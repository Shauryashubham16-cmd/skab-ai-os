// apps.*, system.*, windows.*, files.*, calc.* tool definitions.
// Split out of utils/toolRegistry.js (which had grown to 423 lines holding
// every tool domain in one object) purely to group by area of the machine
// each tool touches — the STANDARDIZED TOOL SCHEMA & EXECUTION CONTRACT
// comment in toolRegistry.js still describes the shape every entry here
// follows, and toolRegistry.js is still the only place that merges these
// into the live TOOLS map, validates args, and checks permissions.
const { z } = require('../../schemas');
const { launch, knownApps } = require('../appLauncher');
const { verifyLaunch } = require('../launchVerifier');
const systemControl = require('../systemControl');
const { getSystemStatus } = require('../systemStatus');
const windowManager = require('../windowManager');
const fileSearch = require('../fileSearch');
const { safeEvaluate } = require('../calculator');
const {
  openAppRequest, systemActionRequest, windowActionRequest, fileOpenRequest, calcEvaluateRequest,
} = require('../../schemas');

const noArgs = z.object({}).strict();
const filesSearchArgs = z.object({ query: z.string().trim().min(1).max(200), root: z.string().trim().max(500).optional() });
const filesSearchContentArgs = filesSearchArgs.extend({ extensions: z.array(z.string().trim().max(10)).max(20).optional() });
const systemProcessesArgs = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  sortBy: z.enum(['cpu', 'mem']).optional(),
});

const coreTools = {
  'apps.open': {
    describe: 'Launch an allowlisted desktop app and confirm it actually started running (not just that the OS accepted the request). args: { app: "<key from apps.list>" }',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: openAppRequest,
    execute: async (args) => {
      const result = launch(args.app);
      if (!result.ok) return result;
      // Same honesty upgrade as the plain chat "open X" path
      // (routes/chat.js) — poll for the real process instead of reporting
      // success the moment the OS merely accepts the spawn request.
      const verify = await verifyLaunch(result.app);
      return { ...result, ...verify, state: verify.verified ? 'online' : 'unconfirmed' };
    },
  },
  'apps.list': {
    describe: 'List apps Jarvis is allowed to launch. args: {}',
    permission: 'read',
    requiresCapability: null,
    argsSchema: noArgs,
    execute: async () => ({ ok: true, apps: Object.keys(knownApps()).sort() }),
  },
  'system.status': {
    describe: 'Read live CPU/RAM/disk/GPU/battery status. args: {}',
    permission: 'read',
    requiresCapability: null,
    argsSchema: noArgs,
    execute: async () => ({ ok: true, ...(await getSystemStatus()) }),
  },
  'system.processes': {
    describe: 'List running processes. args: { limit?: number, sortBy?: "cpu"|"mem" }',
    permission: 'read',
    requiresCapability: null,
    argsSchema: systemProcessesArgs,
    execute: async (args) => ({ ok: true, processes: await systemControl.listProcesses(args.limit || 20, args.sortBy || 'mem') }),
  },
  'system.power': {
    describe: 'Power/volume/brightness/lock actions. args: { action: "shutdown"|"restart"|"sleep"|"hibernate"|"lock"|"logout"|"mute"|"unmute"|"volume_up"|"volume_down"|"volume_set"|"brightness_set"|"kill_process", args?: { level?: number, target?: string } }. Destructive actions (shutdown/restart/sleep/hibernate/logout/kill_process) return needsConfirmation instead of running immediately.',
    // 'dangerous' with no requiresCapability: this tool is the reference
    // case for permissions.js's "dangerous tool, no capability flag" note —
    // its gate is systemControl's own CONFIRM_REQUIRED + pending-confirm
    // flow (a per-action, per-user confirmation) rather than a global
    // on/off switch. Non-destructive actions in the same enum (mute,
    // volume, lock) run immediately; requestAction() decides which.
    permission: 'dangerous',
    requiresCapability: null,
    argsSchema: systemActionRequest.omit({ target: true, level: true }).extend({
      args: z.object({ level: z.number().int().min(0).max(100).optional(), target: z.string().trim().min(1).max(100).optional() }).optional(),
    }),
    execute: async (args, ctx) => systemControl.requestAction(ctx.userId, args.action, args.args || {}),
  },
  'windows.list': {
    describe: 'List open windows. args: {} (Windows only)',
    permission: 'read',
    requiresCapability: null,
    argsSchema: noArgs,
    execute: async () => windowManager.listWindows(),
  },
  'windows.active': {
    describe: 'Get the currently focused window. args: {} (Windows only)',
    permission: 'read',
    requiresCapability: null,
    argsSchema: noArgs,
    execute: async () => windowManager.getActiveWindow(),
  },
  'windows.action': {
    describe: 'Focus/minimize/maximize/restore/close a window. args: { action: "focus"|"minimize"|"maximize"|"restore"|"close", target: "<title or handle>" } (Windows only)',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: windowActionRequest,
    execute: async (args) => windowManager.windowAction(args.action, args.target),
  },
  'files.search': {
    describe: 'Search filenames in allowlisted folders. args: { query: string, root?: string }',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: filesSearchArgs,
    execute: async (args) => fileSearch.searchByName(args.query, { root: args.root }),
  },
  'files.searchContent': {
    describe: 'Search file contents in allowlisted folders. args: { query: string, root?: string, extensions?: string[] }',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: filesSearchContentArgs,
    execute: async (args) => fileSearch.searchByContent(args.query, { root: args.root, extensions: args.extensions }),
  },
  'files.open': {
    describe: 'Open (or reveal) a file found via files.search. args: { path: string, reveal?: boolean }',
    permission: 'standard',
    requiresCapability: null,
    argsSchema: fileOpenRequest,
    execute: async (args) => {
      if (!fileSearch.isUnderAllowedRoot(args.path)) return { ok: false, error: 'That path is outside the allowed search roots.' };
      return fileSearch.openPath(args.path, { reveal: args.reveal });
    },
  },
  'calc.evaluate': {
    describe: 'Evaluate a real arithmetic expression safely (no eval — a hand-written parser). Supports + - * / % ^, parentheses, constants (pi, e), and functions (sqrt, abs, floor, ceil, round, sin, cos, tan, asin, acos, atan, ln, log10, log2, log(x,base?), exp, min, max, pow). args: { expression: string }',
    permission: 'read',
    requiresCapability: null,
    argsSchema: calcEvaluateRequest,
    execute: async (args) => safeEvaluate(args.expression),
  },
};

module.exports = { coreTools, noArgs };
