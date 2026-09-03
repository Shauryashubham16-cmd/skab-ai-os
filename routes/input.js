const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  inputMoveRequest, inputClickRequest, inputScrollRequest,
  inputTypeRequest, inputKeyRequest, automationEnableRequest,
  inputDragDropRequest, inputClipboardWriteRequest,
} = require('../schemas');
const inputControl = require('../utils/inputControl');
const automationGuard = require('../utils/automationGuard');

const router = express.Router();

router.get('/status', (req, res) => res.json({ enabled: automationGuard.isEnabled('input'), platform: process.platform }));

// Runtime kill switch — no server restart needed to arm or disarm this.
router.post('/enable', validate({ body: automationEnableRequest }), (req, res) => {
  const enabled = automationGuard.setEnabled('input', req.body.enabled);
  res.json({ ok: true, enabled });
});

router.get('/bounds', asyncHandler(async (req, res) => {
  res.json(await inputControl.getBounds());
}));

router.post('/move', validate({ body: inputMoveRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.moveMouse(req.body.x, req.body.y);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/click', validate({ body: inputClickRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.click(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/scroll', validate({ body: inputScrollRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.scroll(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/type', validate({ body: inputTypeRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.typeText(req.body.text);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

// Raw SendKeys combos, e.g. { "keys": "^c" } for ctrl+c, { "keys": "%{F4}" } for alt+F4.
router.post('/key', validate({ body: inputKeyRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.pressKeys(req.body.keys);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/dragdrop', validate({ body: inputDragDropRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.dragDrop(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.get('/clipboard', asyncHandler(async (req, res) => {
  const result = await inputControl.clipboardRead();
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/clipboard', validate({ body: inputClipboardWriteRequest }), asyncHandler(async (req, res) => {
  const result = await inputControl.clipboardWrite(req.body.text);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

module.exports = router;
