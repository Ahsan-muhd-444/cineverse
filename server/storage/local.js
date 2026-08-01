/**
 * DEV-ONLY filesystem storage adapter.
 *
 * Writes uploaded video into a local directory and streams it back through the
 * app's own HTTP endpoints. This exists so the feature works on a fresh clone
 * with zero configuration — it is NOT production persistence:
 *
 *   - a restart on an ephemeral host (Render, Fly, containers) loses the disk;
 *   - it serves bytes through the Node process instead of a CDN;
 *   - expiry is a best-effort in-process sweeper, not a storage lifecycle rule.
 *
 * Configure S3-compatible storage (see server/storage/s3.js) for production.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { isValidKey } = require('../uploads');

const ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), '.uploads'));

/**
 * Map an object key to an absolute path, refusing anything that escapes ROOT.
 * Keys are server-generated, but they come back to us through a URL, so this
 * is treated as untrusted input every time.
 */
function resolveKey(key) {
  if (!isValidKey(key)) return null;
  const full = path.resolve(ROOT, key);
  // path.resolve collapses `..`; confirm the result is still inside ROOT.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

/**
 * Stream a request body to disk, enforcing the grant EXACTLY as we go.
 *
 * `maxBytes` is the transport ceiling; `expectedBytes` is what the client
 * declared. Exceeding either aborts and deletes mid-stream, and finishing short
 * of `expectedBytes` is rejected on completion - a partial file must never
 * survive as a playable source.
 */
function saveStream(key, readable, maxBytes, expectedBytes) {
  return new Promise((resolve, reject) => {
    const full = resolveKey(key);
    if (!full) return reject(Object.assign(new Error('BAD_KEY'), { code: 'BAD_KEY' }));

    fsp
      .mkdir(path.dirname(full), { recursive: true })
      .then(() => {
        const out = fs.createWriteStream(full);
        let received = 0;
        let failed = false;

        const fail = (code) => {
          if (failed) return;
          failed = true;
          readable.unpipe(out);
          /*
           * Delete only AFTER the write stream has closed, then reject.
           *
           * The previous version fired `fsp.rm` immediately and rejected
           * synchronously, so the removal raced the stream's final flush: the
           * caller saw a rejection while a partial file was still on disk (and
           * could even be re-created by a write landing after the unlink).
           * Sequencing it means a rejected upload has provably left nothing
           * behind by the time the caller hears about it.
           */
          /*
           * A structured `code` and nothing else.
           *
           * This used to also set `closeConnection: true`, which the HTTP layer
           * branched on to decide whether to tear the socket down — so a storage
           * failure that forgot the flag answered keep-alive and retained the
           * connection. `uploads-http.js` now closes on EVERY unsuccessful
           * outcome, so the flag is not merely unused, it would be misleading:
           * the adapter has no say in HTTP connection lifecycle.
           */
          const cleanup = () => {
            fsp
              .rm(full, { force: true })
              .catch(() => {})
              .then(() => reject(Object.assign(new Error(code), { code })));
          };
          if (out.destroyed) cleanup();
          else out.once('close', cleanup);
          out.destroy();
        };

        const ceiling = Number.isSafeInteger(expectedBytes) && expectedBytes > 0
          ? Math.min(maxBytes, expectedBytes)
          : maxBytes;

        readable.on('data', (chunk) => {
          received += chunk.length;
          // Enforce on ACTUAL bytes: a lying Content-Length must not smuggle a
          // larger body past intent validation. Stops at the DECLARED size, so
          // an over-long body is cut off immediately rather than at the cap.
          if (received > ceiling) fail(received > maxBytes ? 'TOO_LARGE' : 'SIZE_MISMATCH');
        });
        readable.on('error', () => fail('STREAM_ERROR'));
        out.on('error', () => fail('WRITE_ERROR'));
        out.on('finish', () => {
          if (failed) return;
          // Short bodies are rejected here: the stream ended cleanly, but the
          // object is not what was authorized.
          if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && received !== expectedBytes) {
            return fail('SIZE_MISMATCH');
          }
          resolve({ key, size: received });
        });

        readable.pipe(out);
      })
      .catch(() => reject(Object.assign(new Error('WRITE_ERROR'), { code: 'WRITE_ERROR' })));
  });
}

async function statObject(key) {
  const full = resolveKey(key);
  if (!full) return null;
  try {
    const st = await fsp.stat(full);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function createReadStream(key, start, end) {
  const full = resolveKey(key);
  if (!full) return null;
  return fs.createReadStream(full, start === undefined ? undefined : { start, end });
}

async function deleteObject(key) {
  const full = resolveKey(key);
  if (!full) return false;
  await fsp.rm(full, { force: true });
  return true;
}

/**
 * Best-effort expiry for the dev adapter: delete objects older than maxAgeMs
 * and prune the directories left behind. Production should use a bucket
 * lifecycle rule instead (see docs/uploads.md).
 */
async function sweep(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        // Drop the directory once its contents have aged out.
        try {
          const rest = await fsp.readdir(full);
          if (!rest.length) await fsp.rmdir(full);
        } catch {
          /* raced with another sweep — fine */
        }
      } else {
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs < cutoff) {
            await fsp.rm(full, { force: true });
            removed += 1;
          }
        } catch {
          /* already gone */
        }
      }
    }
  }

  await walk(ROOT);
  return removed;
}

module.exports = {
  name: 'local-fs',
  /** The client uploads through OUR endpoint; the token is the authorization. */
  direct: false,
  root: ROOT,
  async createUploadTarget({ key, mimeType, token }) {
    return {
      method: 'PUT',
      url: `/api/uploads/put?token=${encodeURIComponent(token)}`,
      headers: { 'Content-Type': mimeType },
      key,
      direct: false,
    };
  },
  /** Same-origin relative URL — plays in a <video> for every room member. */
  async createReadUrl(key) {
    return `/api/uploads/file/${key}`;
  },
  saveStream,
  statObject,
  createReadStream,
  deleteObject,
  sweep,
};
