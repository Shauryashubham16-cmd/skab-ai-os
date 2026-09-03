/* ---------------- SETTINGS PANEL ----------------
   Fills in the "Settings" nav item, which existed in services/nav.js but had
   no panel behind it. Follows the exact overlay-panel pattern
   components/Imagination/imaginationViewer.js established (an
   #xOverlay.open toggle, an #xClose button, Escape-to-close) — see
   .settings-overlay/.settings-header/.settings-close in main.css, which
   share their base rules with .imagination-overlay rather than duplicating
   them. */
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const toggleCinematicBoot = document.getElementById('toggleCinematicBoot');
const toggleFastBoot = document.getElementById('toggleFastBoot');
const toggleBootSound = document.getElementById('toggleBootSound');
const settingsReplayBoot = document.getElementById('settingsReplayBoot');

function renderToggle(el, on) {
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', String(on));
}

function refreshBootToggles() {
  renderToggle(toggleCinematicBoot, window.JARVIS.bootSettings.cinematic);
  renderToggle(toggleFastBoot, window.JARVIS.bootSettings.fast);
  renderToggle(toggleBootSound, window.JARVIS.bootSettings.sound);
}
refreshBootToggles();

function bindToggle(el, key) {
  el.setAttribute('role', 'switch');
  const flip = () => {
    window.JARVIS.setBootSetting(key, !window.JARVIS.bootSettings[key]);
    refreshBootToggles();
  };
  el.addEventListener('click', flip);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
  });
}
bindToggle(toggleCinematicBoot, 'cinematic');
bindToggle(toggleFastBoot, 'fast');
bindToggle(toggleBootSound, 'sound');

settingsReplayBoot.addEventListener('click', async () => {
  if (settingsReplayBoot.classList.contains('busy')) return;
  settingsReplayBoot.classList.add('busy');
  settingsReplayBoot.textContent = 'Running…';
  closeSettings();
  try {
    if (typeof window.JARVIS.replayBoot === 'function') await window.JARVIS.replayBoot();
  } finally {
    settingsReplayBoot.textContent = 'Replay';
    settingsReplayBoot.classList.remove('busy');
  }
});

function openSettings() { settingsOverlay.classList.add('open'); }
function closeSettings() { settingsOverlay.classList.remove('open'); }
settingsClose.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOverlay.classList.contains('open')) closeSettings();
});
