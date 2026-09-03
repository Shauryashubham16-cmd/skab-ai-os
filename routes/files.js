const express = require('express');
const { validate } = require('../middleware/validate');
const { fileSearchQuery, fileContentSearchRequest, fileOpenRequest } = require('../schemas');
const fileSearch = require('../utils/fileSearch');

const router = express.Router();

router.get('/roots', (req, res) => res.json({ roots: fileSearch.allowedRoots() }));

router.get('/search', validate({ query: fileSearchQuery }), (req, res) => {
  const result = fileSearch.searchByName(req.query.q, { root: req.query.root });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

router.post('/search/content', validate({ body: fileContentSearchRequest }), (req, res) => {
  const result = fileSearch.searchByContent(req.body.query, { root: req.body.root, extensions: req.body.extensions });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// The path is checked against the allowlisted roots server-side before
// openPath ever runs — never a raw shell string either way.
router.post('/open', validate({ body: fileOpenRequest }), (req, res) => {
  const target = req.body.path;
  if (!fileSearch.isUnderAllowedRoot(target)) {
    return res.status(400).json({ ok: false, error: 'That path is outside the allowed search roots.' });
  }
  const result = fileSearch.openPath(target, { reveal: req.body.reveal });
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

module.exports = router;
