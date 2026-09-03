// Terminal safety tests. The terminal spawns a real shell on the host
// machine, so these tests never actually spawn anything — they cover the
// three layers that stand in front of spawn(): the schema that shapes what
// counts as a valid command, the hardcoded block-list that applies
// regardless of configuration, and the permission declaration that ties it
// into the centralized privileged-action layer (utils/permissions.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlocked, TERMINAL_TOOL_META } = require('../utils/terminal');
const { terminalCommand } = require('../schemas');
const permissions = require('../utils/permissions');

test('TERMINAL_TOOL_META: terminal is declared dangerous and gated on the "terminal" capability', () => {
  assert.equal(TERMINAL_TOOL_META.permission, 'dangerous');
  assert.equal(TERMINAL_TOOL_META.requiresCapability, 'terminal');
});

test('authorize(): terminal execution is blocked while ENABLE_TERMINAL is off', () => {
  permissions.setCapabilityEnabled('terminal', false);
  const result = permissions.authorize('terminal.run', TERMINAL_TOOL_META);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /terminal/);
});

test('authorize(): terminal execution is allowed once ENABLE_TERMINAL is armed', () => {
  permissions.setCapabilityEnabled('terminal', true);
  try {
    const result = permissions.authorize('terminal.run', TERMINAL_TOOL_META);
    assert.equal(result.allowed, true);
  } finally {
    permissions.setCapabilityEnabled('terminal', false);
  }
});

test('isBlocked: blocks "rm -rf /" but not a scoped rm -rf on a subfolder', () => {
  assert.equal(isBlocked('rm -rf /'), true);
  assert.equal(isBlocked('rm -rf /home/user/project/node_modules'), false);
});

test('isBlocked: blocks filesystem-formatting and raw-disk-write commands', () => {
  assert.equal(isBlocked('mkfs.ext4 /dev/sda1'), true);
  assert.equal(isBlocked('dd if=/dev/zero of=/dev/sda'), true);
});

test('isBlocked: blocks a classic bash fork bomb', () => {
  assert.equal(isBlocked(':(){ :|:& };:'), true);
});

test('isBlocked: blocks shutdown, Windows registry deletion, and drive format', () => {
  assert.equal(isBlocked('shutdown /s /t 0'), true);
  assert.equal(isBlocked('reg delete HKCU\\Software\\Foo /f'), true);
  assert.equal(isBlocked('format c: /y'), true);
});

test('isBlocked: does not flag ordinary, harmless commands', () => {
  assert.equal(isBlocked('ls -la'), false);
  assert.equal(isBlocked('git status'), false);
  assert.equal(isBlocked('npm test'), false);
  assert.equal(isBlocked('echo "shut the door"'), false); // "shut" alone must not false-positive on \bshutdown\b
});

test('terminalCommand schema: rejects an empty command', () => {
  assert.throws(() => terminalCommand.parse({ command: '' }));
});

test('terminalCommand schema: rejects a missing command field', () => {
  assert.throws(() => terminalCommand.parse({}));
});

test('terminalCommand schema: accepts an ordinary command string', () => {
  const parsed = terminalCommand.parse({ command: 'echo hello' });
  assert.equal(parsed.command, 'echo hello');
});
