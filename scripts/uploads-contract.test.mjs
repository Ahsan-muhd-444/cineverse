/**
 * The upload contract descriptor, proven BEHAVIOURALLY.
 *
 * `contractMounted: true` used to be a boolean literal readiness trusted. The
 * replacement is a frozen descriptor plus a registrar, and the only honest proof
 * that the descriptor is truthful is to spy on `socket.on` and compare what
 * actually gets attached — which is what this does, rather than reading source
 * text. Readiness is then derived from the descriptor, so dropping a handler
 * makes multipart unavailable.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UPLOAD_CONTRACT, UPLOAD_EVENTS, registerUploadSocketHandlers } = require('../server/uploads-contract.js');
const { deriveMultipartReadiness, contractIsComplete, REQUIRED_CONTRACT_EVENTS } = require('../server/uploads-multipart.js');

const noop = () => {};
function stubDeps() {
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
    createMultipartUpload: noop,
    createPartUploadTarget: noop,
    listMultipartParts: noop,
    completeMultipartUpload: noop,
    abortMultipartUpload: noop,
  };
}

/* ============================================== the descriptor is truthful */

test('the registrar attaches exactly the descriptor events, no more, no fewer', () => {
  const attached = [];
  const socket = {
    on(event) {
      // A handler must never be registered twice for the same event.
      assert.equal(attached.includes(event), false, `${event} registered twice`);
      attached.push(event);
    },
  };
  const returned = registerUploadSocketHandlers(socket, stubDeps());

  assert.deepEqual(attached.slice().sort(), [...UPLOAD_CONTRACT.events].sort());
  assert.deepEqual(attached.slice().sort(), [...UPLOAD_EVENTS].sort());
  assert.equal(returned, UPLOAD_CONTRACT);
});

test('the descriptor is frozen, versioned and mounted', () => {
  assert.equal(UPLOAD_CONTRACT.mounted, true);
  assert.equal(UPLOAD_CONTRACT.version, 1);
  assert.ok(Object.isFrozen(UPLOAD_CONTRACT));
  assert.ok(Object.isFrozen(UPLOAD_CONTRACT.events));
});

/* ============================================== completeness gate */

test('contractIsComplete requires mounted AND every required event', () => {
  assert.deepEqual(contractIsComplete({ mounted: true, events: [...REQUIRED_CONTRACT_EVENTS] }), { ok: true });
  assert.equal(contractIsComplete(UPLOAD_CONTRACT).ok, true);

  assert.equal(contractIsComplete({ mounted: false, events: [...REQUIRED_CONTRACT_EVENTS] }).ok, false);
  assert.equal(contractIsComplete(undefined).ok, false);
  assert.equal(contractIsComplete(null).ok, false);
  assert.equal(contractIsComplete({ mounted: true }).ok, false, 'no events array');

  for (const drop of REQUIRED_CONTRACT_EVENTS) {
    const events = REQUIRED_CONTRACT_EVENTS.filter((e) => e !== drop);
    const verdict = contractIsComplete({ mounted: true, events });
    assert.equal(verdict.ok, false, drop);
    assert.match(verdict.reason, new RegExp(drop.replace(':', '\\:')));
  }
});

/* ============================================== readiness derives from it */

test('multipart readiness is enabled only with a COMPLETE contract', () => {
  const storage = fullMultipartStorage();
  const base = { objectStorage: true, secretStrong: true, storage };

  assert.equal(deriveMultipartReadiness({ ...base, contract: UPLOAD_CONTRACT }).enabled, true);

  // A build that dropped a handler yields an incomplete descriptor → unavailable.
  const incomplete = { mounted: true, events: UPLOAD_CONTRACT.events.filter((e) => e !== 'upload:renew') };
  const readiness = deriveMultipartReadiness({ ...base, contract: incomplete });
  assert.equal(readiness.enabled, false);
  assert.match(readiness.reason, /upload:renew/);

  // No descriptor at all is unavailable, not a silent pass.
  assert.equal(deriveMultipartReadiness({ ...base, contract: undefined }).enabled, false);
});

test('readiness still requires storage and secret alongside the contract', () => {
  const storage = fullMultipartStorage();
  const withContract = (over) =>
    deriveMultipartReadiness({ objectStorage: true, secretStrong: true, storage, contract: UPLOAD_CONTRACT, ...over });

  assert.equal(withContract({}).enabled, true);
  assert.equal(withContract({ objectStorage: false }).enabled, false);
  assert.equal(withContract({ secretStrong: false }).enabled, false);
  assert.equal(withContract({ storage: { ...storage, listMultipartParts: undefined } }).enabled, false);
  assert.equal(withContract({ storage: { ...storage, direct: false } }).enabled, false);
});
