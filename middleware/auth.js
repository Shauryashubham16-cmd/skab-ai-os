const { verifyToken } = require('../utils/passcodeAuth');

function bearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

// Hard gate: no valid JARVIS session token, no access. Every /api route except
// /api/auth/* and /health sits behind this.
function requireAuth(req, res, next) {
  const user = verifyToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  return next();
}

module.exports = { requireAuth, bearer };
