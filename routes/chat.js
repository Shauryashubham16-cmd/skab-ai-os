const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const memory = require('../utils/memory');
const { augmentedSearch, buildContextMessage } = require('../utils/search');
const { chatCompletion, chatCompletionStream, listProviders } = require('../utils/llmProviders');
const { routeMessage, getAgent, listAgents } = require('../utils/agents');
const { validate } = require('../middleware/validate');
const { chatRequest, sessionParams } = require('../schemas');
const { launch, detectOpenIntent } = require('../utils/appLauncher');
const { verifyLaunch } = require('../utils/launchVerifier');
const systemControl = require('../utils/systemControl');
const { getSystemStatus, formatStatus } = require('../utils/systemStatus');
const { detectSystemIntent, isConfirmWord, isCancelWord } = require('../utils/systemIntent');
const longTermMemory = require('../utils/longTermMemory');
const taskEngine = require('../utils/taskEngine');
const contextAwareness = require('../utils/contextAwareness');
const imaginationEngine = require('../utils/imaginationEngine');
const { emitAgentEvent } = require('../utils/eventBus');

const router = express.Router();

function systemReplyPayload(sessionId, reply, extra = {}) {
  return { reply, sessionId, provider: 'system-control', model: null, agent: 'System', agentKey: 'system', routedBy: 'intent', routingReason: 'system-control pattern matched', searched: false, citations: [], ...extra };
}

async function resolveSessionId(userId, body) {
  return body.sessionId ? memory.assertOwnedSession(userId, body.sessionId) : (await memory.createSession(userId)).id;
}

// If there's a pending confirmation for this user and the message is a plain
// "yes"/"confirm"/"no"/"cancel", resolve it — this takes priority over every
// other kind of message, since it's answering a question JARVIS just asked.
async function tryHandlePendingConfirmation(userId, body) {
  const pending = systemControl.getPending(userId);
  if (!pending) return null;
  const message = body.message.trim();
  if (!isConfirmWord(message) && !isCancelWord(message)) return null; // not a confirm/cancel reply — pending stays open

  // If this confirmation belongs to a step inside a paused task run, resume
  // the *run* (so any steps after the confirmed one still execute) instead
  // of just firing the one flagged action and leaving the rest stranded.
  const pendingRunId = taskEngine.getPendingRunId(userId);
  const sessionId = await resolveSessionId(userId, body);
  let reply;

  if (pendingRunId && isConfirmWord(message)) {
    // The confirmed action itself still has to actually run first.
    const confirmed = await systemControl.confirmPending(userId);
    if (!confirmed.ok) {
      reply = `Couldn't complete that: ${confirmed.error}`;
    } else {
      const resumed = await taskEngine.continueRun(pendingRunId, { userId });
      if (resumed.status === 'completed') {
        reply = `Done. ${resumed.verification?.reasoning || ''}`.trim();
      } else if (resumed.status === 'paused') {
        reply = `⚠️ ${resumed.pendingDescription} Reply "confirm" to proceed or "cancel" to back out (this expires in 60s).`;
      } else if (resumed.status === 'failed') {
        reply = `Task stopped: ${resumed.error}`;
      } else {
        reply = confirmed.message || 'Done.';
      }
    }
  } else if (pendingRunId && isCancelWord(message)) {
    systemControl.cancelPending(userId);
    reply = 'Cancelled — the rest of the task was not run.';
  } else if (isConfirmWord(message)) {
    const result = await systemControl.confirmPending(userId);
    reply = result.ok ? (result.message || 'Done.') : `Couldn't complete that: ${result.error}`;
  } else {
    systemControl.cancelPending(userId);
    reply = 'Cancelled — nothing was run.';
  }

  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'System', provider: pendingRunId ? 'task-engine' : 'system-control' });
  return systemReplyPayload(sessionId, reply);
}

