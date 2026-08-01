/**
 * Rejected-upload socket lifecycle, against a REAL http.Server.
 *
 * A `Readable` double cannot show this class of bug: the leak lives in the
 * relationship between an unread request body and the socket. Before this
 * patch, `Content-Length: 3GiB` + a 1 KiB body got a 413 in ~18ms and then the
 * connection stayed open indefinitely, because Node waits for the declared body
 * before recycling the socket and nothing was reading it.
 *
 * Draining the body would be the other wrong answer: a free multi-gigabyte
 * upload to an endpoint that already said no.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-lifecycle.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-life-'));
process.env.UPLOAD_DIR = TMP_ROOT;

const { handleUploadRequest } = require('../server/uploads-http.js');
const local = require('../server/storage/local.js');
const { issueUploadToken } = require('../server/uploads.js');

const SECRET = 'x'.repeat(32);
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const DECLARED = 100 * 1024;
const CLOSE_DEADLINE_MS = 2000;

const token = (expectedBytes = DECLARED) =>
  issueUploadToken(
    {
      key: KEY,
      mimeType: 'video/mp4',
      roomCode: 'ABC123',
      transport: 'single',
      expectedBytes,
      maxBytes: 500 * 1024 * 1024,
    },
    SECRET,
  );

let server;
let port;
const unhandled = [];

test.before(async () => {
  process.on('unhandledRejection', (reason) => unhandled.push(reason));
  server = http.createServer(async (req, res) => {
    const consumed = await handleUploadRequest(req, res, { storage: local, secret: SECRET });
    if (!consumed) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  server.close();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

const activeSockets = () => new Promise((resolve) => server.getConnections((_e, n) => resolve(n)));

/**
 * Wait for the server's connection count to reach zero, up to a bound.
 * A closed socket is not accounted instantly, so polling avoids both a flaky
 * fixed sleep and a dirty baseline leaking between tests.
 */
async function drain(timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let count = await activeSockets();
  while (count > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    count = await activeSockets();
  }
  return count;
}
const storedFile = () => path.join(TMP_ROOT, ...KEY.split('/'));

/**
 * Speak raw HTTP so we control exactly how much body is sent, and observe the
 * socket rather than a client abstraction that might close it for us.
 *
 * `serverClosed` is the property that matters, and it is deliberately NOT the
 * same as "the socket ended": a SUCCESSFUL upload should keep the connection
 * alive (that is correct HTTP), while every rejection must have the server tear
 * it down. Distinguishing the two is the whole contract. When the server does
 * not close within the grace window we destroy the socket client-side so a
 * lingering keep-alive cannot pollute the next test's connection count.
 */
function rawRequest({ headers, write, grace = CLOSE_DEADLINE_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect(port, '127.0.0.1');
    let response = '';
    let respondedAt = null;
    let closedAt = null;
    let settled = false;
    let timer = null;

    const finish = (serverClosed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!sock.destroyed) sock.destroy();
      resolve({ response, respondedAt, closedAt, serverClosed, timedOut: !serverClosed });
    };

    sock.on('connect', () => {
      sock.write(headers);
      if (write) write(sock);
    });
    sock.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (respondedAt === null) {
        respondedAt = Date.now() - started;
        // Once a response has arrived, only a short window is needed to learn
        // whether the server is closing the connection or keeping it alive.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(false), 400);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      closedAt = Date.now() - started;
      finish(true);
    });
    timer = setTimeout(() => finish(false), grace);
  });
}

const statusLine = (r) => r.response.split('\r\n')[0] || '';
const bodyOf = (r) => (r.response.split('\r\n\r\n')[1] || '').trim();

/* =================================================== pre-body mismatch */

test('a declared 3 GiB body with a 1 KiB payload is rejected and the socket closes', async () => {
  const before = await activeSockets();
  const t = token();

  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(t)} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: video/mp4\r\n` +
      `Content-Length: ${3 * 1024 * 1024 * 1024}\r\n` +
      `Connection: keep-alive\r\n\r\n`,
    // Only a tiny prefix of the declared body.
    write: (sock) => sock.write(Buffer.alloc(1024, 1)),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 413 /, statusLine(result));
  assert.match(bodyOf(result), /TOO_LARGE/);
  assert.match(result.response, /[Cc]onnection: close/, 'keep-alive must be disabled');
  assert.equal(result.serverClosed, true, `the SERVER must close the connection (waited ${CLOSE_DEADLINE_MS}ms)`);
  assert.ok(result.closedAt < CLOSE_DEADLINE_MS, `closed after ${result.closedAt}ms`);

  await drain();
  assert.equal(await activeSockets(), before, 'no socket may be retained');
  assert.equal(fs.existsSync(storedFile()), false, 'no partial file');
});

test('a Content-Length that merely disagrees with the grant is rejected and closed', async () => {
  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Length: ${DECLARED - 1}\r\n\r\n`,
    write: (sock) => sock.write(Buffer.alloc(16, 1)),
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 400 /);
  assert.match(bodyOf(result), /SIZE_MISMATCH/);
  assert.equal(result.serverClosed, true, 'the server must close the connection');
  assert.equal(fs.existsSync(storedFile()), false);
});

