// One registry mapping a tool name to a description (for the planning
// prompt), a declared permission level, an optional args schema, and an
// executor. This is the single place that knows about every capability
// built so far — apps, system control, windows, files, vision, input,
// browser, long-term memory — so the task engine doesn't need to know the
// shape of eight different modules.
//
// STANDARDIZED TOOL SCHEMA & EXECUTION CONTRACT
// Every entry in TOOLS (and every plugin tool registered via registerTool)
// now has the same shape:
//   describe            — string shown to the planner LLM and GET /api/... listings
//   permission           — 'read' | 'standard' | 'dangerous' (utils/permissions.js)
//   requiresCapability    — null, or one of permissions.js's capability keys
//                           ('input', 'browser', 'terminal', 'pluginDangerous')
//                           that must be armed before this tool can run
//   argsSchema            — a zod schema args are parsed against before
//                           execute() ever sees them, or null for a tool
//                           that genuinely takes no args
//   execute(args, ctx)    — always async, always returns { ok, ... }
//
// Before this pass, args reaching execute() were validated ONLY when a tool
// was called through its own REST route (each route in routes/*.js already
// ran its own zod schema via middleware/validate.js). A tool called by the
// autonomous task-engine planner (utils/taskEngine.js runTool(step.tool,
// step.args, ctx)) skipped that entirely — the LLM's JSON went straight
// into execute() unvalidated. runTool() below now parses every call's args
// against the tool's own argsSchema and checks its permission via
// utils/permissions.authorize() FIRST, so both entry points — REST and the
// planner — get the same guarantees from the same place.
//
// Destructive system actions still additionally go through
// systemControl.requestAction, which returns needsConfirmation instead of
// executing — the task engine watches for that and pauses, exactly like the
// chat confirm flow already does. That confirmation step is layered on top
// of, not a replacement for, the permission check here.
//
// The actual tool definitions live one level down, grouped by area of the
// machine each tool touches, since this file had grown to 423 lines holding
// every domain in a single object:
//   utils/tools/coreTools.js    — apps.*, system.*, windows.*, files.*, calc.*
//   utils/tools/visionTools.js  — vision.*
//   utils/tools/inputTools.js   — input.*   (mouse/keyboard/clipboard automation)
//   utils/tools/browserTools.js — browser.* (browser automation)
//   utils/tools/memoryTools.js  — memory.*  (long-term memory)
// This file is still the only place that merges them into the live TOOLS
// map, validates args, and checks permissions — nothing about the contract
// above changed, only where each tool's definition is written down.
const { z } = require('../schemas');
const permissions = require('./permissions');
const { coreTools } = require('./tools/coreTools');
const { visionTools } = require('./tools/visionTools');
const { inputTools } = require('./tools/inputTools');
const { browserTools } = require('./tools/browserTools');
const { memoryTools } = require('./tools/memoryTools');

const TOOLS = { ...coreTools, ...visionTools, ...inputTools, ...browserTools, ...memoryTools };

// Plugin-registered tools live in a separate map from the built-ins above —
// keeps TOOLS as a known-safe, code-reviewed set, and makes reload trivial
// (clearPluginTools() wipes only this map, never touches TOOLS). See
// utils/pluginLoader.js for what actually populates this.
const pluginTools = {};

// Rejects a plugin trying to register a name that's already a built-in tool
// (or another plugin's tool) — a plugin can add capabilities, never shadow
// or override one that already exists. A plugin's `permission` is validated
// against the same three-tier scale (utils/permissions.js) every built-in
// tool above declares; a plugin marked 'dangerous' additionally requires
// the 'pluginDangerous' capability, enforced in utils/pluginLoader.js's
// wrapExecute (that gate predates this file and is intentionally left
// there rather than duplicated here — see pluginLoader.js's own comment).
function registerTool(name, { describe, execute, source = 'plugin', permission = 'standard', requiresCapability = null, argsSchema = null }) {
  if (TOOLS[name]) throw new Error(`"${name}" is a built-in tool and can't be overridden by a plugin.`);
  if (pluginTools[name]) throw new Error(`"${name}" is already registered by another plugin.`);
  if (typeof execute !== 'function') throw new Error(`Plugin tool "${name}" has no execute function.`);
  permissions.validatePermissionMeta({ permission, requiresCapability }); // throws on an invalid declaration
  pluginTools[name] = {
    describe: describe || `(no description provided) args: {}`,
    execute, source, permission, requiresCapability,
    argsSchema: argsSchema || z.object({}).passthrough(), // plugins may accept any shape unless they opt into a stricter schema
  };
}

function clearPluginTools() {
  Object.keys(pluginTools).forEach((k) => delete pluginTools[k]);
}

function listTools() {
  return [
    ...Object.entries(TOOLS).map(([name, t]) => ({ name, describe: t.describe, source: 'built-in', permission: t.permission })),
    ...Object.entries(pluginTools).map(([name, t]) => ({ name, describe: t.describe, source: 'plugin', permission: t.permission })),
  ];
}

// The single entry point every caller (REST routes indirectly via their own
// tool-shaped handlers, the task-engine planner, plugin-triggered chains)
// funnels through. Three steps, always in this order:
//   1. look the tool up
//   2. authorize it (utils/permissions.js — capability flags, dangerous-gate note)
//   3. validate args against its declared schema
// Only once all three pass does execute() ever see the args.
async function runTool(name, args = {}, ctx = {}) {
  const tool = TOOLS[name] || pluginTools[name];
  if (!tool) return { ok: false, error: `Unknown tool "${name}".` };

  const auth = permissions.authorize(name, { permission: tool.permission, requiresCapability: tool.requiresCapability });
  if (!auth.allowed) return { ok: false, error: auth.reason };

  if (tool.argsSchema) {
    const parsed = tool.argsSchema.safeParse(args || {});
    if (!parsed.success) {
      return { ok: false, error: `Invalid args for "${name}": ${parsed.error.issues[0].message}` };
    }
    args = parsed.data;
  }

  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { listTools, runTool, TOOLS, registerTool, clearPluginTools };