// "/imagine <description>" — text -> new 3D scene graph (rendered by the
// Imagination tab's Three.js viewer, not a generated image). If the user
// already has a scene loaded, plain follow-up text ("add drones", "make it
// nighttime") EDITS that same scene instead of starting over — say
// "/imagine new <description>" or "/imagine reset <description>" to force a
// fresh one. This mirrors the plan's own example dialogue (one creation
// turn, then bare edit turns) as closely as an explicit, unambiguous
// command can — see tryTaskIntent's comment below for why an explicit
// prefix is used instead of guessing intent from free text.
async function tryImagineIntent(userId, body) {
  const match = body.message.trim().match(/^\/imagine\s+(.+)/is);
  if (!match) return null;
  const sessionId = await resolveSessionId(userId, body);
  let text = match[1].trim();
  const forceNew = /^(?:new|reset)\b[:\s]*/i.test(text);
  if (forceNew) text = text.replace(/^(?:new|reset)\b[:\s]*/i, '').trim();

  if (!text) {
    const reply = 'Tell me what to imagine — e.g. "/imagine a futuristic smart city with flying cars and solar buildings".';
    await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'Imagination', provider: 'imagination-engine' });
    return systemReplyPayload(sessionId, reply);
  }

  const existing = !forceNew ? imaginationEngine.getLastScene(userId) : null;
  emitAgentEvent(userId, 'agent:state', { state: 'understanding', main: 'Imagining', sub: text.slice(0, 80) });
  emitAgentEvent(userId, 'agent:state', { state: 'planning', main: existing ? 'Editing the scene' : 'Building the scene', sub: text.slice(0, 80) });

  let reply;
  let scene = null;
  try {
    scene = existing ? await imaginationEngine.editScene(existing, text) : await imaginationEngine.proposeScene(text);
    imaginationEngine.setLastScene(userId, scene);
    emitAgentEvent(userId, 'agent:state', { state: 'complete', main: 'Scene ready', sub: `${scene.objects.length} object(s)`, revertAfter: 1500 });
    reply = `${existing ? 'Updated' : 'Built'} the scene — ${scene.objects.length} object(s)${scene.notes ? `. ${scene.notes}` : '.'}`;
  } catch (err) {
    emitAgentEvent(userId, 'agent:state', { state: 'error', main: 'Imagination failed', sub: err.message, revertAfter: 2200 });
    reply = `Couldn't build that scene: ${err.message}`;
  }

  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'Imagination', provider: 'imagination-engine' });
  return systemReplyPayload(sessionId, reply, scene ? { provider: 'imagination-engine', agent: 'Imagination', agentKey: 'imagination', scene } : {});
}

// "/task <goal>" / "/agent <goal>" / "/do <goal>" — an explicit, opt-in
// trigger for the real Plan->Execute->Observe->Verify->Correct->Retry loop.
// Kept as an explicit prefix rather than free-text intent detection: the
// task engine can drive mouse/keyboard/browser automation, so it should
// only ever run when the user unambiguously asked for it, never as a guess.
async function tryTaskIntent(userId, body) {
  const match = body.message.trim().match(/^\/(?:task|agent|do)\s+(.+)/is);
  if (!match) return null;
  const goal = match[1].trim();
  const sessionId = await resolveSessionId(userId, body);

  const result = await taskEngine.autonomousRun(goal, { userId }, { execute: true });
  let reply;
  if (result.status === 'no-op') {
    reply = result.notes || "That doesn't need any tool actions — ask me directly instead.";
  } else if (result.status === 'completed') {
    const steps = result.results.map((r) => `${r.result.ok !== false ? '✓' : '✗'} ${r.step.tool}`).join('\n');
    reply = `${steps}\n\n${result.verification?.reasoning || 'Done.'}`;
  } else if (result.status === 'paused') {
    reply = `⚠️ ${result.pendingDescription} Reply "confirm" to proceed or "cancel" to back out (this expires in 60s).`;
  } else if (result.status === 'timeout') {
    reply = `Ran out of time with ${result.remainingSteps} step(s) left. What finished:\n${result.results.map((r) => `${r.result.ok !== false ? '✓' : '✗'} ${r.step.tool}`).join('\n')}`;
  } else {
    reply = `Stopped: ${result.error}\n${result.results.map((r) => `${r.result.ok !== false ? '✓' : '✗'} ${r.step.tool}`).join('\n')}`;
  }

  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'Agent', provider: 'task-engine' });
  return systemReplyPayload(sessionId, reply, { provider: 'task-engine', agent: 'Agent', agentKey: 'task', runId: result.runId, taskStatus: result.status });
}

// "shut down my pc" / "kill spotify" / "set volume to 40" — matched against a
// fixed set of patterns and mapped to a fixed action, never raw text. See
// utils/systemControl.js for which of these require a confirm step first.
async function trySystemControlIntent(userId, body) {
  const intent = detectSystemIntent(body.message);
  if (!intent) return null;
  const result = await systemControl.requestAction(userId, intent.action, intent.args);
  const sessionId = await resolveSessionId(userId, body);
  const reply = result.needsConfirmation
    ? `⚠️ ${result.description} Reply "confirm" to proceed or "cancel" to back out (this expires in 60s).`
    : (result.ok ? (result.message || 'Done.') : `Couldn't do that: ${result.error}`);
  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'System', provider: 'system-control' });
  return systemReplyPayload(sessionId, reply, { pendingAction: result.needsConfirmation ? { id: result.actionId } : undefined });
}

