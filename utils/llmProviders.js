const OpenAI = require('openai');

// --- Circuit breaker + retry classification --------------------------------
// Before this, a provider having a bad moment (a timeout, a 503, a transient
// rate limit) was indistinguishable from a provider being fundamentally
// unusable (bad key, model decommissioned) — both just moved straight to the
// next provider in the fallback chain, and a provider that fails 100% of the
// time still got a full-timeout attempt on every single request. Two
// improvements, kept intentionally simple (in-memory, per-process, no new
// dependency):
//
//   1. One retry, only for errors that look transient, with a short backoff,
//      before giving up on that provider and moving to the next. A 401/403
//      (bad key) or 400 (bad request) is retried zero times — retrying an
//      auth failure just wastes the timeout budget and delays the fallback
//      that will actually work.
//   2. A per-provider circuit breaker: after CIRCUIT_FAILURE_THRESHOLD
//      consecutive failures, that provider is skipped entirely (not even
//      attempted) for CIRCUIT_COOLDOWN_MS, so a provider that's fully down
//      (e.g. mid-outage) doesn't cost every subsequent request a doomed
//      network round trip — the request goes straight to the next configured
//      provider instead. A single success immediately closes the circuit.
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30 * 1000;
const RETRY_BASE_DELAY_MS = 250;

// key -> { consecutiveFailures, openUntil }
const circuitState = new Map();

function getCircuit(key) {
  let c = circuitState.get(key);
  if (!c) { c = { consecutiveFailures: 0, openUntil: 0 }; circuitState.set(key, c); }
  return c;
}

function isCircuitOpen(key) {
  const c = circuitState.get(key);
  return Boolean(c && c.openUntil > Date.now());
}

function recordSuccess(key) {
  const c = getCircuit(key);
  c.consecutiveFailures = 0;
  c.openUntil = 0;
}

