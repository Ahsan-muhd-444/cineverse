/**
 * Socket lifecycle for EVERY unsuccessful upload request — both routes.
 *
 * The earlier lifecycle work only covered size mismatches. Authentication,
 * method and adapter-availability rejections still answered with an ordinary
 * keep-alive response, so a client could declare `Content-Length: 3GiB`, send a
 * 1 KiB prefix, collect a 401, and keep the connection.
 *
 * The same defect then turned out to live on the READ route, which never reads a
 * body at all: a bodied GET was SERVED and its connection retained. Those cases
 * are at the bottom of this file, with positive controls proving ordinary
 * bodyless reads, Range requests and keep-alive are untouched.
 *
 * Every case here uses a real `http.Server` and a raw socket, because the defect
 * lives in the relationship between an unread request body and the connection —
 * which no `Readable` double can express.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-reject.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-reject-'));
process.env.UPLOAD_DIR = TMP_ROOT;

const { handleUploadRequest, requestHasBody, rejectUploadRequest } = require('../server/uploads-http.js');
const local = require('../server/storage/local.js');
const { issueUploadToken } = require('../server/uploads.js');

const SECRET = 'x'.repeat(32);
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const DECLARED = 100 * 1024;
const THREE_GIB = 3 * 1024 * 1024 * 1024;
const CLOSE_DEADLINE_MS = 1500;

const validToken = () =>
  issueUploadToken(
    { key: KEY, mimeType: 'video/mp4', roomCode: 'ABC123', transport: 'single', expectedBytes: DECLARED, maxBytes: 500 * 1024 * 1024 },
    SECRET,
  );

const unhandled = [];
const servers = [];

/** A server bound to a chosen adapter, so NOT_ENABLED and storage errors are reachable. */
async function startServer(storage) {
  const server = http.createServer(async (req, res) => {
    const consumed = await handleUploadRequest(req, res, { storage, secret: SECRET });
    if (!consumed) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, port: server.address().port };
}

test.before(() => {
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
});
test.after(() => {
  for (const s of servers) s.close();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const activeSockets = (server) => new Promise((r) => server.getConnections((_e, n) => r(n)));

/** Poll the connection count to zero rather than sleeping a fixed amount. */
async function drain(server, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let n = await activeSockets(server);
  while (n > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    n = await activeSockets(server);
  }
  return n;
}

/**
 * Raw request. `serverClosed` distinguishes the server tearing the connection
 * down from us giving up on it — the whole point of these tests.
 */
function rawRequest(port, { method = 'PUT', path: route = '/api/uploads/put', query = '', headers = {}, body, grace = CLOSE_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    let timer = null;

    const finish = (serverClosed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!sock.destroyed) sock.destroy();
      resolve({ response, serverClosed });
    };

    const lines = {
      Host: `127.0.0.1:${port}`,
      'Content-Type': 'video/mp4',
      Connection: 'keep-alive',
      ...headers,
    };
    sock.on('connect', () => {
      sock.write(
        `${method} ${route}${query} HTTP/1.1\r\n` +
          Object.entries(lines).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
          '\r\n\r\n',
      );
      if (body) sock.write(body);
    });
    sock.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (timer) clearTimeout(timer);
      // Once answered, a short window is enough to see whether the server closes.
      timer = setTimeout(() => finish(false), 400);
    });
    sock.on('error', () => {});
    sock.on('close', () => finish(true));
    timer = setTimeout(() => finish(false), grace);
  });
}

const statusLine = (r) => r.response.split('\r\n')[0] || '';
const bodyOf = (r) => (r.response.split('\r\n\r\n')[1] || '').trim();
const storedFile = () => path.join(TMP_ROOT, ...KEY.split('/'));

/** A 3 GiB declaration with only a 1 KiB prefix sent — the reproduction shape. */
const bigDeclaration = (extra = {}) => ({
  headers: { 'Content-Length': String(THREE_GIB), ...extra },
  body: Buffer.alloc(1024, 1),
});

/* ============================================== BAD_TOKEN */