// Narrow status intent: answer from the host, never an LLM approximation.
async function tryStatusIntent(userId, body) {
  if (!/^\s*(?:show|what(?:'s| is)|check|give me)?\s*(?:my\s+|the\s+)?(?:computer|pc|system)\s+(?:status|stats|health)\??\s*$/i.test(body.message)) return null;
  const sessionId = await resolveSessionId(userId, body);
  const reply = formatStatus(await getSystemStatus());
  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'System', provider: 'system-status' });
  return systemReplyPayload(sessionId, reply, { provider: 'system-status' });
}

// "open spotify" / "launch vscode" style messages skip the LLM entirely and
// go straight to the app launcher's fixed allowlist — faster, and it means a
// plain sentence never gets passed to a shell, only ever a matched app key.
//
// A successful spawn only proves the OS accepted the request (appLauncher.js
// is explicit about this — its state is 'launch-requested', not 'running').
// So before replying, this now polls for the real process
// (utils/launchVerifier.js) and reports what actually happened: "is open"
// only once a matching process is genuinely found, "requested but
// unconfirmed" if it never shows up within the timeout — never a guessed
// "Spotify is open." The extra wait is bounded (default 6s, usually far
// less — verifyLaunch resolves the moment it finds a match) and reuses
// `systeminformation`, already a dependency via systemControl.js.
async function tryOpenAppIntent(userId, body) {
  const key = detectOpenIntent(body.message);
  if (!key) return null;
  const result = launch(key);
  const sessionId = await resolveSessionId(userId, body);

  if (!result.ok) {
    const reply = `Couldn't open ${key}: ${result.error}`;
    await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'System', provider: 'app-launcher' });
    return systemReplyPayload(sessionId, reply, { provider: 'app-launcher', appKey: key, launched: false, verified: false });
  }

  const verify = await verifyLaunch(key);
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  const reply = verify.verified
    ? `${label} is open.`
    : `Launch requested for ${key} — couldn't confirm it's running yet; it may still be starting.`;
  await memory.saveTurn(userId, sessionId, body.message, reply, { agent: 'System', provider: 'app-launcher' });
  // appKey/launched/verified/pid are additive fields, purely for the
  // frontend's cinematic launch animation (components/HUD/appLaunchCinematic.js)
  // to know which app to label and what really happened — they don't change
  // anything about the reply text itself, which is already the honest source
  // of truth above.
  return systemReplyPayload(sessionId, reply, {
    provider: 'app-launcher', appKey: key, launched: true, verified: verify.verified, pid: verify.pid,
  });
}

// Runs before the normal LLM flow: a pending confirmation always wins, then
// system-control intents, then app-open intents. Whichever fires first short-
// circuits straight to a reply — none of this ever touches the LLM.
async function tryIntents(userId, body) {
  return (await tryHandlePendingConfirmation(userId, body))
    || (await tryImagineIntent(userId, body))
    || (await tryTaskIntent(userId, body))
    || (await trySystemControlIntent(userId, body))
    || (await tryStatusIntent(userId, body))
    || (await tryOpenAppIntent(userId, body));
}

function mergeCitations(base, searchResults) {
  const urls = new Set(base || []);
  searchResults.forEach((r) => urls.add(r.url));
  return Array.from(urls);
}

function buildMemoryContextMessage(hits) {
  if (!hits.length) return null;
  const lines = hits.map((h) => `- [${h.type}] ${h.content}`).join('\n');
  return { role: 'system', content: `Relevant things you already know about the user (only use if actually relevant to this message):\n${lines}` };
}

// "Jarvis should know: active application, active window, current task,
// recent actions. Then use that context in its reasoning" — the plan's
// context-awareness item. utils/contextAwareness.js already polls the
// focused window; this is the first place that context actually reaches
// the LLM instead of just sitting behind GET /api/agent/context for the UI
// to display. Deliberately app/window-level only (no document/tab content,
// no screen pixels) — that stays vision.screen's job, opt-in per call.
function buildActiveContextMessage() {
  const ctx = contextAwareness.getContext();
  if (!ctx.supported || !ctx.current) return null;
  const recent = ctx.recent.slice(1, 4).map((w) => w.title || w.processName).filter(Boolean);
  const lines = [`Active window right now: "${ctx.current.title}" (${ctx.current.processName}).`];
  if (recent.length) lines.push(`Recently focused before that: ${recent.join(' → ')}.`);
  return { role: 'system', content: `${lines.join(' ')} Only mention this if it's actually relevant to what the user is asking.` };
}

