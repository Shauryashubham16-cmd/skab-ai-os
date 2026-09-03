// Verifies a launched app actually started running, by polling the live
// process list (via `systeminformation`, the same library systemControl.js
// already uses for system.processes) for a process name matching the app
// that was just launched. This turns appLauncher.js's honest-but-unconfirmed
// 'launch-requested' state into a real, process-level confirmation instead
// of assuming success — the launch pipeline becomes:
//   launch (spawn) -> verifyLaunch (poll for the real process) -> caller
//   reports the actual outcome (online / unconfirmed / failed).
//
// Deliberately NOT window-detection (utils/windowManager.js) as the primary
// signal: window enumeration here is Windows-only, while process listing via
// systeminformation already works on darwin/win32/linux, so this stays
// cross-platform without a per-OS fallback branch.
const os = require('os');
const si = require('systeminformation');

const platform = os.platform();

// Best-effort process-name substrings per app key, since the string that
// launches an app (utils/appLauncher.js's APP_REGISTRY, e.g. "Google
// Chrome") is often not the same string the OS reports as the running
// process name (e.g. "chrome.exe" / "Google Chrome" / "chrome"). Falls back
// to the app key itself for anything not listed here (e.g. a discovered
// Windows Start-menu app) — good enough for most single-word app names, and
// simply times out (never falsely confirms) for anything it can't match.
const PROCESS_HINTS = {
  chrome: { win32: ['chrome.exe'], darwin: ['Google Chrome'], linux: ['chrome', 'google-chrome'] },
  firefox: { win32: ['firefox.exe'], darwin: ['firefox'], linux: ['firefox'] },
  safari: { darwin: ['Safari'] },
  edge: { win32: ['msedge.exe'], darwin: ['Microsoft Edge'], linux: ['msedge'] },
  spotify: { win32: ['Spotify.exe'], darwin: ['Spotify'], linux: ['spotify'] },
  vscode: { win32: ['Code.exe'], darwin: ['Code Helper', 'Electron'], linux: ['code'] },
  notes: { win32: ['notepad.exe'], darwin: ['Notes'], linux: ['gedit'] },
  calculator: { win32: ['CalculatorApp.exe', 'calc.exe'], darwin: ['Calculator'], linux: ['gnome-calculator'] },
  terminal: { win32: ['cmd.exe', 'WindowsTerminal.exe'], darwin: ['Terminal'], linux: ['gnome-terminal'] },
  mail: { win32: ['olk.exe', 'outlook.exe'], darwin: ['Mail'], linux: ['thunderbird'] },
  calendar: { win32: ['outlook.exe'], darwin: ['Calendar'], linux: ['gnome-calendar'] },
  slack: { win32: ['slack.exe'], darwin: ['Slack'], linux: ['slack'] },
  discord: { win32: ['Discord.exe'], darwin: ['Discord'], linux: ['discord'] },
  finder: { darwin: ['Finder'] },
  files: { win32: ['explorer.exe'], darwin: ['Finder'], linux: ['nautilus'] },
};

function candidateNames(key) {
  const hints = PROCESS_HINTS[key] && PROCESS_HINTS[key][platform];
  return (hints && hints.length ? hints : [key]).map((n) => n.toLowerCase());
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Polls for up to `timeoutMs` for any running process whose name contains
// one of the candidate substrings for `key`. Resolves as soon as a match is
// found — most real launches confirm well under a second — or after the
// timeout with verified:false. Never throws; a systeminformation read
// failure is treated the same as "couldn't confirm yet", not a crash, so a
// flaky process-list read never turns a real launch into a false failure.
async function verifyLaunch(key, { timeoutMs = 6000, intervalMs = 400 } = {}) {
  const candidates = candidateNames(key);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { list } = await si.processes();
      const match = list.find((p) => {
        const name = (p.name || '').toLowerCase();
        return candidates.some((c) => name.includes(c));
      });
      if (match) {
        return { verified: true, pid: match.pid, name: match.name, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // Treat a failed process-list read as just another empty poll.
    }
    await sleep(intervalMs);
  }
  return { verified: false, elapsedMs: Date.now() - startedAt };
}

module.exports = { verifyLaunch };
