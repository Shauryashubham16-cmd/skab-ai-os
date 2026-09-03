// Covers the retry-once-if-transient + per-provider circuit breaker added
// to utils/llmProviders.js. Network calls are mocked at the OpenAI SDK
// level (every provider here is OpenAI-compatible — see llmProviders.js),
// so this suite never depends on real internet access or API keys.
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const OpenAI = require('openai');

function freshLlmProviders() {
  delete require.cache[require.resolve('../utils/llmProviders')];
  return require('../utils/llmProviders');
}

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'LLM_PROVIDER_ORDER']) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = originalEnv;
  mock.restoreAll();
});

function okCompletion(text) {
  return { choices: [{ message: { content: text } }] };
}

test('chatCompletion: a transient failure (500) is retried once against the SAME provider before falling back', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  process.env.GROQ_API_KEY = 'q-key';
  const { chatCompletion, _resetCircuits } = freshLlmProviders();
  _resetCircuits();

  let calls = 0;
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async function mocked() {
    calls += 1;
    if (calls === 1) { const e = new Error('server error'); e.status = 500; throw e; }
    return okCompletion('recovered on retry');
  });

  const result = await chatCompletion([{ role: 'user', content: 'hi' }]);
  assert.equal(result.reply, 'recovered on retry');
  assert.equal(result.provider, 'Gemini'); // never had to fall back to Groq
  assert.equal(calls, 2); // first attempt + one retry, both against Gemini
});

test('chatCompletion: a non-retryable error (401) is NOT retried — falls back to the next provider immediately', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  process.env.GROQ_API_KEY = 'q-key';
  const { chatCompletion, _resetCircuits } = freshLlmProviders();
  _resetCircuits();

  let geminiCalls = 0;
  let call = 0;
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async function mocked() {
    call += 1;
    // First provider tried is Gemini (default order) — fail it with 401.
    if (call === 1) { geminiCalls += 1; const e = new Error('bad key'); e.status = 401; throw e; }
    return okCompletion('groq answered');
  });

  const result = await chatCompletion([{ role: 'user', content: 'hi' }]);
  assert.equal(result.reply, 'groq answered');
  assert.equal(geminiCalls, 1); // exactly one attempt against Gemini, no retry
});

test('circuit breaker: after enough consecutive failures, a provider is skipped without being called again', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  process.env.GROQ_API_KEY = 'q-key';
  const { chatCompletion, circuitStatus, _resetCircuits } = freshLlmProviders();
  _resetCircuits();

  let geminiAttempts = 0;
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async function mocked(args) {
    if (this === undefined) { /* noop, keep lint quiet about unused args */ }
    // Distinguish "which provider" isn't directly visible from the mock, so
    // instead: always fail for the first N calls (covers Gemini's own
    // attempt+retry across 3 separate chatCompletion() calls), then always
    // succeed — Groq should never be needed since Gemini's retry recovers...
    // Simpler: fail everything, so every call (Gemini's 2 attempts each
    // request, Groq's 1) counts toward exhausting both providers' circuits,
    // then assert Gemini's circuit is open after 3 failed requests.
    geminiAttempts += 1;
    const e = new Error('down'); e.status = 503; throw e;
  });

  // Each chatCompletion() call: Gemini fails+retries (2 calls) then Groq
  // fails+retries (2 calls) — Gemini racks up failures across requests.
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(chatCompletion([{ role: 'user', content: 'hi' }]));
  }

  const status = circuitStatus();
  assert.equal(status.gemini.open, true);
  assert.ok(status.gemini.consecutiveFailures >= 3);

  // Both providers fail identically here, so both circuits open together
  // after 3 requests. A 4th request should make NO network calls at all —
  // every configured provider is skipped via the circuit check, which is
  // exactly the point: a fully-down dependency stops costing round trips.
  const attemptsBeforeOpen = geminiAttempts;
  await assert.rejects(chatCompletion([{ role: 'user', content: 'hi' }]));
  assert.equal(geminiAttempts, attemptsBeforeOpen);
});

test('circuit breaker: a single success fully closes the circuit (resets consecutiveFailures)', async () => {
  process.env.GEMINI_API_KEY = 'g-key';
  const { chatCompletion, circuitStatus, _resetCircuits } = freshLlmProviders();
  _resetCircuits();

  let call = 0;
  mock.method(OpenAI.Chat.Completions.prototype, 'create', async function mocked() {
    call += 1;
    if (call <= 2) { const e = new Error('down'); e.status = 503; throw e; }
    return okCompletion('ok now');
  });

  // First request: fails, retries, fails again (2 failed calls) -> provider
  // fails overall, error propagates (only one provider configured).
  await assert.rejects(chatCompletion([{ role: 'user', content: 'hi' }]));
  assert.equal(circuitStatus().gemini.consecutiveFailures, 1);

  // Second request succeeds on the first attempt (call === 3) -> closes circuit.
  const result = await chatCompletion([{ role: 'user', content: 'hi' }]);
  assert.equal(result.reply, 'ok now');
  assert.equal(circuitStatus().gemini.consecutiveFailures, 0);
  assert.equal(circuitStatus().gemini.open, false);
});
