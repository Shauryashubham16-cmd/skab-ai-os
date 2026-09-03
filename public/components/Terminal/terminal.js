/* ---------------- TERMINAL (live, via backend Socket.IO) ---------------- */
const termBody = document.getElementById('termBody');
const termInput = document.getElementById('termInput');

let termAutoscroll = true;

function ts(){
  const d = new Date();
  return d.toTimeString().slice(0,8);
}
function addLine(type, message){
  const div = document.createElement('div');
  div.className = 'term-line ' + type;
  div.innerHTML = `<span class="ts">[${ts()}]</span>${message}`;
  termBody.appendChild(div);
  while(termBody.children.length > 200){ termBody.removeChild(termBody.firstChild); }
  if (termAutoscroll) termBody.scrollTop = termBody.scrollHeight;
}

const termSearchBtn = document.getElementById('termSearchBtn');
const termSearchRow = document.getElementById('termSearchRow');
const termSearchInput = document.getElementById('termSearchInput');
const termAutoscrollBtn = document.getElementById('termAutoscrollBtn');
const termCopyBtn = document.getElementById('termCopyBtn');
const termFullscreenBtn = document.getElementById('termFullscreenBtn');
const terminalCard = document.querySelector('.terminal-card');

termSearchBtn.addEventListener('click', () => {
  const showing = termSearchRow.style.display !== 'none';
  termSearchRow.style.display = showing ? 'none' : 'block';
  termSearchBtn.classList.toggle('active', !showing);
  if (!showing) termSearchInput.focus();
  else { termSearchInput.value = ''; filterTermLines(''); }
});
function filterTermLines(query){
  const q = query.trim().toLowerCase();
  Array.from(termBody.children).forEach((line) => {
    line.classList.toggle('dim', q.length > 0 && !line.textContent.toLowerCase().includes(q));
  });
}
termSearchInput.addEventListener('input', () => filterTermLines(termSearchInput.value));

termAutoscrollBtn.addEventListener('click', () => {
  termAutoscroll = !termAutoscroll;
  termAutoscrollBtn.classList.toggle('active', termAutoscroll);
  if (termAutoscroll) termBody.scrollTop = termBody.scrollHeight;
});

termCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(termBody.innerText);
    termCopyBtn.textContent = '✓';
    setTimeout(() => { termCopyBtn.textContent = '⧉'; }, 1200);
  } catch (err) {
    console.warn('[terminal] copy failed:', err.message);
  }
});

termFullscreenBtn.addEventListener('click', () => {
  const isFull = terminalCard.classList.toggle('fullscreen');
  termFullscreenBtn.classList.toggle('active', isFull);
  termFullscreenBtn.textContent = isFull ? '✕' : '⛶';
  if (termAutoscroll) termBody.scrollTop = termBody.scrollHeight;
});

const termSocket = io('/terminal');

termSocket.on('connect', () => addLine('sys', 'Connected to JARVIS terminal service'));
termSocket.on('disconnect', () => addLine('warn', 'Disconnected from terminal service'));
termSocket.on('terminal:ready', (data) => addLine('success', `Terminal ready · platform ${data.platform}`));
termSocket.on('terminal:stdout', (data) => addLine('info', escapeHtml(data.chunk).replace(/\n/g, '<br>')));
termSocket.on('terminal:stderr', (data) => addLine('error', escapeHtml(data.chunk).replace(/\n/g, '<br>')));
termSocket.on('terminal:exit', (data) => {
  addLine(data.code === 0 ? 'success' : 'warn', `exited with code ${data.code}`);
  if (data.code === 0) setReactorState('idle', { main: 'Ready', sub: 'Ask me anything…' });
  else setReactorState('error', { main: 'Error', sub: `exit code ${data.code}`, revertAfter: 2200 });
});
termSocket.on('terminal:error', (data) => {
  addLine('error', escapeHtml(data.message));
  setReactorState('error', { main: 'Error', sub: data.message, revertAfter: 2200 });
});

// ---- Live agent/task pipeline state (Phase 2) -----------------------
// The backend task engine (utils/taskEngine.js) pushes every real phase
// transition it makes — understanding, planning, executing, observing,
// verifying, correcting, retrying, speaking, complete, error — over this
// socket as it actually happens. This replaces guessed client-side timing
// for any run it drives; see sendChat()'s isTaskCmd branch.
const agentSocket = io('/agent');
agentSocket.on('agent:state', (payload) => {
  if (typeof setReactorState === 'function' && payload && payload.state) {
    setReactorState(payload.state, { main: payload.main, sub: payload.sub, revertAfter: payload.revertAfter });
  }
});
agentSocket.on('agent:log', (payload) => {
  if (!payload || !payload.line) return;
  addLine(payload.ok === false ? 'error' : 'info', `<span class="prompt">agent&gt;</span> ${escapeHtml(payload.line)}`);
  // A /task run's plan included a real apps.open step (utils/taskEngine.js
  // echoes args + verified back on this same event, sourced from
  // utils/launchVerifier.js via toolRegistry.js) — play the same cinematic
  // the plain "open X" chat intent gets, with the same real verified state,
  // so a task-driven launch looks and feels identical either way.
  if (payload.tool === 'apps.open' && typeof playAppLaunchCinematic === 'function') {
    playAppLaunchCinematic(payload.args && payload.args.app, payload.ok !== false, payload.verified, payload.pid);
  }
});

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

const termHistory = [];
let termHistoryIdx = -1;

termInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') {
    if (!termHistory.length) return;
    termHistoryIdx = Math.max(0, termHistoryIdx - 1);
    termInput.value = termHistory[termHistoryIdx] || '';
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    if (!termHistory.length) return;
    termHistoryIdx = Math.min(termHistory.length, termHistoryIdx + 1);
    termInput.value = termHistory[termHistoryIdx] || '';
    e.preventDefault();
    return;
  }
  if (e.key !== 'Enter') return;
  const command = termInput.value.trim();
  if (!command) return;
  termHistory.push(command);
  termHistoryIdx = termHistory.length;
  addLine('prompt', `<span class="prompt">jarvis&gt;</span> ${escapeHtml(command)}`);
  setReactorState('executing', { main: 'Executing', sub: command });
  termSocket.emit('terminal:run', { command });
  termInput.value = '';
});

