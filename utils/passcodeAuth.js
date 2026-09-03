// Single-user passcode auth, replacing Supabase Auth.
//
// There's no signup/login/multi-account flow anymore — there's one local user
// (this machine's owner) and one shared secret word that unlocks the app.
// A correct passcode gets you a signed JWT; the JWT is what every other route
// (and the /terminal socket) checks from then on.
//
// The signing secret is generated once and cached in data/.jwt-secret so
// tokens survive a server restart but a fresh clone/install gets its own
// secret automatically — never hardcode it in source.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
const LOCAL_USER_FILE = path.join(DATA_DIR, '.local-user-id');
const TOKEN_TTL = '30d';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  ensureDataDir();
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

// One fixed "user" for the whole app now that there's no real account system.
// Kept as a real UUID (not a literal string) so it drops straight into the
// existing Supabase tables/RLS policies (chat_sessions.user_id etc.) unchanged.
function getOrCreateLocalUserId() {
  ensureDataDir();
  if (fs.existsSync(LOCAL_USER_FILE)) return fs.readFileSync(LOCAL_USER_FILE, 'utf8').trim();
  const id = crypto.randomUUID();
  fs.writeFileSync(LOCAL_USER_FILE, id);
  return id;
}

const SECRET = getOrCreateSecret();
const LOCAL_USER_ID = getOrCreateLocalUserId();

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a compare of equal length so failure timing doesn't leak length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPasscode(candidate) {
  const expected = process.env.JARVIS_PASSCODE || 'Namo';
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  return timingSafeEqualStr(candidate.trim(), expected);
}

function issueToken() {
  return jwt.sign({ sub: LOCAL_USER_ID }, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.sub !== LOCAL_USER_ID) return null;
    return { id: LOCAL_USER_ID, email: 'local@jarvis' };
  } catch {
    return null;
  }
}

module.exports = { checkPasscode, issueToken, verifyToken, LOCAL_USER_ID };
