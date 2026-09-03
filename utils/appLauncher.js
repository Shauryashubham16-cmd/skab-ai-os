// Opens desktop apps by name.
//
// This never takes freeform text and hands it to a shell. Every launch goes
// through a fixed allowlist (below), keyed by friendly name/aliases, mapped
// to a platform-specific launch command. If the name isn't in the list,
// nothing runs — full stop. Add your own apps in APP_REGISTRY or override/
// extend it via a local apps.json (see loadUserApps below) so you don't have
// to edit source to add e.g. a game or a work tool.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const platform = process.platform; // 'darwin' | 'win32' | 'linux'

// name -> { darwin, win32, linux } launch spec. Each value is either:
//   a string   -> treated as the registered app name (mac: `open -a NAME`,
//                 windows: `start "" NAME`, linux: tried via xdg-open/gtk-launch)
//   an object  -> { cmd, args } spawned directly, for things that need it
const APP_REGISTRY = {
  chrome:      { darwin: 'Google Chrome', win32: 'chrome', linux: 'google-chrome' },
  firefox:     { darwin: 'Firefox', win32: 'firefox', linux: 'firefox' },
  safari:      { darwin: 'Safari' },
  edge:        { darwin: 'Microsoft Edge', win32: 'msedge', linux: 'microsoft-edge' },
  spotify:     { darwin: 'Spotify', win32: 'spotify', linux: 'spotify' },
  vscode:      { darwin: 'Visual Studio Code', win32: 'code', linux: 'code' },
  notes:       { darwin: 'Notes', win32: 'notepad', linux: 'gedit' },
  calculator:  { darwin: 'Calculator', win32: 'calc', linux: 'gnome-calculator' },
  terminal:    { darwin: 'Terminal', win32: 'cmd', linux: 'gnome-terminal' },
  mail:        { darwin: 'Mail', win32: 'outlookmail:', linux: 'thunderbird' },
  calendar:    { darwin: 'Calendar', win32: 'outlookcal:', linux: 'gnome-calendar' },
  slack:       { darwin: 'Slack', win32: 'slack', linux: 'slack' },
  discord:     { darwin: 'Discord', win32: 'discord', linux: 'discord' },
  finder:      { darwin: 'Finder', win32: 'explorer' },
  files:       { darwin: 'Finder', win32: 'explorer', linux: 'nautilus' },
};

// Discover Windows Start-menu shortcuts at runtime. Unlike a shell search this
// only reads .lnk files from the two standard Start Menu directories and later
// launches an exact discovered shortcut with explorer.exe.
function discoverWindowsApps() {
  if (platform !== 'win32') return {};
  const roots = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter(Boolean);
  const found = {};
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk')) {
        const name = path.basename(entry.name, '.lnk').trim().toLowerCase();
        if (name && !found[name]) found[name] = { win32: { cmd: 'explorer.exe', args: [full] } };
      }
    }
  };
  roots.forEach(visit);
  return found;
}

// Aliases so "open my browser" / "open code" etc. resolve naturally.
const ALIASES = {
  browser: 'chrome',
  code: 'vscode',
  'visual studio code': 'vscode',
  music: 'spotify',
  explorer: 'files',
  outlook: 'mail',
};

function loadUserApps() {
  const file = path.join(__dirname, '..', 'config', 'apps.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function resolveKey(name) {
  const key = name.trim().toLowerCase();
  return ALIASES[key] || key;
}

function knownApps() {
  return { ...APP_REGISTRY, ...discoverWindowsApps(), ...loadUserApps() };
}

function launch(name) {
  const registry = knownApps();
  const key = resolveKey(name);
  const entry = registry[key];
  if (!entry) {
    return { ok: false, error: `"${name}" isn't in the app list. Known apps: ${Object.keys(registry).join(', ')}` };
  }

  const target = entry[platform];
  if (!target) {
    return { ok: false, error: `No launcher registered for "${key}" on ${platform}.` };
  }

  try {
    if (typeof target === 'object' && target.cmd) {
      spawn(target.cmd, target.args || [], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', ['-a', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'win32') {
      // 'start' is a cmd.exe builtin, not a real executable — must go through cmd /c.
      // The app token is never user-composed shell text, only a fixed registry value.
      spawn('cmd.exe', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    // A GUI program may detach immediately, so a successful spawn only proves
    // that Windows/macOS/Linux accepted the launch request. Do not claim the
    // app is already running; callers can present this truthful state instead.
    return { ok: true, app: key, state: 'launch-requested', requestedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Lightweight intent detector for chat messages like "open spotify" / "launch vscode".
// Returns the matched app name or null — never returns raw user text for execution.
function detectOpenIntent(message) {
  const match = /^\s*(?:open|launch|start)\s+(?:up\s+)?(?:the\s+)?(?:app\s+)?([a-zA-Z0-9 _.-]{2,40})\s*$/i.exec(message);
  if (!match) return null;
  const registry = knownApps();
  const key = resolveKey(match[1]);
  return registry[key] ? key : null;
}

module.exports = { launch, detectOpenIntent, knownApps };
