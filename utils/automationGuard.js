// Input automation (mouse/keyboard) and browser automation are two of the
// capabilities gated by the centralized privileged-action layer in
// utils/permissions.js. Both are OFF unless explicitly enabled in .env, AND
// both can be flipped off instantly at runtime via POST /api/input/enable or
// /api/browser/enable — no server restart needed — so there's always a fast
// way to stop an agent mid-task without killing the whole app.
//
// This module is now a thin, capability-scoped view over permissions.js
// (isEnabled/setEnabled/status here map onto its "input"/"browser"
// capabilities) — kept as its own file so every existing caller
// (inputControl.js, browserAutomation.js, routes/input.js,
// routes/browser.js) keeps working unchanged. New code should prefer
// utils/permissions.js directly, since it also covers terminal and plugin
// capabilities that this file never did.
const permissions = require('./permissions');

const CAPABILITIES = new Set(['input', 'browser']);

function isEnabled(capability) {
  if (!CAPABILITIES.has(capability)) throw new Error(`Unknown automation capability "${capability}"`);
  return permissions.isCapabilityEnabled(capability);
}

function setEnabled(capability, value) {
  if (!CAPABILITIES.has(capability)) throw new Error(`Unknown automation capability "${capability}"`);
  return permissions.setCapabilityEnabled(capability, value);
}

function status() {
  const all = permissions.capabilityStatus();
  return { input: all.input, browser: all.browser };
}

module.exports = { isEnabled, setEnabled, status };
