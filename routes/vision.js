const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const { visionRequest, visionImageRequest, visionFindElementRequest, visionCompareRequest } = require('../schemas');
const { analyzeScreen, analyzeBuffer, findElement, takeSnapshot, compareToSnapshot } = require('../utils/visionService');

const router = express.Router();

// Captures the current screen and analyzes it — OCR, an LLM description, or
// both. This is Jarvis "looking at" the screen: no keystrokes, no clicks,
// just a screenshot handed to OCR/vision.
router.post('/screen', validate({ body: visionRequest }), asyncHandler(async (req, res) => {
  const result = await analyzeScreen(req.body);
  if (result.ok === false) return res.status(500).json(result);
  res.json(result);
}));

// Same analysis, but against an uploaded image instead of the live screen.
router.post('/image', validate({ body: visionImageRequest }), asyncHandler(async (req, res) => {
  const buffer = Buffer.from(req.body.imageBase64, 'base64');
  res.json(await analyzeBuffer(buffer, req.body.mimeType, req.body));
}));

// Find a UI element on the live screen by its visible text; returns click
// coordinates. OCR-based (see utils/visionService.js) — labeled elements only.
router.post('/find', validate({ body: visionFindElementRequest }), asyncHandler(async (req, res) => {
  const result = await findElement(req.body.text);
  if (result.ok === false) return res.status(500).json(result);
  res.json(result);
}));

// POST /api/vision/snapshot — capture and remember the current screen for a
// later before/after comparison.
router.post('/snapshot', asyncHandler(async (req, res) => {
  const result = await takeSnapshot();
  if (result.ok === false) return res.status(500).json(result);
  res.json(result);
}));

// POST /api/vision/compare — capture a fresh screenshot and diff it against
// an earlier snapshot; { changed, changedPercent, bbox } tell you whether —
// and roughly where — the screen actually changed.
router.post('/compare', validate({ body: visionCompareRequest }), asyncHandler(async (req, res) => {
  const result = await compareToSnapshot(req.body.snapshotId, { threshold: req.body.threshold });
  if (result.ok === false) return res.status(404).json(result);
  res.json(result);
}));

module.exports = router;
