// In-memory run registry + disk-persistence glue for the task engine.
// Split out of utils/taskEngine.js (which had grown to ~570 lines mixing this
// bookkeeping with the actual plan/execute/verify loop) so each file has one
// job: this one owns "what runs exist, what state are they in, how do we get
// them back after a restart," and taskEngine.js owns "how does a run actually
// execute." Nothing here calls an LLM, a tool, or touches device/browser
// state — see taskEngine.js for that.
const taskStore = require('./taskStore');
const { emitAgentEvent } = require('./eventBus');

const RUN_TTL_MS = 15 * 60 * 1000;

// runId -> { goal, steps, cursor, results, userId, createdAt, status }
// This Map is a hot in-memory cache, not the source of truth — every write
// to it (see persistRun below) is mirrored to utils/taskStore.js on disk,
// so a crash doesn't lose run state, only the in-flight step. Read paths
// still read this Map directly for speed; it's populated from disk at
// module load via hydrateFromDisk() so those reads work correctly even
// right after a restart, before any new run has touched a given runId.
const runs = new Map();

// userId -> runId, tracked only while that user has exactly one run sitting
// paused on a confirmation — lets chat.js's existing confirm/cancel flow
// resume the actual task run instead of just firing the one flagged step.
const pendingRunByUser = new Map();

// Emergency stop: runIds flagged for cancellation. A Set rather than a field
// on the run object because a run can be cancelled from a completely
// different request than the one running it (POST /api/tasks/:runId/cancel
// while the original request/background job is still in flight) — the loop
// checks this between every step (and every correction attempt) and unwinds
// as soon as it notices, rather than being interrupted mid-tool-call.
const cancelledRuns = new Set();

function persistRun(runId, run) {
  runs.set(runId, run);
  taskStore.saveRun(runId, run);
}

// Loads whatever utils/taskStore.js has on disk into the hot cache, and
// flags anything still mid-flight as 'interrupted' rather than silently
// resuming it — see the long comment on taskStore.recoverInterruptedRuns()
// for why recovery is "make the state visible and resumable," not
// "automatically re-run it." Call once at server boot (server.js).
function recoverInterruptedRuns() {
  const all = taskStore.loadAllRuns();
  for (const [runId, run] of Object.entries(all)) runs.set(runId, run);
  const recovered = taskStore.recoverInterruptedRuns();
  for (const r of recovered) runs.set(r.runId, r);
  return recovered.map((r) => ({ runId: r.runId, goal: r.goal, userId: r.userId, cursor: r.cursor, status: r.status }));
}

function sweepExpiredRuns() {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.createdAt > RUN_TTL_MS) runs.delete(id);
  }
  taskStore.pruneOlderThan(RUN_TTL_MS);
}

function trackPending(userId, runId, status) {
  if (status === 'paused') pendingRunByUser.set(userId, runId);
  else if (pendingRunByUser.get(userId) === runId) pendingRunByUser.delete(userId);
}

// Returns the runId a user currently has paused on a confirmation, if any.
function getPendingRunId(userId) {
  return pendingRunByUser.get(userId) || null;
}

// Emergency stop. Works whether the run is mid-step, mid-correction, or a
// background job that hasn't reached its first step yet — it just flags the
// runId; runSequence (in taskEngine.js) is the only place that actually
// unwinds, and it checks this flag before every step and before every
// correction attempt. Returns { ok:false } for a run that's already
// finished or doesn't belong to this user, so the route layer can
// 404/409/403 appropriately.
function cancelRun(runId, ctx) {
  const run = runs.get(runId);
  if (!run) return { ok: false, status: 'not-found', error: 'That run no longer exists (it may have expired).' };
  if (run.userId !== ctx.userId) return { ok: false, status: 'forbidden', error: 'That run belongs to a different user.' };
  if (['completed', 'failed', 'cancelled', 'no-op'].includes(run.status)) {
    return { ok: false, status: run.status, error: `That run already finished (${run.status}) — there's nothing left to cancel.` };
  }
  cancelledRuns.add(runId);
  run.status = 'cancelling';
  taskStore.saveRun(runId, run);
  emitAgentEvent(ctx.userId, 'agent:log', { runId, line: '\u25a0 Cancel requested \u2014 stopping at the next safe point' });
  return { ok: true, status: 'cancelling', runId };
}

function getRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  return { ...run };
}

module.exports = {
  RUN_TTL_MS,
  runs, pendingRunByUser, cancelledRuns,
  persistRun, recoverInterruptedRuns, sweepExpiredRuns,
  trackPending, getPendingRunId, cancelRun, getRun,
};
