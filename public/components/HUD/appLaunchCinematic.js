/* ---------------- APP LAUNCH CINEMATIC ---------------- */
// Plays a ~1.6s reactor-pulse + expanding-ring + scan-sweep + materializing
// glass card sequence over the reactor when JARVIS actually launches a
// desktop app. Fired from the two real places this can happen — never
// guessed from message text:
//   1. chat.js, off data.provider === 'app-launcher' (the plain "open
//      spotify" chat intent — see routes/chat.js's tryOpenAppIntent, which
//      now polls utils/launchVerifier.js and echoes back
//      appKey/launched/verified alongside the reply).
//   2. terminal.js's agent:log socket handler, off payload.tool ===
//      'apps.open' (a /task run whose plan calls the same launcher tool,
//      now also verified — see utils/toolRegistry.js — and echoed on that
//      event by utils/taskEngine.js).
// The card's final status text (Online / Not confirmed / Launch failed) is
// always the real, verified outcome — never assumed from a successful
// spawn — matching the honesty of the backend's own reply text.
// "Reactor should pulse" reuses the reactor's own existing burst effect
// (reactorStateMachine.js's reactorBurst()) rather than inventing a second,
// competing pulse. Everything new here (#appLaunchCinematic in index.html)
// is layered on top and additive — no existing HUD element, layout, or
// state-machine behavior is touched.
const alcEl = document.getElementById('appLaunchCinematic');
const alcIcon = document.getElementById('alcIcon');
const alcName = document.getElementById('alcName');
const alcStatus = document.getElementById('alcStatus');
const alcDetail = document.getElementById('alcDetail');

// Small, purely-cosmetic glyph per known app key (see utils/appLauncher.js's
// APP_REGISTRY/ALIASES) — falls back to a generic glyph for anything not
// listed here (e.g. a discovered Windows Start-menu app), so this never
// blocks on keeping two lists in sync.
const ALC_ICONS = {
  chrome: '🌐', firefox: '🦊', safari: '🧭', edge: '🌊', spotify: '🎵',
  vscode: '💻', notes: '📝', calculator: '🧮', terminal: '⌨️', mail: '✉️',
  calendar: '🗓️', slack: '💬', discord: '🎮', finder: '📁', files: '📁',
};

let alcTimer = null;

// appKey: the resolved launcher key (e.g. "spotify").
// launched: whether the OS actually accepted the spawn request (false only
//   if appLauncher.js itself failed, e.g. unknown app).
// verified: whether utils/launchVerifier.js actually found the app's
//   process running afterward — the real "is it actually open" signal, not
//   assumed from a successful spawn. Three honest outcomes, not two:
//   launched===false -> 'fail' (never even requested)
//   launched && !verified -> 'warn' (requested, couldn't confirm — may
//     still be starting, or this app/OS combo has no process-name hint)
//   launched && verified -> 'ok' (confirmed actually running)
// pid: the real PID verifyLaunch() found, shown as a small detail line when
//   verified — purely cosmetic, omitted whenever it isn't available.
function playAppLaunchCinematic(appKey, launched, verified, pid) {
  if (!alcEl) return;
  const label = (appKey || 'app').replace(/[-_]/g, ' ');
  if (alcName) alcName.textContent = label;
  if (alcIcon) alcIcon.textContent = ALC_ICONS[appKey] || '▣';

  let statusText, detailText, tone;
  if (launched === false) {
    statusText = 'Launch failed'; detailText = 'See terminal log'; tone = 'fail';
  } else if (verified) {
    statusText = 'Online'; detailText = pid ? `PID ${pid}` : 'Process confirmed'; tone = 'ok';
  } else {
    statusText = 'Not confirmed'; detailText = 'May still be starting'; tone = 'warn';
  }
  if (alcStatus) alcStatus.textContent = statusText;
  if (alcDetail) alcDetail.textContent = detailText;

  clearTimeout(alcTimer);
  alcEl.classList.remove('play', 'fail', 'warn');
  // eslint-disable-next-line no-unused-expressions
  alcEl.offsetWidth; // force reflow so back-to-back launches re-trigger cleanly
  alcEl.classList.add('play');
  if (tone === 'fail') alcEl.classList.add('fail');
  if (tone === 'warn') alcEl.classList.add('warn');
  if (typeof reactorBurst === 'function') reactorBurst();

  alcTimer = setTimeout(() => alcEl.classList.remove('play', 'fail', 'warn'), 1800);
}

window.JARVIS = window.JARVIS || {};
window.JARVIS.playAppLaunchCinematic = playAppLaunchCinematic;
