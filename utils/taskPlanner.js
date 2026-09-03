// The LLM-facing half of the task engine: turning a goal into a step list
// (proposePlan), proposing a fix for a failed step (correctStep), and
// judging whether a finished run actually achieved its goal (verifyGoal).
//
// This used to live inside utils/taskEngine.js itself, which meant one file
// owned both "how to talk to the planner LLM" (prompt text, JSON parsing,
// which providers to prefer) and "how to execute/orchestrate/persist/cancel
// a run" (crypto ids, the runs Map, taskStore, the /agent socket, retry-
// with-correction control flow) — two different concerns that don't need to
// change together, and two different kinds of thing to test (this file's
// tests can mock chatCompletion and check the prompt/parsing contract in
// isolation, without dragging in a fake tool registry or event bus).
// taskEngine.js now only depends on this module's three functions, not on
// its own copy of the prompt strings or JSON-extraction logic — the same
// prompts/parsing are used everywhere a plan/correction/verification is
// needed, with one place to change them.
const { chatCompletion } = require('./llmProviders');
const { extractJson } = require('./agents');
const { listTools } = require('./toolRegistry');
const contextAwareness = require('./contextAwareness');

const MAX_STEPS = 8;
// Every planning/correction/verification call prefers the same fast,
// cheap-first provider order — none of these need the strongest model, they
// need to come back quickly, so the heavier providers (openai/perplexity)
// are deliberately left off this list and only used for user-facing chat.
const PLANNER_PROVIDER_ORDER = ['gemini', 'groq', 'openrouter', 'xai'];

function toolCatalogText() {
  return listTools().map((t) => `- ${t.name}: ${t.describe}`).join('\n');
}

function activeContextLine() {
  const ctx = contextAwareness.getContext();
  if (!ctx.supported || !ctx.current) return '';
  return `\n\nActive window right now: "${ctx.current.title}" (${ctx.current.processName}). Use this if the goal refers to "this"/"it"/the current thing without naming it.`;
}

function planPrompt() {
  return `You are the planning layer of a desktop AI assistant. Break the user's goal into
the smallest sequence of tool calls that accomplishes it, using ONLY the tools listed below.

Available tools:
${toolCatalogText()}

Rules:
- Use at most ${MAX_STEPS} steps. Prefer fewer.
- Only use tools from the list, with exactly the args shape described.
- If the goal doesn't require any tool (pure conversation/question), return an empty steps array.
- If the goal is unsafe, destructive beyond what a confirm step already protects, or outside what
  these tools can do, return an empty steps array and explain why in "notes".

Reply with ONLY a JSON object, no prose, no code fence:
{"steps":[{"tool":"<name>","args":{...},"why":"<=15 words"}],"notes":"<=30 words"}`;
}

async function proposePlan(goal) {
  const { reply } = await chatCompletion(
    [
      { role: 'system', content: planPrompt() },
      { role: 'user', content: goal.slice(0, 2000) + activeContextLine() },
    ],
    { maxTokens: 700, temperature: 0.1, order: PLANNER_PROVIDER_ORDER },
  );
  const parsed = extractJson(reply);
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('The planner returned something that was not a valid step list.');
  }
  const steps = parsed.steps
    .filter((s) => s && typeof s.tool === 'string')
    .slice(0, MAX_STEPS)
    .map((s) => ({ tool: s.tool, args: s.args || {}, why: s.why || '' }));
  return { steps, notes: parsed.notes || '' };
}

function correctPrompt() {
  return `A step in an automated desktop-assistant task just failed. Propose ONE corrected
replacement step — different args, or a different tool — that fixes the likely cause of failure, using
ONLY the tools listed below. If the failure looks unrecoverable (the args were already reasonable and
the same problem will just repeat), reply with an empty steps array instead of guessing again.

Available tools:
${toolCatalogText()}

Reply with ONLY a JSON object, no prose, no code fence:
{"steps":[{"tool":"<name>","args":{...},"why":"<=15 words"}],"notes":"<=20 words"}`;
}

async function correctStep(goal, step, error) {
  try {
    const { reply } = await chatCompletion(
      [
        { role: 'system', content: correctPrompt() },
        { role: 'user', content: `Goal: ${goal}\nFailed step: ${JSON.stringify({ tool: step.tool, args: step.args })}\nError: ${error}` },
      ],
      { maxTokens: 300, temperature: 0.2, order: PLANNER_PROVIDER_ORDER },
    );
    const parsed = extractJson(reply);
    if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) return null;
    const s = parsed.steps[0];
    if (!s || typeof s.tool !== 'string') return null;
    return { tool: s.tool, args: s.args || {}, why: s.why || 'corrected retry' };
  } catch (err) {
    console.warn('[taskPlanner] correction step failed:', err.message);
    return null;
  }
}

const VERIFY_PROMPT = `You verify whether an AI assistant's completed task actually achieved the user's
goal, based on the tool results below. Be honest — if a step failed or the results don't clearly
show success, say so.

Reply with ONLY a JSON object, no prose, no code fence:
{"achieved":true|false,"reasoning":"<=40 words"}`;

async function verifyGoal(goal, results) {
  try {
    const { reply } = await chatCompletion(
      [
        { role: 'system', content: VERIFY_PROMPT },
        { role: 'user', content: `Goal: ${goal}\n\nStep results:\n${JSON.stringify(results.map((r) => ({ tool: r.step.tool, ok: r.result.ok !== false, summary: r.result.message || r.result.error || 'ok' })), null, 2).slice(0, 4000)}` },
      ],
      { maxTokens: 150, temperature: 0, order: PLANNER_PROVIDER_ORDER },
    );
    const parsed = extractJson(reply);
    if (parsed && typeof parsed.achieved === 'boolean') return parsed;
  } catch (err) {
    console.warn('[taskPlanner] verify step failed:', err.message);
  }
  return { achieved: null, reasoning: 'Verification unavailable — check the step results directly.' };
}

module.exports = {
  proposePlan, correctStep, verifyGoal, toolCatalogText,
  MAX_STEPS, PLANNER_PROVIDER_ORDER,
};
