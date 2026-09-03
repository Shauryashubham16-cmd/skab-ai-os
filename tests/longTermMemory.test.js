// Covers the pure scoring math behind semantic search (cosineSimilarity,
// keywordScore, recencyWeight) without touching disk or an embedding
// provider — add()/search()'s file I/O and network calls are integration
// concerns, deliberately not exercised here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity, keywordScore, recencyWeight } = require('../utils/longTermMemory');

test('cosineSimilarity: identical vectors score 1', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test('cosineSimilarity: orthogonal vectors score 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: opposite vectors score -1', () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: mismatched lengths or missing vectors score 0 instead of throwing', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity(null, [1, 2]), 0);
  assert.equal(cosineSimilarity([1, 2], undefined), 0);
});

test('cosineSimilarity: a zero vector scores 0 rather than dividing by zero', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('keywordScore: full overlap of significant words scores 1', () => {
  const entry = { content: 'the user prefers dark mode in the editor', tags: [] };
  assert.equal(keywordScore('dark mode editor', entry), 1);
});

test('keywordScore: no overlap scores 0', () => {
  const entry = { content: 'likes bubble tea', tags: [] };
  assert.equal(keywordScore('favorite programming language', entry), 0);
});

test('keywordScore: short (<=2 char) words are ignored so they cannot dominate the score', () => {
  const entry = { content: 'a b c long meaningful phrase', tags: [] };
  // "to" and "is" are filtered as noise; only "long"/"phrase" carry the query
  assert.equal(keywordScore('is to long phrase', entry), 1);
});

test('keywordScore: tags count toward the match same as content', () => {
  const entry = { content: 'unrelated sentence here', tags: ['task-outcome'] };
  assert.ok(keywordScore('task outcome', entry) > 0);
});

test('recencyWeight: a fact from right now scores at (or fractionally under, from real elapsed ms) the maximum, 1', () => {
  // Not a strict-equal to 1: recencyWeight(createdAt) computes ageDays from
  // Date.now() at call time, so even a few real elapsed milliseconds between
  // building `createdAt` and calling this makes it *fractionally* under 1 —
  // that's correct behavior, not a bug, so the assertion allows for it
  // instead of being flaky under real timing.
  const weight = recencyWeight(new Date().toISOString());
  assert.ok(weight <= 1);
  assert.ok(weight > 0.999);
});

test('recencyWeight: older entries score strictly lower, never negative', () => {
  const now = recencyWeight(new Date().toISOString());
  const monthOld = recencyWeight(new Date(Date.now() - 30 * 86400000).toISOString());
  const yearOld = recencyWeight(new Date(Date.now() - 365 * 86400000).toISOString());
  assert.ok(monthOld < now);
  assert.ok(yearOld < monthOld);
  assert.ok(yearOld > 0);
});

// add()'s content-length guard, exercised directly (no embedding provider
// configured in this test environment, so add() falls back to storing
// without a vector — exactly the "keyword search still works" path its own
// comments describe, and exactly why this guard needed to exist independent
// of embedText's own truncate-and-warn behavior: a too-long note should
// never even reach the point of silently losing its tail end).
test('add() rejects content over the length cap instead of silently truncating', async () => {
  const { add, remove } = require('../utils/longTermMemory');
  const tooLong = 'x'.repeat(2001);
  await assert.rejects(() => add('test-user-len-cap', { content: tooLong }), /too long/);
});

test('add() accepts content right at the length cap', async () => {
  const { add, remove } = require('../utils/longTermMemory');
  const exactly2000 = 'y'.repeat(2000);
  const entry = await add('test-user-len-cap', { content: exactly2000 });
  assert.equal(entry.content.length, 2000);
  await remove('test-user-len-cap', entry.id); // clean up after ourselves — this hits the real data/longterm.json file
});
