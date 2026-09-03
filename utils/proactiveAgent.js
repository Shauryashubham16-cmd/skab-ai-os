// Proactive Insights — the one genuinely new "intelligence" capability in
// this pass, built entirely on infrastructure that already exists: the same
// scheduler-style setInterval poll as utils/calendarReminders.js /
// utils/scheduler.js, the same real-time push as utils/eventBus.js ->
// utils/agentSocket.js -> the frontend's already-open `/agent` socket
// (see public/components/Calendar/calendarPanel.js's `agent:calendar:reminder`
// listener for the pattern this copies), and the same multi-provider
// chatCompletion() every other LLM call in this app already goes through.
//
// What it does: every tick, gather a small, cheap snapshot (upcoming
// calendar items, the currently focused window, a few learned preferences)
// and ask the LLM ONE narrow question — "is there something worth
// proactively telling the user right now, yes or no" — instead of asking it
// to freely chat. A strict JSON response keeps this from turning into
// unsolicited commentary.
//
// OFF by default (ENABLE_PROACTIVE_AGENT=false). Unlike calendar reminders
// (which are free — no LLM call, just comparing timestamps already in
// calendar.json), this makes a real LLM call on every tick whether or not
// the user is even looking at the app, so — same honest tradeoff as
// terminal/input/browser/plugins in this codebase — it costs API usage and
// therefore needs an opt-in, not just a sensible default interval.
const calendarStore = require('./calendarStore');
const contextAwareness = require('./contextAwareness');
const longTermMemory = require('./longTermMemory');
const { chatCompletion, listProviders } = require('./llmProviders');
const { emitAgentEvent } = require('./eventBus');
const { LOCAL_USER_ID } = require('./passcodeAuth');

const DEFAULT_INTERVAL_MINUTES = 15;
const MIN_INTERVAL_MINUTES = 5; // floor, same spirit as scheduler.js's MIN_INTERVAL_MS — stop a typo'd env var from hammering the LLM
const COOLDOWN_MS = 20 * 60 * 1000; // never notify twice inside 20 minutes, regardless of interval
const MAX_MESSAGE_LENGTH = 220;

let timer = null;
// Per-user cooldown state (userId -> { lastNotifiedAt, lastMessage }),
// not a single global — this app only ever drives tick() with LOCAL_USER_ID
// today (see call site below), so in practice there's one entry, but a
// global here was still the wrong shape: if this module's userId-scoped
// functions (buildSnapshot, tick(userId)) are ever called for more than one
// user — the same "kept user-scoped as defense-in-depth even though the app
// is single-user today" pattern longTermMemory.js and taskEngine.js already
// follow — a global would leak one user's cooldown/dedupe state into
// another's, either suppressing a genuinely new insight for user B because
// user A was just notified, or leaking user A's lastMessage text into the
// dedupe check for user B. Scoped by userId from the start avoids that
// class of bug outright rather than relying on "there's only one user for
// now" staying true.
const cooldownByUser = new Map();
let lastRunAt = null;
let lastError = null;

function cooldownFor(userId) {
  let state = cooldownByUser.get(userId);
  if (!state) {
    state = { lastNotifiedAt: 0, lastMessage: '' };
    cooldownByUser.set(userId, state);
  }
  return state;
}

function getIntervalMs() {
  const raw = Number(process.env.PROACTIVE_AGENT_INTERVAL_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= MIN_INTERVAL_MINUTES ? raw : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

// Strict-JSON parsing that tolerates the two most common ways an LLM wraps
// JSON when not using a real structured-output mode: a ```json fence, or
// stray leading/trailing prose. Same defensive parsing spirit as
// imaginationEngine.js's scene-sanitization step — never trust the raw
// string, always validate the shape before acting on it.
function parseDecision(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { shouldNotify: false, message: '' };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      shouldNotify: parsed.shouldNotify === true,
      message: typeof parsed.message === 'string' ? parsed.message.trim().slice(0, MAX_MESSAGE_LENGTH) : '',
    };
  } catch {
    return { shouldNotify: false, message: '' };
  }
}

async function buildSnapshot(userId) {
  const upcoming = calendarStore.upcoming(userId, 5).map((e) => ({ title: e.title, start: e.start, priority: e.priority }));
  const windowContext = contextAwareness.getContext();
  const preferences = longTermMemory.list(userId, { type: 'preference', limit: 8 }).map((p) => p.content);
  return {
    nowISO: new Date().toISOString(),
    upcomingCalendar: upcoming,
    activeWindow: windowContext.current ? { title: windowContext.current.title, app: windowContext.current.processName } : null,
    knownPreferences: preferences,
  };
}

async function tick() {
  lastRunAt = Date.now();
  lastError = null;
  const userId = LOCAL_USER_ID;
  const cooldown = cooldownFor(userId);
  try {
    if (!listProviders().order.length) return; // no LLM configured — nothing to ask
    if (Date.now() - cooldown.lastNotifiedAt < COOLDOWN_MS) return;

    const snapshot = await buildSnapshot(userId);
    // Nothing worth reasoning about — skip the LLM call entirely rather than
    // asking it to invent something from an empty snapshot.
    if (!snapshot.upcomingCalendar.length && !snapshot.activeWindow && !snapshot.knownPreferences.length) return;

    const { reply } = await chatCompletion(
      [
        {
          role: 'system',
          content:
            'You are JARVIS\'s proactive monitor, running silently in the background. You will be given a small ' +
            'JSON snapshot of the user\'s upcoming calendar, current window/app, and a few known preferences. ' +
            'Decide if there is ONE brief, genuinely useful thing worth proactively telling the user RIGHT NOW — ' +
            'for example an imminent meeting, a high-priority task coming due soon, or something clearly relevant ' +
            'to their current app that a known preference makes actionable. Do NOT invent information not in the ' +
            'snapshot. Do NOT notify just to say something — most ticks should produce no notification at all. ' +
            'Respond with ONLY strict JSON, no other text: {"shouldNotify": boolean, "message": string}. Keep ' +
            'message under 200 characters, written the way Jarvis would say it out loud — direct, no preamble.',
        },
        { role: 'user', content: JSON.stringify(snapshot) },
      ],
      { maxTokens: 150, temperature: 0.3 },
    );

    const decision = parseDecision(reply);
    if (!decision.shouldNotify || !decision.message) return;
    if (decision.message === cooldown.lastMessage) return; // same insight already surfaced — don't repeat it

    cooldown.lastNotifiedAt = Date.now();
    cooldown.lastMessage = decision.message;
    emitAgentEvent(userId, 'agent:insight', { message: decision.message, at: new Date().toISOString() });
  } catch (err) {
    lastError = err.message;
    console.warn('[proactiveAgent] tick failed:', err.message);
  }
}

function start() {
  if (timer) return;
  if (process.env.ENABLE_PROACTIVE_AGENT !== 'true') return;
  timer = setInterval(tick, getIntervalMs());
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const cooldown = cooldownByUser.get(LOCAL_USER_ID);
  return {
    enabled: process.env.ENABLE_PROACTIVE_AGENT === 'true',
    intervalMinutes: getIntervalMs() / 60000,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastNotifiedAt: cooldown?.lastNotifiedAt ? new Date(cooldown.lastNotifiedAt).toISOString() : null,
    lastError,
  };
}

module.exports = { start, stop, status, parseDecision };
