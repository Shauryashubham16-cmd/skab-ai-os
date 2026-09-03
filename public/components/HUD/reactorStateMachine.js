/* ---------------- REACTOR STATE MACHINE ---------------- */
// One source of truth for "what is JARVIS doing right now" — drives the reactor's
// look (color/speed shifts via CSS classes above) and the status text together,
// so they never fall out of sync.
// Full pipeline, matching how a JARVIS turn actually unfolds: a request is
// heard, understood, planned, reasoned about, (optionally) executed via a
// tool, observed, verified, then answered and closed out. Not every turn
// visits every state — a plain chat reply skips straight from thinking to
// speaking — but the states below are the complete vocabulary the reactor,
// the core-status bar, and the AI Core States panel all share.
const PIPELINE_STATES = ['idle', 'listening', 'understanding', 'planning', 'thinking', 'executing', 'observing', 'verifying', 'speaking', 'complete'];
const REACTOR_STATES = [...PIPELINE_STATES, 'error'];
let reactorRevertTimer = null;

// Percent + label shown on the "Reasoning Core" bar in the left panel — a
// real reflection of the same state driving the reactor, not a separate value.
const CORE_STATE_META = {
  idle:          { pct: 8,   label: 'IDLE' },
  listening:     { pct: 22,  label: 'LISTENING' },
  understanding: { pct: 38,  label: 'UNDERSTANDING' },
  planning:      { pct: 52,  label: 'PLANNING' },
  thinking:      { pct: 78,  label: 'THINKING' },
  executing:     { pct: 88,  label: 'EXECUTING' },
  observing:     { pct: 93,  label: 'OBSERVING' },
  verifying:     { pct: 97,  label: 'VERIFYING' },
  speaking:      { pct: 60,  label: 'SPEAKING' },
  complete:      { pct: 100, label: 'COMPLETE' },
  error:         { pct: 100, label: 'ERROR' },
};
window.JARVIS.currentState = 'idle';

// --- AI Core States panel: renders PIPELINE_STATES as a stepper and keeps
// it in lockstep with whatever setReactorState() is told, so it's a real
// reflection of backend-driven events rather than a separate animation.
const aiStatesList = document.getElementById('aiStatesList');
const aiStateNow = document.getElementById('aiStateNow');
const STATE_DISPLAY_LABEL = {
  idle:'Idle', listening:'Listening', understanding:'Understanding', planning:'Planning',
  thinking:'Thinking', executing:'Executing', observing:'Observing', verifying:'Verifying',
  speaking:'Speaking', complete:'Complete', error:'Error',
};
if (aiStatesList) {
  aiStatesList.innerHTML = PIPELINE_STATES.map((s) =>
    `<div class="ai-state-row" data-state="${s}"><span class="ai-state-dot"></span><span>${STATE_DISPLAY_LABEL[s]}</span></div>`
  ).join('');
}
function renderAiStatesPanel(state) {
  if (!aiStatesList) return;
  const idx = PIPELINE_STATES.indexOf(state);
  const rows = aiStatesList.querySelectorAll('.ai-state-row');
  rows.forEach((row) => {
    const rowIdx = PIPELINE_STATES.indexOf(row.dataset.state);
    row.classList.remove('done', 'active', 'error');
    if (state === 'error') { if (rowIdx <= idx) row.classList.add('done'); return; }
    if (idx === -1) return; // unknown state, leave neutral
    if (rowIdx < idx) row.classList.add('done');
    else if (rowIdx === idx) row.classList.add('active');
  });
  if (aiStateNow) {
    aiStateNow.textContent = STATE_DISPLAY_LABEL[state] || 'Idle';
    aiStateNow.style.color = state === 'error' ? 'var(--error)' : (state === 'idle' ? '' : 'var(--accent-bright)');
  }
}
renderAiStatesPanel('idle');

function setReactorState(state, { main, sub, revertAfter } = {}) {
  REACTOR_STATES.forEach((s) => reactorWrap.classList.remove('state-' + s));
  if (state !== 'idle') reactorWrap.classList.add('state-' + state);
  if (main !== undefined) stateMain.textContent = main;
  if (sub !== undefined) stateSub.textContent = sub;
  window.JARVIS.currentState = state;
  renderAiStatesPanel(state);

  const meta = CORE_STATE_META[state] || CORE_STATE_META.idle;
  const coreBar = document.getElementById('coreStateBar');
  const coreVal = document.getElementById('coreStateVal');
  const voiceBar = document.getElementById('voiceEngineBar');
  const voiceVal = document.getElementById('voiceEngineVal');
  if (coreBar) coreBar.style.width = meta.pct + '%';
  if (coreVal) coreVal.textContent = meta.label;
  if (voiceBar) voiceBar.style.width = (state === 'listening' ? 90 : state === 'speaking' ? 65 : 4) + '%';
  if (voiceVal) voiceVal.textContent = state === 'listening' ? 'Capturing' : state === 'speaking' ? 'Speaking' : 'Ready';

  clearTimeout(reactorRevertTimer);
  if (revertAfter) {
    reactorRevertTimer = setTimeout(() => {
      setReactorState('idle', { main: 'Ready', sub: 'Ask me anything…' });
    }, revertAfter);
  }
}

// Walk through a sequence of states with small, snappy delays — used to make
// a single backend call (e.g. one /api/chat round trip) read as the multi-stage
// pipeline it conceptually is, instead of a hard cut from thinking to speaking.
// Each step still calls the same setReactorState(), so every state's real
// visual/CSS/panel wiring above applies — this is just a sequencer on top.
function stepReactorStates(steps) {
  return steps.reduce(
    (chain, [state, opts, delay]) => chain.then(() => {
      setReactorState(state, opts);
      return delay ? new Promise((r) => setTimeout(r, delay)) : Promise.resolve();
    }),
    Promise.resolve(),
  );
}

function reactorBurst() {
  reactorWrap.classList.remove('burst');
  // eslint-disable-next-line no-unused-expressions
  reactorWrap.offsetWidth; // force reflow so the animation can re-trigger
  reactorWrap.classList.add('burst');
  setTimeout(() => reactorWrap.classList.remove('burst'), 750);
}

setReactorState('idle');

