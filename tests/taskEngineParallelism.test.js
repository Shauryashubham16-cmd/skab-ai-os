// Covers utils/taskEngine.js's PARALLEL_SAFE_TOOLS allowlist and the
// concurrent-batch path in runSequence() that uses it. Two kinds of
// coverage:
//   1. A structural consistency check against the live tool registry — every
//      entry must be a real registered tool, and (as a guardrail against a
//      future careless addition) none may be tagged permission:'dangerous'.
//   2. A behavioral check that adjacent steps whose tools are ALL in the
//      allowlist actually run concurrently (not just "in some order"), and
//      that a batch correctly stops extending at the first non-allowlisted
//      step — using toolRegistry.runTool mocked with a real delay so
//      concurrency is observable via timing, not just call order.
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

test('PARALLEL_SAFE_TOOLS: every entry is a real, currently-registered tool', () => {
  const { PARALLEL_SAFE_TOOLS } = require('../utils/taskEngine');
  const { listTools } = require('../utils/toolRegistry');
  const registered = new Map(listTools().map((t) => [t.name, t]));
  for (const name of PARALLEL_SAFE_TOOLS) {
    assert.ok(registered.has(name), `"${name}" is in PARALLEL_SAFE_TOOLS but not registered in toolRegistry`);
  }
});

test('PARALLEL_SAFE_TOOLS: no entry is tagged permission:"dangerous" in the tool registry', () => {
  // Not a guarantee by itself (permission is about authorization, not
  // concurrency safety — see the comment above PARALLEL_SAFE_TOOLS), but a
  // dangerous-tagged tool showing up here would always be a mistake worth
  // catching automatically rather than only in review.
  const { PARALLEL_SAFE_TOOLS } = require('../utils/taskEngine');
  const { listTools } = require('../utils/toolRegistry');
  const byName = new Map(listTools().map((t) => [t.name, t]));
  for (const name of PARALLEL_SAFE_TOOLS) {
    assert.notEqual(byName.get(name)?.permission, 'dangerous', `"${name}" is dangerous and should not be parallel-safe`);
  }
});

test('PARALLEL_SAFE_TOOLS: includes the pure-read tools added for broader batching (windows.active, vision.*, browser reads, clipboard read)', () => {
  const { PARALLEL_SAFE_TOOLS } = require('../utils/taskEngine');
  for (const name of ['windows.active', 'files.searchContent', 'vision.screen', 'vision.findElement', 'vision.snapshot', 'vision.compareToSnapshot', 'browser.read', 'browser.tabs.list', 'browser.verify', 'input.clipboardRead']) {
    assert.ok(PARALLEL_SAFE_TOOLS.has(name), `expected "${name}" to be parallel-safe`);
  }
});

test('PARALLEL_SAFE_TOOLS: excludes mutating tools even when they are conceptually "check"-like (system.power, files.open, browser.navigate)', () => {
  const { PARALLEL_SAFE_TOOLS } = require('../utils/taskEngine');
  for (const name of ['system.power', 'files.open', 'browser.navigate', 'browser.download', 'apps.open', 'memory.remember', 'input.clipboardWrite']) {
    assert.equal(PARALLEL_SAFE_TOOLS.has(name), false, `"${name}" should not be parallel-safe`);
  }
});

function freshTaskEngineWithMockedRunTool(delayMs = 20) {
  delete require.cache[require.resolve('../utils/toolRegistry')];
  delete require.cache[require.resolve('../utils/taskEngine')];
  const toolRegistry = require('../utils/toolRegistry');
  const timeline = []; // { tool, event: 'start'|'end', t }
  mock.method(toolRegistry, 'runTool', async (tool) => {
    timeline.push({ tool, event: 'start', t: Date.now() });
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    timeline.push({ tool, event: 'end', t: Date.now() });
    return { ok: true, tool };
  });
  const taskEngine = require('../utils/taskEngine');
  return { taskEngine, timeline };
}

afterEach(() => {
  mock.restoreAll();
});

test('runSequence: 3 adjacent parallel-safe steps run concurrently — all start before any of them finishes', async () => {
  const { taskEngine, timeline } = freshTaskEngineWithMockedRunTool(30);
  const steps = [
    { tool: 'system.status', args: {} },
    { tool: 'calc.evaluate', args: { expression: '1+1' } },
    { tool: 'memory.recall', args: { query: 'x' } },
  ];
  const result = await taskEngine.runSequence(steps, { userId: 'u1', runId: 'r1' }, { goal: 'check things' });

  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, 3);

  const starts = timeline.filter((e) => e.event === 'start').map((e) => e.t);
  const ends = timeline.filter((e) => e.event === 'end').map((e) => e.t);
  // If these ran sequentially, the LAST start would be at/after the FIRST
  // end (each waits for the previous to fully finish). Concurrent execution
  // means every start happens before any end.
  assert.ok(Math.max(...starts) <= Math.min(...ends), `expected concurrent execution; starts=${starts} ends=${ends}`);
});

test('runSequence: a batch stops extending at the first non-parallel-safe step, which then runs on its own', async () => {
  const { taskEngine, timeline } = freshTaskEngineWithMockedRunTool(20);
  const steps = [
    { tool: 'system.status', args: {} },
    { tool: 'calc.evaluate', args: { expression: '2+2' } },
    { tool: 'apps.open', args: { app: 'notepad' } }, // NOT parallel-safe — breaks the batch
    { tool: 'memory.recall', args: { query: 'y' } },
  ];
  const result = await taskEngine.runSequence(steps, { userId: 'u1', runId: 'r2' }, { goal: 'mixed plan' });
  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.results.map((r) => r.step.tool), ['system.status', 'calc.evaluate', 'apps.open', 'memory.recall']);

  // The first two (system.status, calc.evaluate) form a concurrent batch.
  const batchStarts = timeline.filter((e) => e.event === 'start' && ['system.status', 'calc.evaluate'].includes(e.tool)).map((e) => e.t);
  const batchEnds = timeline.filter((e) => e.event === 'end' && ['system.status', 'calc.evaluate'].includes(e.tool)).map((e) => e.t);
  assert.ok(Math.max(...batchStarts) <= Math.min(...batchEnds));

  // apps.open only starts after the whole batch before it has finished.
  const appsOpenStart = timeline.find((e) => e.tool === 'apps.open' && e.event === 'start').t;
  assert.ok(appsOpenStart >= Math.max(...batchEnds));

  // memory.recall (alone, no adjacent safe step after apps.open breaks the
  // run into single steps again) only starts after apps.open finishes.
  const appsOpenEnd = timeline.find((e) => e.tool === 'apps.open' && e.event === 'end').t;
  const memoryRecallStart = timeline.find((e) => e.tool === 'memory.recall' && e.event === 'start').t;
  assert.ok(memoryRecallStart >= appsOpenEnd);
});

test('runSequence: a single parallel-safe step with no adjacent safe sibling just runs normally (batch size 1 is not treated as a batch)', async () => {
  const { taskEngine, timeline } = freshTaskEngineWithMockedRunTool(5);
  const steps = [{ tool: 'apps.open', args: { app: 'notepad' } }, { tool: 'calc.evaluate', args: { expression: '3+3' } }];
  const result = await taskEngine.runSequence(steps, { userId: 'u1', runId: 'r3' }, { goal: 'one safe step' });
  assert.equal(result.status, 'completed');
  assert.equal(timeline.filter((e) => e.tool === 'calc.evaluate').length, 2); // one start, one end — ran exactly once
});
