// Multi-step task execution + the autonomous
// "plan -> execute -> observe -> verify -> correct -> retry" loop.
//
// Two entry points:
//   runSequence(steps, ctx)   — run an explicit list of {tool, args} steps.
//   autonomousRun(goal, ctx)  — ask the LLM to propose a plan from a goal,
//                               then (optionally) execute it and verify.
//
// Phase 2 addition: every phase transition (planning/executing/observing/
// verifying/correcting/retrying/complete/error) is pushed live over
// utils/eventBus.js -> utils/agentSocket.js -> the /agent socket namespace,
// using the exact PIPELINE_STATES names the frontend reactor/stepper
// already render (see PHASE1-VISUAL-UPGRADE.md). The UI no longer has to
// guess a client-side sequence for task/agent runs — it reflects what the
// backend is actually doing, step by step.
//
// Safety properties that hold regardless of which entry point is used:
//   - A step whose result carries needsConfirmation (system.power's
//     destructive actions) PAUSES the run right there — nothing after it
//     runs until the user confirms via the normal chat "confirm" flow and
//     the run is resumed with continueRun(). The task engine never
//     auto-confirms on the user's behalf, and correction/retry never
//     touches a paused step either.
//   - input.*/browser.* steps fail with a clear error if their capability
//     isn't armed (automationGuard) — the task engine doesn't bypass that,
//     and a disarmed capability is treated as unrecoverable (no retry storm
//     against a tool that will never succeed).
//   - A hard step cap, a capped number of correction attempts per step, and
//     a wall-clock budget together stop runaway plans.
//   - Every step's outcome — including corrections and retries — is written
//     to the shared audit trail.
const crypto = require('crypto');
const { runTool } = require('./toolRegistry');
const audit = require('./audit');
const longTermMemory = require('./longTermMemory');
const { emitAgentEvent } = require('./eventBus');
const taskStore = require('./taskStore');
// Planning/correction/verification (the LLM-facing side of the engine) now
// lives in its own module — see utils/taskPlanner.js for why. taskEngine.js
// only knows it as three functions + a step cap, not as prompt text or a
// specific LLM provider order.
const { proposePlan, correctStep, verifyGoal: verifyGoalWithLlm, MAX_STEPS } = require('./taskPlanner');
// Run registry (the in-memory `runs`/`pendingRunByUser`/`cancelledRuns`
// state, its disk-persistence glue, and cancel/lookup) now lives in its own
// module — see utils/taskRunRegistry.js for why. taskEngine.js only knows
// it as these functions + shared Map/Set references, not as storage details.
const {
  runs, pendingRunByUser, cancelledRuns,
  persistRun, recoverInterruptedRuns, sweepExpiredRuns,
  trackPending, getPendingRunId, cancelRun, getRun,
} = require('./taskRunRegistry');

const MAX_CORRECTIONS_PER_STEP = 2;
const TIME_BUDGET_MS = 60000;

