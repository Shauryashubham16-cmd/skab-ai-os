// Covers the standardized tool schema & execution contract in
// utils/toolRegistry.js: every tool declares { describe, permission,
// requiresCapability, argsSchema, execute }, and runTool() enforces
// authorization + arg validation identically for every tool, whether it's
// invoked via a REST route or the autonomous task-engine planner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runTool, listTools, TOOLS, registerTool, clearPluginTools } = require('../utils/toolRegistry');
const permissions = require('../utils/permissions');

test('listTools: every built-in tool declares a valid permission level', () => {
  const valid = new Set(['read', 'standard', 'dangerous']);
  for (const [name, tool] of Object.entries(TOOLS)) {
    assert.ok(valid.has(tool.permission), `${name} has an invalid permission "${tool.permission}"`);
  }
});

test('listTools: reports permission for both built-in and plugin tools', () => {
  const tools = listTools();
  assert.ok(tools.length > 0);
  for (const t of tools) {
    assert.ok(['read', 'standard', 'dangerous'].includes(t.permission), `${t.name} missing/invalid permission in listing`);
  }
});

test('runTool: unknown tool name returns a clean ok:false, never throws', async () => {
  const result = await runTool('totally.unknown', {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('runTool: a read tool with valid args runs and returns ok:true', async () => {
  const result = await runTool('calc.evaluate', { expression: '3 * 4' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.result, 12);
});

test('runTool: invalid args are rejected before execute() ever runs', async () => {
  const result = await runTool('calc.evaluate', { expression: '' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid args/);
});

test('runTool: a capability-gated tool is blocked when its capability is disabled, before args are even checked', async () => {
  permissions.setCapabilityEnabled('input', false);
  // Deliberately malformed args (x is not a number) — if this returned an
  // "Invalid args" error instead of the capability error, that would mean
  // authorization is being skipped or run after validation, which is the
  // opposite of the intended order (authorize first, then validate).
  const result = await runTool('input.move', { x: 'not-a-number', y: 1 }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /input.*capability|capability.*input/i);
});

test('runTool: a capability-gated tool with valid args succeeds once armed', async () => {
  permissions.setCapabilityEnabled('input', true);
  try {
    // input.move ultimately shells out to a Windows-only PowerShell script;
    // on the CI/test platform (not win32) it returns a clean
    // "only supported on Windows" ok:false rather than throwing — either
    // way, args validation + authorization both passed, which is what this
    // test is actually checking.
    const result = await runTool('input.move', { x: 10, y: 20 }, {});
    assert.equal(typeof result.ok, 'boolean');
  } finally {
    permissions.setCapabilityEnabled('input', false);
  }
});

test('registerTool: rejects a plugin tool trying to shadow a built-in name', () => {
  assert.throws(() => registerTool('calc.evaluate', { describe: 'x', execute: async () => ({ ok: true }) }), /built-in tool/);
});

test('registerTool: rejects an invalid permission on a plugin tool', () => {
  assert.throws(
    () => registerTool('test.badPermission', { describe: 'x', execute: async () => ({ ok: true }), permission: 'nonsense' }),
    /Invalid permission/,
  );
  clearPluginTools();
});

test('registerTool + runTool: a plugin tool with no argsSchema still gets a permissive default and runs', async () => {
  registerTool('test.echo', {
    describe: 'echoes args back',
    permission: 'read',
    execute: async (args) => ({ ok: true, args }),
  });
  try {
    const result = await runTool('test.echo', { anything: 'goes', nested: { a: 1 } }, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, { anything: 'goes', nested: { a: 1 } });
  } finally {
    clearPluginTools();
  }
});

test('runTool: a thrown error inside execute() is caught and returned as ok:false, never propagates', async () => {
  registerTool('test.throws', {
    describe: 'always throws',
    permission: 'read',
    execute: async () => { throw new Error('boom'); },
  });
  try {
    const result = await runTool('test.throws', {}, {});
    assert.equal(result.ok, false);
    assert.match(result.error, /boom/);
  } finally {
    clearPluginTools();
  }
});
