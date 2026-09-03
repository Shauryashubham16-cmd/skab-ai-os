const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { z } = require('../schemas');
const { validate } = require('../middleware/validate');
const { plan, recent } = require('../utils/actionPlanner');
const { knownApps } = require('../utils/appLauncher');
const { getSystemStatus } = require('../utils/systemStatus');
const contextAwareness = require('../utils/contextAwareness');
const proactiveAgent = require('../utils/proactiveAgent');
const { listTools } = require('../utils/toolRegistry');
const permissions = require('../utils/permissions');

const router = express.Router();
router.post('/plan', validate({ body: z.object({ message: z.string().trim().min(1).max(5000) }) }), (req, res) => res.json(plan(req.body.message)));
router.get('/activity', (req, res) => res.json({ activity: recent(Number(req.query.limit) || 50) }));
// GET /api/agent/tools — the standardized tool catalog: every built-in and
// plugin tool with its declared permission level, so the privileged-action
// layer (utils/permissions.js) is inspectable, not just enforced.
router.get('/tools', (req, res) => res.json({ tools: listTools(), capabilities: permissions.capabilityStatus() }));
router.get('/context', asyncHandler(async (req, res) => {
  const status = await getSystemStatus();
  const windowContext = contextAwareness.getContext();
  const { hasVisionProvider } = require('../utils/llmProviders');
  const automationGuard = require('../utils/automationGuard');
  res.json({
    host: status.host,
    runningProcesses: (await require('../utils/systemControl').listProcesses(12, 'cpu')),
    activeWindow: windowContext.current,
    recentWindows: windowContext.recent,
    capabilities: {
      vision: hasVisionProvider() ? 'screen-capture+ocr+llm-description' : 'screen-capture+ocr-only (no vision-capable LLM key configured)',
      browser: automationGuard.isEnabled('browser') ? 'enabled (navigate/click/type/read)' : 'disabled — POST /api/browser/enable to arm',
      input: automationGuard.isEnabled('input') ? 'enabled (mouse/keyboard)' : 'disabled — POST /api/input/enable to arm',
      files: 'search+open, allowlisted roots only',
      windowManagement: windowContext.supported,
    },
  });
}));
router.get('/apps/discovered', (req, res) => {
  const apps = Object.keys(knownApps()).sort();
  res.json({ count: apps.length, apps });
});
router.get('/insights/status', (req, res) => res.json(proactiveAgent.status()));
module.exports = router;