test('an invalid token with a 3 GiB declaration is answered and the socket closed', async () => {
  const { server, port } = await startServer(local);
  const before = await activeSockets(server);

  const result = await rawRequest(port, { query: '?token=not-a-real-token', ...bigDeclaration() });

  assert.match(statusLine(result), /^HTTP\/1\.1 401 /, statusLine(result));
  assert.match(bodyOf(result), /BAD_TOKEN/);
  assert.match(result.response, /[Cc]onnection: close/, 'keep-alive must be disabled');
  assert.equal(result.serverClosed, true, `the server must close within ${CLOSE_DEADLINE_MS}ms`);

  assert.equal(await drain(server), before, 'no socket may be retained');
  assert.equal(fs.existsSync(storedFile()), false, 'nothing may be stored');
});

test('a missing token closes too', async () => {
  const { server, port } = await startServer(local);
  const result = await rawRequest(port, bigDeclaration());
  assert.match(statusLine(result), /^HTTP\/1\.1 401 /);
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0);
});

test('50 invalid-token requests retain no sockets, no files and no unhandled rejections', async () => {
  const { server, port } = await startServer(local);
  unhandled.length = 0;

  for (let i = 0; i < 50; i += 1) {
    const result = await rawRequest(port, { query: `?token=bogus-${i}`, ...bigDeclaration() });
    assert.equal(result.serverClosed, true, `request ${i} left the connection open`);
  }

  assert.equal(await drain(server), 0, 'sockets must return to zero');
  assert.equal(fs.existsSync(storedFile()), false, 'no files');
  assert.deepEqual(unhandled, [], 'no unhandled rejections');
});

/* ============================================== NOT_ENABLED */

test('a direct adapter refuses the byte endpoint and closes', async () => {
  // S3-like: the browser PUTs to the bucket, so this route is not part of the
  // flow — but a client can still try, with a body attached.
  const { server, port } = await startServer({ name: 's3', direct: true });
  const result = await rawRequest(port, { query: `?token=${encodeURIComponent(validToken())}`, ...bigDeclaration() });

  assert.match(statusLine(result), /^HTTP\/1\.1 404 /, statusLine(result));
  assert.match(bodyOf(result), /NOT_ENABLED/);
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0, 'no socket may be retained');
});

test('an adapter with no saveStream also refuses and closes', async () => {
  const { server, port } = await startServer({ name: 'read-only' });
  const result = await rawRequest(port, { query: `?token=${encodeURIComponent(validToken())}`, ...bigDeclaration() });
  assert.match(bodyOf(result), /NOT_ENABLED/);
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0);
});

/* ============================================== METHOD_NOT_ALLOWED */

test('a wrong method carrying a body is refused and closed', async () => {
  const { server, port } = await startServer(local);
  for (const method of ['POST', 'GET', 'DELETE']) {
    const result = await rawRequest(port, { method, query: `?token=${encodeURIComponent(validToken())}`, ...bigDeclaration() });
    assert.match(statusLine(result), /^HTTP\/1\.1 405 /, `${method}: ${statusLine(result)}`);
    assert.match(bodyOf(result), /METHOD_NOT_ALLOWED/, method);
    assert.equal(result.serverClosed, true, `${method} left the connection open`);
  }
  assert.equal(await drain(server), 0, 'no socket may be retained');
});

/* ============================================== storage errors */

/**
 * An adapter whose saveStream rejects immediately, with NO `closeConnection`
 * hint. The HTTP layer must close anyway: once an upload is refused the
 * transport is finished, and where the failure happened is irrelevant.
 */
function failingStorage(code) {
  return {
    name: 'failing',
    async saveStream() {
      throw Object.assign(new Error(code), { code });
    },
    async statObject() {
      return null;
    },
    createReadStream() {
      return null;
    },
  };
}

test('a storage WRITE_ERROR with no closeConnection hint still closes the connection', async () => {
  const { server, port } = await startServer(failingStorage('WRITE_ERROR'));
  const before = await activeSockets(server);

  // Content-Length MATCHES the grant, so the request reaches saveStream; only a
  // prefix of the body is sent, so unread bytes remain when it rejects.
  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    headers: { 'Content-Length': String(DECLARED) },
    body: Buffer.alloc(2048, 7),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 400 /, statusLine(result));
  assert.match(bodyOf(result), /WRITE_ERROR/);
  assert.equal(result.serverClosed, true, 'the server must close');
  assert.equal(await drain(server), before, 'no socket may be retained');
});

