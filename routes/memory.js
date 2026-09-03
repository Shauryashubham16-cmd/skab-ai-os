const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const { listQuery } = require('../schemas');
const memory = require('../utils/memory');
const { status } = require('../utils/supabase');

const router = express.Router();

// GET /api/memory/recent?limit=30 — this user's recent prompts, for the memory panel.
// Backed by Supabase when configured, otherwise a local file (utils/memoryLocal.js) —
// either way this now always has real data, not a placeholder.
router.get('/recent', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const rows = await memory.recentActivity(req.user.id, req.query.limit);
  res.json({
    connected: true,
    backend: status.configured ? 'supabase' : 'local',
    items: rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      content: row.content,
      createdAt: row.created_at,
    })),
  });
}));

module.exports = router;
