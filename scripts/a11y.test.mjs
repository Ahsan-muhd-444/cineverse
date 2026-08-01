/**
 * Unit tests for the shared accessibility helpers (src/lib/a11y.ts).
 *
 * Scope, stated honestly: this repository has no DOM test environment, so these
 * cover the pure decisions — which key dismisses an overlay, and what an
 * icon/colour-only control is actually called. Focus restoration and live
 * regions are behavioural and are listed in the manual checklist instead.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/a11y.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { isDismissKey, describeReaction, describeConnection } = await import('../src/lib/a11y.ts');

/* ---------------- Escape handling ---------------- */

test('a plain Escape dismisses an overlay', () => {
  assert.equal(isDismissKey({ key: 'Escape' }), true);
});

test('no other key dismisses anything', () => {
  for (const key of ['Enter', 'Esc', 'escape', ' ', 'Tab', 'f', 'F']) {
    assert.equal(isDismissKey({ key }), false, `${key} must not close overlays`);
  }
});

test('a MODIFIED Escape belongs to the browser, not to us', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(isDismissKey({ key: 'Escape', [modifier]: true }), false, modifier);
  }
});

test('an Escape something else already handled is not handled twice', () => {
  // Otherwise one press closes the emoji picker AND the dialog behind it.
  assert.equal(isDismissKey({ key: 'Escape', defaultPrevented: true }), false);
});

/* ---------------- names for icon- and colour-only controls ---------------- */

test('a reaction pill says what the number means, and pluralises', () => {
  assert.match(describeReaction('😂', 1), /1 reaction\b/);
  assert.match(describeReaction('😂', 3), /3 reactions/);
  assert.match(describeReaction('😂', 3), /toggle/, 'and says what pressing it does');
});

test('a reaction count is never announced as a fraction or a negative', () => {
  assert.match(describeReaction('🔥', 2.7), /2 reactions/);
  assert.match(describeReaction('🔥', -4), /0 reactions/);
});

test('connection state is carried by words, never by colour alone', () => {
  const seen = new Set();
  for (const quality of ['excellent', 'good', 'fair', 'poor', 'offline']) {
    const described = describeConnection(quality, 120);
    assert.ok(described.length > 0, quality);
    seen.add(described);
  }
  assert.equal(seen.size, 5, 'every state reads differently');
});

test('offline is described as recovering, not as a latency reading', () => {
  const offline = describeConnection('offline', 0);
  assert.match(offline, /reconnecting/i);
  assert.equal(/millisecond/.test(offline), false, 'there is no latency when there is no link');
});

test('latency is announced in full words, not as a bare number', () => {
  assert.match(describeConnection('good', 87), /87 milliseconds/);
  assert.equal(/millisecond/.test(describeConnection('good', 0)), false, 'omitted when unknown');
});
