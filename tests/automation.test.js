// Browser and input (mouse/keyboard) automation are the two capabilities
// that can take real, hard-to-undo actions on the user's behalf. Neither is
// exercised against the real OS/browser here (that needs a live Windows
// desktop / Playwright browser, which CI doesn't have) — instead these
// tests cover the guard every call passes through before it would ever
// reach the OS: off by default, toggleable at runtime without a restart,
// and rejected outright while disabled regardless of what args are passed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const automationGuard = require('../utils/automationGuard');
const inputControl = require('../utils/inputControl');
const {
  inputMoveRequest, inputClickRequest, inputTypeRequest, inputKeyRequest,
  browserNavigateRequest, browserSelectorRequest,
} = require('../schemas');

test('automationGuard: input and browser are off by default in a test environment', () => {
  assert.equal(automationGuard.isEnabled('input'), false);
  assert.equal(automationGuard.isEnabled('browser'), false);
});

test('automationGuard: throws on an unknown capability rather than silently allowing it', () => {
  assert.throws(() => automationGuard.isEnabled('nonexistent'), /Unknown automation capability/);
  assert.throws(() => automationGuard.setEnabled('nonexistent', true), /Unknown automation capability/);
});

test('automationGuard: setEnabled flips the switch at runtime, no restart needed', () => {
  assert.equal(automationGuard.setEnabled('browser', true), true);
  assert.equal(automationGuard.isEnabled('browser'), true);
  assert.equal(automationGuard.setEnabled('browser', false), false);
  assert.equal(automationGuard.isEnabled('browser'), false);
});

test('automationGuard: status() reports both capabilities independently', () => {
  automationGuard.setEnabled('input', true);
  try {
    const status = automationGuard.status();
    assert.equal(status.input, true);
    assert.equal(status.browser, false);
  } finally {
    automationGuard.setEnabled('input', false);
  }
});

test('inputControl: every mouse/keyboard action is rejected while automation is disabled', async () => {
  automationGuard.setEnabled('input', false);
  const move = await inputControl.moveMouse(10, 10);
  const click = await inputControl.click({ x: 10, y: 10 });
  const type = await inputControl.typeText('hello');
  const keys = await inputControl.pressKeys('^c');
  const clipRead = await inputControl.clipboardRead();
  const clipWrite = await inputControl.clipboardWrite('secret');
  for (const result of [move, click, type, keys, clipRead, clipWrite]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled|Windows/); // disabled message, or "Windows only" on a non-win32 test runner
  }
});

// --- Schema-level safety: args are validated before they ever reach the
// automation layer, regardless of whether the capability is armed. ---

test('inputMoveRequest: rejects wildly out-of-range coordinates', () => {
  assert.throws(() => inputMoveRequest.parse({ x: 999999, y: 0 }));
});

test('inputMoveRequest: accepts ordinary screen coordinates', () => {
  const parsed = inputMoveRequest.parse({ x: 500, y: 300 });
  assert.equal(parsed.x, 500);
  assert.equal(parsed.y, 300);
});

test('inputClickRequest: rejects a button value outside left/right/middle', () => {
  assert.throws(() => inputClickRequest.parse({ button: 'super-click' }));
});

test('inputTypeRequest: rejects an empty string (nothing to type)', () => {
  assert.throws(() => inputTypeRequest.parse({ text: '' }));
});

test('inputKeyRequest: rejects an empty key combo', () => {
  assert.throws(() => inputKeyRequest.parse({ keys: '' }));
});

test('browserNavigateRequest: rejects an empty URL', () => {
  assert.throws(() => browserNavigateRequest.parse({ url: '' }));
});

test('browserNavigateRequest: accepts an http(s) URL string', () => {
  const parsed = browserNavigateRequest.parse({ url: 'https://example.com' });
  assert.equal(parsed.url, 'https://example.com');
});

test('browserSelectorRequest: rejects an empty CSS selector', () => {
  assert.throws(() => browserSelectorRequest.parse({ selector: '' }));
});