// Shared setup for both the buffered and streaming endpoints: pick the agent,
// resolve (or create) the conversation, load its history, optionally search.
async function prepare(userId, body) {
  const { message, agent: forced, search, provider } = body;
  const sessionId = body.sessionId
    ? await memory.assertOwnedSession(userId, body.sessionId)
    : (await memory.createSession(userId)).id;

  const decision = await routeMessage(message, { forced });
  const agent = getAgent(decision.agent);
  // Search is always-on only for the researcher; anything else searches only
  // when the router asked for it, or the client explicitly requested it.
  const wantsSearch = typeof search === 'boolean' ? search : (decision.needsSearch || !!agent.alwaysSearch);

  const [history, searchResults, memoryHits] = await Promise.all([
    memory.loadHistory(userId, sessionId, agent.prompt),
    wantsSearch ? augmentedSearch(message) : Promise.resolve([]),
    longTermMemory.search(userId, message, { limit: 3 }),
  ]);

  const contextMessage = buildContextMessage(searchResults);
  const memoryContextMessage = buildMemoryContextMessage(memoryHits);
  const activeContextMessage = buildActiveContextMessage();
  const messages = [
    ...history,
    ...(memoryContextMessage ? [memoryContextMessage] : []),
    ...(activeContextMessage ? [activeContextMessage] : []),
    ...(contextMessage ? [contextMessage] : []),
    { role: 'user', content: message },
  ];

  return { sessionId, decision, agent, searchResults, messages, providerPreference: provider };
}

// GET /api/chat/providers — which LLM providers are configured, in fallback order
router.get('/providers', (req, res) => res.json(listProviders()));

// GET /api/chat/agents — the specialist roster the router picks from
router.get('/agents', (req, res) => res.json({ agents: listAgents() }));

// POST /api/chat
router.post('/', validate({ body: chatRequest }), asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { message } = req.body;

  const opened = await tryIntents(userId, req.body);
  if (opened) return res.json(opened);

  const { sessionId, decision, agent, searchResults, messages, providerPreference } = await prepare(userId, req.body);

  const { reply, provider, model } = await chatCompletion(messages, {
    maxTokens: agent.maxTokens,
    temperature: agent.temperature,
    order: providerPreference ? [providerPreference, ...(agent.order || [])] : agent.order,
  });

  await memory.saveTurn(userId, sessionId, message, reply, { agent: agent.label, provider });

  res.json({
    reply,
    sessionId,
    provider,
    model,
    agent: agent.label,
    agentKey: decision.agent,
    routedBy: decision.routedBy,
    routingReason: decision.reason,
    searched: searchResults.length > 0,
    citations: mergeCitations(null, searchResults),
  });
}));

// POST /api/chat/stream — Server-Sent Events, for the live "typing" feel
router.post('/stream', validate({ body: chatRequest }), async (req, res) => {
  const userId = req.user.id;
  const { message } = req.body;

  const opened = await tryIntents(userId, req.body);
  if (opened) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ meta: true, sessionId: opened.sessionId, agent: 'System', agentKey: 'system', routedBy: 'intent' })}\n\n`);
    res.write(`data: ${JSON.stringify({ delta: opened.reply })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, sessionId: opened.sessionId, provider: opened.provider, agent: 'System', citations: [], pendingAction: opened.pendingAction })}\n\n`);
    return res.end();
  }

  let prepared;
  try {
    prepared = await prepare(userId, req.body);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const { sessionId, decision, agent, searchResults, messages, providerPreference } = prepared;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ meta: true, sessionId, agent: agent.label, agentKey: decision.agent, routedBy: decision.routedBy })}\n\n`);

  let fullText = '';
  let usedProvider = null;

  try {
    const order = providerPreference ? [providerPreference, ...(agent.order || [])] : agent.order;
    for await (const { delta, provider } of chatCompletionStream(messages, { maxTokens: agent.maxTokens, order })) {
      usedProvider = provider;
      fullText += delta;
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }

    await memory.saveTurn(userId, sessionId, message, fullText, { agent: agent.label, provider: usedProvider });
    res.write(`data: ${JSON.stringify({ done: true, sessionId, provider: usedProvider, agent: agent.label, citations: mergeCitations(null, searchResults) })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[chat/stream] error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'Failed to get a response from any configured provider' })}\n\n`);
    res.end();
  }
});

// DELETE /api/chat/:id — clear one conversation's messages
router.delete('/:id', validate({ params: sessionParams }), asyncHandler(async (req, res) => {
  await memory.clearMessages(req.user.id, req.params.id);
  res.json({ cleared: true });
}));

module.exports = router;
