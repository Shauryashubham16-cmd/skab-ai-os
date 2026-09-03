const { z } = require('zod');

const uuid = z.string().uuid('Must be a valid session id');

const unlockRequest = z.object({ code: z.string().trim().min(1).max(100) });

// App name is deliberately restrictive — it's looked up in an allowlist by
// utils/appLauncher.js, never passed through to a shell, but keeping the
// shape tight here means junk never even reaches that lookup.
const openAppRequest = z.object({
  app: z.string().trim().min(1).max(60).regex(/^[a-zA-Z0-9 _.-]+$/, 'Invalid app name'),
});

const systemActionRequest = z.object({
  action: z.enum([
    'shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'logout',
    'kill_process', 'mute', 'unmute', 'volume_up', 'volume_down', 'volume_set', 'brightness_set',
  ]),
  target: z.string().trim().min(1).max(100).optional(), // kill_process: pid or name substring
  level: z.number().int().min(0).max(100).optional(),   // volume_set / brightness_set
});

const confirmActionRequest = z.object({ actionId: z.string().uuid().optional() });

// Target is a window title (matched against currently open windows) or a
// handle string returned by GET /api/system/windows — never freeform text
// passed to a shell. Resolution happens in utils/windowManager.js.
const windowActionRequest = z.object({
  action: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close']),
  target: z.string().trim().min(1).max(200),
});

const visionRequest = z.object({
  mode: z.enum(['ocr', 'describe', 'both']).default('describe'),
  question: z.string().trim().min(1).max(2000).optional(),
});

const visionImageRequest = visionRequest.extend({
  imageBase64: z.string().min(1),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
});

const visionFindElementRequest = z.object({ text: z.string().trim().min(1).max(200) });
const visionCompareRequest = z.object({
  snapshotId: z.string().uuid(),
  threshold: z.number().int().min(0).max(765).default(20),
});

const fileSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  root: z.string().trim().max(500).optional(),
});

const fileContentSearchRequest = z.object({
  query: z.string().trim().min(1).max(200),
  root: z.string().trim().max(500).optional(),
  extensions: z.array(z.string().trim().max(10)).max(20).optional(),
});

const fileOpenRequest = z.object({
  path: z.string().trim().min(1).max(500),
  reveal: z.boolean().optional(),
});

// --- Input automation (mouse/keyboard) ---
const coord = z.number().int().min(-10000).max(10000);

const inputMoveRequest = z.object({ x: coord, y: coord });

const inputClickRequest = z.object({
  x: coord.optional(),
  y: coord.optional(),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  double: z.boolean().default(false),
}).refine((v) => (v.x === undefined) === (v.y === undefined), { message: 'x and y must both be provided, or both omitted (to click at the current cursor position)' });

const inputScrollRequest = z.object({
  delta: z.number().int().min(-50).max(50),
  x: coord.optional(),
  y: coord.optional(),
}).refine((v) => (v.x === undefined) === (v.y === undefined), { message: 'x and y must both be provided, or both omitted' });

const inputTypeRequest = z.object({ text: z.string().min(1).max(5000) });
const inputKeyRequest = z.object({ keys: z.string().trim().min(1).max(100) });
const inputDragDropRequest = z.object({ fromX: coord, fromY: coord, toX: coord, toY: coord });
const inputClipboardWriteRequest = z.object({ text: z.string().max(20000) });

