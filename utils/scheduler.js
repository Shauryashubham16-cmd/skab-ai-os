// Scheduled + recurring goals, on top of taskEngine.runInBackground.
//
// A goal can be scheduled to run once at a future time, or on a fixed
// interval starting now or at a future time. Both are just "call
// taskEngine.runInBackground(goal, ctx) when it's due" — there's no cron
// syntax parser here (no new dependency, and a personal desktop assistant
// has no need for one); "every X minutes/hours" covers the realistic case,
// and an ISO timestamp covers "remind me to do X at 5pm".
//
// Persisted to data/schedules.json via utils/scheduleStore.js — every
// mutation (create/cancel/fire/reschedule) is mirrored to disk, and
// hydrateFromDisk() reloads whatever was there at the last clean or
// unclean shutdown. A restart no longer clears the schedule.
const crypto = require('crypto');
const taskEngine = require('./taskEngine');
const { emitAgentEvent } = require('./eventBus');
const scheduleStore = require('./scheduleStore');

const TICK_MS = 15 * 1000; // maximum sleep between wake-ups — see startScheduler()
                            // below for why this is now a ceiling, not the
                            // granularity: jobs fire within milliseconds of
                            // their due time under normal operation.
const MIN_INTERVAL_MS = 60 * 1000; // floor for recurring jobs, so a typo
                                    // like everyMs:1000 can't hammer the LLM

// id -> { id, userId, goal, mode:'once'|'every', everyMs?, nextRunAt,
//         running, lastRunId, lastStatus, lastRanAt, createdAt, enabled }
const jobs = new Map();
let ticking = false;
let timerHandle = null;
let nextWakeAt = null; // when the currently-armed timer will fire, or null if not running

function persistJob(job) {
  scheduleStore.saveJob(job.id, job);
}

// Loads whatever was on disk into the in-memory map. Call once at server
// boot, before startScheduler(). A job whose nextRunAt is already in the
// past when this runs (server was down through one or more of its due
// times) is NOT fired in a catch-up burst here — tick() picks it up on the
// next tick and fires it exactly once, then reschedule (below) advances it
// past every interval that was missed rather than queuing a backlog.
function hydrateFromDisk() {
  const all = scheduleStore.loadAllJobs();
  for (const job of Object.values(all)) {
    job.running = false; // any "running" flag on disk is stale — the process that set it is gone
    jobs.set(job.id, job);
  }
  return jobs.size;
}

function schedulePayload(job) {
  const { id, userId, goal, mode, everyMs, nextRunAt, running, lastRunId, lastStatus, lastRanAt, createdAt, enabled } = job;
  return { id, userId, goal, mode, everyMs, nextRunAt, running, lastRunId, lastStatus, lastRanAt, createdAt, enabled };
}

// Earliest nextRunAt among jobs that could actually fire on the next wake
// (enabled, not already mid-fire). null if nothing is due at all — the
// caller falls back to the TICK_MS ceiling in that case, purely so a job
// added straight to disk/jobs by something other than
// scheduleOnce/scheduleRecurring is still noticed within a bounded time;
// normal job creation doesn't rely on this fallback, see maybeWakeSooner.
function earliestDueAt() {
  let earliest = null;
  for (const job of jobs.values()) {
    if (!job.enabled || job.running) continue;
    if (earliest === null || job.nextRunAt < earliest) earliest = job.nextRunAt;
  }
  return earliest;
}

// Arms a single setTimeout for exactly when the soonest job is due (clamped
// to [0, TICK_MS]), instead of polling on a fixed interval. This is the fix
// for scheduling granularity: previously every job could fire up to
// TICK_MS (15s) after its nominal due time no matter what, because nothing
// woke the scheduler any sooner than the next fixed poll. Now a job fires
// within milliseconds of its due time — TICK_MS only still bounds the
// worst case (an idle scheduler with nothing due yet still wakes
// periodically, so it can't miss a job that got added to `jobs` some way
// other than scheduleOnce/scheduleRecurring, which nudge it directly).
function armTimer() {
  if (!ticking) return;
  if (timerHandle) clearTimeout(timerHandle);
  const now = Date.now();
  const earliest = earliestDueAt();
  const delay = Math.max(0, Math.min(earliest === null ? TICK_MS : earliest - now, TICK_MS));
  nextWakeAt = now + delay;
  timerHandle = setTimeout(wake, delay);
  timerHandle.unref(); // never keeps the process alive on its own
}

function wake() {
  tick();
  armTimer(); // re-arm for whatever's next due now (a recurring job just
              // advanced its own nextRunAt as part of tick(), so this
              // naturally picks that up too)
}

// Called right after a new job is created. If it's due sooner than the
// currently-armed wake-up, re-arm immediately instead of waiting — this is
// what makes "schedule something 3 seconds from now" actually fire ~3
// seconds from now instead of waiting for the next up-to-15s poll.
function maybeWakeSooner(candidateAt) {
  if (!ticking) return;
  if (nextWakeAt === null || candidateAt < nextWakeAt) armTimer();
}

