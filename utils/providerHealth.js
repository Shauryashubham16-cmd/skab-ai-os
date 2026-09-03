// Health/readiness checks for every external provider JARVIS depends on:
// the LLM providers (Gemini/Groq/OpenRouter/xAI/OpenAI/Perplexity), vision-
// capable subset of those, ElevenLabs (voice), Supabase (memory backend),
// Tavily/Exa (web search augmentation), and Open-Meteo (weather — no key
// needed).
//
// Two distinct questions per provider, kept separate on purpose:
//   configured  — is an API key present in .env at all? Free, synchronous,
//                 already what GET /health and /api/boot-status reported
//                 before this file existed.
//   reachable   — did a real network call to that provider actually
//                 succeed just now? This is new. It costs a network round
//                 trip, so results are cached for CACHE_TTL_MS and a
//                 provider that isn't configured is never dialed at all.
//
// Providers that would burn a paid API call just to prove they're up
// (search augmentation chief among them) are deliberately checked as
// "configured only" — see NO_LIVE_PING below — rather than spending the
// user's quota on every readiness poll.
const axios = require('axios');
const { PROVIDER_DEFS, circuitStatus } = require('./llmProviders');

const CACHE_TTL_MS = 30 * 1000;
const PING_TIMEOUT_MS = 5000;

const cache = new Map(); // key -> { at, result }

async function timeBoxed(fn) {
  const start = Date.now();
  try {
    await fn();
    return { reachable: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err.response ? `HTTP ${err.response.status}` : err.message };
  }
}

// Providers whose "is the key valid" check would consume real usage/quota
// (a search call, a completion) rather than hitting a free metadata
// endpoint. These report configured-only; live reachability isn't checked.
const NO_LIVE_PING = new Set(['tavily', 'exa']);

async function pingLlmProvider(key, def, apiKey) {
  // Every provider here is OpenAI-compatible (see llmProviders.js) — GET
  // {baseURL}/models is the standard, free, no-completion-consumed way to
  // prove a key authenticates, on every one of them.
  return timeBoxed(() => axios.get(`${def.baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: PING_TIMEOUT_MS,
  }));
}

async function pingElevenLabs(apiKey) {
  return timeBoxed(() => axios.get('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': apiKey },
    timeout: PING_TIMEOUT_MS,
  }));
}

async function pingSupabase(url, key) {
  // Any HTTP response (even 401 for a bad key, 404 for an unexpected path)
  // means the network path and the project itself are up — only a network-
  // level failure (DNS, timeout, connection refused) means "unreachable".
  return timeBoxed(() => axios.get(`${url.replace(/\/$/, '')}/rest/v1/`, {
    headers: { apikey: key },
    timeout: PING_TIMEOUT_MS,
    validateStatus: () => true,
  }));
}

async function pingOpenMeteo() {
  // Public, keyless, free — safe to actually call on every readiness check
  // without a cache concern beyond "don't hammer it needlessly", which the
  // shared CACHE_TTL_MS below already covers.
  return timeBoxed(() => axios.get('https://api.open-meteo.com/v1/forecast', {
    params: { latitude: 0, longitude: 0, current_weather: true },
    timeout: PING_TIMEOUT_MS,
  }));
}

function fromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.result;
}

function toCache(key, result) {
  cache.set(key, { at: Date.now(), result });
  return result;
}

async function checkLlmProviders() {
  const results = {};
  await Promise.all(Object.entries(PROVIDER_DEFS).map(async ([key, def]) => {
    const apiKey = process.env[def.apiKeyEnv];
    const configured = Boolean(apiKey);
    // circuit is the request-path breaker (utils/llmProviders.js) — separate
    // from this endpoint's own ping, so "the last few live chat requests to
    // this provider failed" is visible even between /models pings, and even
    // for a provider currently sitting out its cooldown (still worth
    // reporting configured+circuit-open rather than skipping it here too).
    const circuit = circuitStatus()[key];
    const base = { label: def.label, configured, model: process.env[def.modelEnv] || def.defaultModel, circuit };
    if (!configured) {
      results[key] = { ...base, reachable: null };
      return;
    }
    const cacheKey = `llm:${key}`;
    const cached = fromCache(cacheKey);
    const live = cached || toCache(cacheKey, await pingLlmProvider(key, def, apiKey));
    results[key] = { ...base, ...live };
  }));
  return results;
}

async function checkElevenLabs() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const configured = Boolean(apiKey && voiceId);
  if (!configured) return { configured, reachable: null };
  const cached = fromCache('elevenlabs');
  const live = cached || toCache('elevenlabs', await pingElevenLabs(apiKey));
  return { configured, ...live };
}

async function checkSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  const configured = Boolean(url && key);
  if (!configured) return { configured, reachable: null, note: 'falls back to local file memory (data/history.json) when not configured' };
  const cached = fromCache('supabase');
  const live = cached || toCache('supabase', await pingSupabase(url, key));
  return { configured, ...live };
}

async function checkSearchProviders() {
  return {
    tavily: { configured: Boolean(process.env.TAVILY_API_KEY), reachable: null, note: 'configured-only — a live check would consume a paid search credit' },
    exa: { configured: Boolean(process.env.EXA_API_KEY), reachable: null, note: 'configured-only — a live check would consume a paid search credit' },
  };
}

async function checkOpenMeteo() {
  const cached = fromCache('open-meteo');
  const live = cached || toCache('open-meteo', await pingOpenMeteo());
  return { configured: true, ...live }; // no key required — "configured" is always true
}

// The full readiness report. Cheap to call repeatedly thanks to the shared
// cache; the first call after the cache expires pays the real network cost
// (bounded to PING_TIMEOUT_MS per provider, all run in parallel).
async function checkProviders() {
  const [llm, elevenLabs, supabase, search, weather] = await Promise.all([
    checkLlmProviders(),
    checkElevenLabs(),
    checkSupabase(),
    checkSearchProviders(),
    checkOpenMeteo(),
  ]);

  const configuredCount = Object.values(llm).filter((p) => p.configured).length;
  return {
    llm,
    voice: { elevenLabs },
    memory: { supabase },
    search,
    weather: { openMeteo: weather },
    summary: {
      status: configuredCount > 0 ? 'ready' : 'degraded', // at least one LLM provider is required for the app to function
      llmProvidersConfigured: configuredCount,
    },
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { checkProviders, NO_LIVE_PING, CACHE_TTL_MS };
