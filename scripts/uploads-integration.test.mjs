/**
 * The server ↔ upload-contract integration.
 *
 * The handlers were extracted from server.js into server/uploads-contract.js so
 * that (a) the readiness descriptor is a real object rather than a boolean literal
 * and (b) the registration is BEHAVIOURALLY provable — see the socket.on spy
 * below, which is the primary proof, not source text. The source-text checks that
 * remain are secondary guards against the extracted handlers re-growing inline
 * logic; they read uploads-contract.js, which is where the handlers now live.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-integration.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const CONTRACT = fs.readFileSync(path.join(ROOT, 'server', 'uploads-contract.js'), 'utf8');

/** One handler body from the contract module, so assertions are scoped to it. */
function handlerBody(event, nextEvent) {
  const start = CONTRACT.indexOf(`socket.on('${event}'`);
  assert.notEqual(start, -1, `${event} handler not found`);
  const end = nextEvent ? CONTRACT.indexOf(`socket.on('${nextEvent}'`, start) : CONTRACT.length;
  return CONTRACT.slice(start, end === -1 ? CONTRACT.length : end);
}

/* ============================================ behavioural: registration ===== */

test('registerUploadSocketHandlers attaches EXACTLY the descriptor events', () => {
  // The proof that `UPLOAD_CONTRACT.events` is truthful, not a hopeful literal:
  // spy on socket.on and compare what actually gets registered.
  const { registerUploadSocketHandlers, UPLOAD_CONTRACT } = require('../server/uploads-contract.js');
  const registered = [];
  const socket = { on: (event) => registered.push(event) };
  const returned = registerUploadSocketHandlers(socket, stubDeps());

  assert.deepEqual(registered.slice().sort(), [...UPLOAD_CONTRACT.events].sort());
  assert.equal(returned, UPLOAD_CONTRACT, 'the registrar returns the descriptor it mounted');
  assert.equal(UPLOAD_CONTRACT.mounted, true);
  assert.ok(Object.isFrozen(UPLOAD_CONTRACT), 'the descriptor is frozen');
});

test('a descriptor missing an event makes multipart readiness false', () => {
  const { deriveMultipartReadiness, REQUIRED_CONTRACT_EVENTS } = require('../server/uploads-multipart.js');
  const storage = fullMultipartStorage();
  const base = { objectStorage: true, secretStrong: true, storage };

  // A COMPLETE contract enables it…
  assert.equal(
    deriveMultipartReadiness({ ...base, contract: { mounted: true, events: [...REQUIRED_CONTRACT_EVENTS] } }).enabled,
    true,
  );
  // …dropping any single event disables it, with a reason naming the gap.
  for (const drop of REQUIRED_CONTRACT_EVENTS) {
    const events = REQUIRED_CONTRACT_EVENTS.filter((e) => e !== drop);
    const readiness = deriveMultipartReadiness({ ...base, contract: { mounted: true, events } });
    assert.equal(readiness.enabled, false, drop);
    assert.match(readiness.reason, new RegExp(drop.replace(/[:]/g, '\\:')), drop);
  }
  // An unmounted descriptor also disables it.
  assert.equal(deriveMultipartReadiness({ ...base, contract: { mounted: false, events: [] } }).enabled, false);
  assert.equal(deriveMultipartReadiness({ ...base, contract: undefined }).enabled, false);
});

test('the descriptor and the readiness requirement list are the same set', () => {
  const { UPLOAD_CONTRACT, UPLOAD_EVENTS } = require('../server/uploads-contract.js');
  const { REQUIRED_CONTRACT_EVENTS } = require('../server/uploads-multipart.js');
  assert.deepEqual([...UPLOAD_CONTRACT.events].sort(), [...REQUIRED_CONTRACT_EVENTS].sort());
  assert.deepEqual([...UPLOAD_EVENTS].sort(), [...REQUIRED_CONTRACT_EVENTS].sort());
});

/* ============================================ wiring in server.js =========== */

