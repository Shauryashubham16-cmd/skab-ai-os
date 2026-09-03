// Chat memory, backed by Supabase, always scoped to one user.
// Used when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set in .env; see
// utils/memory.js for the local-file fallback used when they aren't.
const { requireAdmin } = require('./supabase');
const MAX_TURNS = 40;

async function listSessions(userId, limit = 30) {
  const supabase = requireAdmin();
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id, title, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

async function createSession(userId, title) {
  const supabase = requireAdmin();
  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({ user_id: userId, title: title || 'New conversation' })
    .select('id, title, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

// Confirms the session exists AND belongs to this user before anything is read
// or written against it — this is what makes a guessed/forged session id useless.
async function assertOwnedSession(userId, sessionId) {
  const supabase = requireAdmin();
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  return data.id;
}

async function renameSession(userId, sessionId, title) {
  const supabase = requireAdmin();
  await assertOwnedSession(userId, sessionId);
  const { data, error } = await supabase
    .from('chat_sessions')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select('id, title, updated_at')
    .single();
  if (error) throw error;
  return data;
}

async function deleteSession(userId, sessionId) {
  const supabase = requireAdmin();
  const { error } = await supabase
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', userId);
  if (error) throw error;
}

async function getMessages(userId, sessionId, limit = MAX_TURNS * 2) {
  const supabase = requireAdmin();
  await assertOwnedSession(userId, sessionId);
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, role, content, agent, provider, created_at')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data;
}

// Builds the message array sent to the model: system prompt + trailing history.
async function loadHistory(userId, sessionId, systemPrompt) {
  const rows = await getMessages(userId, sessionId);
  const recent = rows.slice(-MAX_TURNS * 2);
  return [{ role: 'system', content: systemPrompt }, ...recent.map((r) => ({ role: r.role, content: r.content }))];
}

async function saveTurn(userId, sessionId, userMessage, assistantMessage, meta = {}) {
  const supabase = requireAdmin();
  const { error } = await supabase.from('chat_messages').insert([
    { user_id: userId, session_id: sessionId, role: 'user', content: userMessage },
    {
      user_id: userId,
      session_id: sessionId,
      role: 'assistant',
      content: assistantMessage,
      agent: meta.agent || null,
      provider: meta.provider || null,
    },
  ]);
  if (error) throw error;

  const patch = { updated_at: new Date().toISOString() };
  // First user message doubles as the conversation title, like every chat app.
  const { data: existing } = await supabase
    .from('chat_sessions')
    .select('title')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing && existing.title === 'New conversation') {
    patch.title = userMessage.replace(/\s+/g, ' ').slice(0, 60);
  }
  await supabase.from('chat_sessions').update(patch).eq('id', sessionId).eq('user_id', userId);
}

async function clearMessages(userId, sessionId) {
  const supabase = requireAdmin();
  await assertOwnedSession(userId, sessionId);
  const { error } = await supabase
    .from('chat_messages')
    .delete()
    .eq('session_id', sessionId)
    .eq('user_id', userId);
  if (error) throw error;
}

async function recentActivity(userId, limit = 30) {
  const supabase = requireAdmin();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, session_id, content, created_at')
    .eq('user_id', userId)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
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
