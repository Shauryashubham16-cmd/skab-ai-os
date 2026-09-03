// System-level power controls, audio/brightness, and process management.
//
// The important design rule here: nothing destructive runs on the LLM's say-so
// alone. shutdown / restart / sleep / hibernate / logout / kill_process all go
// through requestAction() first, which parks them as a pending action tied to
// the user and returns a description — the action only actually runs once the
// SAME user calls confirmPending() (wired to typing "confirm"/"yes" in chat,
// or a real confirm button if you add one later). Pending actions expire after
// 60s so a stale "yes" from an unrelated later message can't trigger them.
//
// Every command is built as a fixed file + argument array and run via execFile
// (never a shell string), so even validated numeric input (volume/brightness
// levels) can't reach a shell interpreter.
const { execFile } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const os = require('os');
const si = require('systeminformation');

const execFileP = util.promisify(execFile);
const platform = os.platform(); // 'win32' | 'darwin' | 'linux'

const CONFIRM_REQUIRED = new Set(['shutdown', 'restart', 'sleep', 'hibernate', 'logout', 'kill_process']);
const PENDING_TTL_MS = 60 * 1000;

// userId -> { id, action, args, description, expiresAt }
const pending = new Map();

function describe(action, args) {
  switch (action) {
    case 'shutdown': return 'Shut this computer down immediately.';
    case 'restart': return 'Restart this computer immediately.';
    case 'sleep': return 'Put this computer to sleep.';
    case 'hibernate': return 'Hibernate this computer.';
    case 'logout': return 'Sign out of this computer.';
    case 'kill_process': return `Terminate the process "${args.target}".`;
    default: return `Run "${action}".`;
  }
}

async function runCmd(file, args) {
  try {
    const { stdout, stderr } = await execFileP(file, args, { timeout: 10000, windowsHide: true });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function commandFor(action, args) {
  const level = args.level;
  switch (action) {
    case 'shutdown':
      if (platform === 'win32') return ['shutdown', ['/s', '/t', '0']];
      if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to shut down']];
      return ['systemctl', ['poweroff']];
    case 'restart':
      if (platform === 'win32') return ['shutdown', ['/r', '/t', '0']];
      if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to restart']];
      return ['systemctl', ['reboot']];
    case 'sleep':
      if (platform === 'win32') return ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']];
      if (platform === 'darwin') return ['pmset', ['sleepnow']];
      return ['systemctl', ['suspend']];
    case 'hibernate':
      if (platform === 'win32') return ['shutdown', ['/h']];
      if (platform === 'linux') return ['systemctl', ['hibernate']];
      return null; // not supported on macOS
    case 'lock':
      if (platform === 'win32') return ['rundll32.exe', ['user32.dll,LockWorkStation']];
      if (platform === 'darwin') return ['pmset', ['displaysleepnow']];
      return ['loginctl', ['lock-session']];
    case 'logout':
      if (platform === 'win32') return ['shutdown', ['/l']];
      if (platform === 'darwin') return ['osascript', ['-e', 'tell application "System Events" to log out']];
      return ['loginctl', ['terminate-session', 'self']];
    case 'mute':
      if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).SendKeys([char]173)']];
      if (platform === 'darwin') return ['osascript', ['-e', 'set volume with output muted']];
      return ['amixer', ['-D', 'pulse', 'sset', 'Master', 'mute']];
    case 'unmute':
      if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).SendKeys([char]173)']]; // toggle — Windows has no direct "unmute" key
      if (platform === 'darwin') return ['osascript', ['-e', 'set volume without output muted']];
      return ['amixer', ['-D', 'pulse', 'sset', 'Master', 'unmute']];
    case 'volume_up':
      if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).SendKeys([char]175)']];
      if (platform === 'darwin') return ['osascript', ['-e', 'set volume output volume (output volume of (get volume settings) + 10)']];
      return ['amixer', ['-D', 'pulse', 'sset', 'Master', '5%+']];
    case 'volume_down':
      if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).SendKeys([char]174)']];
      if (platform === 'darwin') return ['osascript', ['-e', 'set volume output volume (output volume of (get volume settings) - 10)']];
      return ['amixer', ['-D', 'pulse', 'sset', 'Master', '5%-']];
    case 'volume_set':
      if (platform === 'darwin') return ['osascript', ['-e', `set volume output volume ${level}`]];
      if (platform === 'linux') return ['amixer', ['-D', 'pulse', 'sset', 'Master', `${level}%`]];
      return null; // Windows has no built-in CLI for an absolute level without extra tooling
    case 'brightness_set':
      if (platform === 'win32') {
        return ['powershell', ['-NoProfile', '-Command', `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${level})`]];
      }
      if (platform === 'linux') return ['xbacklight', ['-set', `${level}`]];
      return null; // no simple built-in on macOS
    default:
      return null;
  }
}

