require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const sessionRoutes = require('./routes/sessions');
const weatherRoutes = require('./routes/weather');
const voiceRoutes = require('./routes/voice');
const systemRoutes = require('./routes/system');
const memoryRoutes = require('./routes/memory');
const agentRoutes = require('./routes/agent');
const visionRoutes = require('./routes/vision');
const fileRoutes = require('./routes/files');
const inputRoutes = require('./routes/input');
const browserRoutes = require('./routes/browser');
const taskRoutes = require('./routes/tasks');
const knowledgeRoutes = require('./routes/knowledge');
const imaginationRoutes = require('./routes/imagination');
const pluginRoutes = require('./routes/plugins');
const calendarRoutes = require('./routes/calendar');
const calcRoutes = require('./routes/calc');
const { requireAuth } = require('./middleware/auth');
const taskEngine = require('./utils/taskEngine');
const { status: supabaseStatus } = require('./utils/supabase');
const { attachTerminal } = require('./utils/terminal');
const { attachAgentEvents } = require('./utils/agentSocket');
const contextAwareness = require('./utils/contextAwareness');
const scheduler = require('./utils/scheduler');
const proactiveAgent = require('./utils/proactiveAgent');
const pluginLoader = require('./utils/pluginLoader');
const automationGuard = require('./utils/automationGuard');
const { listProviders: listLlmProviders, hasVisionProvider } = require('./utils/llmProviders');
const { startReminderTicker } = require('./utils/calendarReminders');

// Load plugin tools before anything can request the tool catalog — a no-op
// unless ENABLE_PLUGINS=true (see utils/pluginLoader.js).
pluginLoader.loadPlugins();

const app = express();
const server = http.createServer(app);

