const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const { openAppRequest, systemActionRequest, confirmActionRequest, windowActionRequest } = require('../schemas');
const { launch, knownApps } = require('../utils/appLauncher');
const systemControl = require('../utils/systemControl');
const { getSystemStatus } = require('../utils/systemStatus');
const windowManager = require('../utils/windowManager');
const contextAwareness = require('../utils/contextAwareness');
const { checkProviders } = require('../utils/providerHealth');

const router = express.Router();

// GET /api/system/health/providers — readiness for every external
// provider (LLM providers, ElevenLabs, Supabase, search augmentation,
// Open-Meteo). Protected (unlike the public GET /health/GET
// /api/boot-status, which stay synchronous/cheap) because this makes real
// network calls — cached (see utils/providerHealth.js) so repeated polling
// doesn't hammer anyone's API quota.
router.get('/health/providers', asyncHandler(async (req, res) => {
  res.json(await checkProviders());
}));

// Real, live process list for the dashboard.
router.get('/processes', asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const sortBy = req.query.sortBy === 'cpu' ? 'cpu' : 'mem';
  res.json({ processes: await systemControl.listProcesses(limit, sortBy) });
}));

router.post('/action', validate({ body: systemActionRequest }), asyncHandler(async (req, res) => {
  const { action, target, level } = req.body;
  if (action === 'kill_process' && !target) return res.status(400).json({ error: '"target" (a pid or process name) is required for kill_process' });
  if ((action === 'volume_set' || action === 'brightness_set') && level === undefined) return res.status(400).json({ error: '"level" (0-100) is required for this action' });
  res.json(await systemControl.requestAction(req.user.id, action, { target, level }));
}));

router.post('/action/confirm', validate({ body: confirmActionRequest }), asyncHandler(async (req, res) => {
  res.json(await systemControl.confirmPending(req.user.id, req.body.actionId));
}));

router.post('/action/cancel', (req, res) => res.json(systemControl.cancelPending(req.user.id)));

router.get('/apps', (req, res) => res.json({ apps: Object.keys(knownApps()) }));

// Names are validated and resolved through the fixed registry. Chat input is
// never passed to a shell or used as an executable path.
router.post('/open', validate({ body: openAppRequest }), (req, res) => {
  const result = launch(req.body.app);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

router.get('/', asyncHandler(async (req, res) => {
  res.json(await getSystemStatus());
}));

// --- Window management ---
router.get('/windows', asyncHandler(async (req, res) => {
  res.json(await windowManager.listWindows());
}));

router.get('/windows/active', asyncHandler(async (req, res) => {
  res.json(await windowManager.getActiveWindow());
}));

// Target is resolved against currently-open windows inside windowManager —
// this route never hands the target string to a shell.
router.post('/windows/action', validate({ body: windowActionRequest }), asyncHandler(async (req, res) => {
  const result = await windowManager.windowAction(req.body.action, req.body.target);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

// --- Context awareness (what app/window is focused right now) ---
router.get('/context', (req, res) => res.json(contextAwareness.getContext()));

module.exports = router;