function scheduleOnce(userId, goal, atMs) {
  if (!Number.isFinite(atMs) || atMs < Date.now() - 5000) {
    throw new Error('atMs must be a timestamp in the future.');
  }
  const id = crypto.randomUUID();
  const job = { id, userId, goal, mode: 'once', everyMs: null, nextRunAt: atMs, running: false, lastRunId: null, lastStatus: null, lastRanAt: null, createdAt: Date.now(), enabled: true };
  jobs.set(id, job);
  persistJob(job);
  maybeWakeSooner(atMs);
  emitAgentEvent(userId, 'agent:log', { line: `\u23f0 Scheduled: "${goal}" for ${new Date(atMs).toLocaleString()}` });
  return schedulePayload(job);
}

function scheduleRecurring(userId, goal, everyMs, { startAt } = {}) {
  if (!Number.isFinite(everyMs) || everyMs < MIN_INTERVAL_MS) {
    throw new Error(`everyMs must be a number >= ${MIN_INTERVAL_MS} (1 minute).`);
  }
  const id = crypto.randomUUID();
  const nextRunAt = Number.isFinite(startAt) ? startAt : Date.now() + everyMs;
  const job = { id, userId, goal, mode: 'every', everyMs, nextRunAt, running: false, lastRunId: null, lastStatus: null, lastRanAt: null, createdAt: Date.now(), enabled: true };
  jobs.set(id, job);
  persistJob(job);
  maybeWakeSooner(nextRunAt);
  emitAgentEvent(userId, 'agent:log', { line: `\u23f0 Scheduled recurring (every ${Math.round(everyMs / 60000)}m): "${goal}"` });
  return schedulePayload(job);
}

function cancelSchedule(id, userId) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'No such schedule (it may have already run and been removed, if it was one-off).' };
  if (job.userId !== userId) return { ok: false, error: 'That schedule belongs to a different user.' };
  jobs.delete(id);
  scheduleStore.deleteJob(id);
  emitAgentEvent(userId, 'agent:log', { line: `\u23f9 Cancelled schedule: "${job.goal}"` });
  return { ok: true };
}

function listSchedules(userId) {
  return Array.from(jobs.values()).filter((j) => j.userId === userId).map(schedulePayload);
}

function getSchedule(id) {
  const job = jobs.get(id);
  return job ? schedulePayload(job) : null;
}

async function fireJob(job) {
  job.running = true;
  persistJob(job);
  try {
    const result = taskEngine.runInBackground(job.goal, { userId: job.userId });
    job.lastRunId = result.runId;
    job.lastStatus = 'started';
    job.lastRanAt = Date.now();
  } catch (err) {
    job.lastStatus = 'error';
    job.lastRanAt = Date.now();
    emitAgentEvent(job.userId, 'agent:log', { line: `\u2717 Scheduled run failed to start: ${err.message}` });
  } finally {
    job.running = false;
    // A 'once' job was already removed from `jobs`/disk by tick() before
    // fireJob was called — don't resurrect it on disk here.
    if (jobs.has(job.id)) persistJob(job);
  }
}

// Advances a recurring job's nextRunAt from its own last nominal due time
// (job.nextRunAt + everyMs), not from "now" — this is the drift fix. Under
// continuous operation, every future fire time is still an exact multiple
// of everyMs from the job's original schedule, regardless of how much
// tick()/fireJob() processing latency (or TICK_MS granularity) delayed the
// actual fire. If the server was down long enough to miss one or more
// intervals entirely, the while loop skips forward past all of them so the
// job fires once now and resumes its normal cadence — not a queued burst
// of catch-up runs for however many intervals were missed.
function advanceNextRunAt(job, now) {
  let next = job.nextRunAt + job.everyMs;
  while (next <= now) next += job.everyMs;
  return next;
}

function tick() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (!job.enabled || job.running || job.nextRunAt > now) continue;
    if (job.mode === 'once') {
      jobs.delete(job.id); // one-off jobs are removed once they've fired, not left around as "done"
      scheduleStore.deleteJob(job.id);
      fireJob(job);
    } else {
      job.nextRunAt = advanceNextRunAt(job, now);
      fireJob(job);
    }
  }
}

function startScheduler() {
  if (ticking) return;
  ticking = true;
  armTimer();
}

// Test-only: undo startScheduler() so a test suite can start/stop the
// scheduler repeatedly without a stray timer surviving into the next test
// file (armTimer's setTimeout is .unref()'d, so it was never a hang risk —
// this is about avoiding cross-test state bleed, not process exit).
function stopScheduler() {
  ticking = false;
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  nextWakeAt = null;
}

module.exports = {
  scheduleOnce, scheduleRecurring, cancelSchedule, listSchedules, getSchedule, startScheduler, stopScheduler, hydrateFromDisk, TICK_MS, MIN_INTERVAL_MS,
  // Exported purely for tests/ to cover the drift-correction math and the
  // self-adjusting wake timer directly.
  advanceNextRunAt, tick,
};