// --- Browser automation ---
const browserNavigateRequest = z.object({ url: z.string().trim().min(1).max(2000) });
const browserSelectorRequest = z.object({ selector: z.string().trim().min(1).max(500) });
const browserTypeRequest = browserSelectorRequest.extend({ text: z.string().max(5000) });
const browserGetTextRequest = z.object({ selector: z.string().trim().max(500).optional() });
const browserScrollRequest = z.object({
  selector: z.string().trim().max(500).optional(),
  direction: z.enum(['up', 'down']).default('down'),
  amount: z.number().int().min(50).max(5000).default(600),
});
const browserTabIndexRequest = z.object({ index: z.number().int().min(0).max(50) });
const browserNewTabRequest = z.object({ url: z.string().trim().max(2000).optional() });
const browserDownloadRequest = z.object({
  selector: z.string().trim().max(500).optional(),
  url: z.string().trim().max(2000).optional(),
}).refine((v) => v.selector || v.url, { message: 'Provide either selector or url.' });
const browserVerifyRequest = z.object({
  textContains: z.string().trim().max(500).optional(),
  urlContains: z.string().trim().max(500).optional(),
  selectorExists: z.string().trim().max(500).optional(),
}).refine((v) => v.textContains || v.urlContains || v.selectorExists, { message: 'Provide at least one of textContains/urlContains/selectorExists.' });

// --- Shared automation on/off toggle ---
const automationEnableRequest = z.object({ enabled: z.boolean() });

// --- Multi-step tasks / autonomous agent ---
const taskStep = z.object({
  tool: z.string().trim().min(1).max(100),
  args: z.record(z.any()).default({}),
});
const taskRunRequest = z.object({ steps: z.array(taskStep).min(1).max(8) });
const taskAutoRequest = z.object({
  goal: z.string().trim().min(1).max(2000),
  execute: z.boolean().default(false),
  // background:true starts the run immediately without blocking the
  // request (see taskEngine.runInBackground) — implies execute regardless
  // of what `execute` was set to, since a background run always runs.
  background: z.boolean().default(false),
});
const taskRunIdParams = z.object({ runId: z.string().uuid() });

// --- Scheduled / recurring tasks ---
const taskScheduleRequest = z.object({
  goal: z.string().trim().min(1).max(2000),
  // exactly one of these two:
  at: z.string().datetime().optional(), // ISO timestamp, one-off
  everyMinutes: z.number().int().min(1).max(10080).optional(), // recurring, 1 min .. 1 week
}).refine((v) => (v.at ? !v.everyMinutes : !!v.everyMinutes), { message: 'Provide exactly one of "at" (ISO timestamp) or "everyMinutes".' });
const scheduleIdParams = z.object({ id: z.string().uuid() });

// --- Long-term memory / preferences ---
const knowledgeAddRequest = z.object({
  type: z.enum(['fact', 'preference', 'note']).default('note'),
  content: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().max(30)).max(10).optional(),
});
const knowledgeListQuery = z.object({
  type: z.enum(['fact', 'preference', 'note']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const knowledgeSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const knowledgeIdParams = z.object({ id: z.string().uuid() });

const chatRequest = z.object({
  message: z.string().trim().min(1, 'message cannot be empty').max(20000),
  sessionId: uuid.optional(),
  agent: z.enum(['auto', 'general', 'researcher', 'coder', 'reasoner']).default('auto'),
  search: z.boolean().optional(),
  // Optional: pin the reply to one specific model/provider (e.g. "chatgpt",
  // "gemini", "perplexity") instead of the normal fallback chain. Still falls
  // back to the rest of the chain if that one specific provider is down.
  provider: z.enum(['gemini', 'groq', 'openrouter', 'xai', 'openai', 'perplexity']).optional(),
});

const sessionCreate = z.object({ title: z.string().trim().min(1).max(120).optional() });
const sessionRename = z.object({ title: z.string().trim().min(1).max(120) });
const sessionParams = z.object({ id: uuid });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const speakRequest = z.object({
  text: z.string().trim().min(1).max(5000),
  voiceId: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/, 'Invalid voiceId').optional(),
});

const weatherQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  days: z.coerce.number().int().min(1).max(14).optional(),
});

const terminalCommand = z.object({
  command: z.string().min(1).max(500),
});

const agentDecision = z.object({
  agent: z.enum(['general', 'researcher', 'coder', 'reasoner']),
  needsSearch: z.boolean(),
  reason: z.string().max(300).optional(),
});

