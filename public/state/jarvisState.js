/* =====================================================================
   JARVIS boot + auth core.
   Runs before any other app script so that:
     - the boot overlay is on screen immediately,
     - every /api/* fetch carries the signed-in user's access token,
     - any /api/* call made by later scripts WAITS for sign-in instead of
       firing anonymously and failing with a 401,
     - the /terminal socket only connects with a verified token.
   ===================================================================== */
(function () {
  const STORE_KEY = 'jarvis_auth';

  const JARVIS = (window.JARVIS = {
    state: { user: null, sessionId: null, agent: 'auto' },
    listeners: [],
    onAuth(fn) { this.listeners.push(fn); if (this.state.user) fn(this.state.user); },
  });

  // ---- token storage -------------------------------------------------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
  }
  function save(session) {
    if (session) localStorage.setItem(STORE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORE_KEY);
    tokens = session;
  }
  let tokens = load();

  // Requests queue here until a session exists, so nothing races the login.
  let resolveReady;
  let ready = new Promise((r) => (resolveReady = r));

  function markSignedIn(user) {
    JARVIS.state.user = user;
    resolveReady();
    JARVIS.listeners.forEach((fn) => { try { fn(user); } catch (e) { console.warn(e); } });
  }
  function markSignedOut() {
    JARVIS.state.user = null;
    JARVIS.state.sessionId = null;
    ready = new Promise((r) => (resolveReady = r));
  }

  JARVIS.accessToken = () => (tokens && tokens.access_token) || null;
  JARVIS.ready = () => ready;

  // ---- fetch wrapper -------------------------------------------------
  // Attaches the bearer token. Tokens are long-lived (30d) stateless JWTs now,
  // so there's no refresh flow — a 401 just means "enter the codeword again".
  const rawFetch = window.fetch.bind(window);
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/');
  const isAuthRoute = (url) => typeof url === 'string' && url.startsWith('/api/auth/');

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isApi(url) || isAuthRoute(url)) return rawFetch(input, init);

    await ready; // hold app requests until the user is signed in

    const withAuth = (extra = {}) => ({
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${JARVIS.accessToken()}`, ...extra },
    });

    const res = await rawFetch(input, withAuth());
    if (res.status === 401) {
      markSignedOut();
      save(null);
      JARVIS.showAuth('Your session expired — please enter the codeword again.');
    }
    return res;
  };

  // ---- socket.io wrapper ---------------------------------------------
  // Sockets are created by later scripts at load time; defer the actual
  // connection until a token exists and hand it over at handshake.
  const realIo = window.io;
  if (typeof realIo === 'function') {
    window.io = function (namespace, opts = {}) {
      const socket = realIo(namespace, {
        ...opts,
        autoConnect: false,
        auth: (cb) => cb({ token: JARVIS.accessToken() }),
      });
      JARVIS.onAuth(() => { if (!socket.connected) socket.connect(); });
      return socket;
    };
    Object.assign(window.io, realIo);
  }

  // ---- boot settings (Cinematic Boot / Fast Boot toggles) ------------
  // Read by settingsPanel.js and by playCinematicSequence() below. Stored
  // the same way session tokens are (localStorage, JSON) — same pattern,
  // separate key so clearing a session never touches these preferences.
  const BOOT_SETTINGS_KEY = 'jarvis_boot_settings';
  function loadBootSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(BOOT_SETTINGS_KEY) || '{}');
      return { cinematic: saved.cinematic !== false, fast: saved.fast === true, sound: saved.sound !== false }; // cinematic + sound default ON, fast defaults OFF
    } catch {
      return { cinematic: true, fast: false, sound: true };
    }
  }
  JARVIS.bootSettings = loadBootSettings();
  JARVIS.setBootSetting = function (key, value) {
    JARVIS.bootSettings[key] = value;
    localStorage.setItem(BOOT_SETTINGS_KEY, JSON.stringify(JARVIS.bootSettings));
  };

  // ---- cinematic boot sequence -----------------------------------------
  // No second reactor is built here — #reactorWrap (further down this file,
  // in the main HUD markup) is already in the DOM and already animating; its
  // ring-spin keyframes run unconditionally, not gated by any "booted"
  // state. This overlay is a dark veil with a growing circular hole
  // (#bootVeilHole, see styles/main.css) that reveals the real HUD
  // underneath in place, so the "smooth transition into the HUD" is a
  // literal reveal of the one HUD that exists, not a swap between two.
  const bootScreen = document.getElementById('bootScreen');
  const bootVeilHole = document.getElementById('bootVeilHole');
  const bootStageEl = document.getElementById('bootStage');
  const bootMarkEl = document.getElementById('bootMark');
  const bootTaglineEl = document.getElementById('bootTagline');
  const bootBar = document.getElementById('bootBarFill');
  const bootRingPct = document.getElementById('bootRingPct');
  const bootRingMicro = document.getElementById('bootRingMicro');
  const bootRingWrap = document.getElementById('bootRingWrap');
  const bootActivationFlash = document.getElementById('bootActivationFlash');
  const bootTicksMajor = document.getElementById('bootTicksMajor');
  const bootTicksMinor = document.getElementById('bootTicksMinor');
  const bootPanelLeft = document.getElementById('bootPanelLeft');
  const bootPanelRight = document.getElementById('bootPanelRight');
  const bootDiagnostics = document.getElementById('bootDiagnostics');
  const bootLog = document.getElementById('bootLog');

  // ---- radial tick marks (once, at load — pure geometry, never rebuilt) --
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function buildTicks(group, count, r1, r2, everyNth) {
    if (!group || group.childElementCount) return;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI;
      const major = everyNth && i % everyNth === 0;
      const rr1 = major ? r1 - 5 : r1;
      const x1 = 100 + rr1 * Math.cos(angle), y1 = 100 + rr1 * Math.sin(angle);
      const x2 = 100 + r2 * Math.cos(angle), y2 = 100 + r2 * Math.sin(angle);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x1.toFixed(2)); line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2)); line.setAttribute('y2', y2.toFixed(2));
      line.setAttribute('stroke-width', major ? '1.4' : '0.6');
      line.setAttribute('opacity', major ? '.6' : '.3');
      group.appendChild(line);
    }
  }
  buildTicks(bootTicksMajor, 24, 100, 96, 3); // 24 marks around the outer rim, every 3rd longer
  buildTicks(bootTicksMinor, 60, 44, 40);     // fine ring closer to the core

  // ---- flanking diagnostic side panels ------------------------------
  // Left panel: live boot-status rows (same STATUS_ROWS/backend data the
  // center diagnostics list uses — real state, not invented for density).
  // Right panel: a real elapsed-time readout (measured with
  // performance.now(), not scripted) plus decorative sparkline bars —
  // the bars are motion/texture only and never stand in for a numeric
  // claim, same spirit as the reactor's existing ambient particles.
  let bootStartTime = 0;
  let bootElapsedTimer = null;
  function buildSpark(n) {
    const wrap = document.createElement('div');
    wrap.className = 'boot-spark';
    for (let i = 0; i < n; i++) {
      const bar = document.createElement('i');
      bar.style.height = (6 + Math.round(Math.random() * 14)) + 'px';
      bar.style.animationDelay = (i * 70) + 'ms';
      wrap.appendChild(bar);
    }
    return wrap;
  }
  function panelRow(label, value) {
    const row = document.createElement('div');
    row.className = 'boot-readout-row';
    row.innerHTML = `<span>${label}</span><span class="val">${value}</span>`;
    return row;
  }
  function renderSidePanels(status) {
    bootPanelLeft.innerHTML = '';
    bootPanelRight.innerHTML = '';
    const rows = STATUS_ROWS;
    const half = Math.ceil(rows.length / 2);
    rows.slice(0, half).forEach(([key, label]) => {
      const st = (status && status[key] && status[key].status) || (status ? 'offline' : 'SYNC');
      bootPanelLeft.appendChild(panelRow(label, status ? (STATUS_LABEL[st] || st.toUpperCase()) : '···'));
    });
    bootPanelLeft.appendChild(buildSpark(14));
    rows.slice(half).forEach(([key, label]) => {
      const st = (status && status[key] && status[key].status) || (status ? 'offline' : 'SYNC');
      bootPanelRight.appendChild(panelRow(label, status ? (STATUS_LABEL[st] || st.toUpperCase()) : '···'));
    });
    const hr = document.createElement('div'); hr.className = 'boot-panel-hr';
    bootPanelRight.appendChild(hr);
    const elapsedRow = panelRow('ELAPSED', '0.0s');
    elapsedRow.id = 'bootElapsedRow';
    bootPanelRight.appendChild(elapsedRow);
    bootPanelRight.appendChild(buildSpark(14));
    bootPanelLeft.classList.add('show');
    bootPanelRight.classList.add('show');
  }
  function startElapsedClock() {
    bootStartTime = performance.now();
    clearInterval(bootElapsedTimer);
    bootElapsedTimer = setInterval(() => {
      const row = document.getElementById('bootElapsedRow');
      if (!row) return;
      const secs = ((performance.now() - bootStartTime) / 1000).toFixed(1);
      row.querySelector('.val').textContent = secs + 's';
    }, 100);
  }
  function stopElapsedClock() { clearInterval(bootElapsedTimer); bootElapsedTimer = null; }

  // ---- synthesized boot sound effects (Web Audio, no shipped assets) --
  // Autoplay policy: browsers block audio before any user gesture, so a
  // cold page load's first stage or two may be silent until the first
  // click/keypress anywhere on the page — that listener resumes the audio
  // context. Every call also checks bootSettings.sound so the Settings
  // toggle is a real mute, not decorative.
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  let actx = null;
  function ensureAudio() {
    if (!AudioCtxClass) return null;
    if (!actx) { try { actx = new AudioCtxClass(); } catch { return null; } }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  ['pointerdown', 'keydown'].forEach((evt) => window.addEventListener(evt, ensureAudio, { once: true, passive: true }));
  function tone(freq, dur, { type = 'sine', gain = 0.05, delay = 0, sweepTo = null } = {}) {
    if (!JARVIS.bootSettings.sound) return;
    const ctx = ensureAudio(); if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
  const bootBeep = (freq = 740) => tone(freq, .09, { type: 'sine', gain: .045 });
  const bootWhoosh = () => tone(200, 1.0, { type: 'sawtooth', gain: .03, sweepTo: 680 });
  const bootActivationChime = () => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, .55, { type: 'sine', gain: .045, delay: i * 0.055 }));
    tone(70, .9, { type: 'triangle', gain: .07, sweepTo: 36 });
  };

  function bootLine(text, cls = '') {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color:rgba(0,216,255,.45)">&gt;</span> ${text}`;
    if (cls) el.className = cls;
    bootLog.appendChild(el);
    while (bootLog.childElementCount > 3) bootLog.removeChild(bootLog.firstChild);
  }
  const wait = (ms, fast) => new Promise((r) => setTimeout(r, fast ? Math.round(ms / 4) : ms));

  // Short technical readout code shown under the percent — cycles with
  // each stage so the ring reads as live telemetry, not a static label.
  const STAGE_MICRO = {
    'SYSTEM POWER': 'PWR.INIT', 'CORE POWER-UP': 'CORE.UP', 'HOLOGRAPHIC RINGS ONLINE': 'RING.SYNC',
    'SYSTEM DIAGNOSTICS': 'DIAG.RUN', 'SYSTEM SCAN': 'SCAN.X', 'J.A.R.V.I.S. ACTIVATION': 'AUTH.CHK',
    'Starting JARVIS': 'BOOT.FAST',
  };
  const setStage = (label) => {
    bootStageEl.textContent = label;
    if (bootRingMicro) {
      bootRingMicro.style.opacity = '0';
      setTimeout(() => { bootRingMicro.textContent = STAGE_MICRO[label] || 'SYS.RUN'; bootRingMicro.style.opacity = '1'; }, 120);
    }
    bootBeep(620 + Math.random() * 160);
  };
  const setHole = (cls) => { bootVeilHole.className = 'boot-veil-hole ' + cls; };
  const setRingSpeed = (x) => { if (bootRingWrap) bootRingWrap.style.setProperty('--ring-speed', x); };

  // Animates both the linear bar and the ring's center readout from
  // whatever they're currently at up to `pct`, instead of snapping — every
  // existing setBar(pct) call site below gets this for free. Fires the
  // 100% activation burst + chime exactly once per run.
  let currentPct = 0;
  let barAnimId = null;
  const setBar = (pct, { fast = false } = {}) => {
    const from = currentPct;
    const to = Math.max(0, Math.min(100, pct));
    const duration = fast ? 140 : 480;
    const start = performance.now();
    cancelAnimationFrame(barAnimId);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const val = Math.round(from + (to - from) * eased);
      bootBar.style.width = val + '%';
      if (bootRingPct) bootRingPct.textContent = val + '%';
      if (t < 1) { barAnimId = requestAnimationFrame(step); }
      else {
        currentPct = to;
        if (to >= 100 && bootRingWrap && !bootRingWrap.classList.contains('activated')) {
          bootRingWrap.classList.add('activated');
          if (bootActivationFlash) { bootActivationFlash.classList.remove('fire'); void bootActivationFlash.offsetWidth; bootActivationFlash.classList.add('fire'); }
          bootActivationChime();
        }
      }
    };
    barAnimId = requestAnimationFrame(step);
  };
  const resetBootVisuals = () => {
    cancelAnimationFrame(barAnimId);
    currentPct = 0;
    bootBar.style.width = '0%';
    if (bootRingPct) bootRingPct.textContent = '0%';
    if (bootRingWrap) { bootRingWrap.classList.remove('activated'); bootRingWrap.style.setProperty('--ring-speed', 1); }
    if (bootActivationFlash) bootActivationFlash.classList.remove('fire');
  };
  // Only ever calls setReactorState() if it exists — reactorStateMachine.js
  // loads later in the script order, but every use below happens after at
  // least one `await wait(...)`, so by the time it runs the rest of the
  // page's scripts have already executed and defined it. Guarded anyway.
  const reactorPulse = (state, opts) => { if (typeof setReactorState === 'function') setReactorState(state, opts); };

  // What the backend actually reports, straight from GET /api/boot-status
  // (public, same reasoning as /health — no user data, just booleans).
  // Nothing here is scripted: if a subsystem is off or broken, that's
  // exactly what gets rendered.
  const STATUS_ROWS = [
    ['core', 'CORE'], ['memory', 'MEMORY'], ['vision', 'VISION'], ['browser', 'BROWSER'],
    ['automation', 'AUTOMATION'], ['plugins', 'PLUGINS'], ['scheduler', 'SCHEDULER'],
    ['security', 'SECURITY'], ['aiAgent', 'AI AGENT'],
  ];
  const STATUS_LABEL = { online: 'ONLINE', degraded: 'DEGRADED', offline: 'OFFLINE', active: 'ACTIVE', ready: 'READY' };

  function renderDiagnostics(status) {
    bootDiagnostics.innerHTML = '';
    STATUS_ROWS.forEach(([key, label], i) => {
      const entry = status && status[key];
      const st = (entry && entry.status) || 'offline'; // no data for a subsystem is reported as offline, never faked as online
      const row = document.createElement('div');
      row.className = 'row';
      row.style.animationDelay = i * 65 + 'ms';
      row.innerHTML = `<span class="label">${label} ${'.'.repeat(Math.max(2, 19 - label.length))}</span><span class="val ${st}">${STATUS_LABEL[st] || st.toUpperCase()}</span>`;
      bootDiagnostics.appendChild(row);
    });
  }

  // The full BLACK SCREEN -> CORE POWER-UP -> RINGS -> DIAGNOSTICS -> SCAN
  // -> ACTIVATION flow. Used for both the real boot and Settings' "Replay"
  // preview (skipIdentity:true for replay — a user opening Settings from
  // inside the HUD is, by definition, already signed in).
  async function playCinematicSequence({ fast = false, skipIdentity = false } = {}) {
    bootScreen.style.display = 'flex';
    bootScreen.classList.remove('hidden');
    bootMarkEl.classList.add('hidden-init');
    bootTaglineEl.classList.add('hidden-init');
    bootDiagnostics.innerHTML = '';
    bootLog.innerHTML = '';
    resetBootVisuals();
    renderSidePanels(null); // placeholder rows animate in immediately — density from second zero
    startElapsedClock();
    setHole('reveal-spark');
    setBar(0, { fast });

    // 1. BLACK SCREEN
    setStage('SYSTEM POWER');
    await wait(500, fast);

    // 2. CORE POWER-UP
    setStage('CORE POWER-UP');
    setHole('reveal-core');
    setBar(14, { fast });
    reactorPulse('understanding', { main: 'Booting', sub: 'Core power-up' });
    await wait(900, fast);

    // 3. ARC-REACTOR / HOLOGRAPHIC RINGS — rings + ticks speed up together
    // with a rising whoosh, so the visual and audio accelerate as one cue.
    setStage('HOLOGRAPHIC RINGS ONLINE');
    setHole('reveal-rings');
    setBar(30, { fast });
    setRingSpeed(1.35);
    bootWhoosh();
    await wait(850, fast);

    // 4. SYSTEM DIAGNOSTICS — a real call, not a scripted checklist. Side
    // panels get re-rendered with the same status object the center
    // diagnostics list uses, so the "extra" panels are real data, not
    // decorative duplicates of a different source.
    setStage('SYSTEM DIAGNOSTICS');
    setBar(48, { fast });
    let status = null;
    try {
      const res = await rawFetch('/api/boot-status');
      status = await res.json();
    } catch (e) { /* backend unreachable */ }
    renderDiagnostics(status);
    renderSidePanels(status);
    if (!status) bootLine('Backend unreachable — is the server running? <span class="fail">FAIL</span>');
    setBar(66, { fast });
    await wait(fast ? 350 : 1500, false);

    // 5. SYSTEM SCAN — second speed-up + whoosh, ring cluster now at its
    // fastest pre-activation pace.
    setStage('SYSTEM SCAN');
    setHole('reveal-wide');
    setBar(80, { fast });
    setRingSpeed(1.8);
    bootWhoosh();
    reactorPulse('verifying', { main: 'Scanning', sub: 'Cross-checking systems' });
    await wait(800, fast);

    // 6. J.A.R.V.I.S. ACTIVATION
    setStage('J.A.R.V.I.S. ACTIVATION');
    bootMarkEl.classList.remove('hidden-init');
    bootTaglineEl.classList.remove('hidden-init');
    setBar(90, { fast });
    reactorPulse('complete', { main: 'Online', sub: 'All systems nominal' });

    let user = null;
    if (!skipIdentity) {
      bootLine('Verifying identity');
      if (tokens && tokens.access_token) {
        try {
          const res = await rawFetch('/api/auth/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
          if (res.ok) user = (await res.json()).user;
        } catch (e) { /* fall through to sign-in */ }
      }
      bootLine(user ? 'Welcome back <span class="ok">OK</span>' : 'No active session <span class="warn">CODEWORD REQUIRED</span>');
    }
    // setBar(100) fires the activation flash + chime itself (see setBar) —
    // the .activated class it adds also snaps ring speed to its fastest
    // burst rate via CSS, so JS doesn't need a separate setRingSpeed here.
    setBar(100, { fast });
    await wait(fast ? 350 : 950, false);

    // 7. MAIN HUD — the veil's hole grows past the viewport diagonal, timed
    // to land just after the activation burst finishes fading.
    setHole('reveal-open');
    await wait(fast ? 260 : 1000, false);
    reactorPulse('idle', { main: 'Ready', sub: 'Ask me anything…' });
    stopElapsedClock();

    return user;
  }

  // Plain, non-cinematic path (Cinematic Boot OFF) — same real checks
  // (backend status + identity), none of the choreography, but still
  // drives the same smoothed bar/ring so the linear bar underneath (if
  // themes ever re-enable it) doesn't jump either.
  async function playPlainSequence() {
    bootScreen.style.display = 'flex';
    bootScreen.classList.remove('hidden');
    resetBootVisuals();
    setHole('reveal-open');
    setStage('Starting JARVIS');
    setBar(35, { fast: true });
    bootDiagnostics.innerHTML = '';
    bootLog.innerHTML = '';
    try { await rawFetch('/api/boot-status'); } catch (e) { /* backend unreachable */ }
    setBar(70, { fast: true });

    let user = null;
    if (tokens && tokens.access_token) {
      try {
        const res = await rawFetch('/api/auth/me', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        if (res.ok) user = (await res.json()).user;
      } catch (e) { /* fall through to sign-in */ }
    }
    setBar(100, { fast: true });
    await wait(150, false);
    return user;
  }

  async function runBoot() {
    const user = JARVIS.bootSettings.cinematic
      ? await playCinematicSequence({ fast: JARVIS.bootSettings.fast })
      : await playPlainSequence();

    stopElapsedClock();
    bootScreen.classList.add('hidden');
    setTimeout(() => { bootScreen.style.display = 'none'; }, 900);

    if (user) markSignedIn(user);
    else JARVIS.showAuth();
  }

  // Exposed for settingsPanel.js's "Replay boot sequence" — a real preview
  // against the live backend, run from inside an already-signed-in session,
  // so it skips the identity re-check and never touches sign-in state.
  JARVIS.replayBoot = async function () {
    await playCinematicSequence({ fast: JARVIS.bootSettings.fast, skipIdentity: true });
    stopElapsedClock();
    bootScreen.classList.add('hidden');
    setTimeout(() => { bootScreen.style.display = 'none'; }, 900);
  };

  // ---- auth screen ---------------------------------------------------
  const authScreen = document.getElementById('authScreen');
  const authForm = document.getElementById('authForm');
  const authMsg = document.getElementById('authMsg');
  const authSubmit = document.getElementById('authSubmit');

  function message(text, kind = 'error') {
    authMsg.className = 'auth-msg ' + kind;
    authMsg.textContent = text;
  }
  function clearMessage() { authMsg.className = 'auth-msg'; authMsg.textContent = ''; }

  JARVIS.showAuth = function (reason) {
    authScreen.classList.remove('hidden');
    authScreen.style.display = 'flex';
    if (reason) message(reason);
  };
  JARVIS.hideAuth = function () {
    authScreen.classList.add('hidden');
    setTimeout(() => { authScreen.style.display = 'none'; }, 520);
  };

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = document.getElementById('authCode').value;
    authSubmit.disabled = true;
    clearMessage();
    try {
      const res = await rawFetch('/api/auth/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');
      save(data.session);
      JARVIS.hideAuth();
      markSignedIn(data.user);
    } catch (err) {
      message(err.message);
    } finally {
      authSubmit.disabled = false;
    }
  });

  JARVIS.signOut = async function () {
    try { await window.fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* best effort */ }
    save(null);
    markSignedOut();
    location.reload();
  };

  runBoot();
})();

/* ---------------- SHARED PANEL-OPEN HELPER ----------------
   Every nav item that reveals an "app" living in the dashboard (Memory,
   Calendar, Calculator, Vision, Agents, Terminal, Home/Assistant) routes
   through this one helper, so every one of them gets the same
   materialize-in animation + scroll-into-view + brief highlight glow —
   not just the two or three that happened to get it first. True overlay
   panels (Imagination/Settings) get the matching .panel-materialize
   keyframe for free via CSS, since toggling display:none -> flex
   naturally (re)plays a CSS animation without needing this helper. */
window.JARVIS.focusPanel = function focusPanel(el, opts) {
  if (!el) return;
  opts = opts || {};
  el.scrollIntoView({ behavior: 'smooth', block: opts.block || 'center' });
  el.classList.remove('panel-materialize');
  // eslint-disable-next-line no-unused-expressions
  el.offsetWidth; // force reflow so back-to-back opens re-trigger cleanly
  el.classList.add('panel-materialize');
  setTimeout(() => el.classList.remove('panel-materialize'), 520);
  if (opts.focus) setTimeout(() => opts.focus.focus(), 320);
};
