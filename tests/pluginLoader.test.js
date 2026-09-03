// Covers the plugin permission system: manifest validation
// (utils/pluginLoader.js's manifestSchema), the built-in-name collision
// guard, and — the important safety property — that a plugin declaring
// permission:"dangerous" cannot actually run until BOTH ENABLE_PLUGINS and
// ENABLE_PLUGIN_DANGEROUS_ACTIONS are true, while a "read" plugin in the
// same load only needs ENABLE_PLUGINS.
//
// Uses small fixture plugin folders under tests/fixtures/plugins/ rather
// than the real plugins/ directory, via loadPlugins(pluginsDir) accepting
// an override — see utils/pluginLoader.js.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pluginLoader = require('../utils/pluginLoader');
const { runTool, TOOLS } = require('../utils/toolRegistry');
const permissions = require('../utils/permissions');

const FIXTURES = path.join(__dirname, 'fixtures', 'plugins');
const DANGEROUS_ONLY = path.join(FIXTURES, 'dangerous-only');
const MIXED = path.join(FIXTURES, 'mixed');
const INVALID = path.join(FIXTURES, 'invalid');

let originalEnablePlugins;
let originalEnableDangerous;

before(() => {
  originalEnablePlugins = process.env.ENABLE_PLUGINS;
  originalEnableDangerous = process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS;
});

after(() => {
  // Restore the real plugins/ directory state so later tests (or a repeated
  // run) aren't left pointed at fixture data.
  process.env.ENABLE_PLUGINS = originalEnablePlugins;
  process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS = originalEnableDangerous;
  pluginLoader.loadPlugins();
});

beforeEach(() => {
  process.env.ENABLE_PLUGINS = 'false';
  process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS = 'false';
  permissions.setCapabilityEnabled('pluginDangerous', false);
  pluginLoader.loadPlugins(); // clears any previously-loaded plugin tools
});

test('manifestSchema: rejects a name that is not "namespace.action" shaped', () => {
  const result = pluginLoader.manifestSchema.safeParse({ name: 'Not A Valid Name', description: 'x'.repeat(15) });
  assert.equal(result.success, false);
});

test('manifestSchema: rejects a permission outside read/standard/dangerous', () => {
  const result = pluginLoader.manifestSchema.safeParse({ name: 'test.thing', description: 'x'.repeat(15), permission: 'god-mode' });
  assert.equal(result.success, false);
});

test('manifestSchema: defaults permission to "standard" and entry to "index.js"', () => {
  const parsed = pluginLoader.manifestSchema.parse({ name: 'test.thing', description: 'a fixture description over ten chars' });
  assert.equal(parsed.permission, 'standard');
  assert.equal(parsed.entry, 'index.js');
});

test('loadPlugins: does nothing while ENABLE_PLUGINS is not "true", even pointed at valid fixtures', () => {
  process.env.ENABLE_PLUGINS = 'false';
  const loaded = pluginLoader.loadPlugins(MIXED);
  assert.deepEqual(loaded, []);
  assert.equal(pluginLoader.loadedPlugins().length, 0);
});

test('loadPlugins: a bad manifest name and a missing entry file both fail to load with a reason, and never crash the loader', () => {
  process.env.ENABLE_PLUGINS = 'true';
  const loaded = pluginLoader.loadPlugins(INVALID);
  assert.equal(loaded.length, 2);
  assert.ok(loaded.every((p) => p.ok === false));
  assert.ok(loaded.some((p) => /Invalid plugin\.json/.test(p.error)));
  assert.ok(loaded.some((p) => /not found/.test(p.error)));
});

test('loadPlugins: a plugin cannot register a name that collides with a built-in tool', () => {
  const builtInName = Object.keys(TOOLS)[0];
  assert.ok(builtInName, 'expected at least one built-in tool to exist for this test');
  // Reuse the read-tool fixture's shape but confirm the collision guard
  // itself (registerTool) throws for any name already in TOOLS — this is
  // exercised directly since building a whole fixture folder named exactly
  // like a built-in would be brittle as TOOLS evolves.
  const { registerTool } = require('../utils/toolRegistry');
  assert.throws(() => registerTool(builtInName, { describe: 'x', execute: async () => ({ ok: true }) }), /built-in tool/);
});

test('loadPlugins + runTool: a "read" plugin runs as soon as ENABLE_PLUGINS is true', async () => {
  process.env.ENABLE_PLUGINS = 'true';
  pluginLoader.loadPlugins(MIXED);
  const loaded = pluginLoader.loadedPlugins();
  assert.ok(loaded.some((p) => p.name === 'test.readonly'));

  const result = await runTool('test.readonly', {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.read, true);
});

test('loadPlugins + runTool: a "dangerous" plugin is loaded but BLOCKED from running while ENABLE_PLUGIN_DANGEROUS_ACTIONS is false', async () => {
  process.env.ENABLE_PLUGINS = 'true';
  process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS = 'false';
  permissions.setCapabilityEnabled('pluginDangerous', false);
  pluginLoader.loadPlugins(DANGEROUS_ONLY);
  const loaded = pluginLoader.loadedPlugins();
  assert.ok(loaded.some((p) => p.name === 'test.dangerous'), 'the dangerous plugin should still LOAD (be registered)');

  const result = await runTool('test.dangerous', {}, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /dangerous/i);
});

test('loadPlugins + runTool: the same dangerous plugin runs once BOTH gates are armed', async () => {
  process.env.ENABLE_PLUGINS = 'true';
  process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS = 'true';
  permissions.setCapabilityEnabled('pluginDangerous', true);
  try {
    pluginLoader.loadPlugins(DANGEROUS_ONLY);
    const result = await runTool('test.dangerous', {}, {});
    assert.equal(result.ok, true);
    assert.equal(result.didSomethingDangerous, true);
  } finally {
    permissions.setCapabilityEnabled('pluginDangerous', false);
  }
});

test('reloadPlugins: re-scanning clears tools from a previous load that are no longer present', async () => {
  process.env.ENABLE_PLUGINS = 'true';
  pluginLoader.loadPlugins(MIXED);
  assert.ok(pluginLoader.loadedPlugins().some((p) => p.name === 'test.readonly'));

  pluginLoader.reloadPlugins(DANGEROUS_ONLY);
  const afterReload = pluginLoader.loadedPlugins();
  assert.ok(!afterReload.some((p) => p.name === 'test.readonly'), 'stale plugin tool should be gone after reload');
  assert.ok(afterReload.some((p) => p.name === 'test.dangerous'));
});
