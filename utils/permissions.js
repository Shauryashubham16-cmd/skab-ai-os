// Centralized privileged-action layer.
//
// Before this file existed, "is this allowed right now" was answered in five
// different places with five different shapes: automationGuard's on/off
// switches (input/browser), pluginLoader's dangerous-permission gate,
// systemControl's own CONFIRM_REQUIRED set + pending-confirmation map,
// terminal.js's ENABLE_TERMINAL check, and toolRegistry's built-in TOOLS map
// which had no permission concept at all — every built-in tool was
// implicitly trusted. That made it impossible to answer "what can this tool
// actually do, and under what conditions" from one place, and it meant a new
// tool could easily forget to gate itself the way an existing one does.
//
// This module is now the single source of truth for two questions every
// privileged action must answer before it runs:
//   1. Is this capability switched on at all right now? (env flag +
//      runtime toggle, same pattern automationGuard already used)
//   2. Does this specific call need the caller to confirm first?
//
// Every tool in the system — built-in (utils/toolRegistry.js), plugin
// (utils/pluginLoader.js), terminal (utils/terminal.js), input/browser
// automation (utils/inputControl.js, utils/browserAutomation.js), and
// destructive system actions (utils/systemControl.js) — is expected to
// declare its permission level and route its "am I allowed to run" check
// through here, rather than re-implementing its own env-var check.
//
// Permission levels (same three-tier scale pluginLoader already used, now
// applied uniformly):
//   'read'      — inspects state, takes no action. Always allowed once
//                  authenticated (auth itself is enforced upstream by
//                  middleware/auth.js on every /api route).
//   'standard'  — takes a real but easily-reversible or low-blast-radius
//                  action (open an app, save a memory, click a page
//                  element). Allowed once authenticated; some standard
//                  tools additionally require their own capability flag
//                  (browser automation, input automation) to be armed.
//   'dangerous' — hard to undo or high blast radius (shutdown, kill a
//                  process, delete-ish file ops, run an arbitrary shell
//                  command, a plugin marked dangerous). Requires the
//                  relevant capability flag AND, for the handful of
//                  actions systemControl already treats this way, an
//                  explicit confirmation step.
//
// A tool's permission level is a DECLARATION, not a sandbox — exactly the
// same honest tradeoff pluginLoader's original comment already called out
// for plugins, and the same one terminal.js calls out for the shell. This
// layer's job is to make sure that declaration is checked consistently, not
// to contain what code with that permission can technically do once it runs.
const CAPABILITY_ENV = {
  terminal: 'ENABLE_TERMINAL',
  input: 'ENABLE_INPUT_AUTOMATION',
  browser: 'ENABLE_BROWSER_AUTOMATION',
  pluginDangerous: 'ENABLE_PLUGIN_DANGEROUS_ACTIONS',
};

// Runtime overrides for capabilities that support the "no restart needed"
// toggle (input/browser already did via automationGuard; terminal did not,
// but exposing the same shape here means the whole app now agrees on one
// place to ask). Seeded from env at module load, exactly like
// automationGuard did — a value here always wins over env once explicitly
// set at runtime, env is just the initial state.
const runtimeState = {
  terminal: process.env.ENABLE_TERMINAL === 'true',
  input: process.env.ENABLE_INPUT_AUTOMATION === 'true',
  browser: process.env.ENABLE_BROWSER_AUTOMATION === 'true',
  pluginDangerous: process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS === 'true',
};

const VALID_PERMISSIONS = new Set(['read', 'standard', 'dangerous']);

function isCapabilityEnabled(capability) {
  if (!(capability in runtimeState)) {
    throw new Error(`Unknown capability "${capability}". Known: ${Object.keys(runtimeState).join(', ')}`);
  }
  return runtimeState[capability];
}

// Kept in sync with process.env so existing readers of process.env.ENABLE_*
// (README, .env.example, log lines at boot) keep telling the truth even
// after a runtime toggle — same reasoning routes/input.js and
// routes/browser.js already relied on via automationGuard.
function setCapabilityEnabled(capability, value) {
  if (!(capability in runtimeState)) {
    throw new Error(`Unknown capability "${capability}". Known: ${Object.keys(runtimeState).join(', ')}`);
  }
  runtimeState[capability] = Boolean(value);
  const envVar = CAPABILITY_ENV[capability];
  if (envVar) process.env[envVar] = String(runtimeState[capability]);
  return runtimeState[capability];
}

function capabilityStatus() {
  return { ...runtimeState };
}

// A tool's declared metadata — what toolRegistry.js, pluginLoader.js, etc.
// pass in. `requiresCapability` is optional: most 'standard' tools (open an
// app, save memory) don't gate on a capability flag at all, only on auth,
// which every /api route already enforces upstream.
function validatePermissionMeta({ permission = 'standard', requiresCapability = null } = {}) {
  if (!VALID_PERMISSIONS.has(permission)) {
    throw new Error(`Invalid permission "${permission}". Must be one of: ${[...VALID_PERMISSIONS].join(', ')}`);
  }
  if (requiresCapability && !(requiresCapability in runtimeState)) {
    throw new Error(`Invalid requiresCapability "${requiresCapability}". Known: ${Object.keys(runtimeState).join(', ')}`);
  }
  return { permission, requiresCapability };
}

// The single authorization check. Returns { allowed, reason? } — never
// throws for an ordinary "not allowed right now" outcome, so callers can
// treat it exactly like the { ok: false, error } shape every tool executor
// already returns.
//
// ctx is intentionally open-ended ({ userId, ... }) — this function doesn't
// need to know who's asking (that's already been settled by requireAuth
// before any of this runs); it only decides whether the ACTION is currently
// permitted at all, independent of who's asking.
function authorize(toolName, meta = {}) {
  const { permission, requiresCapability } = validatePermissionMeta(meta);

  if (requiresCapability && !isCapabilityEnabled(requiresCapability)) {
    const envVar = CAPABILITY_ENV[requiresCapability];
    return {
      allowed: false,
      reason: `"${toolName}" requires the "${requiresCapability}" capability, which is currently disabled. `
        + `Enable it with ${envVar}=true in .env, or the matching /enable endpoint, then try again.`,
    };
  }
  if (permission === 'dangerous' && !requiresCapability) {
    // A dangerous tool that declares no capability flag still needs SOME
    // gate — systemControl's own CONFIRM_REQUIRED + pending-confirmation
    // flow covers this case for power actions. This branch exists so a
    // future dangerous tool can't slip through with neither a capability
    // flag nor a confirmation step by simply forgetting to add one.
    return {
      allowed: true,
      reason: null,
      note: 'dangerous permission with no capability gate — caller must enforce its own confirmation step (see utils/systemControl.js requestAction/confirmPending for the pattern).',
    };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  isCapabilityEnabled,
  setCapabilityEnabled,
  capabilityStatus,
  validatePermissionMeta,
  authorize,
  VALID_PERMISSIONS,
  CAPABILITY_ENV,
};