async function listProcesses(limit = 30, sortBy = 'mem') {
  const data = await si.processes();
  const sorted = [...data.list].sort((a, b) => (sortBy === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem));
  return sorted.slice(0, limit).map((p) => ({
    pid: p.pid,
    name: p.name,
    cpuPercent: Math.round((p.cpu || 0) * 10) / 10,
    memPercent: Math.round((p.mem || 0) * 10) / 10,
    memMB: Math.round((p.memRss || 0) / 1024),
  }));
}

async function killProcess(target) {
  const data = await si.processes();
  let pid;
  if (/^\d+$/.test(target)) {
    pid = parseInt(target, 10);
    if (!data.list.find((p) => p.pid === pid)) return { ok: false, error: `No process with PID ${pid}.` };
  } else {
    const matches = data.list.filter((p) => p.name.toLowerCase().includes(target.toLowerCase()));
    if (matches.length === 0) return { ok: false, error: `No running process matching "${target}".` };
    if (matches.length > 1) {
      const preview = matches.slice(0, 5).map((m) => `${m.name} (pid ${m.pid})`).join(', ');
      return { ok: false, error: `Multiple processes match "${target}": ${preview}. Say a PID instead to be specific.` };
    }
    pid = matches[0].pid;
  }
  try {
    if (platform === 'win32') {
      await execFileP('taskkill', ['/PID', String(pid), '/F']);
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return { ok: true, message: `Terminated process ${pid}.` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The actual executor — only ever called after confirmation for destructive
// actions, or directly for the harmless/reversible ones.
async function execute(action, args) {
  if (action === 'kill_process') return killProcess(args.target);

  const built = commandFor(action, args);
  if (!built) return { ok: false, error: `"${action}" isn't supported on ${platform}.` };
  const [file, cmdArgs] = built;
  const result = await runCmd(file, cmdArgs);
  if (!result.ok) return result;
  return { ok: true, message: `Done: ${action.replace(/_/g, ' ')}.` };
}

function requestAction(userId, action, args = {}) {
  if (!CONFIRM_REQUIRED.has(action)) {
    return execute(action, args).then((result) => ({ needsConfirmation: false, ...result }));
  }
  const id = crypto.randomUUID();
  const description = describe(action, args);
  pending.set(userId, { id, action, args, description, expiresAt: Date.now() + PENDING_TTL_MS });
  return Promise.resolve({ needsConfirmation: true, actionId: id, description });
}

function getPending(userId) {
  const entry = pending.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pending.delete(userId);
    return null;
  }
  return entry;
}

async function confirmPending(userId, actionId) {
  const entry = getPending(userId);
  if (!entry) return { ok: false, error: 'Nothing pending to confirm (it may have expired).' };
  if (actionId && actionId !== entry.id) return { ok: false, error: 'That confirmation ID does not match the pending action.' };
  pending.delete(userId);
  const result = await execute(entry.action, entry.args);
  return { ...result, action: entry.action };
}

function cancelPending(userId) {
  const had = pending.delete(userId);
  return { ok: true, cancelled: had };
}

module.exports = { requestAction, confirmPending, cancelPending, getPending, listProcesses, killProcess, CONFIRM_REQUIRED };
