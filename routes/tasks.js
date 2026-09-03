const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  taskRunRequest, taskAutoRequest, taskRunIdParams, taskScheduleRequest, scheduleIdParams,
} = require('../schemas');
const taskEngine = require('../utils/taskEngine');
const scheduler = require('../utils/scheduler');
const { listTools } = require('../utils/toolRegistry');

const router = express.Router();

// GET /api/tasks/tools — the tool catalog the planner and explicit runs draw from
router.get('/tools', (req, res) => res.json({ tools: listTools() }));

// POST /api/tasks/run — execute an explicit, caller-supplied sequence of
// tool calls. Useful when you (or a UI) already know exactly what steps you
// want, without asking the LLM to invent a plan.
router.post('/run', validate({ body: taskRunRequest }), asyncHandler(async (req, res) => {
  const result = await taskEngine.runSequence(req.body.steps, { userId: req.user.id });
  res.json(result);
}));

// POST /api/tasks/auto — { goal, execute?, background? }.
//   execute:false (default), background:false — returns a proposed plan
//     without running anything, so the caller/UI can show it to the user first.
//   execute:true,  background:false — runs it immediately and BLOCKS the
//     request until it's done, returning the final result.
//   background:true — starts it right away without blocking the request;
//     returns { status:'queued', runId } immediately, progress streams over
//     the /agent socket, final state lands in GET /api/tasks/:runId.
router.post('/auto', validate({ body: taskAutoRequest }), asyncHandler(async (req, res) => {
  if (req.body.background) {
    const result = taskEngine.runInBackground(req.body.goal, { userId: req.user.id });
    return res.status(202).json(result);
  }
  const result = await taskEngine.autonomousRun(req.body.goal, { userId: req.user.id }, { execute: req.body.execute });
  res.json(result);
}));

// POST /api/tasks/:runId/continue — resume a run that paused on a
// confirm-required step, after the user has confirmed (or cancelled) it
// through the normal chat flow.
router.post('/:runId/continue', validate({ params: taskRunIdParams }), asyncHandler(async (req, res) => {
  const result = await taskEngine.continueRun(req.params.runId, { userId: req.user.id });
  if (result.status === 'not-found') return res.status(404).json(result);
  if (result.status === 'forbidden') return res.status(403).json(result);
  res.json(result);
}));

// POST /api/tasks/:runId/cancel — emergency stop for a run that's queued,
// planning, or mid-step. Flags it; the engine unwinds at the next safe
// point (between steps / between correction attempts), not mid-tool-call.
router.post('/:runId/cancel', validate({ params: taskRunIdParams }), (req, res) => {
  const result = taskEngine.cancelRun(req.params.runId, { userId: req.user.id });
  if (!result.ok) {
    const code = result.status === 'not-found' ? 404 : result.status === 'forbidden' ? 403 : 409;
    return res.status(code).json(result);
  }
  res.json(result);
});

// ---------------- Scheduled / recurring tasks ----------------
// NOTE: these must be registered before the generic "GET /:runId" below —
// Express matches route patterns in registration order, and "/scheduled"
// would otherwise be swallowed by "/:runId" (and fail its UUID validation).

// POST /api/tasks/schedule — { goal, at? (ISO timestamp) | everyMinutes? }.
// One-off jobs fire once and are removed; recurring jobs keep firing until
// cancelled. Both run via taskEngine.runInBackground when due — in-memory
// only, cleared on server restart (see utils/scheduler.js).
router.post('/schedule', validate({ body: taskScheduleRequest }), asyncHandler((req, res) => {
  const { goal, at, everyMinutes } = req.body;
  const result = at
    ? scheduler.scheduleOnce(req.user.id, goal, new Date(at).getTime())
    : scheduler.scheduleRecurring(req.user.id, goal, everyMinutes * 60 * 1000);
  res.status(201).json(result);
}));

// GET /api/tasks/scheduled — this user's schedules (one-off + recurring)
router.get('/scheduled', (req, res) => res.json({ schedules: scheduler.listSchedules(req.user.id) }));

// DELETE /api/tasks/scheduled/:id
router.delete('/scheduled/:id', validate({ params: scheduleIdParams }), (req, res) => {
  const result = scheduler.cancelSchedule(req.params.id, req.user.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// GET /api/tasks/:runId — inspect a run's current state
router.get('/:runId', validate({ params: taskRunIdParams }), (req, res) => {
  const run = taskEngine.getRun(req.params.runId);
  if (!run || run.userId !== req.user.id) return res.status(404).json({ ok: false, error: 'Run not found.' });
  res.json({ ok: true, ...run });
});

module.exports = router;