// Tools with no side effects — pure reads/computation that never touch
// device state, the filesystem, or a live browser/input session. Adjacent
// steps in a plan that are ALL in this set carry no ordering risk against
// each other (nothing one of them does can affect what another observes),
// so runSequence batches and runs them concurrently instead of one at a
// time. Everything else (apps.*, windows.action, input.move/click/type/
// key/dragDrop/clipboardWrite, browser.navigate/click/type/scroll/tabs.new/
// tabs.switch/tabs.close/download, files.open, system.power,
// memory.remember) stays strictly sequential — those either mutate shared
// state or depend on a specific device/session state existing from the
// step before them, so parallelizing them would be a real correctness/
// safety risk, not just a missed optimization.
//
// This set is deliberately a hand-curated allowlist, not "every tool tagged
// permission:'read' in toolRegistry.js" (that tag is about AUTHORIZATION —
// does this tool need a capability armed — not about concurrency safety;
// the two questions usually agree but aren't the same one). It's also
// deliberately NOT a general dependency-aware DAG executor: this system
// executes LLM-generated plans against real device/browser/filesystem
// state, so the cost of getting parallelism wrong (two steps that turn out
// to have a real ordering dependency the planner didn't notice, or a
// dependency-inference heuristic silently misjudging one) is a genuine
// safety/correctness incident, not a slow response. A conservative,
// reviewed allowlist that a human can look at and verify "yes, every one of
// these is a pure read with no way to interfere with its neighbors" is the
// right trade-off here even though it means some genuinely independent
// standard/dangerous-tagged steps stay sequential.
//
// Every tool below was checked individually against its own execute()
// implementation (not just its permission tag) for hidden mutation before
// being added:
//   - vision.snapshot does write to an in-memory snapshot store, but only
//     ever ADDS a new entry keyed by its own fresh snapshotId — it can't
//     collide with or be affected by any sibling in this set.
//   - browser.read/browser.tabs.list/browser.verify all resolve through
//     browserAutomation's activePage() (utils/browserAutomation.js), which
//     reads the current tab but never mutates it — confirmed none of the
//     three ever touch the module's `pages`/`activeIndex` state, so running
//     several concurrently is exactly as safe as running them one at a time
//     (they just each read the same unchanging tab).
const PARALLEL_SAFE_TOOLS = new Set([
  'memory.recall', 'calc.evaluate',
  'system.status', 'system.processes',
  'apps.list',
  'windows.list', 'windows.active',
  'files.search', 'files.searchContent',
  'vision.screen', 'vision.findElement', 'vision.snapshot', 'vision.compareToSnapshot',
  'browser.read', 'browser.tabs.list', 'browser.verify',
  'input.clipboardRead',
]);

// A failure is worth asking the LLM to correct only if the cause could
// plausibly be fixed by different args/tool choice. A disarmed capability or
// an out-of-scope file path will fail the exact same way every retry, so
// treat those as terminal instead of burning correction attempts on them.
const UNRECOVERABLE_ERROR = /not armed|disabled|outside the allowed|forbidden|unknown tool/i;

function isRecoverable(result) {
  if (!result || result.ok !== false) return false;
  if (result.needsConfirmation) return false;
  return !UNRECOVERABLE_ERROR.test(result.error || '');
}

function emitState(ctx, state, extra = {}) {
  emitAgentEvent(ctx.userId, 'agent:state', { runId: ctx.runId || null, state, ...extra });
}

function emitLog(ctx, line, meta = {}) {
  emitAgentEvent(ctx.userId, 'agent:log', { runId: ctx.runId || null, line, ...meta });
}

async function runStep(step, ctx) {
  emitState(ctx, 'executing', { main: 'Executing', sub: step.why || step.tool });
  const result = await runTool(step.tool, step.args || {}, ctx);
  audit.record({
    type: 'task-step',
    tool: step.tool,
    args: step.tool === 'input.type' ? { length: (step.args?.text || '').length } : step.args,
    ok: result.ok !== false,
    summary: result.ok === false ? `${step.tool} failed: ${result.error}` : `Task step: ${step.tool}`,
  });
  // Observe: look at what the tool actually returned before deciding what to
  // do next, and say so — this is a real phase, not just a renamed log line.
  emitState(ctx, 'observing', {
    main: 'Observing',
    sub: result.ok === false ? `${step.tool} failed: ${result.error}` : `${step.tool} \u2192 ok`,
  });
  // args is additive here too — the frontend's app-launch cinematic reads
  // args.app off an 'apps.open' step to label its animation. `verified` and
  // `pid` are additive too — undefined for every other tool, and for
  // apps.open they're the real process-level confirmation and PID from
  // utils/launchVerifier.js (see toolRegistry.js), not just "the spawn call
  // didn't throw".
  emitLog(ctx, result.ok === false ? `\u2717 ${step.tool}: ${result.error}` : `\u2713 ${step.tool}`, { tool: step.tool, ok: result.ok !== false, args: step.args, verified: result.verified, pid: result.pid });
  return result;
}