test('every storage error code closes, and an unknown one becomes UPLOAD_FAILED', async () => {
  for (const [code, expected, status] of [
    ['STREAM_ERROR', /STREAM_ERROR/, 400],
    ['BAD_KEY', /BAD_KEY/, 400],
    ['TOO_LARGE', /TOO_LARGE/, 413],
    ['SIZE_MISMATCH', /SIZE_MISMATCH/, 400],
  ]) {
    const { server, port } = await startServer(failingStorage(code));
    const result = await rawRequest(port, {
      query: `?token=${encodeURIComponent(validToken())}`,
      headers: { 'Content-Length': String(DECLARED) },
      body: Buffer.alloc(2048, 7),
    });
    assert.match(statusLine(result), new RegExp(`^HTTP/1\\.1 ${status} `), `${code}: ${statusLine(result)}`);
    assert.match(bodyOf(result), expected, code);
    assert.equal(result.serverClosed, true, `${code} left the connection open`);
    assert.equal(await drain(server), 0, `${code} retained a socket`);
  }

  // A rejection with no code at all must not leak an empty error.
  const { server, port } = await startServer({
    name: 'anonymous-failure',
    async saveStream() {
      throw new Error('something opaque');
    },
  });
  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    headers: { 'Content-Length': String(DECLARED) },
    body: Buffer.alloc(2048, 7),
  });
  assert.match(bodyOf(result), /UPLOAD_FAILED/, bodyOf(result));
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0);
});

test('the real local adapter rejects pre-stream, before any bytes are written', async () => {
  // local.js resolves its destination first: an unusable key fails before a
  // single byte is read, which is the genuine pre-stream path.
  await assert.rejects(
    () => local.saveStream('../../escape.mp4', Readable.from([Buffer.alloc(16)]), DECLARED, DECLARED),
    (err) => err.code === 'BAD_KEY',
  );
});

test('a pre-stream destination failure closes the connection', async () => {
  /*
   * A real `mkdir` failure: the root is a FILE, so creating a directory beneath
   * it fails for actual filesystem reasons before any byte is written. This is
   * the pre-stream branch, and it carries no `closeConnection` hint — the HTTP
   * layer must close on its own judgement.
   */
  const blocker = path.join(TMP_ROOT, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');

  const { server, port } = await startServer({
    name: 'local-like',
    async saveStream(key) {
      // Mirrors local.js: prepare the destination before streaming.
      await fs.promises.mkdir(path.dirname(path.join(blocker, key)), { recursive: true });
      return { key, size: 0 };
    },
  });

  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    headers: { 'Content-Length': String(DECLARED) },
    body: Buffer.alloc(2048, 7),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 4\d\d /, statusLine(result));
  assert.equal(result.serverClosed, true, 'a pre-stream failure must still close');
  assert.equal(await drain(server), 0, 'no socket may be retained');
});

/* ============================================== success keeps keep-alive */

test('only SUCCESS may preserve the connection', async () => {
  const { server, port } = await startServer(local);
  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    headers: { 'Content-Length': String(DECLARED) },
    body: Buffer.alloc(DECLARED, 5),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 200 /, statusLine(result));
  assert.match(bodyOf(result), /"ok":true/);
  // A successful upload is ordinary HTTP: no forced close.
  assert.doesNotMatch(result.response, /[Cc]onnection: close/, 'success must not force a close');
  assert.equal(fs.statSync(storedFile()).size, DECLARED);
  fs.rmSync(storedFile(), { force: true });
});

/* ==============================================================================
 * The READ route: /api/uploads/file/<key>
 *
 * It never consumes a request body, so a declared one is the identical
 * retention defect. Reproduced before the fix, on this exact harness:
 *
 *   POST  + 3 GiB declaration -> 405, no Connection: close, socket NEVER closed
 *   GET   + 3 GiB declaration -> 200, the file was SERVED, socket NEVER closed
 *   GET   missing object      -> 404, no Connection: close, socket NEVER closed
 *   20 bodied GETs            -> 19 sockets still held
 * ============================================================================ */

const READ_KEY = 'rooms/ABC123/0123456789abcdef/read.mp4';
const READ_BYTES = 4096;
const readFile = () => path.join(TMP_ROOT, ...READ_KEY.split('/'));
const readPath = (key = READ_KEY) => `/api/uploads/file/${key}`;
const MISSING_KEY = 'rooms/ABC123/0123456789abcdef/absent.mp4';

/** A real object to read, so the positive controls exercise the real streaming path. */
function seedReadFixture() {
  fs.mkdirSync(path.dirname(readFile()), { recursive: true });
  fs.writeFileSync(readFile(), Buffer.alloc(READ_BYTES, 9));
}

