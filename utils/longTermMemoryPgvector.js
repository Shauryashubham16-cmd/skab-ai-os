// Real vector-based long-term memory: Postgres + pgvector via Supabase,
// instead of the brute-force in-process cosine scan in longTermMemory.js.
// Same public API (add/list/remove/search/cleanup) and the same shape of
// entry, so utils/longTermMemory.js can delegate to this file transparently
// — routes/knowledge.js and everything else never needs to know which
// backend is active. See supabase-schema-vector.sql for the table + RPC
// this depends on, and README.md for the opt-in flag (USE_PGVECTOR_MEMORY).
const crypto = require('crypto');
const { requireAdmin } = require('./supabase');
const { embedText, hasEmbeddingProvider } = require('./llmProviders');

const VALID_TYPES = new Set(['fact', 'preference', 'note']);
const DEDUPE_SIMILARITY = 0.96;
const TABLE = 'long_term_memory';
// Same ceiling and same reasoning as longTermMemory.js's MAX_CONTENT_LENGTH
// — kept in sync by hand, deliberately, same as this file's own header
// comment already does for the scoring helpers above.
const MAX_CONTENT_LENGTH = 2000;

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function recencyWeight(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  return 1 / (1 + ageDays / 30);
}

function keywordScore(query, entry) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const haystack = `${entry.content} ${(entry.tags || []).join(' ')}`.toLowerCase();
  return words.reduce((sum, w) => sum + (haystack.includes(w) ? 1 : 0), 0) / words.length;
}

// Every user's memory is scoped by userId — required here (unlike the
// single-file JSON backend, where scoping is the caller's problem) since
// Postgres rows from every user share one table.
async function add(userId, { type = 'note', content, tags = [] }) {
  if (!userId) throw new Error('userId is required.');
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown memory type "${type}" — expected fact, preference, or note.`);
  if (!content || !content.trim()) throw new Error('content is required.');
  const trimmed = content.trim();
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content is too long (${trimmed.length} chars, max ${MAX_CONTENT_LENGTH}) — summarize it into a shorter note instead of storing it verbatim.`);
  }
  const cleanTags = (tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10);
  const db = requireAdmin();

  let vector = null;
  if (hasEmbeddingProvider()) {
    try {
      vector = await embedText(trimmed);
    } catch (err) {
      console.warn('[longTermMemoryPgvector] embedding failed, storing without one:', err.message);
    }
  }

  // Dedupe: exact text match always; near-identical meaning only when this
  // entry has a vector (an RPC round trip per write is worth it here —
  // writes are rare compared to reads/searches).
  const { data: exact } = await db.from(TABLE).select('*').eq('user_id', userId).ilike('content', trimmed).limit(1);
  let dupe = exact && exact[0];
  if (!dupe && vector) {
    const { data: near } = await db.rpc('match_long_term_memory', {
      p_user_id: userId, p_query_embedding: vector, p_match_count: 1,
    });
    if (near && near[0] && near[0].similarity >= DEDUPE_SIMILARITY) {
      const { data: full } = await db.from(TABLE).select('*').eq('id', near[0].id).single();
      dupe = full;
    }
  }
  if (dupe) {
    const mergedTags = Array.from(new Set([...(dupe.tags || []), ...cleanTags])).slice(0, 10);
    const { data: updated, error } = await db.from(TABLE)
      .update({ created_at: new Date().toISOString(), tags: mergedTags })
      .eq('id', dupe.id).select().single();
    if (error) throw error;
    return strip(updated);
  }

  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    type,
    content: trimmed,
    tags: cleanTags,
    embedding: vector,
    created_at: new Date().toISOString(),
  };
  const { data: inserted, error } = await db.from(TABLE).insert(row).select().single();
  if (error) throw error;
  return strip(inserted);
}

async function list(userId, { type, limit = 100 } = {}) {
  const db = requireAdmin();
  let query = db.from(TABLE).select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(strip);
}

async function remove(userId, id) {
  const db = requireAdmin();
  const { data, error } = await db.from(TABLE).delete().eq('id', id).eq('user_id', userId).select();
  if (error) throw error;
  return (data || []).length > 0;
}

// Ranks by pgvector cosine similarity (via the match_long_term_memory RPC)
// blended with keyword overlap and recency — same weighting formula as the
// original in-process implementation, so switching backends doesn't change
// what a search feels like.
async function search(userId, query, { limit = 10 } = {}) {
  const db = requireAdmin();

  let queryVector = null;
  if (hasEmbeddingProvider()) {
    try {
      queryVector = await embedText(query);
    } catch (err) {
      console.warn('[longTermMemoryPgvector] query embedding failed, falling back to keyword search:', err.message);
    }
  }

  if (queryVector) {
    const { data, error } = await db.rpc('match_long_term_memory', {
      p_user_id: userId, p_query_embedding: queryVector, p_match_count: Math.max(limit * 3, 30),
    });
    if (error) throw error;
    const scored = (data || []).map((e) => {
      const kw = keywordScore(query, e);
      const score = (e.similarity * 0.7 + kw * 0.3) * (0.7 + 0.3 * recencyWeight(e.created_at));
      return { entry: e, score };
    }).filter((s) => s.entry.similarity > 0.2 || s.score > 0);
    scored.sort((a, b) => b.score - a.score || new Date(b.entry.created_at) - new Date(a.entry.created_at));
    return scored.slice(0, limit).map((s) => strip(s.entry));
  }

  // No embedding available at all (no provider configured, or the call
  // failed) — pure keyword search over this user's rows, same degrade path
  // the original module takes.
  const { data, error } = await db.from(TABLE).select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  const scored = (data || [])
    .map((e) => ({ entry: e, kw: keywordScore(query, e) }))
    .filter((s) => s.kw > 0);
  scored.sort((a, b) => b.kw - a.kw || new Date(b.entry.created_at) - new Date(a.entry.created_at));
  return scored.slice(0, limit).map((s) => strip(s.entry));
}

async function cleanup(userId, { maxAgeDays = 180, keepTypes = ['fact', 'preference'] } = {}) {
  const db = requireAdmin();
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const { data, error } = await db.from(TABLE)
    .delete()
    .eq('user_id', userId)
    .lt('created_at', cutoff)
    .not('type', 'in', `(${keepTypes.join(',')})`)
    .select();
  if (error) throw error;
  const removedCount = (data || []).length;
  const { count } = await db.from(TABLE).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return { removedCount, remaining: count || 0 };
}

function strip(row) {
  if (!row) return row;
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    tags: row.tags || [],
    createdAt: row.created_at,
  };
}

module.exports = {
  add, list, remove, search, cleanup,
  cosineSimilarity, keywordScore, recencyWeight,
};