// Thin wrapper around taskPlanner's verifyGoal (see utils/taskPlanner.js)
// that keeps the 'verifying' socket-state emission here in taskEngine —
// that emission is about this module's run-lifecycle reporting, not about
// how verification itself works, so it stays with the rest of the
// emitState calls rather than moving into taskPlanner, which has no idea
// what a "run" or ctx.runId is.
async function verifyGoal(goal, results, ctx = {}) {
  emitState(ctx, 'verifying', { main: 'Verifying', sub: 'Checking the goal was actually achieved' });
  return verifyGoalWithLlm(goal, results);
}

// A run of 2+ immediately-adjacent steps, starting at `start`, that are ALL
// in PARALLEL_SAFE_TOOLS. Returns the exclusive end index (start if no such
// batch exists, i.e. a single step or a not-safe step follows). Stops
// extending the batch at MAX_STEPS-relative bounds the caller already
// applied via `capped`.
function findParallelBatchEnd(capped, start) {
  let end = start;
  while (end < capped.length && PARALLEL_SAFE_TOOLS.has(capped[end].tool)) end += 1;
  return end;
}

// Executes steps in order starting at `from`. On a recoverable failure it
// asks the LLM for a corrected replacement step and retries in place (up to
// MAX_CORRECTIONS_PER_STEP), emitting 'correcting'/'retrying' for each
// attempt, before giving up on that step. Stops (and reports why) on the
// first confirm-required step or a step that's still failing after
// corrections; a hard step cap and time budget apply on top of whatever the
// caller already trimmed the plan to.
//
// Adjacent steps that are all side-effect-free (PARALLEL_SAFE_TOOLS) run
// concurrently via Promise.all instead of one at a time — safe because
// nothing in that set can affect what another step in the same set
// observes. A failure inside a parallel batch does NOT get corrected
// concurrently (correction re-runs one step at a time, same as the
// sequential path, just entered from a batch) — that keeps the
// cancel/correct/retry semantics identical regardless of which path got a
// step there, so the rest of this function doesn't need two versions of
// that logic.
//
// `onProgress(results, cursor)`, if given, is called after every
// completed step (or completed batch) so the caller can persist run state
// incrementally — see taskEngine's persistRun/taskStore.js. Purely a
// notification; runSequence itself does no I/O and stays testable without
// touching disk.
async function runSequence(steps, ctx, { from = 0, goal = '', onProgress } = {}) {
  const capped = steps.slice(0, MAX_STEPS);
  const results = [];
  const deadline = Date.now() + TIME_BUDGET_MS;

  const reportProgress = (cursor) => { if (onProgress) onProgress(results, cursor); };

  async function runOneWithCorrection(step, i) {
    let result = await runStep(step, ctx);
    let attempt = 0;
    while (isRecoverable(result) && attempt < MAX_CORRECTIONS_PER_STEP && Date.now() < deadline) {
      if (cancelledRuns.has(ctx.runId)) return { step, result, cancelled: true };
      attempt += 1;
      emitState(ctx, 'correcting', { main: 'Correcting', sub: `${step.tool} failed \u2014 working out a fix (${attempt}/${MAX_CORRECTIONS_PER_STEP})` });
      const fixed = await correctStep(goal, step, result.error);
      if (!fixed) break;
      emitState(ctx, 'retrying', { main: 'Retrying', sub: fixed.why || fixed.tool });
      emitLog(ctx, `\u21bb retry ${attempt}: ${fixed.tool} (was ${step.tool})`, { tool: fixed.tool });
      step = fixed;
      result = await runStep(step, ctx);
    }
    return { step, result, cancelled: false };
  }

  let i = from;
  while (i < capped.length) {
    if (cancelledRuns.has(ctx.runId)) {
      cancelledRuns.delete(ctx.runId);
      emitState(ctx, 'idle', { main: 'Cancelled', sub: 'Stopped by user', revertAfter: 1500 });
      emitAgentEvent(ctx.userId, 'agent:log', { runId: ctx.runId, line: '\u25a0 Cancelled' });
      reportProgress(i);
      return { status: 'cancelled', results, cursor: i };
    }
    if (Date.now() > deadline) {
      reportProgress(i);
      return { status: 'timeout', results, cursor: i, remaining: capped.slice(i) };
    }

    const batchEnd = findParallelBatchEnd(capped, i);
    const isBatch = batchEnd - i >= 2;

    if (isBatch) {
      emitState(ctx, 'executing', { main: 'Executing', sub: `${batchEnd - i} independent step(s) in parallel` });
      const batchOutcomes = await Promise.all(capped.slice(i, batchEnd).map((step) => runOneWithCorrection(step, i)));
      for (const outcome of batchOutcomes) {
        if (outcome.cancelled) {
          cancelledRuns.delete(ctx.runId);
          results.push({ step: outcome.step, result: outcome.result });
          emitState(ctx, 'idle', { main: 'Cancelled', sub: 'Stopped by user', revertAfter: 1500 });
          emitAgentEvent(ctx.userId, 'agent:log', { runId: ctx.runId, line: '\u25a0 Cancelled mid-batch' });
          reportProgress(i);
          return { status: 'cancelled', results, cursor: i };
        }
      }
      // needsConfirmation is theoretical here, not a live case: every tool
      // in PARALLEL_SAFE_TOOLS is a pure read/computation and none of them
      // ever set it (only system.power does, and it's deliberately not in
      // that set) — handled anyway so a future plugin tool added to the
      // allowlist by mistake fails safe instead of silently skipping the
      // pause behaviour other tools rely on.
      const failureIdx = batchOutcomes.findIndex((o) => o.result.needsConfirmation || o.result.ok === false);
      batchOutcomes.forEach((o) => results.push({ step: o.step, result: o.result }));
      i = batchEnd;
      reportProgress(i);
      if (failureIdx !== -1) {
        const failure = batchOutcomes[failureIdx];
        const failedAt = i - (batchOutcomes.length - failureIdx); // real index of the failing step within capped
        if (failure.result.needsConfirmation) {
          return { status: 'paused', results, cursor: i, remaining: capped.slice(i), pendingActionId: failure.result.actionId, pendingDescription: failure.result.description };
        }
        emitState(ctx, 'error', { main: 'Step failed', sub: `${failure.step.tool}: ${failure.result.error}` });
        return { status: 'failed', results, cursor: failedAt, failedStep: failure.step, error: failure.result.error };
      }
      continue;
    }

    const step = capped[i];
    const outcome = await runOneWithCorrection(step, i);
    if (outcome.cancelled) {
      cancelledRuns.delete(ctx.runId);
      results.push({ step: outcome.step, result: outcome.result });
      emitState(ctx, 'idle', { main: 'Cancelled', sub: 'Stopped by user', revertAfter: 1500 });
      emitAgentEvent(ctx.userId, 'agent:log', { runId: ctx.runId, line: '\u25a0 Cancelled mid-correction' });
      reportProgress(i);
      return { status: 'cancelled', results, cursor: i };
    }

    results.push({ step: outcome.step, result: outcome.result });
    i += 1;
    reportProgress(i);

    if (outcome.result.needsConfirmation) {
      return { status: 'paused', results, cursor: i, remaining: capped.slice(i), pendingActionId: outcome.result.actionId, pendingDescription: outcome.result.description };
    }
    if (outcome.result.ok === false) {
      emitState(ctx, 'error', { main: 'Step failed', sub: `${outcome.step.tool}: ${outcome.result.error}` });
      return { status: 'failed', results, cursor: i - 1, failedStep: outcome.step, error: outcome.result.error };
    }
  }
  return { status: 'completed', results };
}

