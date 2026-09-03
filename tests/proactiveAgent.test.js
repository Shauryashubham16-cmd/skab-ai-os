// Covers parseDecision only — the pure "did the LLM give us a usable
// decision" logic. The tick()/start() functions touch the scheduler,
// calendarStore, contextAwareness and a real LLM call, which is an
// integration concern deliberately not exercised here, same convention as
// tests/calendarStore.test.js only covering computeRemindAt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecision } = require('../utils/proactiveAgent');

test('parses a clean strict-JSON response', () => {
  const decision = parseDecision('{"shouldNotify": true, "message": "Meeting in 10 minutes"}');
  assert.deepEqual(decision, { shouldNotify: true, message: 'Meeting in 10 minutes' });
});

test('tolerates a ```json fence around the object', () => {
  const decision = parseDecision('```json\n{"shouldNotify": false, "message": ""}\n```');
  assert.equal(decision.shouldNotify, false);
});

test('tolerates stray prose before/after the JSON object', () => {
  const raw = 'Sure, here you go:\n{"shouldNotify": true, "message": "Battery is low"}\nLet me know if you need more.';
  const decision = parseDecision(raw);
  assert.equal(decision.shouldNotify, true);
  assert.equal(decision.message, 'Battery is low');
});

test('non-JSON garbage never throws — defaults to no notification', () => {
  assert.deepEqual(parseDecision('not json at all'), { shouldNotify: false, message: '' });
  assert.deepEqual(parseDecision(''), { shouldNotify: false, message: '' });
  assert.deepEqual(parseDecision('{broken'), { shouldNotify: false, message: '' });
});

test('shouldNotify must be a real boolean true, not just truthy', () => {
  const decision = parseDecision('{"shouldNotify": "yes", "message": "hi"}');
  assert.equal(decision.shouldNotify, false); // string "yes" !== true — fails closed
});

test('message is truncated to the max length', () => {
  const longMsg = 'x'.repeat(500);
  const decision = parseDecision(JSON.stringify({ shouldNotify: true, message: longMsg }));
  assert.ok(decision.message.length <= 220);
});