test('a malformed Content-Length is rejected and closed', async () => {
  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Length: 99999999999999999999\r\n\r\n`,
    write: (sock) => sock.write(Buffer.alloc(16, 1)),
  });
  // Node may reject the header itself (400) before our handler sees it; either
  // way the connection must not survive.
  assert.match(statusLine(result), /^HTTP\/1\.1 4\d\d /, statusLine(result));
  assert.equal(result.serverClosed, true, 'socket must be closed by the server');
});

/* ================================================= chunked overflow */

test('a chunked body exceeding the grant stops early, closes, and leaves nothing', async () => {
  const before = await activeSockets();

  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: video/mp4\r\n` +
      `Transfer-Encoding: chunked\r\n\r\n`,
    write: (sock) => {
      // Stream well past the 100 KiB grant in 16 KiB chunks.
      const chunk = Buffer.alloc(16 * 1024, 2);
      let sent = 0;
      const pump = () => {
        if (sock.destroyed || sent >= 512 * 1024) return;
        sent += chunk.length;
        sock.write(`${chunk.length.toString(16)}\r\n`);
        sock.write(chunk);
        sock.write('\r\n');
        setTimeout(pump, 5);
      };
      pump();
    },
  });

  assert.equal(result.serverClosed, true, `the server must close the connection (waited ${CLOSE_DEADLINE_MS}ms)`);
  /*
   * This client streams 512 KiB — well past the bounded drain budget — so the
   * receive queue stays non-empty and the close cannot be graceful. TCP sends
   * RST rather than FIN in that situation, and an RST discards response bytes
   * the peer has not read yet, so the reason is best-effort here.
   *
   * That is a deliberate trade, not an oversight: guaranteeing delivery would
   * mean reading the body without bound, which is the free-upload sink this
   * whole path exists to refuse. TERMINATION is the guarantee; a separate test
   * below asserts guaranteed DELIVERY for a body inside the drain budget.
   *
   * (Asserting a response here is what made this test flaky at roughly one run
   * in six under full-suite load.)
   */
  if (result.response !== '') {
    assert.match(statusLine(result), /^HTTP\/1\.1 4\d\d /, statusLine(result));
    assert.match(bodyOf(result), /SIZE_MISMATCH|TOO_LARGE/, bodyOf(result));
  }

  await drain();
  assert.equal(await activeSockets(), before, 'no socket may be retained');
  assert.equal(fs.existsSync(storedFile()), false, 'no partial object may survive');
});