// execute:false (the default) returns the proposed plan without running
// anything — a dry run the caller can inspect or hand to the user before
// committing. execute:true runs it through runSequence immediately and BLOCKS
// until it's done. Pass `runId` when a caller (runInBackground, the
// scheduler) already generated one before kicking this off, so progress
// events and getRun() line up with the id the caller handed back.
async function autonomousRun(goal, ctx, { execute = false, runId: providedRunId } = {}) {
  sweepExpiredRuns();
  const runId = providedRunId || crypto.randomUUID();
  const runCtx = { ...ctx, runId };
  const createdAt = runs.get(runId)?.createdAt || Date.now();

  // Register the run BEFORE planning starts, not after — previously a run
  // only existed in `runs`/taskStore once proposePlan() had already
  // resolved (runInBackground was the one exception, since it pre-persists
  // a 'queued' record itself), which meant cancelRun() 404'd on any run
  // still mid-planning unless it happened to go through the background
  // path. Registering here closes that gap for every caller (blocking
  // POST /api/tasks/auto included) — cancelRun() can now find and flag the
  // run the whole time proposePlan's LLM call is in flight, not just once
  // execution begins. execute:false (dry-run "just show me the plan")
  // callers still get this record; it's cheap and gives them a real runId
  // to inspect via GET /api/tasks/:runId even before they decide to run it.
  if (!runs.has(runId)) {
    persistRun(runId, { goal, steps: [], results: [], cursor: 0, userId: ctx.userId, createdAt, status: 'planning' });
  }

  try {
    emitState(runCtx, 'understanding', { main: 'Understanding', sub: goal.slice(0, 80) });
    emitState(runCtx, 'planning', { main: 'Planning', sub: 'Breaking the goal into steps' });
    const { steps, notes } = await proposePlan(goal);

    // A cancel requested WHILE proposePlan's LLM call was in flight was
    // previously invisible until the first step of runSequence — the
    // planning call itself (often the single slowest part of a run,
    // frequently several seconds) couldn't be interrupted at all. Checked
    // here, right as control returns from it, so "cancel" is honored at the
    // earliest safe point instead of only once execution starts.
    if (cancelledRuns.has(runId)) {
      cancelledRuns.delete(runId);
      persistRun(runId, { goal, steps, results: [], cursor: 0, userId: ctx.userId, createdAt, status: 'cancelled' });
      trackPending(ctx.userId, runId, 'cancelled');
      emitState(runCtx, 'idle', { main: 'Cancelled', sub: 'Stopped by user before execution began', revertAfter: 1500 });
      emitAgentEvent(ctx.userId, 'agent:log', { runId, line: '\u25a0 Cancelled during planning' });
      return { status: 'cancelled', runId, goal, results: [] };
    }

    if (!steps.length) {
      emitState(runCtx, 'complete', { main: 'Nothing to run', sub: notes || 'No tool steps needed', revertAfter: 1500 });
      return { status: 'no-op', goal, notes };
    }
    if (!execute) {
      emitState(runCtx, 'complete', { main: 'Plan ready', sub: `${steps.length} step(s) \u2014 awaiting execute`, revertAfter: 1500 });
      return { status: 'planned', goal, steps, notes };
    }

    emitState(runCtx, 'thinking', { main: 'Thinking', sub: `Executing ${steps.length} step(s)` });
    // Persisted after every step (see onProgress below), not just once at the
    // end — this is what makes crash recovery meaningful: if the process dies
    // mid-run, taskStore.js has the real cursor/results from the last
    // completed step, not nothing.
    const onProgress = (partialResults, cursor) => {
      persistRun(runId, { goal, steps, results: partialResults, cursor, userId: ctx.userId, createdAt, status: 'executing' });
    };
    const run = await runSequence(steps, runCtx, { goal, onProgress });
    persistRun(runId, { goal, steps, results: run.results, cursor: run.cursor ?? steps.length, userId: ctx.userId, createdAt, status: run.status });
    trackPending(ctx.userId, runId, run.status);

    if (run.status === 'completed') {
      // Same reasoning as above: cancellation is checked between every step,
      // but a run whose LAST step just finished can still receive a cancel
      // in the gap before verifyGoal's own LLM call starts. verifyGoal isn't
      // free (it's a real LLM round trip) and a run the user just cancelled
      // shouldn't spend it, nor should it get reported back as "completed".
      if (cancelledRuns.has(runId)) {
        cancelledRuns.delete(runId);
        persistRun(runId, { goal, steps, results: run.results, cursor: run.cursor ?? steps.length, userId: ctx.userId, createdAt, status: 'cancelled' });
        trackPending(ctx.userId, runId, 'cancelled');
        emitState(runCtx, 'idle', { main: 'Cancelled', sub: 'Stopped by user before verification', revertAfter: 1500 });
        emitAgentEvent(ctx.userId, 'agent:log', { runId, line: '\u25a0 Cancelled before verification' });
        return { status: 'cancelled', runId, goal, results: run.results };
      }
      const verification = await verifyGoal(goal, run.results, runCtx);
      longTermMemory.add(ctx.userId, {
        type: 'note',
        content: `Task "${goal}": ${verification.achieved === false ? 'not fully completed' : 'completed'} \u2014 ${verification.reasoning}`,
        tags: ['task-outcome'],
      }).catch((err) => console.warn('[taskEngine] failed to save task-outcome note:', err.message));
      emitState(runCtx, 'speaking', { main: 'Speaking', sub: 'Reporting results' });
      emitState(runCtx, 'complete', { main: 'Complete', sub: verification.reasoning, revertAfter: 1800 });
      return { status: 'completed', runId, goal, results: run.results, verification };
    }
    if (run.status === 'paused') {
      emitState(runCtx, 'idle', { main: 'Waiting on you', sub: run.pendingDescription || 'Confirmation needed' });
      return { status: 'paused', runId, goal, results: run.results, pendingActionId: run.pendingActionId, pendingDescription: run.pendingDescription, remainingSteps: run.remaining.length };
    }
    if (run.status === 'timeout') {
      emitState(runCtx, 'error', { main: 'Timed out', sub: `${run.remaining.length} step(s) unfinished`, revertAfter: 2200 });
      return { status: 'timeout', runId, goal, results: run.results, remainingSteps: run.remaining.length };
    }
    if (run.status === 'cancelled') {
      return { status: 'cancelled', runId, goal, results: run.results };
    }
    return { status: 'failed', runId, goal, results: run.results, failedStep: run.failedStep, error: run.error };
  } finally {
    // Belt-and-suspenders against a leak: every normal path above already
    // clears its own cancel flag once observed, so this is a no-op on those
    // paths. It only does real work if something threw between cancelRun()
    // flagging this runId and any of those checkpoints observing it (e.g.
    // proposePlan itself rejecting) — without this, that flag would sit in
    // `cancelledRuns` forever, since nothing else ever revisits a runId that
    // never reached runSequence.
    cancelledRuns.delete(runId);
  }
}

