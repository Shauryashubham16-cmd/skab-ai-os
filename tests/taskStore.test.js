// Covers utils/taskStore.js — the durable-persistence half of the task
// engine (saveRun/loadRun/deleteRun/loadAllRuns, crash recovery via
// recoverInterruptedRuns, and pruneOlderThan). The module's own header
// comment already claimed this file existed ("tests/taskStore.test.js
// covers persistence itself") — it didn't; this fills that gap.
//
// fs is mocked with an in-memory object standing in for the file, so this
// suite never reads or writes the real data/task-runs.json.
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

function freshTaskStoreWithFakeFs() {
  delete require.cache[require.resolve('../utils/taskStore')];
  let fileContent = null; // null = "file doesn't exist" (matches a fresh boot with no prior runs)
  const isTargetFile = (filePath) => String(filePath).endsWith('task-runs.json');
  // Only intercept the ONE file taskStore.js actually touches — Node's own
  // module loader uses fs.readFileSync/existsSync internally for every
  // require() call (including the require('../utils/taskStore') below), so
  // a blanket mock that ignores the path breaks module loading itself, not
  // just this module's persistence.
  const realReadFileSync = fs.readFileSync;
  const realExistsSync = fs.existsSync;
  mock.method(fs, 'readFileSync', (filePath, ...rest) => {
    if (!isTargetFile(filePath)) return realReadFileSync(filePath, ...rest);
    if (fileContent === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return fileContent;
  });
  mock.method(fs, 'writeFileSync', (filePath, data) => {
    if (isTargetFile(filePath)) { fileContent = data; return undefined; }
    throw new Error(`unexpected writeFileSync target in test: ${filePath}`);
  });
  mock.method(fs, 'existsSync', (dirPath) => (String(dirPath).endsWith('data') ? true : realExistsSync(dirPath)));
  mock.method(fs, 'mkdirSync', () => {});
  const taskStore = require('../utils/taskStore');
  return { taskStore, getFileContent: () => fileContent };
}

afterEach(() => {
  mock.restoreAll();
});

test('saveRun + loadRun: a saved run round-trips exactly', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('run-1', { goal: 'test goal', status: 'executing', results: [], cursor: 0, userId: 'u1', createdAt: 123 });
  const loaded = taskStore.loadRun('run-1');
  assert.deepEqual(loaded, { goal: 'test goal', status: 'executing', results: [], cursor: 0, userId: 'u1', createdAt: 123 });
});

test('loadRun: a runId that was never saved returns null, not a throw', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  assert.equal(taskStore.loadRun('never-existed'), null);
});

test('saveRun: saving the same runId twice overwrites, not duplicates', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('run-1', { status: 'executing', cursor: 1 });
  taskStore.saveRun('run-1', { status: 'completed', cursor: 5 });
  assert.deepEqual(taskStore.loadRun('run-1'), { status: 'completed', cursor: 5 });
  assert.equal(Object.keys(taskStore.loadAllRuns()).length, 1);
});

test('deleteRun: removes the run; deleting an unknown runId is a harmless no-op', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('run-1', { status: 'completed' });
  taskStore.deleteRun('run-1');
  assert.equal(taskStore.loadRun('run-1'), null);
  // second delete / deleting something that was never there: must not throw
  assert.doesNotThrow(() => taskStore.deleteRun('run-1'));
  assert.doesNotThrow(() => taskStore.deleteRun('was-never-saved'));
});

test('loadAllRuns: returns every saved run keyed by runId', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('a', { status: 'completed' });
  taskStore.saveRun('b', { status: 'paused' });
  const all = taskStore.loadAllRuns();
  assert.deepEqual(Object.keys(all).sort(), ['a', 'b']);
});

test('IN_FLIGHT_STATUSES: includes every status a run can be persisted in mid-execution, including "planning"', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  for (const status of ['queued', 'planning', 'thinking', 'executing', 'observing', 'correcting', 'retrying', 'cursor-in-progress']) {
    assert.equal(taskStore.IN_FLIGHT_STATUSES.has(status), true, `expected ${status} to be in-flight`);
  }
  // 'paused' is deliberately excluded — a paused run is correctly waiting
  // on a human, not interrupted by a crash.
  assert.equal(taskStore.IN_FLIGHT_STATUSES.has('paused'), false);
  for (const status of ['completed', 'failed', 'cancelled', 'no-op', 'interrupted']) {
    assert.equal(taskStore.IN_FLIGHT_STATUSES.has(status), false, `expected ${status} to NOT be in-flight`);
  }
});

test('recoverInterruptedRuns: relabels every in-flight run "interrupted" and returns it, leaves terminal/paused runs untouched', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('mid-plan', { status: 'planning', goal: 'g1' });
  taskStore.saveRun('mid-exec', { status: 'executing', goal: 'g2', cursor: 2 });
  taskStore.saveRun('done', { status: 'completed', goal: 'g3' });
  taskStore.saveRun('waiting-on-human', { status: 'paused', goal: 'g4' });

  const recovered = taskStore.recoverInterruptedRuns();

  assert.equal(recovered.length, 2);
  const recoveredIds = recovered.map((r) => r.runId).sort();
  assert.deepEqual(recoveredIds, ['mid-exec', 'mid-plan']);
  for (const r of recovered) {
    assert.equal(r.status, 'interrupted');
    assert.ok(typeof r.interruptedAt === 'number');
  }

  // The change is also persisted, not just returned in memory.
  assert.equal(taskStore.loadRun('mid-plan').status, 'interrupted');
  assert.equal(taskStore.loadRun('mid-exec').status, 'interrupted');
  // Terminal and paused runs are completely untouched.
  assert.equal(taskStore.loadRun('done').status, 'completed');
  assert.equal(taskStore.loadRun('waiting-on-human').status, 'paused');
});

test('recoverInterruptedRuns: with nothing in-flight, returns an empty array and writes nothing', () => {
  const { taskStore, getFileContent } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('done', { status: 'completed' });
  const before = getFileContent();
  const recovered = taskStore.recoverInterruptedRuns();
  assert.deepEqual(recovered, []);
  assert.equal(getFileContent(), before); // no unnecessary write when nothing changed
});

test('recoverInterruptedRuns: with no saved runs at all (fresh boot), returns an empty array without throwing', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  assert.deepEqual(taskStore.recoverInterruptedRuns(), []);
});

test('pruneOlderThan: removes only runs older than the cutoff', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  const now = Date.now();
  taskStore.saveRun('old', { status: 'completed', createdAt: now - 100000 });
  taskStore.saveRun('recent', { status: 'completed', createdAt: now - 10 });
  taskStore.pruneOlderThan(50000);
  const all = taskStore.loadAllRuns();
  assert.deepEqual(Object.keys(all), ['recent']);
});

test('pruneOlderThan: a run with no createdAt is treated as very old (createdAt defaults to 0) and gets pruned', () => {
  const { taskStore } = freshTaskStoreWithFakeFs();
  taskStore.saveRun('no-timestamp', { status: 'completed' });
  taskStore.pruneOlderThan(1000);
  assert.equal(taskStore.loadRun('no-timestamp'), null);
});
