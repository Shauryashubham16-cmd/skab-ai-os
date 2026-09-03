// Covers the scheduling-granularity fix in utils/scheduler.js: previously
// a fixed setInterval(tick, TICK_MS) meant a job could fire up to 15s after
// its nominal due time no matter what. It's now a single self-adjusting
// setTimeout armed for exactly the soonest due job (clamped to TICK_MS as
// a ceiling for the idle case), re-armed after every fire and nudged
// immediately whenever a new job is scheduled sooner than the current
// wake-up. node:test's MockTimers give this suite exact, deterministic
// control over "how much wall-clock time passed" without any real waits or
// flakiness. scheduleStore (disk I/O) and taskEngine.runInBackground
// (actual task execution) are both mocked.
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function freshScheduler() {
  delete require.cache[require.resolve('../utils/scheduleStore')];
  delete require.cache[require.resolve('../utils/taskEngine')];
  delete require.cache[require.resolve('../utils/scheduler')];
  const scheduleStore = require('../utils/scheduleStore');
  mock.method(scheduleStore, 'saveJob', () => {});
  mock.method(scheduleStore, 'deleteJob', () => {});
  mock.method(scheduleStore, 'loadAllJobs', () => ({}));
  const taskEngine = require('../utils/taskEngine');
  const runInBackgroundCalls = [];
  mock.method(taskEngine, 'runInBackground', (goal, ctx) => {
    runInBackgroundCalls.push({ goal, ctx });
    return { status: 'queued', runId: `run-for-${goal}` };
  });
  const scheduler = require('../utils/scheduler');
  return { scheduler, runInBackgroundCalls };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test('scheduleOnce: a job due soon fires within milliseconds of its due time, not up to TICK_MS later', async () => {
  const { scheduler, runInBackgroundCalls } = freshScheduler();
  scheduler.startScheduler();
  const dueInMs = 500; // comfortably under the old 15s granularity
  scheduler.scheduleOnce('user-1', 'water the plants', Date.now() + dueInMs);

  // Advance just short of due — must not have fired yet.
  await mock.timers.tick(dueInMs - 50);
  assert.equal(runInBackgroundCalls.length, 0);

  // Advance past due — should fire now, NOT wait for a 15s poll boundary.
  await mock.timers.tick(100);
  assert.equal(runInBackgroundCalls.length, 1);
  assert.equal(runInBackgroundCalls[0].goal, 'water the plants');

  scheduler.stopScheduler();
});

test('scheduleOnce: scheduling a sooner job re-arms the timer immediately (maybeWakeSooner)', async () => {
  const { scheduler, runInBackgroundCalls } = freshScheduler();
  scheduler.startScheduler();
  // First job is far out — without maybeWakeSooner, the timer would be
  // armed for ~10s and a second, sooner job would have to wait for that.
  scheduler.scheduleOnce('user-1', 'far off task', Date.now() + 10000);
  scheduler.scheduleOnce('user-1', 'urgent task', Date.now() + 200);

  await mock.timers.tick(250);
  assert.equal(runInBackgroundCalls.length, 1);
  assert.equal(runInBackgroundCalls[0].goal, 'urgent task');

  // The far-off task still fires on its own schedule, not early.
  await mock.timers.tick(10000);
  assert.equal(runInBackgroundCalls.length, 2);
  assert.equal(runInBackgroundCalls[1].goal, 'far off task');

  scheduler.stopScheduler();
});

test('scheduleRecurring: fires on schedule and re-arms for the next interval without drifting', async () => {
  const { scheduler, runInBackgroundCalls } = freshScheduler();
  scheduler.startScheduler();
  scheduler.scheduleRecurring('user-1', 'check inbox', 60 * 1000); // MIN_INTERVAL_MS

  await mock.timers.tick(60 * 1000);
  assert.equal(runInBackgroundCalls.length, 1);

  await mock.timers.tick(60 * 1000);
  assert.equal(runInBackgroundCalls.length, 2);

  scheduler.stopScheduler();
});

test('an idle scheduler (no jobs) still wakes at most every TICK_MS and does nothing harmful', async () => {
  const { scheduler, runInBackgroundCalls } = freshScheduler();
  scheduler.startScheduler();
  await mock.timers.tick(scheduler.TICK_MS * 3);
  assert.equal(runInBackgroundCalls.length, 0);
  scheduler.stopScheduler();
});

test('stopScheduler: cancels the armed timer — nothing fires after stopping even once due', async () => {
  const { scheduler, runInBackgroundCalls } = freshScheduler();
  scheduler.startScheduler();
  scheduler.scheduleOnce('user-1', 'should not fire', Date.now() + 500);
  scheduler.stopScheduler();
  await mock.timers.tick(5000);
  assert.equal(runInBackgroundCalls.length, 0);
});

test('advanceNextRunAt: skips forward past every missed interval instead of queuing a catch-up burst', () => {
  const { scheduler } = freshScheduler();
  const everyMs = 60 * 1000;
  const job = { nextRunAt: 0, everyMs };
  // "now" is 3.5 intervals past the job's last nominal due time.
  const now = everyMs * 3.5;
  const next = scheduler.advanceNextRunAt(job, now);
  assert.equal(next, everyMs * 4); // next multiple of everyMs strictly after now
  assert.ok(next > now);
});