// Defense in depth: some native/child-process-backed libraries (screen
// capture chief among them) can throw through an event-emitter path that
// bypasses a route's own try/catch — e.g. no display attached, no X server.
// Without this handler that crashes the entire server over one bad vision
// call. Logging and staying up is the right behavior; the specific request
// still needs its own error handling to return a clean response to that caller.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err);
});

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  try { await require('./utils/browserAutomation').close(); } catch { /* best-effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || `http://localhost:${PORT}`).split(',');

// Only trust X-Forwarded-* headers (and therefore derive req.ip from them,
// which the rate limiters below key on) when explicitly told to — set
// TRUST_PROXY=true if this runs behind a reverse proxy/load balancer.
// Trusting it unconditionally would let a client spoof its own IP via that
// header and dodge rate limiting entirely.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// --- Security middleware ---
// helmet sets the standard hardening headers. The frontend split
// (PHASE-FRONTEND-SPLIT.md) already moved every inline <script> block and
// onclick="" attribute out of index.html into real files under public/, and
// this pass finished the job by converting the last handful of inline
// style="" attributes into utility classes (public/styles/main.css) — so
// 'unsafe-inline' is no longer needed for either scriptSrc or styleSrc.
// A future change that reintroduces an inline <script> or style="" attribute
// will now be caught by the browser refusing to run/apply it, not silently
// allowed.
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // cdnjs/jsdelivr serve the pinned Three.js + OrbitControls build the
        // Imagination viewer needs (public/index.html) — current Three.js no
        // longer ships a classic non-module build on its own site at all, so
        // these two CDNs are the only place that old pairing still lives.
        // Everything else stays same-origin.
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
// Images are bigger than the general 1mb JSON limit below allows — this
// path-scoped parser runs first for /api/vision and the general one then
// no-ops (body-parser skips re-parsing once req.body is already set).
app.use('/api/vision', express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting — protects your API keys from runaway usage and cost.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down a bit.' },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests — slow down a bit.' },
});
// Scene generation and semantic search both make an LLM/embedding call per
// request — same cost profile as chat, so they get the same tighter budget
// instead of sharing the generic 120/min apiLimiter meant for cheap reads.
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to this endpoint — slow down a bit.' },
});

// --- Public routes ---
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'jarvis-backend',
    auth: true, // passcode auth is always "configured" — it defaults to Namo if unset
    database: true,
    databaseBackend: supabaseStatus.configured ? 'supabase' : 'local',
    integrations: {
      supabase: { configured: supabaseStatus.configured },
      elevenLabs: { configured: Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) },
    },
    terminal: process.env.ENABLE_TERMINAL === 'true',
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);

// GET /api/boot-status — public (same reasoning as /health: booleans and
// enable-flags, no user data), and deliberately cheap/synchronous. This is
// what the cinematic boot screen's diagnostics panel reads from — real
// subsystem state, not a scripted animation. Every field reflects something
// that already exists elsewhere in the app; this just aggregates it into one
// fast round-trip instead of the frontend hitting nine different routes
// (most of which require auth anyway, and boot runs before sign-in).
app.get('/api/boot-status', (req, res) => {
  const llm = listLlmProviders();
  const automation = automationGuard.status();
  const pluginsEnabled = process.env.ENABLE_PLUGINS === 'true';
  const pluginErrors = pluginsEnabled ? pluginLoader.loadErrors() : [];
  const usingDefaultPasscode = !process.env.JARVIS_PASSCODE; // checkPasscode() falls back to 'Namo' when unset

  res.json({
    core: { status: 'online', uptimeSeconds: Math.round(process.uptime()) },
    memory: { status: 'online', backend: supabaseStatus.configured ? 'supabase' : 'local' },
    vision: { status: hasVisionProvider() ? 'online' : 'degraded', ocr: true, llmVision: hasVisionProvider() },
    browser: { status: automation.browser ? 'online' : 'offline', enabled: automation.browser },
    automation: { status: automation.input ? 'online' : 'offline', enabled: automation.input },
    plugins: {
      status: !pluginsEnabled ? 'offline' : pluginErrors.length ? 'degraded' : 'online',
      enabled: pluginsEnabled,
      loaded: pluginsEnabled ? pluginLoader.loadedPlugins().length : 0,
      errors: pluginErrors.length,
    },
    scheduler: { status: 'online' }, // startScheduler() runs unconditionally from server boot
    security: { status: usingDefaultPasscode ? 'degraded' : 'active', defaultPasscode: usingDefaultPasscode },
    aiAgent: { status: llm.order.length ? 'ready' : 'offline', providers: llm.order },
    time: new Date().toISOString(),
  });
});

// --- Protected routes ---
// Everything below requires a valid JARVIS session token (see middleware/auth.js).
// each router, so no handler ever executes for an anonymous caller.
app.use('/api', apiLimiter);
app.use('/api/chat', requireAuth, chatLimiter, chatRoutes);
app.use('/api/sessions', requireAuth, sessionRoutes);
app.use('/api/memory', requireAuth, memoryRoutes);
app.use('/api/agent', requireAuth, agentRoutes);
app.use('/api/system', requireAuth, systemRoutes);
app.use('/api/voice', requireAuth, chatLimiter, voiceRoutes);
app.use('/api/weather', requireAuth, weatherRoutes);
app.use('/api/vision', requireAuth, visionRoutes);
app.use('/api/files', requireAuth, fileRoutes);
app.use('/api/input', requireAuth, inputRoutes);
app.use('/api/browser', requireAuth, browserRoutes);
app.use('/api/tasks', requireAuth, heavyLimiter, taskRoutes);
app.use('/api/knowledge', requireAuth, heavyLimiter, knowledgeRoutes);
app.use('/api/imagination', requireAuth, heavyLimiter, imaginationRoutes);
app.use('/api/plugins', requireAuth, pluginRoutes);
app.use('/api/calendar', requireAuth, calendarRoutes);
app.use('/api/calc', requireAuth, calcRoutes);

// --- Frontend (static) ---
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- 404 + error handling ---
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// Central error handler. Errors carrying an explicit .status (ApiError —
// see utils/apiError.js — or anything else that sets .status, like the
// memory/supabase layer) keep their meaning; everything else is reported as
// a generic 500 so internal details never leak to the client. A .code, if
// the error carries one (ApiError's optional third arg), rides along
// alongside .error — additive, so every existing frontend call site that
// only reads `data.error` as a string keeps working unchanged.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[unhandled]', err);
  const body = { error: status >= 500 ? 'Internal server error' : err.message };
  if (status < 500 && err.code) body.code = err.code;
  if (status < 500 && err.details !== undefined) body.details = err.details;
  res.status(status).json(body);
});

// --- Live terminal over Socket.IO (auth enforced inside attachTerminal) ---
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
});
attachTerminal(io);
attachAgentEvents(io);

server.listen(PORT, () => {
  console.log(`JARVIS is online at http://localhost:${PORT}  (UI + API on one server)`);
  console.log(`  auth:     passcode gate ready (codeword ${process.env.JARVIS_PASSCODE ? 'set via .env' : 'defaulting to "Namo" — set JARVIS_PASSCODE in .env to change it'})`);
  console.log(`  database: ${supabaseStatus.configured ? 'Supabase memory (persistent, cloud)' : 'local file memory (persistent, data/history.json)'}`);
  console.log(`  chat:     POST /api/chat, POST /api/chat/stream (multi-agent router)`);
  console.log(`  history:  GET/POST /api/sessions`);
  console.log(`  terminal: socket.io /terminal (auth required, ENABLE_TERMINAL=${process.env.ENABLE_TERMINAL})`);
  console.log(`  agent:    socket.io /agent (auth required) — live task/agent pipeline state`);
  console.log(`  schedule: POST /api/tasks/schedule (one-off/recurring goals, in-memory)`);
  console.log(`  plugins:  ${pluginLoader.loadedPlugins().length} loaded (ENABLE_PLUGINS=${process.env.ENABLE_PLUGINS === 'true'}) — GET /api/plugins`);
  console.log(`  context:  active-window tracking ${process.platform === 'win32' ? 'started' : 'unavailable on this platform'} (GET /api/system/context)`);
});

// Crash recovery: anything left mid-flight in data/task-runs.json when the
// process last ended (killed, crashed, redeployed mid-run) is relabelled
// 'interrupted' here — never silently re-executed, since a partially-run
// plan could include browser/input/system steps a human should look at
// first. GET /api/tasks/:runId already returns 'interrupted' runs with
// their real cursor/results; POST /api/tasks/:runId/continue resumes one
// exactly like resuming a paused confirmation. See utils/taskStore.js.
const interrupted = taskEngine.recoverInterruptedRuns();
if (interrupted.length) {
  console.log(`  recovery: ${interrupted.length} task run(s) were mid-flight at last shutdown — marked 'interrupted', resumable via POST /api/tasks/:runId/continue`);
}

// Reload any schedules that were on disk from a previous run — closes the
// "restart clears the schedule" gap; see utils/scheduleStore.js.
const restoredSchedules = scheduler.hydrateFromDisk();
if (restoredSchedules) {
  console.log(`  schedule: restored ${restoredSchedules} job(s) from data/schedules.json`);
}

contextAwareness.start();
scheduler.startScheduler();
proactiveAgent.start(); // no-op unless ENABLE_PROACTIVE_AGENT=true — see utils/proactiveAgent.js
startReminderTicker();