function recordFailure(key) {
  const c = getCircuit(key);
  c.consecutiveFailures += 1;
  if (c.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    c.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
}

// Status-code-bearing errors (auth, bad request, not-found/model-unknown) are
// not worth retrying against the SAME provider — the second attempt will
// fail identically. Everything else (network errors, timeouts, 429/5xx,
// "empty response") is treated as transient and worth exactly one retry.
function isRetryable(err) {
  const status = err.status || err.response?.status;
  if (status && [400, 401, 403, 404].includes(status)) return false;
  return true;
}

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

// Wraps a single provider call with the retry-once-if-transient policy and
// circuit-breaker bookkeeping. `fn` is the actual network call for provider
// `key`; callers pass a closure so this stays agnostic to what the call
// shape is (chat completion, embedding, vision — all three use it).
async function withResilience(key, fn) {
  if (isCircuitOpen(key)) {
    const err = new Error('circuit open \u2014 too many recent failures, skipping for now');
    err.circuitOpen = true;
    throw err;
  }
  try {
    const result = await fn();
    recordSuccess(key);
    return result;
  } catch (err) {
    if (!isRetryable(err)) { recordFailure(key); throw err; }
    await sleep(RETRY_BASE_DELAY_MS + Math.random() * RETRY_BASE_DELAY_MS);
    try {
      const result = await fn();
      recordSuccess(key);
      return result;
    } catch (retryErr) {
      recordFailure(key);
      throw retryErr;
    }
  }
}

// Exposed for GET /api/system/health/providers and tests — lets the health
// report distinguish "not configured" from "configured but circuit open due
// to recent failures" instead of just retrying blind.
function circuitStatus() {
  const now = Date.now();
  const out = {};
  for (const [key, c] of circuitState) {
    out[key] = { consecutiveFailures: c.consecutiveFailures, open: c.openUntil > now, openForMs: c.openUntil > now ? c.openUntil - now : 0 };
  }
  return out;
}

// Test-only: force-reset breaker state between test cases so one test's
// simulated outage can't bleed into the next.
function _resetCircuits() { circuitState.clear(); }

// Every provider here exposes an OpenAI-compatible /chat/completions endpoint,
// so the only thing that differs between them is base URL, API key, and model
// name. Add a new one by adding an entry here — no other code changes needed.
const PROVIDER_DEFS = {
  gemini: {
    label: 'Gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
  },
  groq: {
    label: 'Groq',
    apiKeyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    label: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    modelEnv: 'OPENROUTER_MODEL',
    // OpenRouter's free-model lineup rotates (models get delisted with little
    // notice) — this is deliberately overridable via OPENROUTER_MODEL in .env
    // without touching code if this specific ID stops working.
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  xai: {
    label: 'Grok (xAI)',
    apiKeyEnv: 'XAI_API_KEY',
    baseURL: 'https://api.x.ai/v1',
    modelEnv: 'XAI_MODEL',
    defaultModel: 'grok-4.3',
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
  },
  perplexity: {
    label: 'Perplexity',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    baseURL: 'https://api.perplexity.ai',
    modelEnv: 'PERPLEXITY_MODEL',
    // Perplexity's "sonar" models search the live web as part of the
    // completion, so picking it also gets you built-in citations.
    defaultModel: 'sonar',
  },
};

const DEFAULT_ORDER = ['gemini', 'groq', 'openrouter', 'xai', 'openai', 'perplexity'];

// Rebuilt on every call (cheap — just reading env vars + constructing thin SDK
// clients) rather than cached at startup, so editing .env and restarting always
// picks up new keys without any other change.
// `preferred` lets an agent ask for its own provider order (e.g. the coder agent
// prefers the fastest open-weight model, the reasoner prefers the strongest one).
// Anything not listed still follows as fallback, so a preference never reduces
// resilience — it only reorders it.
function getProviders(preferred) {
  const configuredOrder = (process.env.LLM_PROVIDER_ORDER || DEFAULT_ORDER.join(','))
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const order = Array.isArray(preferred) && preferred.length
    ? [...preferred.filter((k) => configuredOrder.includes(k)), ...configuredOrder.filter((k) => !preferred.includes(k))]
    : configuredOrder;

  return order
    .map((key) => {
      const def = PROVIDER_DEFS[key];
      if (!def) {
        console.warn(`[llm] unknown provider "${key}" in LLM_PROVIDER_ORDER — skipping`);
        return null;
      }
      const apiKey = process.env[def.apiKeyEnv];
      if (!apiKey) return null; // not configured — silently skip, not an error
      return {
        key,
        label: def.label,
        model: process.env[def.modelEnv] || def.defaultModel,
        client: new OpenAI({ apiKey, baseURL: def.baseURL }),
      };
    })
    .filter(Boolean);
}

// Non-streaming: tries each configured provider in order, returns the first
// success. Every failure (bad key, rate limit, provider outage, empty reply)
// just moves to the next provider — the caller only sees an error if all of
// them failed.
async function chatCompletion(messages, { maxTokens = 1024, order, temperature } = {}) {
  const providers = getProviders(order);
  if (!providers.length) {
    throw new Error('No LLM provider configured — set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY in .env');
  }

  const errors = [];
  for (const p of providers) {
    try {
      const completion = await withResilience(p.key, () => p.client.chat.completions.create({
        model: p.model,
        max_tokens: maxTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages,
      }));
      const reply = completion.choices[0]?.message?.content ?? '';
      if (!reply.trim()) throw new Error('empty response');
      return { reply, provider: p.label, model: p.model, citations: completion.citations };
    } catch (err) {
      console.warn(`[llm] ${p.label} failed, trying next provider:`, err.message);
      errors.push(`${p.label}: ${err.message}`);
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join(' | ')}`);
}

// Streaming: same fallback logic, but only BEFORE any delta has reached the
// caller. Once a provider has started streaming real content, switching
// providers mid-response would mix two different models' text together, so a
// failure after that point surfaces as an error instead of silently retrying.
async function* chatCompletionStream(messages, { maxTokens = 1024, order } = {}) {
  const providers = getProviders(order);
  if (!providers.length) {
    throw new Error('No LLM provider configured — set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, XAI_API_KEY in .env');
  }

  const errors = [];
  for (const p of providers) {
    if (isCircuitOpen(p.key)) {
      console.warn(`[llm] ${p.label} circuit open, skipping`);
      errors.push(`${p.label}: circuit open (recent failures)`);
      continue;
    }
    let startedStreaming = false;
    try {
      const stream = await p.client.chat.completions.create({
        model: p.model,
        max_tokens: maxTokens,
        messages,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          startedStreaming = true;
          yield { delta, provider: p.label };
        }
      }
      recordSuccess(p.key);
      return;
    } catch (err) {
      console.warn(`[llm] ${p.label} stream failed${startedStreaming ? ' mid-response' : ''}:`, err.message);
      errors.push(`${p.label}: ${err.message}`);
      if (!startedStreaming) recordFailure(p.key);
      if (startedStreaming) throw new Error(`${p.label} failed mid-response: ${err.message}`);
    }
  }
  throw new Error(`All LLM providers failed — ${errors.join(' | ')}`);
}

function listProviders() {
  const configured = getProviders().map((p) => ({ key: p.key, label: p.label, model: p.model }));
  return { order: configured.map((p) => p.key), providers: configured };
}

// Providers whose default/OpenAI-compatible endpoint accepts image_url content
// parts. Not every configured provider can see images, so vision calls only
// ever try this subset — never groq/openrouter/perplexity, which would just
// error or silently ignore the image.
const VISION_CAPABLE = new Set(['gemini', 'openai', 'xai']);

function hasVisionProvider() {
  return getProviders().some((p) => VISION_CAPABLE.has(p.key));
}

// Same fallback-through-providers shape as chatCompletion, but the message is
// fixed to a single multimodal turn (text prompt + one image) rather than a
// full conversation — callers needing vision inside a longer chat should
// summarize the image reply back into their own history instead of chaining
// multimodal turns here.
async function visionCompletion(imageBase64, mimeType, prompt, { maxTokens = 700 } = {}) {
  const providers = getProviders().filter((p) => VISION_CAPABLE.has(p.key));
  if (!providers.length) {
    throw new Error('No vision-capable LLM provider configured — set GEMINI_API_KEY, OPENAI_API_KEY, or XAI_API_KEY in .env');
  }

  const errors = [];
  for (const p of providers) {
    try {
      const completion = await withResilience(p.key, () => p.client.chat.completions.create({
        model: p.model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        }],
      }));
      const reply = completion.choices[0]?.message?.content ?? '';
      if (!reply.trim()) throw new Error('empty response');
      return { reply, provider: p.label, model: p.model };
    } catch (err) {
      console.warn(`[vision] ${p.label} failed, trying next provider:`, err.message);
      errors.push(`${p.label}: ${err.message}`);
    }
  }
  throw new Error(`All vision providers failed — ${errors.join(' | ')}`);
}

// Providers whose OpenAI-compatible endpoint also serves /embeddings.
// groq/openrouter/xai/perplexity don't (or don't reliably) — semantic memory
// only ever tries this subset, and falls back to keyword search everywhere
// else in the app if neither is configured.
const EMBEDDING_MODELS = {
  gemini: 'text-embedding-004',
  openai: 'text-embedding-3-small',
};

function hasEmbeddingProvider() {
  return getProviders().some((p) => EMBEDDING_MODELS[p.key]);
}

// Returns a plain number[] embedding vector for `text`, trying each
// embedding-capable configured provider in order. Callers should treat a
// thrown error as "semantic search unavailable right now" and fall back to
// keyword matching — this is an enhancement, not a hard dependency anywhere.
async function embedText(text) {
  const providers = getProviders().filter((p) => EMBEDDING_MODELS[p.key]);
  if (!providers.length) {
    throw new Error('No embedding-capable provider configured — set GEMINI_API_KEY or OPENAI_API_KEY in .env');
  }
  const input = String(text);
  if (input.length > 8000) {
    // Every current caller (longTermMemory.js / longTermMemoryPgvector.js)
    // already rejects content this long before it gets here — this warning
    // is a defensive backstop for any future caller that doesn't, so a
    // truncation this significant is never silent.
    console.warn(`[embed] input is ${input.length} chars, truncating to 8000 for embedding — only the truncated portion will be searchable.`);
  }
  const errors = [];
  for (const p of providers) {
    try {
      const model = process.env[`${p.key.toUpperCase()}_EMBEDDING_MODEL`] || EMBEDDING_MODELS[p.key];
      const res = await withResilience(p.key, () => p.client.embeddings.create({ model, input: input.slice(0, 8000) }));
      const vector = res.data?.[0]?.embedding;
      if (!Array.isArray(vector) || !vector.length) throw new Error('empty embedding');
      return vector;
    } catch (err) {
      console.warn(`[embed] ${p.label} failed, trying next provider:`, err.message);
      errors.push(`${p.label}: ${err.message}`);
    }
  }
  throw new Error(`All embedding providers failed — ${errors.join(' | ')}`);
}

module.exports = {
  chatCompletion, chatCompletionStream, listProviders, visionCompletion, hasVisionProvider,
  embedText, hasEmbeddingProvider,
  PROVIDER_DEFS, VISION_CAPABLE,
  circuitStatus, _resetCircuits,
};
