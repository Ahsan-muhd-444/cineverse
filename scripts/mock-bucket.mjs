/**
 * A mock object-storage bucket — TESTS ONLY.
 *
 * This is a real HTTP server on its own origin, so a browser exercises the ACTUAL
 * cross-origin upload path: a presigned-style PUT to a different host, a CORS
 * preflight, and reading the `ETag` response header (the single most common
 * multipart misconfiguration). It is never reachable in production — server.js
 * only ever points at it under an explicit test flag.
 *
 * TWO faces:
 *   - a private /_control API the Node adapter uses for create/list/complete/
 *     abort/stat (these run server-side, no browser involved);
 *   - browser-facing /part and /object routes the BROWSER hits directly.
 *
 * State is byte COUNTS, not bytes: nothing here needs the content, and holding it
 * would make the mock the one place a large upload buffers. It enforces the same
 * provider rules a real bucket does (ascending parts, matching ETags, part
 * sizes) so a test cannot pass against a laxer stand-in.
 */

import http from 'node:http';
import crypto from 'node:crypto';

export function startMockBucket(options = {}) {
  // Mutable at runtime via /_control/cors, so ONE bucket can serve both the
  // correct-CORS case and the missing-ETag negative case (item 9) without
  // rebooting the app that points at it.
  let exposeEtag = options.exposeEtag !== false; // default: correct CORS
  const allowOrigin = options.allowOrigin || '*';

  /** uploadId -> { key, mimeType, parts: Map<number,{etag,size}> } */
  const uploads = new Map();
  /** key -> { size, contentType } */
  const objects = new Map();
  const faults = new Set(); // e.g. 'part:2:once' armed via /_control/fail
  const oncePassed = new Set();
  let counter = 0;
  // Optional per-part delay so a browser test can reliably intervene (pause,
  // cancel, go offline) while a part is genuinely in flight.
  let slowMs = 0;
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const cors = (res, extraExpose = []) => {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    const expose = ['content-length', 'content-range', 'accept-ranges', ...extraExpose];
    // The deliberate switch: with exposeEtag off, the browser PUT succeeds but the
    // engine cannot read the ETag → MISSING_ETAG. That is item 9's negative case.
    if (exposeEtag) expose.push('ETag');
    res.setHeader('Access-Control-Expose-Headers', expose.join(', '));
  };

  /*
   * Read a request body and report whether it arrived INTACT.
   *
   * A real bucket only stores a part when the full body is received cleanly. The
   * previous version resolved a byte count on `end` OR `error` and the caller
   * committed either way, so an aborted or truncated PUT would list a partial
   * part — which a resume would then trust as complete. Now only a clean `end`
   * yields `{completed:true}`; an abort, an error, or a premature `close` (the
   * socket dying before `end`) yields `{completed:false}`, and the caller refuses
   * to commit.
   */
  const readBody = (req) =>
    new Promise((resolve) => {
      let bytes = 0;
      let settled = false;
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        resolve({ completed, bytes });
      };
      req.on('data', (c) => (bytes += c.length));
      // `end` always precedes `close` on a fully-received request, so a clean
      // finish wins the idempotent race; a truncated one only ever sees `close`.
      req.on('end', () => finish(true));
      req.on('aborted', () => finish(false));
      req.on('error', () => finish(false));
      req.on('close', () => finish(false));
    });

  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock.bucket');
    const path = url.pathname;
    log.push({ method: req.method, path });

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    /* ------------------ private control API ------------------ */
    if (path === '/_control/create' && req.method === 'POST') {
      const { key, mimeType } = await readJson(req);
      counter += 1;
      const uploadId = `mock-${counter}-${crypto.randomBytes(4).toString('hex')}`;
      uploads.set(uploadId, { key, mimeType, parts: new Map() });
      return json(res, 200, { uploadId });
    }
    if (path === '/_control/list' && req.method === 'POST') {
      const { uploadId } = await readJson(req);
      const upload = uploads.get(uploadId);
      if (!upload) return json(res, 404, { error: 'NoSuchUpload' });
      const parts = [...upload.parts.entries()]
        .map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.size }))
        .sort((a, b) => a.partNumber - b.partNumber);
      return json(res, 200, { parts });
    }
    if (path === '/_control/complete' && req.method === 'POST') {
      const { uploadId, parts } = await readJson(req);
      const upload = uploads.get(uploadId);
      if (!upload) return json(res, 404, { error: 'NoSuchUpload' });
      let previous = 0;
      let total = 0;
      for (const p of parts || []) {
        if (!(p.partNumber > previous)) return json(res, 400, { error: 'parts must ascend' });
        previous = p.partNumber;
        const stored = upload.parts.get(p.partNumber);
        if (!stored) return json(res, 400, { error: `no such part ${p.partNumber}` });
        if (stored.etag !== p.etag) return json(res, 400, { error: `etag mismatch part ${p.partNumber}` });
        total += stored.size;
      }
      /*
       * Fault: assemble an OVERSIZED object. The provider "succeeds" but the
       * finished object is one byte too big, so the server's final size check fails
       * with SIZE_MISMATCH — a genuinely TERMINAL completion failure the browser
       * stress/reselect scenarios need (a real bucket can do this on a bad part).
       */
      const stored = faults.has('complete:oversize') ? total + 1 : total;
      objects.set(upload.key, { size: stored, contentType: upload.mimeType });
      uploads.delete(uploadId);
      return json(res, 200, { ok: true, size: stored });
    }
    if (path === '/_control/abort' && req.method === 'POST') {
      const { uploadId } = await readJson(req);
      uploads.delete(uploadId);
      return json(res, 200, { ok: true });
    }
    if (path === '/_control/stat' && req.method === 'POST') {
      const { key } = await readJson(req);
      const object = objects.get(key);
      if (!object) return json(res, 404, { error: 'NotFound' });
      return json(res, 200, { size: object.size, contentType: object.contentType });
    }
    if (path === '/_control/delete' && req.method === 'POST') {
      const { key } = await readJson(req);
      const existed = objects.delete(key);
      return json(res, 200, { ok: true, existed });
    }
    if (path === '/_control/fail' && req.method === 'POST') {
      const { fault } = await readJson(req);
      faults.add(fault);
      return json(res, 200, { ok: true });
    }
    if (path === '/_control/cors' && req.method === 'POST') {
      const body = await readJson(req);
      exposeEtag = body.exposeEtag !== false;
      return json(res, 200, { ok: true, exposeEtag });
    }
    if (path === '/_control/slow' && req.method === 'POST') {
      const body = await readJson(req);
      slowMs = Number.isFinite(body.ms) && body.ms >= 0 ? body.ms : 0;
      return json(res, 200, { ok: true, slowMs });
    }
    if (path === '/_control/reset' && req.method === 'POST') {
      uploads.clear();
      objects.clear();
      faults.clear();
      oncePassed.clear();
      log.length = 0;
      exposeEtag = options.exposeEtag !== false;
      return json(res, 200, { ok: true });
    }
    if (path === '/_control/inspect' && req.method === 'GET') {
      return json(res, 200, {
        openUploads: uploads.size,
        objects: [...objects.keys()],
        requests: log.length,
      });
    }

    /* ------------------ browser-facing: PUT a part ------------------ */
    // /part/<uploadId>/<partNumber>
    const partMatch = /^\/part\/([^/]+)\/(\d+)$/.exec(path);
    if (partMatch && req.method === 'PUT') {
      const uploadId = decodeURIComponent(partMatch[1]);
      const partNumber = Number(partMatch[2]);
      cors(res);

      // Fault injection for the retry/refresh scenarios.
      const failKey = `part:${partNumber}:once`;
      if (faults.has(failKey) && !oncePassed.has(failKey)) {
        oncePassed.add(failKey);
        await readBody(req);
        res.writeHead(500);
        res.end('injected transient failure');
        return;
      }
      if (faults.has(`part:${partNumber}:expire`) && !oncePassed.has(`part:${partNumber}:expire`)) {
        oncePassed.add(`part:${partNumber}:expire`);
        await readBody(req);
        res.writeHead(403);
        res.end('expired url');
        return;
      }

      const upload = uploads.get(uploadId);
      if (!upload) {
        await readBody(req);
        if (!res.writableEnded) {
          res.writeHead(404);
          res.end('no such upload');
        }
        return;
      }
      const body = await readBody(req);
      /*
       * ONLY a cleanly-received body commits the part. A truncated/aborted PUT is
       * dropped — ListParts must not show it — exactly as a real bucket behaves
       * when the client hangs up mid-upload.
       */
      if (!body.completed) {
        if (!res.writableEnded) {
          res.writeHead(400);
          res.end('incomplete body');
        }
        return;
      }
      /*
       * The part is COMMITTED only at the end of processing. If the client hangs
       * up during the slow window (a pause, cancel or going offline aborts the
       * XHR after the body was sent but before the response), the part is NOT
       * stored — modelling a bucket that had not finished persisting. Without this
       * a paused part still landed after its delay, so a pause never actually
       * stopped progress.
       */
      if (slowMs > 0) {
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableEnded) clientGone = true;
        });
        await sleep(slowMs);
        if (clientGone || res.destroyed) return; // aborted mid-commit — drop it
      }
      const size = body.bytes;
      const etag = `"${crypto.createHash('md5').update(`${uploadId}:${partNumber}:${size}`).digest('hex')}"`;
      upload.parts.set(partNumber, { etag, size });
      // The ETag header the browser must be able to read (if CORS still open).
      if (!res.writableEnded) {
        res.setHeader('ETag', etag);
        res.writeHead(200);
        res.end();
      }
      return;
    }

    /* ------------------ browser-facing: single-shot PUT ------------------ */
    // /single/<key...>  — the whole (small) file in one request. Same commit
    // model as a part: a body aborted during the slow window is NOT stored.
    if (path.startsWith('/single/') && req.method === 'PUT') {
      const key = decodeURIComponent(path.slice('/single/'.length));
      cors(res);
      const contentType = req.headers['content-type'] || 'application/octet-stream';
      const body = await readBody(req);
      if (!body.completed) {
        if (!res.writableEnded) {
          res.writeHead(400);
          res.end('incomplete body');
        }
        return;
      }
      if (slowMs > 0) {
        let clientGone = false;
        res.on('close', () => {
          if (!res.writableEnded) clientGone = true;
        });
        await sleep(slowMs);
        if (clientGone || res.destroyed) return; // cancelled mid-commit — drop it
      }
      objects.set(key, { size: body.bytes, contentType });
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end();
      }
      return;
    }

    /* ------------------ browser-facing: read the object ------------------ */
    // /object/<key...>  (key contains slashes)
    if (path.startsWith('/object/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const key = decodeURIComponent(path.slice('/object/'.length));
      const object = objects.get(key);
      cors(res);
      if (!object) {
        res.writeHead(404);
        res.end();
        return;
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), object.size - 1) : object.size - 1;
        res.writeHead(206, {
          'Content-Type': object.contentType,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${object.size}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(end - start + 1, 7));
        return;
      }
      res.writeHead(200, {
        'Content-Type': object.contentType,
        'Content-Length': object.size,
        'Accept-Ranges': 'bytes',
      });
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(object.size, 7));
      return;
    }

    res.writeHead(404);
    res.end('mock-bucket: not found');
  });

  return new Promise((resolve) => {
    server.listen(options.port || 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        exposeEtag,
        close: () => new Promise((r) => server.close(r)),
        inspect: () => ({ openUploads: uploads.size, objects: [...objects.keys()] }),
      });
    });
  });
}

/* Run standalone: `node scripts/mock-bucket.mjs [port] [--no-etag]` */
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const port = Number(process.argv[2]) || 0;
  const exposeEtag = !process.argv.includes('--no-etag');
  startMockBucket({ port, exposeEtag }).then((b) => {
    // eslint-disable-next-line no-console
    console.log(`mock-bucket listening on ${b.origin} (exposeEtag=${exposeEtag})`);
  });
}
