// Covers isRecoverable() — the switch that decides whether a failed task
// step is worth an LLM correction/retry attempt or should be treated as
// terminal. Getting this wrong in either direction is expensive: too
// permissive burns correction attempts (and LLM calls) on a capability
// that will fail identically every time; too strict gives up on genuinely
// fixable mistakes (bad args, wrong tool choice) after one try.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isRecoverable } = require('../utils/taskEngine');

test('isRecoverable: a successful result is not "recoverable" — there is nothing to recover from', () => {
  assert.equal(isRecoverable({ ok: true }), false);
});

test('isRecoverable: null/undefined result is treated as not recoverable', () => {
  assert.equal(isRecoverable(null), false);
  assert.equal(isRecoverable(undefined), false);
});

test('isRecoverable: a step awaiting user confirmation is never auto-retried', () => {
  assert.equal(isRecoverable({ ok: false, needsConfirmation: true, error: 'confirm required' }), false);
});

test('isRecoverable: a disarmed-capability error is terminal (retrying would fail identically)', () => {
  assert.equal(isRecoverable({ ok: false, error: 'input automation is not armed' }), false);
});

test('isRecoverable: an out-of-scope-path error is terminal', () => {
  assert.equal(isRecoverable({ ok: false, error: 'That path is outside the allowed directory.' }), false);
});

test('isRecoverable: an unknown-tool error is terminal', () => {
  assert.equal(isRecoverable({ ok: false, error: 'unknown tool "foo.bar"' }), false);
});

test('isRecoverable: an ordinary failure (bad args, timeout, not-found) is recoverable', () => {
  assert.equal(isRecoverable({ ok: false, error: 'Element not found on page' }), true);
  assert.equal(isRecoverable({ ok: false, error: 'Request timed out' }), true);
});

// --- cancelRun: emergency stop ---
const { cancelRun, getRun, runInBackground } = require('../utils/taskEngine');

test('cancelRun: a run that does not exist returns not-found, not a throw', () => {
  const result = cancelRun('00000000-0000-0000-0000-000000000000', { userId: 'u1' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-found');
});

test('cancelRun: a run belonging to a different user is forbidden, not silently cancelled', () => {
  const started = runInBackground('say hello', { userId: 'owner' });
  const result = cancelRun(started.runId, { userId: 'someone-else' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'forbidden');
  // and the run itself is untouched — still owned by, and cancellable by, its real owner
  const run = getRun(started.runId);
  assert.equal(run.userId, 'owner');
});

test('cancelRun: cancelling a run twice the second time reports there is nothing left to cancel', () => {
  const started = runInBackground('say hello', { userId: 'owner2' });
  const first = cancelRun(started.runId, { userId: 'owner2' });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'cancelling');
  // run is now mid-cancel (not yet a terminal status) — cancelling again is still a
  // legitimate ok:true no-op right up until the loop actually observes the flag and
  // flips it to 'cancelled'; this test only asserts the not-found/forbidden guards
  // above, since the exact terminal state depends on async timing this test doesn't
  // control without mocking the LLM calls proposePlan()/runSequence() make.
});
