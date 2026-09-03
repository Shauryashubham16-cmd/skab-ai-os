// Long-term memory: durable facts, learned preferences, and task-outcome
// notes that should survive across sessions — distinct from utils/memory.js,
// which is the per-conversation chat history. Default backend is a plain
// JSON file, same pattern as memoryLocal.js: read/written synchronously,
// zero setup.
//
// Every function below is user-scoped (userId is always the first
// argument), even though this app is intentionally single-user
// (routes/auth.js issues one shared passcode session for LOCAL_USER_ID —
// see utils/passcodeAuth.js — there's no signup/multi-account flow). Kept
// user-scoped anyway as cheap defense-in-depth: it costs nothing when
// there's only ever one real userId in practice, and it means this file's
// own logic never has to special-case "what if that assumption changes,"
// it just always filters by whichever id it's given.
//
// Phase 3: semantic retrieval. Each entry gets an embedding vector at write
// time (best-effort — see embedText in llmProviders.js) and search() ranks
// by cosine similarity to the query's own embedding when one's available.
// With dozens to low-hundreds of entries a brute-force cosine scan over
// plain JS arrays is plenty fast, so this stays the default with no vector
// DB to install or run. If no embedding-capable provider is configured (see
// hasEmbeddingProvider()), or an embedding call fails, entries are stored
// without a vector and search transparently falls back to keyword-overlap
// scoring for those entries — semantic search is an enhancement, never a
// hard requirement.
//
// Real vector backend: set USE_PGVECTOR_MEMORY=true (with SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY configured, and supabase-schema-vector.sql run)
// to delegate every call below to utils/longTermMemoryPgvector.js instead —
// same API, real pgvector cosine search in Postgres rather than a JS array
// scan. Worth it once a single user's memory reaches the thousands of
// entries; overkill before that.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { embedText, hasEmbeddingProvider } = require('./llmProviders');
const { status: supabaseStatus } = require('./supabase');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'longterm.json');
const MAX_ENTRIES_PER_USER = 2000;
const VALID_TYPES = new Set(['fact', 'preference', 'note']);
// Matches schemas/index.js's knowledgeAddRequest cap on the REST route —
// duplicated here (not imported, to keep this module usable standalone/in
// tests without pulling in zod) so the same ceiling also applies to the
// memory.remember tool path (utils/toolRegistry.js), which calls add()
// directly and was never covered by that Zod schema. Without this, an LLM
// planner step could hand add() arbitrary-length content that would then
// get silently truncated at embedText's own 8000-char input cap — same
// entry stored, but only the first ~8000 characters ever searchable, with
// nothing surfaced about it anywhere. Rejecting it here instead means a
// too-long "note" is a clear error the caller sees, not silent data loss.
const MAX_CONTENT_LENGTH = 2000;

// Entries this similar to an existing one are treated as duplicates at
// write time — keeps repeated task-outcome notes and re-stated preferences
// from slowly bloating memory with near-identical lines (the "memory
// cleanup" item from the plan). Pure text equality still always dedupes,
// vector-based dedupe only kicks in when both entries have embeddings.
const DEDUPE_SIMILARITY = 0.96;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(entries) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
}

// ---- pure scoring helpers — always local to this file (not delegated to
// the pgvector backend even when it's active) so tests/longTermMemory.test.js
// can exercise the math without touching disk, Supabase, or an embedding
// provider. utils/longTermMemoryPgvector.js re-implements the same formulas
// for its own internal ranking, deliberately kept in sync by hand rather
// than shared, since the pgvector version scores rows shaped by a SQL RPC
// response, not this file's in-memory entry objects.
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

// A recency multiplier, not a hard cutoff: a strong semantic match from a
// year ago still beats a weak one from today, but among similar-strength
// matches, recent wins.
function recencyWeight(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  return 1 / (1 + ageDays / 30); // halves roughly every 30 days
}

function keywordScore(query, entry) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!words.length) return 0;
  const haystack = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
  return words.reduce((sum, w) => sum + (haystack.includes(w) ? 1 : 0), 0) / words.length;
}

function strip(entry) {
  const { vector, userId, ...rest } = entry;
  return rest;
}

// ---- JSON-file backend (default) ---------------------------------------

