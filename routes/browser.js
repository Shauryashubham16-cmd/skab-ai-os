const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  browserNavigateRequest, browserSelectorRequest, browserTypeRequest,
  browserGetTextRequest, automationEnableRequest, browserScrollRequest,
  browserTabIndexRequest, browserNewTabRequest, browserDownloadRequest,
  browserVerifyRequest,
} = require('../schemas');
const browserAutomation = require('../utils/browserAutomation');
const automationGuard = require('../utils/automationGuard');

const router = express.Router();

router.get('/status', asyncHandler(async (req, res) => {
  const live = await browserAutomation.status();
  res.json({ enabled: automationGuard.isEnabled('browser'), ...live });
}));

// Runtime kill switch — no server restart needed to arm or disarm this.
router.post('/enable', validate({ body: automationEnableRequest }), (req, res) => {
  const enabled = automationGuard.setEnabled('browser', req.body.enabled);
  res.json({ ok: true, enabled });
});

router.post('/navigate', validate({ body: browserNavigateRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.navigate(req.body.url);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/click', validate({ body: browserSelectorRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.click(req.body.selector);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/type', validate({ body: browserTypeRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.typeInto(req.body.selector, req.body.text);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/read', validate({ body: browserGetTextRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.getText(req.body.selector);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/scroll', validate({ body: browserScrollRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.scroll(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.get('/tabs', asyncHandler(async (req, res) => {
  const result = await browserAutomation.listTabs();
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/tabs/new', validate({ body: browserNewTabRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.newTab(req.body.url);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/tabs/switch', validate({ body: browserTabIndexRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.switchTab(req.body.index);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/tabs/close', validate({ body: browserTabIndexRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.closeTab(req.body.index);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/download', validate({ body: browserDownloadRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.download(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/verify', validate({ body: browserVerifyRequest }), asyncHandler(async (req, res) => {
  const result = await browserAutomation.verify(req.body);
  if (result.ok === false) return res.status(400).json(result);
  res.json(result);
}));

router.post('/screenshot', asyncHandler(async (req, res) => {
  const result = await browserAutomation.screenshot();
  if (result.ok === false) return res.status(400).json(result);
  res.json({ ok: true, mimeType: result.mimeType, imageBase64: result.buffer.toString('base64') });
}));

router.post('/close', asyncHandler(async (req, res) => {
  res.json(await browserAutomation.close());
}));

module.exports = router;
