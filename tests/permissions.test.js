// Covers utils/permissions.js — the centralized privileged-action layer
// every tool (built-in, plugin, terminal) is meant to route its "am I
// allowed to run right now" check through.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const permissions = require('../utils/permissions');

test('capabilityStatus: starts with every capability off in a test environment', () => {
  const status = permissions.capabilityStatus();
  assert.equal(status.input, false);
  assert.equal(status.browser, false);
  assert.equal(status.terminal, false);
  assert.equal(status.pluginDangerous, false);
});

test('isCapabilityEnabled: throws on an unknown capability name', () => {
  assert.throws(() => permissions.isCapabilityEnabled('nonexistent'), /Unknown capability/);
});

test('setCapabilityEnabled: throws on an unknown capability name', () => {
  assert.throws(() => permissions.setCapabilityEnabled('nonexistent', true), /Unknown capability/);
});

test('setCapabilityEnabled: flips the runtime state and keeps process.env in sync', () => {
  assert.equal(permissions.setCapabilityEnabled('input', true), true);
  assert.equal(permissions.isCapabilityEnabled('input'), true);
  assert.equal(process.env.ENABLE_INPUT_AUTOMATION, 'true');

  assert.equal(permissions.setCapabilityEnabled('input', false), false);
  assert.equal(permissions.isCapabilityEnabled('input'), false);
  assert.equal(process.env.ENABLE_INPUT_AUTOMATION, 'false');
});

test('validatePermissionMeta: rejects an invalid permission level', () => {
  assert.throws(() => permissions.validatePermissionMeta({ permission: 'super-admin' }), /Invalid permission/);
});

test('validatePermissionMeta: rejects an unknown requiresCapability', () => {
  assert.throws(
    () => permissions.validatePermissionMeta({ permission: 'standard', requiresCapability: 'nope' }),
    /Invalid requiresCapability/,
  );
});

test('validatePermissionMeta: defaults permission to "standard" and requiresCapability to null', () => {
  const meta = permissions.validatePermissionMeta({});
  assert.equal(meta.permission, 'standard');
  assert.equal(meta.requiresCapability, null);
});

test('authorize: a read tool with no capability requirement is always allowed', () => {
  const result = permissions.authorize('calc.evaluate', { permission: 'read', requiresCapability: null });
  assert.equal(result.allowed, true);
});

test('authorize: a standard tool gated on a disabled capability is blocked with a clear reason', () => {
  permissions.setCapabilityEnabled('browser', false);
  const result = permissions.authorize('browser.navigate', { permission: 'standard', requiresCapability: 'browser' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /browser/);
  assert.match(result.reason, /ENABLE_BROWSER_AUTOMATION/);
});

test('authorize: the same tool is allowed once its capability is armed', () => {
  permissions.setCapabilityEnabled('browser', true);
  try {
    const result = permissions.authorize('browser.navigate', { permission: 'standard', requiresCapability: 'browser' });
    assert.equal(result.allowed, true);
  } finally {
    permissions.setCapabilityEnabled('browser', false); // reset for other tests
  }
});

test('authorize: a dangerous tool with no capability gate is allowed but flagged with a note for the caller', () => {
  const result = permissions.authorize('system.power', { permission: 'dangerous', requiresCapability: null });
  assert.equal(result.allowed, true);
  assert.match(result.note, /confirmation/);
});

test('authorize: a dangerous tool gated on a capability is blocked the same way a standard one is', () => {
  permissions.setCapabilityEnabled('terminal', false);
  const result = permissions.authorize('terminal.run', { permission: 'dangerous', requiresCapability: 'terminal' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /terminal/);
});

test('authorize: throws if given an invalid permission declaration rather than silently allowing it', () => {
  assert.throws(() => permissions.authorize('mystery.tool', { permission: 'god-mode' }));
});
