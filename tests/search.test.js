const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { searchTavily, searchExa, augmentedSearch, buildContextMessage } = require('../utils/search');

let savedEnv;
beforeEach(() => { savedEnv = { ...process.env }; });
afterEach(() => { process.env = savedEnv; });

test('searchTavily: returns [] and never calls the client when no API key is set', async () => {
  delete process.env.TAVILY_API_KEY;
  const post = mock.fn(async () => { throw new Error('should not be called'); });
  const results = await searchTavily('quantum computing', 4, { http: { post } });
  assert.deepEqual(results, []);
  assert.equal(post.mock.callCount(), 0);
});

test('searchTavily: maps a successful response into the shared result shape', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  const post = mock.fn(async () => ({
    data: { results: [{ title: 'A Guide', url: 'https://example.com/a', content: 'x'.repeat(500) }] },
  }));
  const results = await searchTavily('topic', 4, { http: { post } });
  assert.equal(post.mock.callCount(), 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'Tavily');
  assert.equal(results[0].title, 'A Guide');
  assert.equal(results[0].snippet.length, 400); // truncated to 400 chars
});

test('searchTavily: a request failure is swallowed and returns [] rather than throwing', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  const post = mock.fn(async () => { throw new Error('network down'); });
  const results = await searchTavily('topic', 4, { http: { post } });
  assert.deepEqual(results, []);
});

test('searchExa: maps a successful response into the shared result shape', async () => {
  process.env.EXA_API_KEY = 'test-key';
  const post = mock.fn(async () => ({
    data: { results: [{ title: 'B Doc', url: 'https://example.com/b', text: 'hello world' }] },
  }));
  const results = await searchExa('topic', 4, { http: { post } });
  assert.equal(results[0].source, 'Exa');
  assert.equal(results[0].snippet, 'hello world');
});

test('augmentedSearch: merges both providers and passes the injected client through to both', async () => {
  process.env.TAVILY_API_KEY = 'tk';
  process.env.EXA_API_KEY = 'ek';
  const post = mock.fn(async (url) => ({
    data: { results: [{ title: url.includes('tavily') ? 'T' : 'E', url: 'https://x', content: 'c', text: 't' }] },
  }));
  const results = await augmentedSearch('topic', { http: { post } });
  assert.equal(post.mock.callCount(), 2);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.source).sort(), ['Exa', 'Tavily']);
});

test('buildContextMessage: returns null for an empty result set', () => {
  assert.equal(buildContextMessage([]), null);
});

test('buildContextMessage: formats up to 8 results into one system message', () => {
  const results = Array.from({ length: 10 }, (_, i) => ({ source: 'Tavily', title: `T${i}`, url: `https://x/${i}`, snippet: 's' }));
  const msg = buildContextMessage(results);
  assert.equal(msg.role, 'system');
  const lines = msg.content.split('\n').filter((l) => l.startsWith('['));
  assert.equal(lines.length, 8);
});