async function jsonAdd(userId, { type = 'note', content, tags = [] }) {
  if (!userId) throw new Error('userId is required.');
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown memory type "${type}" — expected fact, preference, or note.`);
  if (!content || !content.trim()) throw new Error('content is required.');
  const trimmed = content.trim();
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content is too long (${trimmed.length} chars, max ${MAX_CONTENT_LENGTH}) — summarize it into a shorter note instead of storing it verbatim.`);
  }
  const entries = load();
  const mine = entries.filter((e) => e.userId === userId);
  if (mine.length >= MAX_ENTRIES_PER_USER) {
    const oldest = mine.reduce((a, b) => (new Date(a.createdAt) < new Date(b.createdAt) ? a : b));
    const idx = entries.findIndex((e) => e.id === oldest.id);
    if (idx !== -1) entries.splice(idx, 1);
  }

  let vector = null;
  if (hasEmbeddingProvider()) {
    try {
      vector = await embedText(trimmed);
    } catch (err) {
      console.warn('[longTermMemory] embedding failed, storing without one (keyword search will still find it):', err.message);
    }
  }

  // Dedupe within this user's own entries only — exact text match, or
  // (when both sides have vectors) near-identical meaning.
  const dupe = entries.find((e) => {
    if (e.userId !== userId) return false;
    if (e.content.trim().toLowerCase() === trimmed.toLowerCase()) return true;
    return vector && e.vector && cosineSimilarity(vector, e.vector) >= DEDUPE_SIMILARITY;
  });
  if (dupe) {
    dupe.createdAt = new Date().toISOString();
    dupe.tags = Array.from(new Set([...dupe.tags, ...(tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)])).slice(0, 10);
    save(entries);
    return strip(dupe);
  }

  const entry = {
    id: crypto.randomUUID(),
    userId,
    type,
    content: trimmed,
    tags: (tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 10),
    createdAt: new Date().toISOString(),
    vector,
  };
  entries.unshift(entry);
  save(entries);
  return strip(entry);
}

function jsonList(userId, { type, limit = 100 } = {}) {
  const entries = load().filter((e) => e.userId === userId);
  const filtered = type ? entries.filter((e) => e.type === type) : entries;
  return filtered.slice(0, limit).map(strip);
}

function jsonRemove(userId, id) {
  const entries = load();
  const next = entries.filter((e) => !(e.id === id && e.userId === userId));
  const removed = next.length !== entries.length;
  if (removed) save(next);
  return removed;
}

// Ranks entries by semantic similarity (cosine, when both the query and an
// entry have vectors) blended with keyword overlap and recency. Never
// throws on embedding failure — silently degrades to pure keyword-overlap
// search.
async function jsonSearch(userId, query, { limit = 10 } = {}) {
  const entries = load().filter((e) => e.userId === userId);
  if (!entries.length) return [];

  let queryVector = null;
  if (hasEmbeddingProvider()) {
    try {
      queryVector = await embedText(query);
    } catch (err) {
      console.warn('[longTermMemory] query embedding failed, falling back to keyword search:', err.message);
    }
  }

  const scored = entries.map((e) => {
    const kw = keywordScore(query, e);
    const semantic = queryVector && e.vector ? cosineSimilarity(queryVector, e.vector) : 0;
    const score = (semantic * 0.7 + kw * 0.3) * (0.7 + 0.3 * recencyWeight(e.createdAt));
    return { entry: e, score, semantic, kw };
  }).filter((s) => s.semantic > 0.2 || s.kw > 0);

  scored.sort((a, b) => b.score - a.score || new Date(b.entry.createdAt) - new Date(a.entry.createdAt));
  return scored.slice(0, limit).map((s) => strip(s.entry));
}

// "Memory cleanup": drop entries that are neither recent nor a kept type.
// Simple by design — a full usage-tracked eviction policy is more machinery
// than a personal assistant's memory size actually needs. Run manually or
// on a schedule via routes/knowledge.js; never runs automatically on its own.
function jsonCleanup(userId, { maxAgeDays = 180, keepTypes = ['fact', 'preference'] } = {}) {
  const entries = load();
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const next = entries.filter((e) => {
    if (e.userId !== userId) return true; // never touch other users' entries
    return keepTypes.includes(e.type) || new Date(e.createdAt).getTime() >= cutoff;
  });
  const removedCount = entries.length - next.length;
  if (removedCount > 0) save(next);
  return { removedCount, remaining: next.filter((e) => e.userId === userId).length };
}

// ---- backend selection ---------------------------------------------------
// Lazily required so a plain JSON setup (the default) never even loads
// @supabase/supabase-js's request path for this feature.
const usePgvector = process.env.USE_PGVECTOR_MEMORY === 'true' && supabaseStatus.configured;
const pgvector = usePgvector ? require('./longTermMemoryPgvector') : null;

if (process.env.USE_PGVECTOR_MEMORY === 'true' && !supabaseStatus.configured) {
  console.warn('[longTermMemory] USE_PGVECTOR_MEMORY=true but Supabase is not configured — falling back to the local JSON backend.');
}

const add = usePgvector ? pgvector.add : jsonAdd;
const list = usePgvector ? pgvector.list : jsonList;
const remove = usePgvector ? pgvector.remove : jsonRemove;
const search = usePgvector ? pgvector.search : jsonSearch;
const cleanup = usePgvector ? pgvector.cleanup : jsonCleanup;

module.exports = {
  add, list, remove, search, cleanup,
  // Exported in addition to the public API above purely so tests/ can cover
  // the scoring math directly without touching disk, Supabase, or an
  // embedding provider — not intended as a stable API for other modules to
  // call, and always the local implementation regardless of which backend
  // is active (see comment above).
  cosineSimilarity, keywordScore, recencyWeight,
};
