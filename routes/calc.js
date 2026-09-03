const express = require('express');
const { validate } = require('../middleware/validate');
const { calcEvaluateRequest } = require('../schemas');
const { safeEvaluate, CONSTANTS, FUNCTIONS } = require('../utils/calculator');

const router = express.Router();

// In-memory, per-user, most-recent-first — same "small, ephemeral, no new
// storage file needed" choice as taskEngine's runs map. A calculator history
// resetting on restart is a fine tradeoff; it's scratch work, not data.
const MAX_HISTORY = 25;
const history = new Map(); // userId -> [{ expression, result, at }]

// Per-user variable scope, same lifetime/tradeoff as history above. `ans`
// is implicit — always the previous successful result, threaded into every
// call automatically — while named variables (`x = 5`, then `x * 2`) come
// from utils/calculator.js's `assignedName` on an assignment expression.
// Kept as its own Map rather than folded into history so clearing history
// doesn't surprise-reset a variable someone's mid-calculation with.
const MAX_VARS = 20; // a personal calculator scope, not a spreadsheet
const scopes = new Map(); // userId -> { ans?: number, [name]: number }

// GET /api/calc/reference — the constants/functions this evaluator supports,
// so the frontend can render a real hint instead of a hardcoded guess.
router.get('/reference', (req, res) => {
  res.json({ constants: Object.keys(CONSTANTS), functions: FUNCTIONS });
});

// GET /api/calc/history
router.get('/history', (req, res) => {
  res.json({ history: history.get(req.user.id) || [] });
});

// GET /api/calc/vars — current `ans` + any named variables for this user,
// so the frontend can show what's actually available to reference.
router.get('/vars', (req, res) => {
  res.json({ vars: scopes.get(req.user.id) || {} });
});

// POST /api/calc/evaluate — { expression: string }
router.post('/evaluate', validate({ body: calcEvaluateRequest }), (req, res) => {
  const scope = scopes.get(req.user.id) || {};
  const outcome = safeEvaluate(req.body.expression, scope);
  if (outcome.ok) {
    const list = history.get(req.user.id) || [];
    list.unshift({ expression: outcome.expression, result: outcome.result, at: new Date().toISOString() });
    if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
    history.set(req.user.id, list);

    const nextScope = { ...scope, ans: outcome.result };
    if (outcome.assignedName) {
      nextScope[outcome.assignedName] = outcome.result;
      // Oldest-assigned-first eviction once past MAX_VARS, so a long
      // session can't grow this without bound — `ans` is exempt, it's
      // always just overwritten, never counted as one of the named slots.
      const names = Object.keys(nextScope).filter((n) => n !== 'ans');
      while (names.length > MAX_VARS) delete nextScope[names.shift()];
    }
    scopes.set(req.user.id, nextScope);
  }
  res.json(outcome);
});

router.delete('/history', (req, res) => {
  history.delete(req.user.id);
  res.json({ ok: true });
});

// DELETE /api/calc/vars — clear ans + all named variables for this user,
// independent of history (see the comment on `scopes` above).
router.delete('/vars', (req, res) => {
  scopes.delete(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
