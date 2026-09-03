const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const { sessionCreate, sessionRename, sessionParams, listQuery } = require('../schemas');
const memory = require('../utils/memory');

const router = express.Router();

// Every handler below is already behind requireAuth in server.js, and every
// query is filtered by req.user.id — one user can never touch another's history.
router.get('/', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json({ sessions: await memory.listSessions(req.user.id, req.query.limit) });
}));

router.post('/', validate({ body: sessionCreate }), asyncHandler(async (req, res) => {
  res.status(201).json({ session: await memory.createSession(req.user.id, req.body.title) });
}));

router.get('/:id/messages', validate({ params: sessionParams }), asyncHandler(async (req, res) => {
  res.json({ messages: await memory.getMessages(req.user.id, req.params.id) });
}));

router.patch('/:id', validate({ params: sessionParams, body: sessionRename }), asyncHandler(async (req, res) => {
  res.json({ session: await memory.renameSession(req.user.id, req.params.id, req.body.title) });
}));

router.delete('/:id/messages', validate({ params: sessionParams }), asyncHandler(async (req, res) => {
  await memory.clearMessages(req.user.id, req.params.id);
  res.json({ cleared: true });
}));

router.delete('/:id', validate({ params: sessionParams }), asyncHandler(async (req, res) => {
  await memory.deleteSession(req.user.id, req.params.id);
  res.json({ deleted: true });
}));

module.exports = router;
