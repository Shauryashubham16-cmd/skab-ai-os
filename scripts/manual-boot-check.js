// See notes below for why this lives outside tests/ (needs jsdom, a one-off
// devDependency, not added to package.json). Run with:
//   node scripts/manual-boot-check.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const jarvisStateSrc = fs.readFileSync(path.join(ROOT, 'public/state/jarvisState.js'), 'utf8');

function extractBlock(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start) + endMarker.length;
  if (start === -1 || end === -1) throw new Error(`Could not find block ${startMarker}..${endMarker}`);
  return html.slice(start, end);
}
const bootBlock = extractBlock(indexHtml, '<div id="bootScreen">', '</div>\n</div>');
const authBlock = extractBlock(indexHtml, '<div id="authScreen"', '</div>\n</div>');

const REQUIRED_IDS = [
  'bootScreen', 'bootVeilHole', 'bootStage', 'bootMark', 'bootTagline',
  'bootBarFill', 'bootDiagnostics', 'bootLog', 'authScreen', 'authForm',
  'authCode', 'authMsg', 'authSubmit', 'authTitle', 'authLead',
];

const FAKE_BOOT_STATUS = {
  core: { status: 'online' }, memory: { status: 'online', backend: 'local' },
  vision: { status: 'degraded', ocr: true, llmVision: false },
  browser: { status: 'offline', enabled: false }, automation: { status: 'offline', enabled: false },
  plugins: { status: 'offline', enabled: false, loaded: 0, errors: 0 },
  scheduler: { status: 'online' }, security: { status: 'active', defaultPasscode: false },
  aiAgent: { status: 'ready', providers: ['gemini'] }, time: new Date().toISOString(),
};

// Fresh JSDOM window per scenario — no two sequences ever share a document,
// so there's no possibility of the kind of cross-talk that broke the first
// draft of this script (two playCinematicSequence() runs fighting over the
// same DOM at once).
function freshWindow({ fetchImpl, bootSettings }) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bootBlock}\n${authBlock}</body></html>`, {
    url: 'http://localhost/',
    // 'dangerously' (rather than 'outside-only') lets us load jarvisState.js as a
    // real inline <script> below instead of via window.eval() — same net effect
    // (the boot IIFE runs and wires itself to this window/document), but it goes
    // through JSDOM's normal script-execution path rather than a raw eval call.
    // Still only ever fed our own on-disk source, never external/user input.
    runScripts: 'dangerously',
  });
  const { window } = dom;
  for (const id of REQUIRED_IDS) {
    if (!window.document.getElementById(id)) throw new Error(`Missing #${id} in extracted markup`);
  }
  window.fetch = fetchImpl;
  window.localStorage.clear();
  if (bootSettings) window.localStorage.setItem('jarvis_boot_settings', JSON.stringify(bootSettings));
  return window;
}

// Loads jarvisState.js into `window` as a real <script> element (JSDOM executes it
// synchronously for inline scripts under runScripts:'dangerously') instead of
// window.eval(jarvisStateSrc). Replaces every prior window.eval(jarvisStateSrc) call site.
function loadJarvisState(window) {
  const script = window.document.createElement('script');
  script.textContent = jarvisStateSrc;
  window.document.body.appendChild(script);
}

async function scenarioA_freshBootNoSession() {
  console.log('\n[A] Fresh page load, no stored session, fast+cinematic boot...');
  let calls = [];
  const window = freshWindow({
    bootSettings: { cinematic: true, fast: true }, // set BEFORE eval so the automatic runBoot() at load also runs fast
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/boot-status') return { ok: true, json: async () => FAKE_BOOT_STATUS };
      throw new Error(`Unexpected fetch in scenario A: ${url}`);
    },
  });

  const start = Date.now();
  loadJarvisState(window); // runBoot() fires automatically at the bottom of the IIFE, fire-and-forget
  const authScreen = window.document.getElementById('authScreen');
  const bootScreen = window.document.getElementById('bootScreen');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!authScreen.classList.contains('hidden')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Date.now() - start;
  console.log(`  settled after ${elapsed}ms; fetch calls: ${JSON.stringify(calls)}`);

  if (authScreen.classList.contains('hidden')) throw new Error('[A] Auth screen never appeared for a session-less boot');
  if (!bootScreen.classList.contains('hidden')) throw new Error('[A] Boot screen never hid itself after completing');
  if (!calls.includes('/api/boot-status')) throw new Error('[A] /api/boot-status was never called during real boot');
  if (elapsed > 6000) throw new Error(`[A] Fast boot took ${elapsed}ms — Fast Boot setting is not actually compressing timing`);
  console.log('  [A] PASS — lands on the auth screen, boot veil hidden, fast timing honored');
}