/**
 * The real local adapter, instrumented. Proves a rejected request never reaches
 * `statObject` or opens a read stream — "no work started" as well as "no socket
 * retained".
 */
function countingStorage() {
  const calls = { statObject: 0, createReadStream: 0, streamsOpen: 0 };
  return {
    ...local,
    calls,
    async statObject(key) {
      calls.statObject += 1;
      return local.statObject(key);
    },
    createReadStream(key, start, end) {
      calls.createReadStream += 1;
      const stream = local.createReadStream(key, start, end);
      if (stream) {
        calls.streamsOpen += 1;
        stream.once('close', () => {
          calls.streamsOpen -= 1;
        });
      }
      return stream;
    },
  };
}

/* ---------------- the body-detection rule itself ---------------- */

test('requestHasBody treats only a real declaration as a body', () => {
  const check = (headers) => requestHasBody({ headers });

  assert.equal(check({}), false, 'no headers');
  assert.equal(check({ 'content-length': '0' }), false, 'Content-Length: 0 is not a body');

  assert.equal(check({ 'content-length': '1' }), true);
  assert.equal(check({ 'content-length': String(THREE_GIB) }), true);
  assert.equal(check({ 'transfer-encoding': 'chunked' }), true);
  // Transfer-Encoding wins even with a zero length: the framing, not the number,
  // decides what follows.
  assert.equal(check({ 'transfer-encoding': 'chunked', 'content-length': '0' }), true);

  /*
   * Unparseable declarations fail CLOSED — guessing "probably zero" is how a
   * body slips past. Note `''`, `' '` and `'\n'`: `Number()` maps all three to a
   * confident 0, which is why the raw text is checked before it is coerced.
   */
  for (const raw of ['abc', '', ' ', '\n', '1,2', '1e9', '-1', '1.5', '0x10', '+1', '0 ', ' 0', '9'.repeat(30)]) {
    assert.equal(check({ 'content-length': raw }), true, `Content-Length: ${JSON.stringify(raw)}`);
  }
  // Leading zeros are still digits, and still zero.
  assert.equal(check({ 'content-length': '00' }), false);
});

/* ---------------- rejections ---------------- */

test('a POST to the read route with a 3 GiB declaration is refused and closed', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  const result = await rawRequest(port, { method: 'POST', path: readPath(), ...bigDeclaration() });

  assert.match(statusLine(result), /^HTTP\/1\.1 405 /, statusLine(result));
  assert.match(bodyOf(result), /METHOD_NOT_ALLOWED/);
  assert.match(result.response, /[Cc]onnection: close/, 'keep-alive must be disabled');
  assert.equal(result.serverClosed, true, `the server must close within ${CLOSE_DEADLINE_MS}ms`);
  assert.equal(await drain(server), 0, 'no socket may be retained');
  assert.equal(storage.calls.statObject, 0, 'a wrong method must not touch storage');
});

test('a bodied GET is rejected BEFORE statObject, whether or not the object exists', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  for (const [label, key] of [
    ['missing object', MISSING_KEY],
    ['existing object', READ_KEY],
  ]) {
    const result = await rawRequest(port, { method: 'GET', path: readPath(key), ...bigDeclaration() });

    assert.match(statusLine(result), /^HTTP\/1\.1 400 /, `${label}: ${statusLine(result)}`);
    assert.match(bodyOf(result), /REQUEST_BODY_NOT_ALLOWED/, label);
    assert.match(result.response, /[Cc]onnection: close/, label);
    assert.equal(result.serverClosed, true, `${label} left the connection open`);
    // The existing object must NOT have been served: before the fix this
    // returned 200 with 4096 bytes of video.
    assert.doesNotMatch(result.response, /^HTTP\/1\.1 2\d\d /, label);
  }

  assert.equal(await drain(server), 0, 'no socket may be retained');
  assert.equal(storage.calls.statObject, 0, 'the rejection must precede any stat');
  assert.equal(storage.calls.createReadStream, 0, 'no read stream may be opened');
});