// Resumes a paused run — call this after the user has confirmed (or
// cancelled) the pending action through the normal chat flow.
async function continueRun(runId, ctx) {
  sweepExpiredRuns();
  const run = runs.get(runId);
  if (!run) return { status: 'not-found', error: 'That run no longer exists (it may have expired).' };
  if (run.userId !== ctx.userId) return { status: 'forbidden', error: 'That run belongs to a different user.' };

  const runCtx = { ...ctx, runId };
  emitState(runCtx, 'executing', { main: 'Resuming', sub: run.goal.slice(0, 80) });
  const baseResults = run.results;
  const onProgress = (partialResults, cursor) => {
    persistRun(runId, { ...run, results: [...baseResults, ...partialResults], cursor, status: 'executing' });
  };
  const rest = await runSequence(run.steps, runCtx, { from: run.cursor, goal: run.goal, onProgress });
  run.results = [...baseResults, ...rest.results];
  run.cursor = rest.cursor ?? run.steps.length;
  run.status = rest.status;
  persistRun(runId, run);
  trackPending(run.userId, runId, run.status);

  if (rest.status === 'completed' && cancelledRuns.has(runId)) {
    // Same race as autonomousRun's own completed-then-cancelled check above:
    // a cancel that lands in the gap after the last step finishes but
    // before verifyGoal starts. Honor it instead of spending an LLM call to
    // verify a run the user just asked to stop.
    cancelledRuns.delete(runId);
    run.status = 'cancelled';
    persistRun(runId, run);
    trackPending(run.userId, runId, 'cancelled');
    emitAgentEvent(run.userId, 'agent:log', { runId, line: '\u25a0 Cancelled before verification' });
    return { status: 'cancelled', runId, goal: run.goal, results: run.results };
  }

  if (rest.status === 'completed') {
    const verification = await verifyGoal(run.goal, run.results, runCtx);
    longTermMemory.add(run.userId, {
      type: 'note',
      content: `Task "${run.goal}": ${verification.achieved === false ? 'not fully completed' : 'completed'} \u2014 ${verification.reasoning}`,
      tags: ['task-outcome'],
    }).catch((err) => console.warn('[taskEngine] failed to save task-outcome note:', err.message));
    emitState(runCtx, 'complete', { main: 'Complete', sub: verification.reasoning, revertAfter: 1800 });
    return { status: 'completed', runId, goal: run.goal, results: run.results, verification };
  }
  if (rest.status === 'paused') {
    return { status: 'paused', runId, goal: run.goal, results: run.results, pendingActionId: rest.pendingActionId, pendingDescription: rest.pendingDescription, remainingSteps: rest.remaining.length };
  }
  return { status: rest.status, runId, goal: run.goal, results: run.results, error: rest.error, remainingSteps: rest.remaining ? rest.remaining.length : undefined };
}