async function scenarioB_diagnosticsAccuracy() {
  console.log('\n[B] Replay preview (skipIdentity), degraded/offline subsystems...');
  let calls = [];
  const window = freshWindow({
    bootSettings: { cinematic: false, fast: false }, // deliberately OFF, to prove replayBoot always shows the real cinematic sequence regardless
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/boot-status') return { ok: true, json: async () => FAKE_BOOT_STATUS };
      if (url === '/api/auth/me') throw new Error('[B] replayBoot must not touch identity — it is only reachable from an already-signed-in session');
      throw new Error(`Unexpected fetch in scenario B: ${url}`);
    },
  });
  loadJarvisState(window);
  // The automatic runBoot() also fires here (cinematic:false -> plain path,
  // which is fast). Give it a moment to clear before driving replayBoot()
  // explicitly, so the two don't overlap.
  await new Promise((r) => setTimeout(r, 800));
  calls = []; // only care about calls made by the explicit replayBoot() below

  window.JARVIS.setBootSetting('fast', true);
  const bootVeilHole = window.document.getElementById('bootVeilHole');
  const bootDiagnostics = window.document.getElementById('bootDiagnostics');

  const start = Date.now();
  await window.JARVIS.replayBoot();
  const elapsed = Date.now() - start;
  console.log(`  replayBoot() resolved after ${elapsed}ms; fetch calls: ${JSON.stringify(calls)}`);

  if (!bootVeilHole.className.includes('reveal-open')) throw new Error('[B] Veil did not end fully open');
  const rows = [...bootDiagnostics.querySelectorAll('.row')];
  if (rows.length !== 9) throw new Error(`[B] Expected 9 diagnostic rows, got ${rows.length}`);
  const text = rows.map((r) => r.textContent.trim()).join(' | ');
  console.log('  rows:', text);
  if (!text.includes('DEGRADED')) throw new Error('[B] Degraded subsystem not shown as DEGRADED');
  if (!text.includes('OFFLINE')) throw new Error('[B] Offline subsystem not shown as OFFLINE');
  if (!rows.some((r) => r.querySelector('.val.offline'))) throw new Error('[B] No element carries the .offline styling hook');
  if (!rows.some((r) => r.querySelector('.val.degraded'))) throw new Error('[B] No element carries the .degraded styling hook');
  if (!calls.includes('/api/boot-status')) throw new Error('[B] replayBoot() did not call /api/boot-status');
  console.log('  [B] PASS — real per-subsystem status rendered accurately, identity never touched');
}

async function scenarioC_backendUnreachable() {
  console.log('\n[C] Backend unreachable during diagnostics...');
  const window = freshWindow({
    bootSettings: { cinematic: true, fast: true },
    fetchImpl: async () => { throw new Error('ECONNREFUSED (simulated)'); },
  });
  loadJarvisState(window);
  await new Promise((r) => setTimeout(r, 2500)); // fast mode, plenty of margin
  const bootLog = window.document.getElementById('bootLog');
  const bootDiagnostics = window.document.getElementById('bootDiagnostics');
  console.log('  bootLog contents:', bootLog.textContent.trim());
  if (!bootLog.textContent.includes('Backend unreachable')) throw new Error('[C] No unreachable-backend warning was shown');
  if (bootDiagnostics.querySelector('.val.online')) throw new Error('[C] A subsystem was marked ONLINE despite the backend being unreachable — this must never happen');
  console.log('  [C] PASS — failure is surfaced honestly, nothing falsely reported ONLINE');
}

async function scenarioD_validSessionSkipsAuth() {
  console.log('\n[D] Fresh page load WITH a valid stored session...');
  const window = freshWindow({
    bootSettings: { cinematic: true, fast: true },
    fetchImpl: async (url, opts) => {
      if (url === '/api/boot-status') return { ok: true, json: async () => FAKE_BOOT_STATUS };
      if (url === '/api/auth/me') {
        if (opts?.headers?.Authorization !== 'Bearer test-token-123') throw new Error('[D] Bearer token not attached to /api/auth/me');
        return { ok: true, json: async () => ({ user: { id: 'local-user', name: 'Rahul' } }) };
      }
      throw new Error(`Unexpected fetch in scenario D: ${url}`);
    },
  });
  window.localStorage.setItem('jarvis_auth', JSON.stringify({ access_token: 'test-token-123' }));

  loadJarvisState(window);
  let signedInUser = null;
  window.JARVIS.onAuth((user) => { signedInUser = user; });

  const authScreen = window.document.getElementById('authScreen');
  const bootScreen = window.document.getElementById('bootScreen');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (bootScreen.classList.contains('hidden')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 100)); // let markSignedIn's listener callback fire

  console.log('  signed-in user after boot:', signedInUser);
  console.log('  authScreen classes:', authScreen.className);
  if (!signedInUser || signedInUser.name !== 'Rahul') throw new Error('[D] markSignedIn was not called with the real /api/auth/me user');
  if (!authScreen.classList.contains('hidden')) throw new Error('[D] Auth screen should stay hidden when the session is valid — the boot should reveal straight into the HUD');
  console.log('  [D] PASS — valid session skips the auth card entirely, straight into the HUD');
}

async function main() {
  await scenarioA_freshBootNoSession();
  await scenarioB_diagnosticsAccuracy();
  await scenarioC_backendUnreachable();
  await scenarioD_validSessionSkipsAuth();
  console.log('\nAll headless boot-sequence checks passed.');
}

main().catch((err) => {
  console.error('\nMANUAL BOOT CHECK FAILED:', err.message);
  process.exit(1);
});
