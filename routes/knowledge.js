const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  knowledgeAddRequest, knowledgeListQuery, knowledgeSearchQuery, knowledgeIdParams,
} = require('../schemas');
const longTermMemory = require('../utils/longTermMemory');
const { hasEmbeddingProvider } = require('../utils/llmProviders');

const router = express.Router();

router.get('/', validate({ query: knowledgeListQuery }), asyncHandler(async (req, res) => {
  const entries = await longTermMemory.list(req.user.id, { type: req.query.type, limit: req.query.limit });
  res.json({ entries });
}));

// GET /api/knowledge/search — semantic when an embedding-capable provider
// is configured, keyword-overlap otherwise (search() degrades on its own).
router.get('/search', validate({ query: knowledgeSearchQuery }), asyncHandler(async (req, res) => {
  const entries = await longTermMemory.search(req.user.id, req.query.q, { limit: req.query.limit });
  res.json({ entries, semantic: hasEmbeddingProvider() });
}));

router.post('/', validate({ body: knowledgeAddRequest }), asyncHandler(async (req, res) => {
  const entry = await longTermMemory.add(req.user.id, req.body);
  res.status(201).json({ ok: true, entry });
}));

router.delete('/:id', validate({ params: knowledgeIdParams }), asyncHandler(async (req, res) => {
  const removed = await longTermMemory.remove(req.user.id, req.params.id);
  if (!removed) return res.status(404).json({ ok: false, error: 'No entry with that id.' });
  res.json({ ok: true, removed: true });
}));

// POST /api/knowledge/cleanup — manual trigger for the "memory cleanup"
// pass (drops old notes; facts/preferences are kept by default). Never runs
// on its own — see utils/longTermMemory.js.
router.post('/cleanup', asyncHandler(async (req, res) => {
  const { maxAgeDays, keepTypes } = req.body || {};
  const result = await longTermMemory.cleanup(req.user.id, { maxAgeDays, keepTypes });
  res.json({ ok: true, ...result });
}));

module.exports = router;