// --- Imagination engine (Phase 4) ---
// The scene itself is validated/clamped by utils/imaginationEngine.js's
// sanitizeScene() (numeric ranges, object type allowlist, object count cap)
// rather than duplicated here in zod — this just checks it's an object at
// all before it reaches that logic.
const imaginationSceneRequest = z.object({
  prompt: z.string().trim().min(1).max(1000),
});
const imaginationEditRequest = z.object({
  scene: z.object({}).passthrough(),
  instruction: z.string().trim().min(1).max(300),
});
const imaginationFromScreenRequest = z.object({
  instruction: z.string().trim().max(300).optional(),
});
const imaginationImageRequest = z.object({
  prompt: z.string().trim().min(1).max(1000),
  size: z.enum(['1024x1024', '1024x1792', '1792x1024']).default('1024x1024'),
});

// ---------------- Calendar ----------------
const calendarRecurrence = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).optional(),
  until: z.string().min(1).optional(),
  count: z.number().int().min(1).max(500).optional(),
}).nullable().optional();
const calendarEventCreate = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  start: z.string().datetime({ offset: true }).or(z.string().min(1)), // ISO string; datetime() is strict, fall back to any non-empty string for date-only/local values
  end: z.string().min(1).nullable().optional(),
  allDay: z.boolean().optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  remindMinutesBefore: z.number().int().min(0).max(10080).nullable().optional(), // up to 7 days ahead
  recurrence: calendarRecurrence,
});
const calendarEventUpdate = calendarEventCreate.partial().extend({
  completed: z.boolean().optional(),
});
// Accepts either a stored event's own uuid, or an expanded occurrence id
// ("<uuid>::<index>", see calendarStore.js's expandOccurrences/baseEventId)
// — the frontend gets occurrence ids back from list()/upcoming() and needs
// to be able to round-trip them into GET/PATCH/DELETE by id.
const calendarEventParams = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}(::\d+)?$/i, 'must be an event id, optionally with a ::N occurrence suffix'),
});
const calendarListQuery = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  includeCompleted: z.enum(['true', 'false']).optional().transform((v) => v !== 'false'),
});

// ---------------- Calculator ----------------
const calcEvaluateRequest = z.object({
  expression: z.string().trim().min(1).max(200),
});

module.exports = {
  z,
  unlockRequest,
  openAppRequest,
  systemActionRequest,
  confirmActionRequest,
  chatRequest,
  sessionCreate,
  sessionRename,
  sessionParams,
  listQuery,
  speakRequest,
  weatherQuery,
  terminalCommand,
  agentDecision,
  windowActionRequest,
  visionRequest,
  visionImageRequest,
  visionFindElementRequest,
  visionCompareRequest,
  fileSearchQuery,
  fileContentSearchRequest,
  fileOpenRequest,
  inputMoveRequest,
  inputClickRequest,
  inputScrollRequest,
  inputTypeRequest,
  inputKeyRequest,
  inputDragDropRequest,
  inputClipboardWriteRequest,
  browserNavigateRequest,
  browserSelectorRequest,
  browserTypeRequest,
  browserGetTextRequest,
  browserScrollRequest,
  browserTabIndexRequest,
  browserNewTabRequest,
  browserDownloadRequest,
  browserVerifyRequest,
  automationEnableRequest,
  taskRunRequest,
  taskAutoRequest,
  taskRunIdParams,
  taskScheduleRequest,
  scheduleIdParams,
  knowledgeAddRequest,
  knowledgeListQuery,
  knowledgeSearchQuery,
  knowledgeIdParams,
  imaginationSceneRequest,
  imaginationEditRequest,
  imaginationFromScreenRequest,
  imaginationImageRequest,
  calendarEventCreate,
  calendarEventUpdate,
  calendarEventParams,
  calendarListQuery,
  calcEvaluateRequest,
};