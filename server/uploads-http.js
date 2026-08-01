/**
 * HTTP surface for uploaded video.
 *
 * Only TWO endpoints, and both exist solely for the dev filesystem adapter —
 * with S3-compatible storage configured the browser PUTs straight to the bucket
 * and reads from a presigned GET, so neither of these is ever hit.
 *
 *   PUT /api/uploads/put?token=<capability token>   store bytes
 *   GET /api/uploads/file/<key>                     stream bytes (Range-aware)
 *
 * Authorization is the token alone: it was minted for an approved room member,
 * it pins the key/MIME/byte-cap, and it expires. Nothing else in the request is
 * trusted — not the path, not Content-Length, not Content-Type.
 *
 * ONE lifecycle rule across both endpoints: a request whose body we are not
 * going to read is answered and CLOSED. Only PUT reads a body, and only a
 * successful PUT keeps the connection.
 */

const { verifyUploadToken, isValidKey } = require('./uploads');

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
};

function mimeForKey(key) {
  const dot = key.lastIndexOf('.');
  return (dot >= 0 && MIME_BY_EXT[key.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

/**
 * How long to wait for a rejected peer to acknowledge our FIN before forcing the
 * socket down. Bounded on purpose: long enough for a graceful close, far too
 * short to be a free upload window.
 */
const REJECT_CLOSE_GRACE_MS = 250;

/**
 * Hard cap on how much of a rejected body we will read purely to close cleanly.
 * 256 KiB is a few TCP windows - plenty to clear the receive queue for a normal
 * client, and nothing like an upload allowance.
 */
const REJECT_DRAIN_MAX_BYTES = 256 * 1024;

/**
 * Reject a request whose body we are NOT going to read.
 *
 * The leak this closes: a client sent `Content-Length: 3GiB`, we replied 413
 * after 18ms, and then the socket stayed open forever - Node keeps the
 * connection alive waiting for a body nobody is reading, and the paused
 * readable pins the socket. 50 such requests are 50 retained sockets.
 *
 * Draining the body would be the other wrong answer: a free multi-gigabyte
 * upload to an endpoint that already said no.
 *
 * Delivery of the reason is BEST-EFFORT within the bounded drain window;
 * TERMINATION is the invariant. `socket.destroy()` on a connection with unread
 * inbound data emits a TCP RST, and an RST discards whatever the peer has not
 * read yet - including the response just written. Clearing a bounded prefix of
 * the receive queue first lets the close be a FIN, so a client whose remaining
 * body fits the window reads its reason. A peer that floods the socket keeps the
 * queue permanently non-empty, so its reason may still be lost to an RST - that
 * is accepted, because the alternative is reading the body without bound.
 */
function sendJsonAndClose(req, res, status, body) {
  // Tell Node not to expect another request on this connection, so it does not
  // wait for the unread body before recycling the socket.
  res.shouldKeepAlive = false;

  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
  }

  res.end(payload, () => {
    const socket = res.socket || req.socket;
    if (!socket || socket.destroyed) return;

    let finished = false;
    let discarded = 0;

    const shutdown = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', shutdown);
      req.removeListener('error', shutdown);
      if (!socket.destroyed) {
        // Half-close: FIN once our write buffer has drained. If the receive
        // queue is now empty the close is clean and the reason gets through; if
        // the peer is still flooding, the stack will RST and the reason may be
        // lost. Accepted trade-off for refusing to be an unbounded sink.
        socket.end();
        setTimeout(() => {
          if (!socket.destroyed) socket.destroy();
        }, 50).unref?.();
      }
    };

    /*
     * BOUNDED drain, capped in bytes and time.
     *
     * Not politeness - correctness. TCP sends RST instead of FIN whenever a
     * socket is closed with unread data still in its receive queue, and an RST
     * discards response bytes the peer has not read yet. That is what produced
     * the intermittent empty reply: the uploader got ECONNRESET rather than
     * SIZE_MISMATCH. Clearing the queue first lets the close be graceful.
     *
     * The caps are what keep this from becoming the very thing we are refusing:
     * at most REJECT_DRAIN_MAX_BYTES and REJECT_CLOSE_GRACE_MS, whichever comes
     * first. A multi-gigabyte body is never read - only enough of it to say
     * goodbye properly.
     */
    const onData = (chunk) => {
      discarded += chunk.length;
      if (discarded >= REJECT_DRAIN_MAX_BYTES) shutdown();
    };

    const timer = setTimeout(shutdown, REJECT_CLOSE_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', onData);
    req.once('end', shutdown);
    req.once('error', shutdown);
    req.resume();
  });
}

/**
 * The ONE rejection path for BOTH upload routes.
 *
 * Every unsuccessful outcome that can be reached with an unread request body in
 * flight goes through here - a client may declare `Content-Length: 3GiB`, send a
 * 1 KiB prefix, and get a 401 from the PUT route or a 405 from the read route.
 * If the response is written with a plain `sendJson()` the connection is never
 * closed and the socket is retained.
 *
 * Deliberately NOT conditional on an adapter-supplied hint: once an upload is
 * being refused, the transport is finished. The storage layer keeps returning
 * structured error codes, but it does not get a vote on HTTP connection
 * lifecycle.
 */
function rejectUploadRequest(req, res, status, error) {
  sendJsonAndClose(req, res, status, { ok: false, error });
  return true;
}

/**
 * Does this request CLAIM a body?
 *
 * Deliberately about the declaration, not the bytes: the decision has to be made
 * before reading anything, so the headers are all there is to go on.
 *
 * Fail-closed on anything unparseable. A `Content-Length` that is not a
 * non-negative safe integer ("1,2" from duplicated headers, "1e9", "abc") is
 * treated as a body, because the alternative is guessing that a malformed
 * declaration means zero bytes.
 */
function requestHasBody(req) {
  // Any transfer-encoding at all means a framed body follows, and its length is
  // unknowable from the headers.
  const transferEncoding = req.headers['transfer-encoding'];
  if (transferEncoding !== undefined) return true;

  const rawLength = req.headers['content-length'];
  if (rawLength === undefined) return false;

  /*
   * A Content-Length is `1*DIGIT` and nothing else (RFC 9110). Testing the raw
   * text before coercing matters, because `Number()` maps several malformed
   * values to a confident 0: `Number('')`, `Number(' ')` and `Number('\n')` are
   * all zero, so a header that is not a length at all would read as "no body".
   * Duplicated headers arrive joined ("1,2") and are malformed for the same
   * reason.
   */
  if (!/^\d+$/.test(String(rawLength))) return true;

  const length = Number(rawLength);
  return !Number.isSafeInteger(length) || length > 0;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * Parse a single-range `Range: bytes=start-end` header against a known size.
 * Returns null for "no range", or `{ unsatisfiable: true }` when out of bounds.
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  if (start < 0 || start >= size || end < start) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Handle an /api/uploads/* request. Returns true when the request was consumed
 * (so the caller must not fall through to the Next.js handler).
 */
async function handleUploadRequest(req, res, { storage, secret }) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/uploads/')) return false;

  /* ---------------- PUT the bytes ---------------- */
  if (pathname === '/api/uploads/put') {
    if (req.method !== 'PUT') {
      // A wrong method can still carry a body, so this must close too.
      return rejectUploadRequest(req, res, 405, 'METHOD_NOT_ALLOWED');
    }
    // With direct-to-bucket storage this endpoint is not part of the flow.
    if (storage.direct || typeof storage.saveStream !== 'function') {
      // Direct-to-bucket storage: the browser never PUTs here, but a client can
      // still try, with a body attached.
      return rejectUploadRequest(req, res, 404, 'NOT_ENABLED');
    }

    const claims = verifyUploadToken(url.searchParams.get('token'), secret);
    if (!claims) {
      return rejectUploadRequest(req, res, 401, 'BAD_TOKEN');
    }

    /*
     * Reject before reading a byte when the client is honest about the size.
     * A PRESENT Content-Length must equal the declared size EXACTLY, not merely
     * fit under the cap, because the grant authorized that one size. A missing
     * Content-Length may still stream; saveStream then enforces the exact count
     * on real bytes and rejects a short body on completion.
     */
    const header = req.headers['content-length'];
    if (header !== undefined) {
      const declared = Number(header);
      if (!Number.isSafeInteger(declared) || declared < 0) {
        return rejectUploadRequest(req, res, 400, 'BAD_LENGTH');
      }
      if (declared > claims.maxBytes) {
        return rejectUploadRequest(req, res, 413, 'TOO_LARGE');
      }
      if (declared !== claims.expectedBytes) {
        return rejectUploadRequest(req, res, 400, 'SIZE_MISMATCH');
      }
    }

    try {
      const saved = await storage.saveStream(claims.key, req, claims.maxBytes, claims.expectedBytes);
      sendJson(res, 200, { ok: true, key: claims.key, size: saved.size });
    } catch (err) {
      /*
       * ANY saveStream rejection ends the transport.
       *
       * This used to branch on `err.closeConnection`, which meant a storage
       * failure that forgot to set the flag (a write error, a mkdir failure, a
       * custom adapter) answered with an ordinary keep-alive response and
       * retained the socket. Where the failure happened is irrelevant: the body
       * is no longer being consumed, so the connection has to go.
       */
      const code = err && typeof err.code === 'string' ? err.code : 'UPLOAD_FAILED';
      const status = code === 'TOO_LARGE' ? 413 : 400;
      return rejectUploadRequest(req, res, status, code);
    }
    return true;
  }

  /* ---------------- GET the bytes ---------------- */
  if (pathname.startsWith('/api/uploads/file/')) {
    /*
     * The READ route never consumes a request body, so a declared one is the same
     * socket-retention defect the PUT route had: a client sent
     * `Content-Length: 3GiB` with a 1 KiB prefix, collected a 405 or a 404, and
     * kept the connection - Node waits for a body nobody reads. 20 such requests
     * were 19 retained sockets.
     *
     * Decided BEFORE any routing work (no key decode, no statObject, no stream),
     * because the leak is independent of whether the object exists.
     */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Closed regardless of body headers: a wrong method is finished either way,
      // and checking the method first keeps the reason accurate.
      return rejectUploadRequest(req, res, 405, 'METHOD_NOT_ALLOWED');
    }
    if (requestHasBody(req)) {
      /*
       * A GET or HEAD with a body. Browser fetch APIs refuse to send one, so no
       * legitimate client reaches here - but a raw HTTP client can, and the
       * request would otherwise be SERVED while its body sat unread.
       *
       * `Content-Length: 0` is not a body and keeps ordinary keep-alive.
       */
      return rejectUploadRequest(req, res, 400, 'REQUEST_BODY_NOT_ALLOWED');
    }
    /*
     * Everything past this point is provably bodyless, so the remaining
     * responses use plain keep-alive `sendJson` on purpose: a 404 for a missing
     * object is ordinary HTTP, and a <video> element reissuing Range requests on
     * the same connection is the behaviour that makes seeking usable.
     */
    if (storage.direct || typeof storage.createReadStream !== 'function') {
      sendJson(res, 404, { ok: false, error: 'NOT_ENABLED' });
      return true;
    }

    // decodeURIComponent can throw on a malformed escape — treat that as 404.
    let key;
    try {
      key = decodeURIComponent(pathname.slice('/api/uploads/file/'.length));
    } catch {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return true;
    }
    if (!isValidKey(key)) {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return true;
    }

    const stat = await storage.statObject(key);
    if (!stat) {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return true;
    }

    const contentType = mimeForKey(key);
    const range = parseRange(req.headers.range, stat.size);

    if (range && range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return true;
    }

    // Range support is what makes seeking work in a <video> element.
    const status = range ? 206 : 200;
    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;

    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      // Uploads are immutable under a random key, so let the browser cache them
      // for the session; `private` keeps them out of shared caches.
      'Cache-Control': 'private, max-age=3600',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = storage.createReadStream(key, start, end);
    if (!stream) {
      res.end();
      return true;
    }
    stream.on('error', () => res.destroy());
    // Stop reading from disk if the viewer seeks away or closes the tab.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }

  return false;
}

module.exports = {
  handleUploadRequest,
  parseRange,
  mimeForKey,
  requestHasBody,
  sendJsonAndClose,
  rejectUploadRequest,
};
