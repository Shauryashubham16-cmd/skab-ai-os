// Covers utils/taskPlanner.js — extracted out of utils/taskEngine.js so the
// LLM-facing planning/correction/verification contract (prompt text, JSON
// parsing, step-count capping) can be tested without dragging in the full
// task engine's runs Map, taskStore, or event bus. chatCompletion itself is
// mocked here (via utils/llmProviders' exported function), so this suite
// never makes a real network call.
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module instances per test, with llmProviders mocked BEFORE
// taskPlanner is required — taskPlanner destructures `chatCompletion` at
// require time, so the mock has to already be in place on the llmProviders
// module object for that destructure to capture it.
function freshTaskPlanner(mockedReply) {
  delete require.cache[require.resolve('../utils/llmProviders')];
  delete require.cache[require.resolve('../utils/taskPlanner')];
  const llmProviders = require('../utils/llmProviders');
  mock.method(llmProviders, 'chatCompletion', async () => ({ reply: mockedReply, provider: 'Mock', model: 'mock-model' }));
  return require('../utils/taskPlanner');
}

afterEach(() => {
  mock.restoreAll();
});

test('proposePlan: parses a well-formed plan and trims each step to {tool,args,why}', async () => {
  const { proposePlan } = freshTaskPlanner(JSON.stringify({
    steps: [{ tool: 'apps.open', args: { app: 'notepad' }, why: 'open notepad', extra: 'should be dropped' }],
    notes: 'straightforward',
  }));
  const result = await proposePlan('open notepad');
  assert.deepEqual(result.steps, [{ tool: 'apps.open', args: { app: 'notepad' }, why: 'open notepad' }]);
  assert.equal(result.notes, 'straightforward');
});

test('proposePlan: caps steps at MAX_STEPS even if the LLM returns more', async () => {
  // MAX_STEPS itself isn't known until taskPlanner is required, so build the
  // oversized step list generously (20 is comfortably above the real cap)
  // and just assert the result never exceeds whatever MAX_STEPS turns out
  // to be, rather than needing it before the require.
  const oversized = { steps: Array.from({ length: 20 }, (_, i) => ({ tool: `tool.${i}`, args: {} })) };
  const { proposePlan, MAX_STEPS } = freshTaskPlanner(JSON.stringify(oversized));
  const result = await proposePlan('do a lot of things');
  assert.equal(result.steps.length, MAX_STEPS);
  assert.ok(result.steps.length < 20);
});

test('proposePlan: drops malformed step entries (missing/non-string tool) instead of throwing', async () => {
  const { proposePlan } = freshTaskPlanner(JSON.stringify({
    steps: [{ tool: 'ok.tool', args: {} }, { args: {} }, null, { tool: 42 }],
  }));
  const result = await proposePlan('goal');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tool, 'ok.tool');
});

test('proposePlan: throws a clear error when the LLM reply is not valid JSON with a steps array', async () => {
  const { proposePlan } = freshTaskPlanner('not json at all');
  await assert.rejects(proposePlan('goal'), /not a valid step list/);
});

test('proposePlan: an empty steps array is a legitimate "no tool needed" plan, not an error', async () => {
  const { proposePlan } = freshTaskPlanner(JSON.stringify({ steps: [], notes: 'just conversation' }));
  const result = await proposePlan('what time is it in Tokyo');
  assert.deepEqual(result.steps, []);
  assert.equal(result.notes, 'just conversation');
});

test('correctStep: parses a corrected single-step replacement', async () => {
  const { correctStep } = freshTaskPlanner(JSON.stringify({ steps: [{ tool: 'files.search', args: { query: 'report' }, why: 'retry with broader query' }] }));
  const fixed = await correctStep('find my report', { tool: 'files.search', args: { query: 'nonexistent.txt' } }, 'not found');
  assert.deepEqual(fixed, { tool: 'files.search', args: { query: 'report' }, why: 'retry with broader query' });
});

test('correctStep: an empty steps array (LLM giving up) returns null, not an empty object', async () => {
  const { correctStep } = freshTaskPlanner(JSON.stringify({ steps: [] }));
  const fixed = await correctStep('goal', { tool: 'x', args: {} }, 'still broken');
  assert.equal(fixed, null);
});

test('correctStep: never throws — an LLM/parsing failure returns null so the caller treats it as unrecoverable', async () => {
  const { correctStep } = freshTaskPlanner('garbage, not json');
  const fixed = await correctStep('goal', { tool: 'x', args: {} }, 'error');
  assert.equal(fixed, null);
});

test('verifyGoal: parses achieved:true/false with reasoning', async () => {
  const { verifyGoal } = freshTaskPlanner(JSON.stringify({ achieved: true, reasoning: 'all steps succeeded' }));
  const result = await verifyGoal('open notepad', [{ step: { tool: 'apps.open' }, result: { ok: true } }]);
  assert.equal(result.achieved, true);
  assert.equal(result.reasoning, 'all steps succeeded');
});

test('verifyGoal: never throws — falls back to achieved:null with an explanatory reasoning on failure', async () => {
  const { verifyGoal } = freshTaskPlanner('not json');
  const result = await verifyGoal('goal', []);
  assert.equal(result.achieved, null);
  assert.match(result.reasoning, /unavailable/i);
});
