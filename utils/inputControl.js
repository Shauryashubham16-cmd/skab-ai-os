// Mouse & keyboard automation. Same trust model as windowManager.js: fixed
// PowerShell script, enum-validated ops, numeric coordinates checked against
// the actual screen bounds — never a shell string built from user text.
//
// This is gated behind automationGuard's "input" switch (off by default) on
// top of the normal requireAuth on every route, because unlike window
// management or file search, this can actually type/click things — i.e. take
// actions that are hard to undo. Every call is written to the shared audit
// trail regardless of outcome.
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const audit = require('./audit');
const automationGuard = require('./automationGuard');

const execFileP = util.promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, 'scripts', 'input-control.ps1');
const platform = process.platform;

const UNSUPPORTED = { ok: false, error: 'Input automation is currently only supported on Windows.' };
const DISABLED = { ok: false, error: 'Input automation is disabled. Enable it with POST /api/input/enable ({"enabled":true}) or ENABLE_INPUT_AUTOMATION=true in .env.' };

async function runScript(args) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, ...args],
    { timeout: 8000, maxBuffer: 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : { ok: true };
}

function guardOrThrow() {
  if (platform !== 'win32') return UNSUPPORTED;
  if (!automationGuard.isEnabled('input')) return DISABLED;
  return null;
}

function logAction(action, args, result) {
  audit.record({
    type: 'input',
    action,
    args,
    ok: result.ok !== false,
    summary: result.ok === false ? `${action} failed: ${result.error}` : `Input: ${action}${args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`,
  });
}

async function getBounds() {
  if (platform !== 'win32') return UNSUPPORTED;
  return runScript(['-Op', 'bounds']);
}

async function moveMouse(x, y) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'move', '-X', String(x), '-Y', String(y)]);
    logAction('move', { x, y }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('move', { x, y }, result);
    return result;
  }
}

async function click({ x, y, button = 'left', double = false } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  const args = ['-Op', 'click', '-Button', button];
  if (x !== undefined && y !== undefined) args.push('-X', String(x), '-Y', String(y));
  if (double) args.push('-Double');
  try {
    const result = await runScript(args);
    logAction('click', { x, y, button, double }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('click', { x, y, button, double }, result);
    return result;
  }
}

async function scroll({ delta, x, y } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  const args = ['-Op', 'scroll', '-Delta', String(delta)];
  if (x !== undefined && y !== undefined) args.push('-X', String(x), '-Y', String(y));
  try {
    const result = await runScript(args);
    logAction('scroll', { delta, x, y }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('scroll', { delta, x, y }, result);
    return result;
  }
}

async function typeText(text) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'type', '-Text', text]);
    logAction('type', { length: text.length }, result); // never log the typed text itself
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('type', { length: text.length }, result);
    return result;
  }
}

// Raw SendKeys notation for shortcuts: "^c" (ctrl+c), "{ENTER}", "%{F4}".
// This is the escape hatch for key combos `typeText` can't express — it is
// NOT escaped before being sent, so callers must pass valid SendKeys syntax.
async function pressKeys(keys) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'key', '-Keys', keys]);
    logAction('key', { keys }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('key', { keys }, result);
    return result;
  }
}

// Press-move-release from one point to another, moving through the screen
// in steps rather than teleporting — see the PS1 script's comment on why
// (HTML5/custom drag handlers need to see the mousemove events in between).
async function dragDrop({ fromX, fromY, toX, toY } = {}) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'dragdrop', '-FromX', String(fromX), '-FromY', String(fromY), '-ToX', String(toX), '-ToY', String(toY)]);
    logAction('dragdrop', { fromX, fromY, toX, toY }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('dragdrop', { fromX, fromY, toX, toY }, result);
    return result;
  }
}

// Clipboard read/write. Same gate as everything else in this file — the
// clipboard can hold sensitive text (passwords copied a moment ago, etc.),
// so reading it is a real capability, not a convenience freebie.
async function clipboardRead() {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'clipget']);
    // Never log clipboard contents — same reasoning as not logging typed text.
    logAction('clipget', { length: (result.text || '').length }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('clipget', {}, result);
    return result;
  }
}

async function clipboardWrite(text) {
  const blocked = guardOrThrow();
  if (blocked) return blocked;
  try {
    const result = await runScript(['-Op', 'clipset', '-Text', text]);
    logAction('clipset', { length: text.length }, result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    logAction('clipset', { length: text.length }, result);
    return result;
  }
}

module.exports = { getBounds, moveMouse, click, scroll, typeText, pressKeys, dragDrop, clipboardRead, clipboardWrite };