test('a chunked GET body is rejected and closed', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  // 0x400 = 1024 bytes, and deliberately never terminated: the length is
  // unknowable from the headers, which is exactly why any transfer-encoding
  // counts as a body.
  const result = await rawRequest(port, {
    method: 'GET',
    path: readPath(),
    headers: { 'Transfer-Encoding': 'chunked' },
    body: `400\r\n${'a'.repeat(1024)}\r\n`,
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 400 /, statusLine(result));
  assert.match(bodyOf(result), /REQUEST_BODY_NOT_ALLOWED/);
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0, 'no socket may be retained');
  assert.equal(storage.calls.statObject, 0);
});

test('a HEAD with a body is rejected and closed', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  const result = await rawRequest(port, { method: 'HEAD', path: readPath(), ...bigDeclaration() });

  // Node suppresses the response body for HEAD, so the status line and the
  // close header are the evidence — not the JSON.
  assert.match(statusLine(result), /^HTTP\/1\.1 400 /, statusLine(result));
  assert.match(result.response, /[Cc]onnection: close/, 'keep-alive must be disabled');
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0, 'no socket may be retained');
  assert.equal(storage.calls.statObject, 0);
});

test('50 read-route body attempts retain no sockets, no streams and no unhandled rejections', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();
  unhandled.length = 0;

  for (let i = 0; i < 50; i += 1) {
    // Alternate the shapes so the count covers every rejection branch.
    const shape = i % 4;
    const result = await rawRequest(port, {
      method: shape === 0 ? 'POST' : shape === 1 ? 'HEAD' : 'GET',
      path: readPath(shape === 3 ? MISSING_KEY : READ_KEY),
      ...(shape === 2
        ? { headers: { 'Transfer-Encoding': 'chunked' }, body: `400\r\n${'a'.repeat(1024)}\r\n` }
        : bigDeclaration()),
    });
    assert.equal(result.serverClosed, true, `request ${i} (shape ${shape}) left the connection open`);
  }

  assert.equal(await drain(server), 0, 'sockets must return to zero');
  assert.equal(storage.calls.createReadStream, 0, 'no read stream may be opened');
  assert.equal(storage.calls.streamsOpen, 0, 'no stream may be left open');
  assert.deepEqual(unhandled, [], 'no unhandled rejections');
});

/* ---------------- positive controls: normal reading is untouched ---------------- */

test('a bodyless GET still streams the object and keeps the connection', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  const result = await rawRequest(port, { method: 'GET', path: readPath(), grace: 700 });

  assert.match(statusLine(result), /^HTTP\/1\.1 200 /, statusLine(result));
  assert.match(result.response, new RegExp(`Content-Length: ${READ_BYTES}`));
  assert.match(result.response, /Accept-Ranges: bytes/);
  assert.doesNotMatch(result.response, /[Cc]onnection: close/, 'an ordinary read must not force a close');
  assert.equal(result.serverClosed, false, 'keep-alive must survive');
  assert.equal(storage.calls.statObject, 1);
  assert.equal(storage.calls.createReadStream, 1, 'the object must actually be streamed');
});

test('a bodyless HEAD still returns headers and no body', async () => {
  const storage = countingStorage();
  const { server, port } = await startServer(storage);
  seedReadFixture();

  const result = await rawRequest(port, { method: 'HEAD', path: readPath(), grace: 700 });

  assert.match(statusLine(result), /^HTTP\/1\.1 200 /, statusLine(result));
  assert.match(result.response, new RegExp(`Content-Length: ${READ_BYTES}`));
  assert.equal(bodyOf(result), '', 'HEAD must carry no body');
  assert.equal(result.serverClosed, false, 'keep-alive must survive');
  assert.equal(storage.calls.createReadStream, 0, 'HEAD must not open a stream');
});

