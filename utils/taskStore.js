// Durable storage for task-engine runs — closes the "in-memory only" gap in
// utils/taskEngine.js. Same pattern as utils/longTermMemory.js's JSON-file
// backend: read/written synchronously, zero setup, one file under data/.
//
// This module only persists; it has no opinion about *when* a run should be
// written or resumed — taskEngine.js owns that. Kept separate so taskEngine's
// control-flow logic isn't tangled with file I/O, and so tests can exercise
// either half independently (tests/taskStore.test.js covers persistence
// itself; tests/taskEngine.test.js can stub this module out entirely).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'task-runs.json');

// Statuses a run can be *persisted* in while genuinely still in flight —
// i.e. the process could plausibly die with the run sitting at one of
// these. 'paused' is deliberately excluded: a paused run is not
// interrupted, it's correctly waiting on a human, and continueRun() already
// knows how to resume it via the normal confirm flow. Everything else here
// only exists mid-step, in memory, on the stack of a runSequence() call —
// if the run is still recorded at one of these when the store is loaded at
// boot, the process that was running it is gone.
const IN_FLIGHT_STATUSES = new Set(['queued', 'planning', 'thinking', 'executing', 'observing', 'correcting', 'retrying', 'cursor-in-progress']);

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persist(all) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

// Writes/overwrites one run's full record. Called by taskEngine after every
// step (not just at the end of a run) so a crash mid-run loses at most the
// one step in flight, never the whole run.
function saveRun(runId, run) {
  const all = load();
  all[runId] = run;
  persist(all);
}

function deleteRun(runId) {
  const all = load();
  if (!(runId in all)) return;
  delete all[runId];
  persist(all);
}

function loadRun(runId) {
  const all = load();
  return all[runId] || null;
}

function loadAllRuns() {
  return load();
}

// Called once at server boot. Any run still recorded as in-flight (see
// IN_FLIGHT_STATUSES above) did not get a clean status transition before
// the process ended — the most recent persisted cursor/results are real,
// but nothing after that ran. Those are relabelled 'interrupted' in place
// (not deleted — the goal, steps, cursor, and partial results are exactly
// what a resume needs) and handed back so the caller can decide what to do
// with them; this module never resumes anything on its own; deliberately
// consistent with the rest of taskEngine's safety model (never auto-act
// without a caller explicitly asking), a crash is not different from a
// paused confirmation in that regard — silently re-running steps that may
// include browser/system/input automation right after an unplanned process
// exit is exactly the kind of thing that should require a deliberate
// continueRun() call, not happen automatically at boot.
function recoverInterruptedRuns() {
  const all = load();
  const recovered = [];
  for (const [runId, run] of Object.entries(all)) {
    if (IN_FLIGHT_STATUSES.has(run.status)) {
      run.status = 'interrupted';
      run.interruptedAt = Date.now();
      recovered.push({ runId, ...run });
    }
  }
  if (recovered.length) persist(all);
  return recovered;
}

// Runs older than this are pruned from disk the same way taskEngine's own
// sweepExpiredRuns() prunes them from its in-memory cache — keeps
// data/task-runs.json from growing forever across long-running servers.
function pruneOlderThan(maxAgeMs) {
  const all = load();
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [runId, run] of Object.entries(all)) {
    if ((run.createdAt || 0) < cutoff) {
      delete all[runId];
      changed = true;
    }
  }
  if (changed) persist(all);
}

module.exports = { saveRun, deleteRun, loadRun, loadAllRuns, recoverInterruptedRuns, pruneOlderThan, IN_FLIGHT_STATUSES, FILE };