test('a chunked body matching the grant exactly still succeeds', async () => {
  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: video/mp4\r\n` +
      `Transfer-Encoding: chunked\r\n\r\n`,
    write: (sock) => {
      const chunk = Buffer.alloc(DECLARED, 3);
      sock.write(`${chunk.length.toString(16)}\r\n`);
      sock.write(chunk);
      sock.write('\r\n0\r\n\r\n');
    },
  });

  assert.match(statusLine(result), /^HTTP\/1\.1 200 /, statusLine(result));
  assert.match(bodyOf(result), /"ok":true/);
  // A successful upload must NOT be torn down: keep-alive is correct here, and
  // it is the control case proving the close path is specific to rejections.
  assert.equal(result.serverClosed, false, 'a successful upload keeps the connection alive');
  assert.equal(fs.statSync(storedFile()).size, DECLARED);
  fs.rmSync(storedFile(), { force: true });
  await drain();
});

/* ==================================================== repeated abuse */

test('50 rejected requests retain no sockets, no files and no unhandled rejections', async () => {
  /*
   * Asserts an ABSOLUTE zero, not "back to the baseline".
   *
   * The baseline version of this test failed with `0 !== 1`: it captured its
   * baseline while a legitimate keep-alive socket from the preceding SUCCESSFUL
   * upload was still open, so it demanded one retained socket and got none.
   * Zero retained is both the stronger claim and the one actually wanted.
   */
  await drain();
  unhandled.length = 0;

  for (let i = 0; i < 50; i += 1) {
    const result = await rawRequest({
      headers:
        `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: video/mp4\r\n` +
        `Content-Length: ${3 * 1024 * 1024 * 1024}\r\n` +
        `Connection: keep-alive\r\n\r\n`,
      write: (sock) => sock.write(Buffer.alloc(512, 1)),
    });
    assert.equal(result.serverClosed, true, `request ${i} was not closed by the server`);
  }

  const remaining = await drain();
  assert.equal(remaining, 0, `no socket may be retained after 50 rejections, saw ${remaining}`);
  assert.equal(fs.existsSync(storedFile()), false, 'no partial files');
  assert.deepEqual(unhandled, [], 'no unhandled rejections');
});

test('a rejected request does not poison the next valid one', async () => {
  await drain();
  await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Length: ${3 * 1024 * 1024 * 1024}\r\n\r\n`,
    write: (sock) => sock.write(Buffer.alloc(256, 1)),
  });

  const ok = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: video/mp4\r\n` +
      `Content-Length: ${DECLARED}\r\n\r\n`,
    write: (sock) => sock.write(Buffer.alloc(DECLARED, 4)),
  });

  assert.match(statusLine(ok), /^HTTP\/1\.1 200 /, statusLine(ok));
  assert.equal(fs.statSync(storedFile()).size, DECLARED);
  fs.rmSync(storedFile(), { force: true });
  await drain();
});

/* ============================================ the RST race (regression) */

test('a rejection inside the drain window delivers its reason (best-effort)', async () => {
  /*
   * The regression this pins down.
   *
   * TCP sends RST instead of FIN whenever a socket is closed with unread data
   * still in its receive queue, and an RST discards response bytes the peer has
   * not read yet. Closing immediately after writing the 4xx therefore lost the
   * response about one run in a hundred: the uploader saw ECONNRESET instead of
   * SIZE_MISMATCH, losing the only signal that says what was wrong.
   *
   * The bounded drain in sendJsonAndClose clears the receive queue first, so a
   * normally-paced client always reads its reason. Repeated because the original
   * failure was intermittent.
   */
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const result = await rawRequest({
      headers:
        `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: video/mp4\r\n` +
        `Content-Length: ${3 * 1024 * 1024 * 1024}\r\n\r\n`,
      write: (sock) => {
        const chunk = Buffer.alloc(16 * 1024, 9);
        let sent = 0;
        const pump = () => {
          // Stay INSIDE the 256 KiB bounded-drain cap. Within that budget the
          // server can clear its receive queue and close with FIN rather than
          // RST, so the reason gets through. Best-effort within this window;
          // termination remains the invariant for a flooding peer.
          if (sock.destroyed || sent >= 160 * 1024) return;
          sent += chunk.length;
          sock.write(chunk);
          setTimeout(pump, 5);
        };
        pump();
      },
    });

    assert.notEqual(result.response, '', `attempt ${attempt}: the reason was lost to an RST`);
    assert.match(statusLine(result), /^HTTP\/1\.1 413 /, `attempt ${attempt}: ${statusLine(result)}`);
    assert.match(bodyOf(result), /TOO_LARGE/, `attempt ${attempt}: body was "${bodyOf(result)}"`);
    assert.equal(result.serverClosed, true, `attempt ${attempt}: the server must close`);
  }

  await drain();
  assert.equal(fs.existsSync(storedFile()), false, 'no partial object may survive');
});

test('a socket-saturating flood is still terminated, and stores nothing', async () => {
  /*
   * The honest limit of the guarantee above.
   *
   * A client that saturates the socket keeps the receive queue permanently
   * non-empty, so the close cannot be graceful and the response MAY be lost to
   * an RST. That is deliberate: the alternative is reading the body without
   * bound, which is exactly the free-upload sink this whole path refuses to be.
   *
   * So the contract asserted here is the one that always holds - the server
   * tears the connection down, retains no socket, and stores nothing. If a
   * response does arrive it must still be the correct one.
   */
  const before = await drain();

  const result = await rawRequest({
    headers:
      `PUT /api/uploads/put?token=${encodeURIComponent(token())} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Content-Type: video/mp4\r\n` +
      `Content-Length: ${3 * 1024 * 1024 * 1024}\r\n\r\n`,
    write: (sock) => {
      const chunk = Buffer.alloc(64 * 1024, 9);
      let sent = 0;
      const pump = () => {
        while (!sock.destroyed && sent < 24 * 1024 * 1024) {
          sent += chunk.length;
          if (!sock.write(chunk)) return; // resume on drain
        }
      };
      sock.on('drain', pump);
      pump();
    },
  });

  assert.equal(result.serverClosed, true, 'the server must tear the connection down');
  if (result.response !== '') {
    assert.match(statusLine(result), /^HTTP\/1\.1 4\d\d /, statusLine(result));
  }

  assert.equal(await drain(), before, 'no socket may be retained');
  assert.equal(fs.existsSync(storedFile()), false, 'no partial object may survive');
});
