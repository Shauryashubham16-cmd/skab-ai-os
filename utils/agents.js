// Multi-agent layer.
//
// A cheap "router" agent reads the incoming message and decides which
// specialist should answer it and whether live web results are needed. Each
// specialist has its own system prompt, its own preferred provider order, and
// its own token budget — so a one-line question doesn't pay reasoning prices,
// and a hard problem isn't answered by the fastest/cheapest model.
//
// The router's answer is parsed with Zod. If the router is unavailable or
// returns anything unexpected, a keyword heuristic decides instead — routing
// never becomes a single point of failure for chat itself.
const { chatCompletion } = require('./llmProviders');
const { agentDecision } = require('../schemas');

const BASE_IDENTITY = `You are JARVIS, a sharp, dry-witted AI assistant embedded in a personal
desktop OS interface. You can reference the weather widget, terminal panel, memory panel and voice
output in the UI when relevant. Never invent facts about the user's machine or files.`;

const AGENTS = {
  general: {
    label: 'Generalist',
    description: 'Everyday conversation, quick questions, small talk, summaries.',
    order: ['groq', 'gemini', 'openrouter', 'xai'],
    maxTokens: 1024,
    temperature: 0.7,
    prompt: `${BASE_IDENTITY}
Answer conversationally and concisely. Do not pad short answers.`,
  },
  researcher: {
    label: 'Researcher',
    description: 'Anything time-sensitive, factual lookups, news, prices, "latest"/"today" questions.',
    order: ['gemini', 'openrouter', 'groq', 'xai'],
    maxTokens: 1536,
    temperature: 0.4,
    alwaysSearch: true,
    prompt: `${BASE_IDENTITY}
You are in research mode. Supplementary web-search results may be supplied for this turn: prefer
them over memory for anything current, cite the sources you actually used, and say plainly when
the results do not answer the question rather than guessing.`,
  },
  coder: {
    label: 'Engineer',
    description: 'Code, debugging, shell commands, config, stack traces, APIs.',
    order: ['groq', 'openrouter', 'gemini', 'xai'],
    maxTokens: 2048,
    temperature: 0.2,
    prompt: `${BASE_IDENTITY}
You are in engineering mode. Give correct, runnable code in fenced blocks with the language tag.
State assumptions explicitly, mention the failure mode when an approach is risky, and never
suggest destructive shell commands.`,
  },
  reasoner: {
    label: 'Analyst',
    description: 'Multi-step reasoning, planning, tradeoffs, maths, architecture decisions.',
    order: ['gemini', 'xai', 'openrouter', 'groq'],
    maxTokens: 3072,
    temperature: 0.3,
    prompt: `${BASE_IDENTITY}
You are in analysis mode. Work the problem through step by step, weigh the alternatives, then give
a clear recommendation and the reasoning that supports it. Flag what would change your answer.`,
  },
};

const ROUTER_PROMPT = `You are a routing classifier inside an AI assistant. Choose the single best
specialist for the user's message and whether live web search is required.

Specialists:
- general: everyday conversation, quick questions, rewriting, summarising.
- researcher: anything time-sensitive or factual that needs current information.
- coder: code, debugging, shell/config/API questions.
- reasoner: multi-step reasoning, planning, maths, architecture tradeoffs.

Reply with ONLY a JSON object, no prose, no code fence:
{"agent":"general|researcher|coder|reasoner","needsSearch":true|false,"reason":"<=12 words"}`;

const CODE_HINTS = /\b(code|bug|error|stack trace|function|regex|api|npm|python|javascript|typescript|sql|docker|git|compile|traceback|exception|refactor)\b|```/i;
const RESEARCH_HINTS = /\b(today|now|latest|current|news|price|weather|score|release[ds]?|who won|this week|this year|20\d\d)\b/i;
const REASON_HINTS = /\b(why|compare|tradeoff|trade-off|plan|strategy|architecture|design|should i|pros and cons|step by step|calculate|prove)\b/i;

function heuristicRoute(message) {
  if (CODE_HINTS.test(message)) return { agent: 'coder', needsSearch: false, reason: 'code keywords' };
  if (RESEARCH_HINTS.test(message)) return { agent: 'researcher', needsSearch: true, reason: 'time-sensitive keywords' };
  if (REASON_HINTS.test(message) || message.length > 400) return { agent: 'reasoner', needsSearch: false, reason: 'reasoning keywords' };
  return { agent: 'general', needsSearch: false, reason: 'default' };
}

function extractJson(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function routeMessage(message, { forced = 'auto' } = {}) {
  if (forced !== 'auto' && AGENTS[forced]) {
    return { agent: forced, needsSearch: !!AGENTS[forced].alwaysSearch, reason: 'chosen by user', routedBy: 'user' };
  }

  try {
    const { reply } = await chatCompletion(
      [
        { role: 'system', content: ROUTER_PROMPT },
        { role: 'user', content: message.slice(0, 2000) },
      ],
      { maxTokens: 120, temperature: 0, order: ['groq', 'gemini', 'openrouter', 'xai'] },
    );
    const parsed = agentDecision.safeParse(extractJson(reply));
    if (parsed.success) return { ...parsed.data, routedBy: 'router-agent' };
    console.warn('[agents] router returned unusable output, falling back to heuristic');
  } catch (err) {
    console.warn('[agents] router agent unavailable, falling back to heuristic:', err.message);
  }

  return { ...heuristicRoute(message), routedBy: 'heuristic' };
}

function getAgent(key) {
  return AGENTS[key] || AGENTS.general;
}

function listAgents() {
  return Object.entries(AGENTS).map(([key, a]) => ({
    key,
    label: a.label,
    description: a.description,
    preferredOrder: a.order,
  }));
}

module.exports = { routeMessage, getAgent, listAgents, AGENTS, extractJson };
