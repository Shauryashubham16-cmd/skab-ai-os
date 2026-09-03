// Window management + "what window is focused right now" via a fixed
// PowerShell helper script (utils/scripts/window-manager.ps1).
//
// Same trust model as the rest of utils/: the script path and its arguments
// are always fixed enum values or numeric handles obtained from a prior
// enumeration — never raw user text — and it's invoked with execFile, never
// a shell string. Windows-only for now; other platforms get a clear
// "not supported" response instead of a silent no-op.
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');

const execFileP = util.promisify(execFile);
const SCRIPT_PATH = path.join(__dirname, 'scripts', 'window-manager.ps1');
const platform = process.platform;

const UNSUPPORTED = { ok: false, error: 'Window management is currently only supported on Windows.' };

async function runScript(args) {
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, ...args],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function listWindows() {
  if (platform !== 'win32') return UNSUPPORTED;
  const data = await runScript(['-Op', 'list']);
  // A single window comes back as an object, not an array — normalize.
  const windows = Array.isArray(data) ? data : (data ? [data] : []);
  return { ok: true, count: windows.length, windows };
}

async function getActiveWindow() {
  if (platform !== 'win32') return UNSUPPORTED;
  const data = await runScript(['-Op', 'active']);
  if (!data || data.ok === false) return { ok: false, error: data?.error || 'No active window' };
  return { ok: true, ...data };
}

// Resolves a user-facing "target" (a title, or a handle string from a prior
// listWindows() call) to a live handle by re-enumerating current windows —
// so an action always acts on something that's actually open right now.
async function resolveHandle(target) {
  const { windows } = await listWindows();
  if (/^\d+$/.test(target)) {
    const exact = windows.find((w) => w.handle === target);
    if (exact) return exact;
  }
  const needle = target.trim().toLowerCase();
  const exactTitle = windows.find((w) => w.title.toLowerCase() === needle);
  if (exactTitle) return exactTitle;
  const partial = windows.find((w) => w.title.toLowerCase().includes(needle)
    || (w.processName || '').toLowerCase() === needle);
  return partial || null;
}

async function windowAction(action, target) {
  if (platform !== 'win32') return UNSUPPORTED;
  if (!target) return { ok: false, error: '"target" (a window title or handle) is required' };
  const match = await resolveHandle(target);
  if (!match) return { ok: false, error: `No open window matches "${target}"` };
  const result = await runScript(['-Op', 'action', '-Handle', match.handle, '-Action', action]);
  return { ...result, window: { title: match.title, processName: match.processName, pid: match.pid } };
}

module.exports = { listWindows, getActiveWindow, windowAction };
