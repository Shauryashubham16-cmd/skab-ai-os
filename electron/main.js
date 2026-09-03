const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Where .env lives depends on whether this is a packaged installer or a dev run:
//  - Dev (`npm run electron`): the project root .env, same file `npm start` uses.
//  - Packaged (.exe): a real .env can't ship inside the installer (that would
//    bake secrets into a redistributable file), so it lives in the OS's per-user
//    app-data folder instead, created from the bundled .env.example on first run.
function resolveEnvPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, '..', '.env');
  }
  const userEnvPath = path.join(app.getPath('userData'), '.env');
  if (!fs.existsSync(userEnvPath)) {
    const examplePath = path.join(process.resourcesPath, '.env.example');
    try {
      fs.copyFileSync(examplePath, userEnvPath);
    } catch (err) {
      console.error('[electron] could not seed .env from .env.example:', err.message);
    }
  }
  return userEnvPath;
}

let mainWindow;
const PORT = process.env.PORT || 4000;
const APP_URL = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(`${url}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error('JARVIS server did not come up in time'));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#05070B', // matches the HUD's dark theme — avoids a white flash on load
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false, // no <webview> anywhere in the app — leaving the tag enabled is its own attack surface
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  try {
    await waitForServer(APP_URL);
  } catch (err) {
    console.error('[electron] backend did not start in time:', err.message);
    // Load anyway — the page's own fetch calls will surface the real error,
    // which is more useful than an Electron-level blank screen.
  }

  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => { mainWindow = null; });

  // DevTools exposes the same renderer console a compromised/malicious
  // page could use to poke at window internals — harmless in dev (where
  // you want it for debugging the HUD), but there's no reason an installed
  // desktop app should let a user (or anything running as them) pop it
  // open via Ctrl+Shift+I/F12 in a packaged build.
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = (input.key || '').toLowerCase();
      const isDevToolsShortcut = key === 'f12' || (input.control && input.shift && key === 'i');
      if (isDevToolsShortcut) event.preventDefault();
    });
    mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
  }
}

// Hardening applied to every webContents this app ever creates (the main
// window today, plus anything spawned by it in the future) rather than just
// mainWindow — attaching at the app level means a new surface added later
// can't accidentally skip these checks by forgetting to wire them up itself.
//
//  - setWindowOpenHandler: window.open()/target=_blank never opens a second
//    Electron window (which would inherit webPreferences and could become
//    a second privileged surface) — it hands off to the OS browser instead,
//    and only for http/https targets. Anything else (file://, javascript:,
//    custom schemes) is dropped outright rather than handed to shell.openExternal,
//    since that call can itself trigger local file handlers on some OSes.
//  - will-navigate: the loaded page (and anything it might redirect to —
//    compromised CDN script, XSS, a misbehaving fetch) can never navigate
//    the window itself away from APP_URL. The app never needs top-level
//    navigation beyond the one local URL it boots to.
//  - setPermissionRequestHandler: deny every permission request (camera,
//    mic, geolocation, notifications, clipboard-read, etc.) by default —
//    nothing in this app's current feature set needs the browser to grant
//    them, so there is no legitimate prompt to approve.
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(url);
    } catch { /* not a parseable URL — drop it */ }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (url !== APP_URL && !url.startsWith(`${APP_URL}/`)) {
      event.preventDefault();
      console.warn(`[electron] blocked navigation attempt to ${url}`);
    }
  });

  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });
}

app.on('web-contents-created', (event, contents) => hardenWebContents(contents));

async function main() {
  const envPath = resolveEnvPath();
  const isFirstRun = app.isPackaged && !fs.existsSync(path.join(app.getPath('userData'), '.env-initialized'));
  require('dotenv').config({ path: envPath });

  // This starts the exact same Express + Socket.IO server used by `npm start` —
  // nothing about the backend or frontend changes for the desktop build.
  require('../server.js');

  Menu.setApplicationMenu(null);
  await createWindow();

  if (isFirstRun) {
    fs.writeFileSync(path.join(app.getPath('userData'), '.env-initialized'), '');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'JARVIS — first run',
      message: 'JARVIS needs your API keys to fully work.',
      detail: `A template .env file was created at:\n\n${envPath}\n\nOpen it in any text editor, fill in your keys, then restart JARVIS.`,
    });
  }
}

app.whenReady().then(() => {
  main();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
