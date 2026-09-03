const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { unlockRequest } = require('../schemas');
const { checkPasscode, issueToken } = require('../utils/passcodeAuth');

const router = express.Router();

// This is now the ONLY unauthenticated surface in the app, and it's a single
// guessable word instead of an email+password pair, so it gets the strictest
// limiter here: a handful of tries per window, then a lockout. This does not
// make a shared passcode as strong as real per-user auth — see README.
const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes.' },
});

// POST /api/auth/unlock — the entire "sign in" flow now.
router.post('/unlock', unlockLimiter, validate({ body: unlockRequest }), (req, res) => {
  if (!checkPasscode(req.body.code)) {
    return res.status(401).json({ error: 'Incorrect codeword' });
  }
  const token = issueToken();
  res.json({ session: { access_token: token }, user: { id: 'local', email: 'local@jarvis' } });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// POST /api/auth/logout — purely client-side (discard the token); nothing to
// revoke server-side since tokens are stateless JWTs.
router.post('/logout', requireAuth, (req, res) => res.json({ ok: true }));

module.exports = router;
