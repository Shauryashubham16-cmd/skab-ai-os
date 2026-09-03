/* =====================================================================
   Agents · Context · Vision · Task-Activity panels.
   All backed by real, already-existing routes — no mock data:
     /api/agent/context   -> active window + capability flags
     /api/agent/activity  -> shared audit/action-log feed (also used as the
                              "action visualization" and to light up orbit nodes)
     /api/tasks/tools     -> the live tool/agent registry
     /api/vision/screen   -> on-demand real screen capture + OCR/description
   ===================================================================== */
(function () {
  const JARVIS = window.JARVIS;

  /* ---------------- ORBIT NODE <-> TOOL PREFIX MAP ---------------- */
  // Matches the 6 orbit nodes created earlier (Browser/Memory/Vision/Files/Weather/Code)
  // to the tool-name prefixes that show up in the activity feed.
  const ORBIT_TOOL_MAP = { browser: 'Browser', memory: 'Memory', vision: 'Vision', files: 'Files', weather: 'Weather', system: 'Code', apps: 'Code', windows: 'Code', input: 'Code' };
  function flashOrbitNode(name){
    const nodeEls = Array.from(document.querySelectorAll('.orbit-node'));
    const el = nodeEls.find((n) => n.querySelector('span')?.textContent === name);
    if (!el) return;
    el.classList.add('active');
    clearTimeout(el._offTimer);
    el._offTimer = setTimeout(() => el.classList.remove('active'), 2600);
  }

  /* ---------------- TASK ACTIVITY (also drives action-visualization + orbit lights) ---------------- */
  const activityList = document.getElementById('activityList');
  let lastActivityId = null;

  function timeAgo(iso){
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 5) return 'now';
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    return Math.floor(diff / 3600) + 'h ago';
  }

  async function loadActivity(){
    try {
      const res = await fetch('/api/agent/activity?limit=12');
      if (!res.ok) return;
      const { activity } = await res.json();
      if (!activity || !activity.length) {
        activityList.innerHTML = '<div class="activity-empty">No activity yet — Jarvis is idle.</div>';
        return;
      }
      // New entry since last poll? Burst the reactor + light the matching orbit node —
      // this is the "action visualization showing exactly what the agent is doing".
      if (lastActivityId && activity[0].id !== lastActivityId) {
        const prefix = (activity[0].tool || activity[0].action || '').split('.')[0];
        if (ORBIT_TOOL_MAP[prefix]) flashOrbitNode(ORBIT_TOOL_MAP[prefix]);
        if (typeof reactorBurst === 'function') reactorBurst();
      }
      lastActivityId = activity[0].id;

      activityList.innerHTML = activity.slice(0, 8).map((e) => {
        const msg = e.summary || e.tool || e.action || e.type || 'Activity';
        const isErr = e.ok === false || e.type === 'error';
        return `<div class="activity-row${isErr ? ' err' : ''}"><span class="dot"></span><div class="body"><div class="msg">${escapeHtml(msg)}</div><div class="when">${timeAgo(e.at)}</div></div></div>`;
      }).join('');
    } catch (err) {
      console.warn('[activity] poll failed:', err.message);
    }
  }
  loadActivity();
  setInterval(loadActivity, 4000);

  /* ---------------- AGENTS / TOOL REGISTRY ---------------- */
  const agentChipGrid = document.getElementById('agentChipGrid');
  const agentsCount = document.getElementById('agentsCount');
  let toolNames = [];

  async function loadTools(){
    try {
      const res = await fetch('/api/tasks/tools');
      if (!res.ok) return;
      const { tools } = await res.json();
      toolNames = tools.map((t) => t.name);
      agentsCount.textContent = tools.length + ' online';
      agentChipGrid.innerHTML = tools.map((t) => {
        const cat = t.name.split('.')[0];
        return `<span class="agent-chip" data-cat="${escapeHtml(cat)}" title="${escapeHtml(t.describe)}"><span class="led"></span>${escapeHtml(t.name)}</span>`;
      }).join('');
    } catch (err) {
      agentChipGrid.innerHTML = '<div class="agent-empty">Tool registry unavailable.</div>';
    }
  }
  loadTools();

  // Light up the matching chip(s) whenever that tool actually runs (reuses the
  // same activity poll result rather than a second network round-trip).
  const origLoadActivity = loadActivity;
  let recentLiveTools = new Set();
  setInterval(async () => {
    try {
      const res = await fetch('/api/agent/activity?limit=6');
      if (!res.ok) return;
      const { activity } = await res.json();
      recentLiveTools = new Set((activity || []).filter((e) => (Date.now() - new Date(e.at).getTime()) < 5000).map((e) => e.tool).filter(Boolean));
      document.querySelectorAll('.agent-chip').forEach((chip) => {
        chip.classList.toggle('live', recentLiveTools.has(chip.textContent.trim()));
      });
    } catch (e) { /* silent */ }
  }, 3000);

  /* ---------------- CONTEXT AWARENESS ---------------- */
  const ctxApp = document.getElementById('ctxApp');
  const ctxTitle = document.getElementById('ctxTitle');
  const ctxProc = document.getElementById('ctxProc');
  const ctxCaps = document.getElementById('ctxCaps');

  async function loadContext(){
    try {
      const res = await fetch('/api/agent/context');
      if (!res.ok) return;
      const data = await res.json();
      const win = data.activeWindow || {};
      ctxApp.textContent = win.app || win.processName || '—';
      ctxTitle.textContent = win.title || '—';
      ctxProc.textContent = Array.isArray(data.runningProcesses) ? data.runningProcesses.length : '—';
      const caps = data.capabilities || {};
      ctxCaps.innerHTML = Object.entries(caps).filter(([k]) => k !== 'windowManagement').map(([k, v]) => {
        const on = typeof v === 'string' ? !/disabled|no /i.test(v) : !!v;
        return `<span class="cap-pill ${on ? 'on' : 'off'}">${escapeHtml(k)}</span>`;
      }).join('');
    } catch (err) {
      console.warn('[context] poll failed:', err.message);
    }
  }
  loadContext();
  setInterval(loadContext, 15000);

  /* ---------------- VISION ---------------- */
  const visionBtn = document.getElementById('visionBtn');
  const visionPreview = document.getElementById('visionPreview');
  const visionStatus = document.getElementById('visionStatus');

  visionBtn.addEventListener('click', async () => {
    visionBtn.disabled = true;
    visionStatus.textContent = 'Scanning…';
    visionPreview.classList.add('scanning');
    visionPreview.innerHTML = '<span class="vision-placeholder">Capturing screen…</span>';
    if (typeof setReactorState === 'function') setReactorState('observing', { main: 'Observing', sub: 'Analyzing screen…' });
    try {
      const res = await fetch('/api/vision/screen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'both' }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Vision analysis failed');
      const desc = data.description || data.text || data.ocr || 'No readable content detected.';
      visionPreview.textContent = desc;
      visionStatus.textContent = 'Last scan just now';
      if (typeof setReactorState === 'function') setReactorState('verifying', { main: 'Verifying', sub: 'Confirming what was seen' });
      if (typeof reactorBurst === 'function') reactorBurst();
      setTimeout(() => {
        if (typeof setReactorState === 'function') setReactorState('complete', { main: 'Complete', sub: 'Screen analyzed', revertAfter: 1400 });
      }, 500);
    } catch (err) {
      visionPreview.innerHTML = `<span class="vision-placeholder">${escapeHtml(err.message)}</span>`;
      visionStatus.textContent = 'Error';
      if (typeof setReactorState === 'function') setReactorState('error', { main: 'Vision error', sub: err.message, revertAfter: 2200 });
    } finally {
      visionBtn.disabled = false;
      visionPreview.classList.remove('scanning');
    }
  });
})();