test('server.js mounts the contract and derives readiness from its descriptor', () => {
  assert.match(SERVER, /require\('\.\/server\/uploads-contract'\)/, 'the contract module must be required');
  assert.match(SERVER, /registerUploadSocketHandlers\(socket, \{/, 'the registrar must be called per socket');
  // The free-standing boolean literal is gone; readiness derives from the frozen
  // descriptor the same file mounts.
  assert.doesNotMatch(SERVER, /contractMounted: true/, 'the boolean literal must be gone');
  assert.match(SERVER, /contract: UPLOAD_CONTRACT/, 'readiness must be derived from the mounted descriptor');
});

test('uploadConfig is derived exactly once, at module scope', () => {
  const matches = SERVER.match(/createUploadRuntimeConfig\(/g) || [];
  assert.equal(matches.length, 1, `expected one derivation, found ${matches.length}`);
  // The runtime config is derived once and FROZEN at module scope, with the
  // deployment upload-availability switch folded onto the same object.
  assert.match(SERVER, /const uploadConfig = Object\.freeze\(\{/, 'uploadConfig is frozen at module scope');
  assert.match(SERVER, /createUploadRuntimeConfig\(process\.env, \{[\s\S]*?\bstorage,[\s\S]*?\}\)\.config,/, 'derived from the runtime config');
  assert.match(SERVER, /uploadsEnabled: uploadAvailability\.enabled/, 'the deployment availability switch is folded in');
});

test('server.js passes the authenticated context into the registrar, not the payload', () => {
  const start = SERVER.indexOf('registerUploadSocketHandlers(socket, {');
  const body = SERVER.slice(start, start + 900);
  for (const dep of ['io', 'storage', 'sessions: uploadSessions', 'memberContext', 'limitMember', 'createUploadIntent']) {
    assert.ok(body.includes(dep), `the registrar must receive ${dep}`);
  }
});

/* ============================================ handlers delegate ============== */

test('every handler requires membership, rate-limits, and delegates to a service', () => {
  for (const [event, next, fn] of [
    ['upload:intent', 'upload:part-targets', 'createUploadIntent'],
    ['upload:part-targets', 'upload:status', 'requestPartTargets'],
    ['upload:status', 'upload:renew', 'readUploadStatus'],
    ['upload:renew', 'upload:complete', 'renewUploadSession'],
    ['upload:abort', 'upload:room-progress', 'abortMultipartUpload'],
    ['upload:room-progress', null, 'buildRoomProgress'],
  ]) {
    const body = handlerBody(event, next);
    assert.match(body, new RegExp(`${fn}\\(`), `${event} must call ${fn}`);
    assert.match(body, /memberContext\(socket\)/, `${event} must require membership`);
    assert.match(body, /limitMember\(ctx, POLICY\./, `${event} must be rate limited`);
    assert.doesNotMatch(body, /roomCode: payload\.|memberId: payload\./, `${event} must not trust client identity`);
  }
});

test('the extracted modules do no authorization plumbing of their own', () => {
  for (const rel of ['server/uploads-multipart-service.js', 'server/uploads-intent.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /memberContext|limitMember|POLICY\./, `${rel} must not do auth plumbing`);
  }
});

/* ============================================ the legacy path is gone ======== */

test('the legacy inline intent path does not return', () => {
  const body = handlerBody('upload:intent', 'upload:part-targets');
  assert.doesNotMatch(body, /validateUploadIntent\(/, 'metadata validation belongs to the service');
  assert.doesNotMatch(body, /buildObjectKey\(/, 'key minting belongs to the service');
  assert.doesNotMatch(body, /issueUploadToken\(/, 'token minting belongs to the service');
  assert.doesNotMatch(body, /createUploadTarget\(/, 'target creation belongs to the service');
  assert.doesNotMatch(body, /selectUploadMode\(/, 'transport selection belongs to the service');
});

test('the deployment-wide maxUploadBytes flow is gone', () => {
  assert.doesNotMatch(SERVER, /maxUploadBytes\(\)/, 'the legacy env-reading helper must be gone');
  const uploads = fs.readFileSync(path.join(ROOT, 'server', 'uploads.js'), 'utf8');
  assert.doesNotMatch(uploads, /function maxUploadBytes/, 'uploads.js must not parse MAX_UPLOAD_BYTES');
});

/* ============================================ completion dispatch =========== */

test('multipart completion is dispatched EXPLICITLY, never inferred', () => {
  const body = handlerBody('upload:complete', 'upload:abort');
  assert.match(body, /payload\.mode === 'multipart'/, 'the mode must be checked explicitly');
  assert.match(body, /completeMultipartUpload\(\{/, 'multipart completion must go through the service');
  assert.ok(
    body.indexOf("payload.mode === 'multipart'") < body.indexOf('verifyUploadToken('),
    'the multipart branch must precede single-shot verification',
  );
  // Progress is cleared on the CLASSIFICATION, not on ok alone.
  assert.match(body, /result\.ok \|\| result\.terminal/, 'the bar must clear on a terminal failure too');
});

test('single-shot completion verifies the v2 token, enforces the room, forwards claims', () => {
  const body = handlerBody('upload:complete', 'upload:abort');
  assert.match(body, /verifyUploadToken\(payload\.token, secret\)/);
  assert.match(body, /BAD_TOKEN/);
  assert.match(body, /claims\.roomCode !== room\.code/);
  assert.match(body, /WRONG_ROOM/);
  assert.match(body, /finalizeUpload\(\{ storage, claims, label: payload\.label, clean \}\)/);
  assert.doesNotMatch(body, /finalizeUpload\(\{[^}]*\.\.\.claims/, 'claims must not be rebuilt');
});

/* ============================================ the service still works ======== */

test('the extracted intent service is importable and returns an ack payload', async () => {
  const { createUploadIntent } = require('../server/uploads-intent.js');
  const { createUploadRuntimeConfig } = require('../server/uploads-multipart.js');

  const calls = [];
  const storage = {
    async createUploadTarget(grant) {
      calls.push(grant);
      return { method: 'POST', url: 'https://spy/u', fields: {}, direct: true };
    },
  };
  const uploadConfig = createUploadRuntimeConfig({}, { objectStorage: false }).config;
  const result = await createUploadIntent({
    payload: { fileName: 'm.mp4', mimeType: 'video/mp4', size: 1024 },
    uploadConfig,
    storage,
    secret: 'x'.repeat(32),
    roomCode: 'ABC123',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  for (const field of ['transport', 'key', 'mimeType', 'roomCode', 'expectedBytes', 'maxBytes']) {
    assert.ok(field in calls[0], `the grant must carry ${field}`);
  }
  assert.equal(calls[0].transport, 'single');
  assert.equal(calls[0].roomCode, 'ABC123');
});

/* ---------------------------------------------------------------- helpers --- */

function stubDeps() {
  const noop = () => {};
  return {
    io: { to: () => ({ emit: noop }) },
    storage: {},
    secret: 'x'.repeat(32),
    uploadConfig: {},
    sessions: {},
    POLICY: {},
    memberContext: () => null,
    limitMember: () => ({ ok: true }),
    ackWith: noop,
    rateLimitedAck: noop,
    nowMs: () => 0,
    clean: (v) => v,
    verifyUploadToken: () => null,
    finalizeUpload: async () => ({ ok: false }),
    createUploadIntent: async () => ({ ok: false }),
    publishUploadProgress: noop,
    clearUploadProgress: noop,
    progressThrottleMs: 2000,
  };
}

function fullMultipartStorage() {
  return {
    direct: true,
    multipart: true,
    createMultipartUpload() {},
    createPartUploadTarget() {},
    listMultipartParts() {},
    completeMultipartUpload() {},
    abortMultipartUpload() {},
  };
}
