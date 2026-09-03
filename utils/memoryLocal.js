// Chat memory, backed by a local JSON file instead of Supabase.
//
// This is what actually makes JARVIS work out of the box: since the app is
// single-user now (see utils/passcodeAuth.js), a small file on disk is all
// the "database" it needs. Same function signatures/shapes as
// utils/memorySupabase.js so routes/chat.js, routes/sessions.js, and
// routes/memory.js never need to know which backend is active.
//
// Not built for concurrent multi-process access or huge history — it's a
// single local user's chat log, read/written synchronously. If you outgrow
// that, set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env and this file
// stops being used entirely.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'history.json');
const MAX_TURNS = 40;

function empty() {
  return { sessions: {}, messages: {} };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return empty();
  }
}

function save(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function nowISO() { return new Date().toISOString(); }

function ownedSession(db, userId, sessionId) {
  const s = db.sessions[sessionId];
  return s && s.user_id === userId ? s : null;
}

async function listSessions(userId, limit = 30) {
  const db = load();
  return Object.values(db.sessions)
    .filter((s) => s.user_id === userId)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, limit)
    .map(({ id, title, created_at, updated_at }) => ({ id, title, created_at, updated_at }));
}

async function createSession(userId, title) {
  const db = load();
  const id = crypto.randomUUID();
  const ts = nowISO();
  db.sessions[id] = { id, user_id: userId, title: title || 'New conversation', created_at: ts, updated_at: ts };
  save(db);
  const { id: sid, title: t, created_at, updated_at } = db.sessions[id];
  return { id: sid, title: t, created_at, updated_at };
}

async function assertOwnedSession(userId, sessionId) {
  const db = load();
  const s = ownedSession(db, userId, sessionId);
  if (!s) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  return s.id;
}

async function renameSession(userId, sessionId, title) {
  const db = load();
  const s = ownedSession(db, userId, sessionId);
  if (!s) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  s.title = title;
  s.updated_at = nowISO();
  save(db);
  return { id: s.id, title: s.title, updated_at: s.updated_at };
}

async function deleteSession(userId, sessionId) {
  const db = load();
  const s = ownedSession(db, userId, sessionId);
  if (!s) return;
  delete db.sessions[sessionId];
  for (const [mid, m] of Object.entries(db.messages)) {
    if (m.session_id === sessionId) delete db.messages[mid];
  }
  save(db);
}

async function getMessages(userId, sessionId, limit = MAX_TURNS * 2) {
  await assertOwnedSession(userId, sessionId);
  const db = load();
  return Object.values(db.messages)
    .filter((m) => m.session_id === sessionId && m.user_id === userId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(-limit);
}

async function loadHistory(userId, sessionId, systemPrompt) {
  const rows = await getMessages(userId, sessionId);
  const recent = rows.slice(-MAX_TURNS * 2);
  return [{ role: 'system', content: systemPrompt }, ...recent.map((r) => ({ role: r.role, content: r.content }))];
}

async function saveTurn(userId, sessionId, userMessage, assistantMessage, meta = {}) {
  const db = load();
  const s = ownedSession(db, userId, sessionId);
  if (!s) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  const ts = nowISO();
  const userId1 = crypto.randomUUID();
  const userId2 = crypto.randomUUID();
  db.messages[userId1] = { id: userId1, user_id: userId, session_id: sessionId, role: 'user', content: userMessage, agent: null, provider: null, created_at: ts };
  db.messages[userId2] = {
    id: userId2, user_id: userId, session_id: sessionId, role: 'assistant', content: assistantMessage,
    agent: meta.agent || null, provider: meta.provider || null, created_at: ts,
  };
  s.updated_at = ts;
  if (s.title === 'New conversation') {
    s.title = userMessage.replace(/\s+/g, ' ').slice(0, 60);
  }
  save(db);
}

async function clearMessages(userId, sessionId) {
  await assertOwnedSession(userId, sessionId);
  const db = load();
  for (const [mid, m] of Object.entries(db.messages)) {
    if (m.session_id === sessionId && m.user_id === userId) delete db.messages[mid];
  }
  save(db);
}

async function recentActivity(userId, limit = 30) {
  const db = load();
  return Object.values(db.messages)
    .filter((m) => m.user_id === userId && m.role === 'user')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit)
    .map(({ id, session_id, content, created_at }) => ({ id, session_id, content, created_at }));
}

module.exports = {
  listSessions,
  createSession,
  assertOwnedSession,
  renameSession,
  deleteSession,
  getMessages,
  loadHistory,
  saveTurn,
  clearMessages,
  recentActivity,
};
