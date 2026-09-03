// Covers the zod request schemas that gate every write-ish endpoint added
// across Phases 2-4. These are pure validation — no I/O — so failures here
// mean a real gap in what the API will accept or reject.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  taskAutoRequest, knowledgeAddRequest, imaginationSceneRequest, imaginationEditRequest,
  imaginationFromScreenRequest,
} = require('../schemas');

test('taskAutoRequest: accepts a bare goal and defaults execute to false', () => {
  const parsed = taskAutoRequest.parse({ goal: 'open notepad' });
  assert.equal(parsed.execute, false);
});

test('taskAutoRequest: rejects an empty goal', () => {
  assert.throws(() => taskAutoRequest.parse({ goal: '' }));
});

test('taskAutoRequest: rejects a goal over the 2000-char cap', () => {
  assert.throws(() => taskAutoRequest.parse({ goal: 'x'.repeat(2001) }));
});

test('knowledgeAddRequest: defaults type to "note" when omitted', () => {
  const parsed = knowledgeAddRequest.parse({ content: 'likes dark mode' });
  assert.equal(parsed.type, 'note');
});

test('knowledgeAddRequest: rejects a type outside fact/preference/note', () => {
  assert.throws(() => knowledgeAddRequest.parse({ type: 'secret', content: 'x' }));
});

test('knowledgeAddRequest: rejects empty content', () => {
  assert.throws(() => knowledgeAddRequest.parse({ content: '' }));
});

test('knowledgeAddRequest: caps tags at 10 entries', () => {
  const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
  assert.throws(() => knowledgeAddRequest.parse({ content: 'x', tags }));
});

test('imaginationSceneRequest: requires a non-empty prompt within 1000 chars', () => {
  assert.throws(() => imaginationSceneRequest.parse({ prompt: '' }));
  assert.throws(() => imaginationSceneRequest.parse({ prompt: 'x'.repeat(1001) }));
  assert.doesNotThrow(() => imaginationSceneRequest.parse({ prompt: 'a futuristic city' }));
});

test('imaginationEditRequest: requires both a scene object and an instruction', () => {
  assert.throws(() => imaginationEditRequest.parse({ scene: {} }));
  assert.throws(() => imaginationEditRequest.parse({ instruction: 'add drones' }));
  assert.doesNotThrow(() => imaginationEditRequest.parse({ scene: { objects: [] }, instruction: 'add drones' }));
});

test('imaginationFromScreenRequest: instruction is optional', () => {
  assert.doesNotThrow(() => imaginationFromScreenRequest.parse({}));
  assert.doesNotThrow(() => imaginationFromScreenRequest.parse({ instruction: 'make it nighttime' }));
});
