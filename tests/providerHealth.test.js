// Health/readiness checks for external providers. Network calls are mocked
// (node:test's built-in `mock`) so this suite never depends on real
// internet access or burns real API quota — it verifies the SHAPE of the
// readiness report, the configured/reachable distinction, and the caching
// behavior, not that any particular provider is actually up right now.
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Reload the module fresh per test so its internal cache Map starts empty —
// require() caches modules, so without this a cache hit from an earlier
// test would silently skip the mocked axios call in a later one.
function freshProviderHealth() {
  delete require.cache[require.resolve('../utils/providerHealth')];
  return require('../utils/providerHealth');
}

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Start from a clean slate — no provider configured — so each test
  // controls exactly which keys are "present".
  for (const key of [
    'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY',
    'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY',
    'TAVILY_API_KEY', 'EXA_API_KEY',
  ]) delete process.env[key];
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
});

afterEach(() => {
  process.env = originalEnv;
  mock.restoreAll();
});

test('checkProviders: with nothing configured, every LLM provider reports configured:false and reachable:null (no network call made)', async () => {
  const { checkProviders } = freshProviderHealth();
  const report = await checkProviders();
  for (const provider of Object.values(report.llm)) {
    assert.equal(provider.configured, false);
    assert.equal(provider.reachable, null);
  }
  assert.equal(axios.get.mock.calls.length, 1); // only the keyless Open-Meteo check should have fired
  assert.equal(report.summary.status, 'degraded');
  assert.equal(report.summary.llmProvidersConfigured, 0);
});

test('checkProviders: a configured LLM provider triggers exactly one live ping and reports reachable:true on success', async () => {
  process.env.GEMINI_API_KEY = 'fake-key-for-test';
  const { checkProviders } = freshProviderHealth();
  const report = await checkProviders();
  assert.equal(report.llm.gemini.configured, true);
  assert.equal(report.llm.gemini.reachable, true);
  assert.equal(typeof report.llm.gemini.latencyMs, 'number');
  assert.equal(report.summary.status, 'ready');
  assert.equal(report.summary.llmProvidersConfigured, 1);
});

test('checkProviders: a configured provider whose ping fails reports reachable:false with an error, never throws', async () => {
  process.env.GROQ_API_KEY = 'fake-key-for-test';
  mock.method(axios, 'get', async () => { throw new Error('network unreachable'); });
  const { checkProviders } = freshProviderHealth();
  const report = await checkProviders();
  assert.equal(report.llm.groq.configured, true);
  assert.equal(report.llm.groq.reachable, false);
  assert.match(report.llm.groq.error, /network unreachable/);
});

test('checkProviders: search providers (Tavily/Exa) never trigger a live network call, even when configured', async () => {
  process.env.TAVILY_API_KEY = 'fake';
  process.env.EXA_API_KEY = 'fake';
  const { checkProviders, NO_LIVE_PING } = freshProviderHealth();
  assert.ok(NO_LIVE_PING.has('tavily'));
  assert.ok(NO_LIVE_PING.has('exa'));
  const callsBefore = axios.get.mock.calls.length;
  const report = await checkProviders();
  assert.equal(report.search.tavily.configured, true);
  assert.equal(report.search.tavily.reachable, null);
  assert.equal(report.search.exa.configured, true);
  assert.equal(report.search.exa.reachable, null);
  // Only Open-Meteo's keyless check should have added a call — confirms
  // Tavily/Exa truly never dial out.
  assert.equal(axios.get.mock.calls.length, callsBefore + 1);
});

test('checkProviders: Supabase reports configured:false with a helpful fallback note when unset', async () => {
  const { checkProviders } = freshProviderHealth();
  const report = await checkProviders();
  assert.equal(report.memory.supabase.configured, false);
  assert.match(report.memory.supabase.note, /local file memory/);
});

test('checkProviders: Open-Meteo is always reported as configured (no key required)', async () => {
  const { checkProviders } = freshProviderHealth();
  const report = await checkProviders();
  assert.equal(report.weather.openMeteo.configured, true);
});

test('checkProviders: repeated calls within the cache window reuse the cached result instead of pinging again', async () => {
  process.env.GEMINI_API_KEY = 'fake-key-for-test';
  const { checkProviders } = freshProviderHealth();
  await checkProviders();
  const callsAfterFirst = axios.get.mock.calls.length;
  await checkProviders();
  const callsAfterSecond = axios.get.mock.calls.length;
  assert.equal(callsAfterSecond, callsAfterFirst, 'second call within the TTL window should not have pinged again');
});