test('a Range GET still returns 206 with the right slice', async () => {
  const { server, port } = await startServer(local);
  seedReadFixture();

  const result = await rawRequest(port, {
    method: 'GET',
    path: readPath(),
    headers: { Range: 'bytes=100-199' },
    grace: 700,
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 206 /, statusLine(result));
  assert.match(result.response, new RegExp(`Content-Range: bytes 100-199/${READ_BYTES}`));
  assert.match(result.response, /Content-Length: 100/);
  assert.doesNotMatch(result.response, /[Cc]onnection: close/);
  assert.equal(result.serverClosed, false, 'seeking must not cost the connection');
});

test('Content-Length: 0 is not a body and does not force a close', async () => {
  const { server, port } = await startServer(local);
  seedReadFixture();

  const result = await rawRequest(port, {
    method: 'GET',
    path: readPath(),
    headers: { 'Content-Length': '0' },
    grace: 700,
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 200 /, statusLine(result));
  assert.doesNotMatch(result.response, /[Cc]onnection: close/, 'a zero-length declaration is not a body');
  assert.equal(result.serverClosed, false, 'keep-alive must survive');
});

test('a missing object is still an ordinary keep-alive 404', async () => {
  const { server, port } = await startServer(local);
  const result = await rawRequest(port, { method: 'GET', path: readPath(MISSING_KEY), grace: 700 });

  assert.match(statusLine(result), /^HTTP\/1\.1 404 /, statusLine(result));
  assert.match(bodyOf(result), /NOT_FOUND/);
  // Bodyless, so there is nothing to tear the connection down for.
  assert.doesNotMatch(result.response, /[Cc]onnection: close/);
});

/* ==============================================================================
 * The OUTER wrapper: an UNEXPECTED handler failure.
 *
 * server.js wraps handleUploadRequest and, on an unexpected rejection, routes it
 * through the same bounded rejectUploadRequest instead of a plain keep-alive 500
 * — otherwise the very same socket-retention defect reappears for the one case
 * the handler's own try/catch does not cover. This replicates that exact wrapper
 * and injects failures, using the REAL rejectUploadRequest.
 * ============================================================================ */

/** The precise server.js wrapper: fall through to `handle`, else bounded-close 500. */
async function startWrappedServer(handler) {
  const server = http.createServer((req, res) => {
    handler(req, res)
      .then((handled) => {
        if (!handled) {
          // Stand-in for the Next fall-through; only reached when the handler
          // declines the request, which these tests never do.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"NOT_HANDLED"}');
        }
      })
      .catch(() => {
        // EXACTLY server.js: bounded close, never a plain keep-alive 500.
        if (!res.writableEnded) rejectUploadRequest(req, res, 500, 'UPLOAD_ERROR');
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { server, port: server.address().port };
}

test('an unexpected PUT-handler failure answers 500 and closes the connection', async () => {
  // A handler that rejects unexpectedly while the request still carries an unread
  // 3 GiB body — the one path the handler's own try/catch does not cover.
  const { server, port } = await startWrappedServer(async () => {
    throw new Error('unexpected handler failure');
  });
  const before = await activeSockets(server);

  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    ...bigDeclaration(),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 500 /, statusLine(result));
  assert.match(bodyOf(result), /UPLOAD_ERROR/);
  assert.match(result.response, /[Cc]onnection: close/, 'an unexpected failure must still close');
  assert.equal(result.serverClosed, true, 'the server must close');
  assert.equal(await drain(server), before, 'no socket may be retained');
});

test('an unexpected failure with a MATCHING Content-Length still closes', async () => {
  // The body is fully declared and mostly unsent: identical retention risk.
  const { server, port } = await startWrappedServer(async () => {
    throw Object.assign(new Error('boom'), { code: 'WHATEVER' });
  });

  const result = await rawRequest(port, {
    query: `?token=${encodeURIComponent(validToken())}`,
    headers: { 'Content-Length': String(DECLARED) },
    body: Buffer.alloc(2048, 7),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 500 /, statusLine(result));
  assert.equal(result.serverClosed, true);
  assert.equal(await drain(server), 0, 'no socket may be retained');
});

test('a bodyless read-route internal error closes cleanly with no unhandled rejection', async () => {
  // The real handler, but with a storage whose statObject throws unexpectedly on
  // an ordinary bodyless GET. The wrapper must answer 500 and close without an
  // RST (there is no body) and without an unhandled rejection.
  unhandled.length = 0;
  const exploding = {
    ...local,
    async statObject() {
      throw new Error('disk on fire');
    },
  };
  const { server, port } = await startWrappedServer((req, res) =>
    handleUploadRequest(req, res, { storage: exploding, secret: SECRET }),
  );
  seedReadFixture();

  const result = await rawRequest(port, { method: 'GET', path: readPath(), grace: 900 });

  assert.match(statusLine(result), /^HTTP\/1\.1 500 /, statusLine(result));
  assert.match(bodyOf(result), /UPLOAD_ERROR/);
  assert.equal(result.serverClosed, true, 'the connection must close cleanly');
  assert.equal(await drain(server), 0, 'no socket may be retained');
  // Give any stray microtask a beat, then assert nothing escaped.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(unhandled, [], 'no unhandled rejection may escape the wrapper');
});