// Starts a goal without blocking the caller — the request that triggered
// this (POST /api/tasks/auto {background:true}, or the scheduler firing a
// due job) gets a runId back immediately; the run's actual progress streams
// over the /agent socket exactly like a blocking autonomousRun's does, and
// the final state lands in GET /api/tasks/:runId once it's done. There's no
// queue/concurrency limit here — each call starts right away — which is a
// deliberate scope choice for a single-user desktop assistant rather than a
// multi-tenant job queue; see PHASE-PLUGINS-SCHEDULER.md.
function runInBackground(goal, ctx) {
  sweepExpiredRuns();
  const runId = crypto.randomUUID();
  persistRun(runId, { goal, steps: [], results: [], cursor: 0, userId: ctx.userId, createdAt: Date.now(), status: 'queued' });
  emitAgentEvent(ctx.userId, 'agent:log', { runId, line: `\u25b6 Started in background: ${goal}` });
  autonomousRun(goal, ctx, { execute: true, runId }).catch((err) => {
    const run = runs.get(runId);
    if (run) { run.status = 'error'; taskStore.saveRun(runId, run); }
    emitAgentEvent(ctx.userId, 'agent:log', { runId, line: `\u2717 Background run failed: ${err.message}` });
  });
  return { status: 'queued', runId, goal };
}

module.exports = {
  runSequence, proposePlan, verifyGoal, autonomousRun, continueRun, getRun, getPendingRunId,
  cancelRun, runInBackground, recoverInterruptedRuns,
  // Exported alongside the public API purely for tests/ to cover the
  // recoverable-vs-terminal classification and the parallel-safe allowlist
  // directly — not a stable API for other modules.
  isRecoverable, PARALLEL_SAFE_TOOLS,
};
