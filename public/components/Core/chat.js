/* ---------------- CHAT (live, via backend /api/chat) ---------------- */
// The conversation id now comes from the server (a real row in chat_sessions),
// not a random client string, so history survives restarts and belongs to the
// signed-in user. JARVIS.state.sessionId is managed by the history panel below.
function currentSessionId() { return window.JARVIS.state.sessionId; }

const searchInput = document.getElementById('searchInput');
const sendIcon = document.getElementById('sendBtn');
const stateMain = document.querySelector('.state-text .main');
const stateSub = document.querySelector('.state-text .sub');
const replyBox = document.getElementById('replyBox');
let currentSpeech = null;

// Assistant replies are spoken by the server-side ElevenLabs integration.
// If it is not configured (or the request fails), text chat continues normally.
async function speakReply(text) {
  try {
    if (currentSpeech) {
      currentSpeech.pause();
      URL.revokeObjectURL(currentSpeech.src);
    }
    const res = await fetch('/api/voice/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 5000) }),
    });
    if (!res.ok) throw new Error('voice unavailable');
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    currentSpeech = audio;

    // Real playback-amplitude analyser, so the core/particles pulse with the
    // actual shape of Jarvis's voice while speaking (not a canned animation).
    try {
      const speakCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = speakCtx.createMediaElementSource(audio);
      const speakAnalyser = speakCtx.createAnalyser();
      speakAnalyser.fftSize = 128;
      src.connect(speakAnalyser); speakAnalyser.connect(speakCtx.destination);
      window.JARVIS.speakingLevel = true;
      const speakData = new Uint8Array(speakAnalyser.frequencyBinCount);
      (function pump(){
        if (currentSpeech !== audio) { window.JARVIS.speakingLevel = false; return; }
        speakAnalyser.getByteFrequencyData(speakData);
        const avg = speakData.reduce((a,b)=>a+b,0) / speakData.length;
        window.JARVIS.voiceLevel = Math.min(1, (avg / 255) * 1.7);
        requestAnimationFrame(pump);
      })();
      audio.onended = () => { window.JARVIS.speakingLevel = false; URL.revokeObjectURL(url); if (currentSpeech === audio) currentSpeech = null; speakCtx.close(); };
    } catch (analyserErr) {
      audio.onended = () => { URL.revokeObjectURL(url); if (currentSpeech === audio) currentSpeech = null; };
    }
    await audio.play();
  } catch (err) {
    console.info('[voice] ElevenLabs playback skipped:', err.message);
  }
}

// Minimal, safe markdown: escapes first, then only transforms markdown syntax
// characters (never touches text content), so this can't become an XSS vector.
function renderMarkdown(raw){
  let html = escapeHtml(raw);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre class="md-code-block"><code>${code}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(?:^|\n)((?:[-*] .+\n?)+)/g, (m, block) => {
    const items = block.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
    return '<ul class="md-list">' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>';
  });
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function sendChat(message){
  message = (message || '').trim();
  if (!message) return;
  // /task, /agent, /do trigger the real backend agent loop (utils/taskEngine.js)
  // and need to reach /api/chat like a normal message — every other leading-
  // slash message is a local UI command handled by runSlashCommand instead.
  const isTaskCmd = /^\/(?:task|agent|do)\s+\S/i.test(message);
  const isImagineCmd = /^\/imagine\s+\S/i.test(message);
  const isLiveCmd = isTaskCmd || isImagineCmd; // backend drives the reactor live for both — see below
  if (message.startsWith('/') && !isLiveCmd) { runSlashCommand(message); return; }

  if (pendingAttachment) {
    message += `\n\n[Attached file: ${pendingAttachment.name}]\n\`\`\`\n${pendingAttachment.content}\n\`\`\``;
  }

  const originalMessage = searchInput.value || message;
  searchInput.value = '';
  clearAttachment();
  slashMenu.style.display = 'none';

  if (isLiveCmd) {
    // From here on the /agent socket drives the reactor with real backend
    // phase transitions (understanding → planning → executing/… → complete)
    // — no client-side guessing for this path, whether it's a /task run or
    // an /imagine scene build.
    setReactorState('understanding', { main: 'Understanding…', sub: originalMessage });
  } else {
    // A real /api/chat round trip is a single request, but conceptually a turn
    // moves through understanding → planning → thinking before anything comes
    // back. Play those two short beats up front (they reflect real, if brief,
    // work the moment does involve — parsing intent, choosing an agent), then
    // hold on "thinking" for however long the actual fetch takes.
    await stepReactorStates([
      ['understanding', { main: 'Understanding…', sub: originalMessage }, 260],
      ['planning', { main: 'Planning…', sub: 'Choosing the right agent/tool' }, 220],
    ]);
    setReactorState('thinking', { main: 'Thinking…', sub: originalMessage });
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        ...(currentSessionId() ? { sessionId: currentSessionId() } : {}),
        agent: window.JARVIS.state.agent,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'chat request failed');

    // A brand-new conversation gets its id back on the first reply — adopt it
    // so the rest of the turn (and the history panel) tracks the same thread.
    if (data.sessionId && data.sessionId !== currentSessionId()) {
      window.JARVIS.state.sessionId = data.sessionId;
    }
    window.JARVIS.refreshHistory && window.JARVIS.refreshHistory();

    // If the backend actually routed this to a tool-using agent (data.agent
    // is set by the multi-agent router, not invented here), show the
    // execute/observe/verify beats — this is the one place they reflect a
    // real fact about the response rather than being played unconditionally.
    // Skip this for /task and /imagine runs — the /agent socket already
    // played the real phase sequence live for those. app-launcher turns also
    // skip this generic replay: the real verification (utils/launchVerifier.js)
    // already happened server-side before this response even arrived, so
    // replaying a second, guessed "Verifying…" beat here would just be
    // theater layered on top of a result that's already final — instead they
    // get one short, specifically-labeled beat right before the cinematic
    // reveals the real outcome.
    if (data.provider === 'app-launcher') {
      setReactorState('verifying', { main: 'Verifying', sub: `Confirming ${data.appKey || 'app'}…` });
      await new Promise((resolve) => setTimeout(resolve, 180));
    } else if (!isLiveCmd && data.agent && data.agent !== 'chat') {
      await stepReactorStates([
        ['executing', { main: 'Executing', sub: `via ${data.agent}` }, 260],
        ['observing', { main: 'Observing', sub: 'Reading tool output' }, 220],
        ['verifying', { main: 'Verifying', sub: 'Checking the result' }, 200],
      ]);
    }

    const agentTag = data.agent ? `<span class="agent-badge">${escapeHtml(data.agent)}</span>` : '';
    replyBox.style.display = 'block';
    replyBox.innerHTML = `<div class="who">JARVIS${data.provider ? ` · via ${escapeHtml(data.provider)}` : ''}${agentTag}</div>${renderMarkdown(data.reply)}`;
    speakReply(data.reply);
    reactorBurst();
    // A real app-launcher turn (routes/chat.js's tryOpenAppIntent) — play the
    // cinematic materialize sequence, labeled with the actual app and its
    // real, verified state (online / unconfirmed / failed) — never guessed.
    if (data.provider === 'app-launcher' && typeof playAppLaunchCinematic === 'function') {
      playAppLaunchCinematic(data.appKey, data.launched, data.verified, data.pid);
    }
    // /imagine runs hand back a scene graph — open the Imagination viewer
    // and render it right alongside the chat reply.
    if (data.scene && typeof openImagination === 'function') openImagination(data.scene);
    if (!isLiveCmd) {
      setReactorState('speaking', { main: 'Speaking', sub: 'Response ready' });
      setTimeout(() => {
        setReactorState('complete', { main: 'Complete', sub: originalMessage });
        setTimeout(() => setReactorState('idle', { main: 'Ready', sub: 'Ask me anything…' }), 1200);
      }, 1400);
    }
    // task/imagine-command runs: the socket's own 'complete' (or 'idle' if a
    // task paused on a confirmation) already landed the reactor in the right place.
  } catch (err) {
    replyBox.style.display = 'block';
    replyBox.innerHTML = `<div class="who">Error</div>${escapeHtml(err.message)}`;
    setReactorState('error', { main: 'Error', sub: 'Try again', revertAfter: 2200 });
  }
}

/* ---- Slash commands ---- */
const SLASH_COMMANDS = [
  { cmd: '/clear', desc: 'Clear this conversation' },
  { cmd: '/help', desc: 'List available commands' },
  { cmd: '/weather', desc: 'Refresh the weather widget' },
  { cmd: '/system', desc: 'Refresh system stats' },
  { cmd: '/model', desc: 'Show which LLM providers are configured' },
  { cmd: '/terminal', desc: 'Run a command in the terminal — /terminal <cmd>' },
  { cmd: '/task', desc: 'Run a multi-step goal through the real agent loop — /task <goal>' },
  { cmd: '/imagine', desc: 'Build an interactive 3D scene — /imagine <description>' },
];
const slashMenu = document.getElementById('slashMenu');
let slashSelIdx = 0;

function slashMatches(){
  const v = searchInput.value;
  if (!v.startsWith('/')) return [];
  const q = v.slice(1).split(' ')[0].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q));
}
function renderSlashMenu(){
  const matches = slashMatches();
  if (!matches.length) { slashMenu.style.display = 'none'; return; }
  slashSelIdx = Math.min(slashSelIdx, matches.length - 1);
  slashMenu.innerHTML = matches.map((c, i) =>
    `<div class="slash-item ${i === slashSelIdx ? 'sel' : ''}" data-cmd="${c.cmd}"><b>${c.cmd}</b><span>${c.desc}</span></div>`
  ).join('');
  slashMenu.style.display = 'block';
  slashMenu.querySelectorAll('.slash-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      searchInput.value = el.dataset.cmd + ' ';
      slashMenu.style.display = 'none';
      searchInput.focus();
    });
    el.addEventListener('mouseenter', () => { slashSelIdx = i; renderSlashMenu(); });
  });
}

async function runSlashCommand(raw){
  const [cmd, ...rest] = raw.trim().split(' ');
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/clear':
      if (currentSessionId()) await fetch(`/api/chat/${currentSessionId()}`, { method: 'DELETE' });
      replyBox.style.display = 'none';
      replyBox.innerHTML = '';
      stateSub.textContent = 'Conversation cleared';
      break;
    case '/help':
      replyBox.style.display = 'block';
      replyBox.innerHTML = '<div class="who">Commands</div>' +
        SLASH_COMMANDS.map((c) => `<b>${c.cmd}</b> — ${c.desc}<br>`).join('');
      break;
    case '/weather':
      await loadWeather();
      stateSub.textContent = 'Weather refreshed';
      break;
    case '/system':
      await loadSystemStats();
      stateSub.textContent = 'System stats refreshed';
      break;
    case '/model': {
      try {
        const res = await fetch('/api/chat/providers');
        const data = await res.json();
        replyBox.style.display = 'block';
        replyBox.innerHTML = '<div class="who">Configured providers</div>' + (
          data.providers.length
            ? data.providers.map((p, i) => `${i + 1}. <b>${escapeHtml(p.label)}</b> — <code class="md-inline-code">${escapeHtml(p.model)}</code>`).join('<br>')
            : 'None configured — set at least one provider key in .env.'
        );
      } catch (err) {
        stateSub.textContent = 'Could not reach the provider list';
      }
      break;
    }
    case '/terminal':
      if (!arg) { stateSub.textContent = 'Usage: /terminal <command>'; break; }
      addLine('prompt', `<span class="prompt">jarvis&gt;</span> ${escapeHtml(arg)}`);
      setReactorState('executing', { main: 'Executing', sub: arg });
      termSocket.emit('terminal:run', { command: arg });
      break;
    default:
      stateSub.textContent = `Unknown command: ${cmd} (try /help)`;
  }
  searchInput.value = '';
  slashMenu.style.display = 'none';
}

/* ---- File attachment (text/code files only — no vision model wired) ---- */
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const attachChip = document.getElementById('attachChip');
const searchBarEl = document.getElementById('searchBar');
const TEXTY_EXT = /\.(txt|md|js|ts|jsx|tsx|py|json|css|html|csv|log|yml|yaml)$/i;
let pendingAttachment = null;

function readTextFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
function clearAttachment(){
  pendingAttachment = null;
  attachBtn.classList.remove('has-file');
  attachChip.style.display = 'none';
  fileInput.value = '';
}
async function attachFile(file){
  if (!file) return;
  if (!file.type.startsWith('text/') && file.type !== 'application/json' && !TEXTY_EXT.test(file.name)) {
    replyBox.style.display = 'block';
    replyBox.innerHTML = '<div class="who">Attachment</div>Only text/code files are supported here — ' +
      "image analysis isn't wired up in this build.";
    return;
  }
  try {
    const MAX = 60000;
    let content = await readTextFile(file);
    const truncated = content.length > MAX;
    if (truncated) content = content.slice(0, MAX);
    pendingAttachment = { name: file.name, content, truncated };
    attachBtn.classList.add('has-file');
    attachChip.style.display = 'inline-flex';
    attachChip.innerHTML = `📎 ${escapeHtml(file.name)}${truncated ? ' (truncated)' : ''} <span class="x" id="attachRemove">✕</span>`;
    document.getElementById('attachRemove').addEventListener('click', clearAttachment);
  } catch (err) {
    console.warn('[attach] could not read file:', err.message);
  }
}
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => attachFile(fileInput.files[0]));
['dragover', 'dragenter'].forEach((evt) => searchBarEl.addEventListener(evt, (e) => { e.preventDefault(); searchBarEl.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach((evt) => searchBarEl.addEventListener(evt, (e) => { e.preventDefault(); searchBarEl.classList.remove('drag-over'); }));
searchBarEl.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) attachFile(f); });

searchInput.addEventListener('input', renderSlashMenu);
searchInput.addEventListener('keydown', (e) => {
  const matches = slashMatches();
  if (matches.length && slashMenu.style.display !== 'none') {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashSelIdx = (slashSelIdx + 1) % matches.length; renderSlashMenu(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashSelIdx = (slashSelIdx - 1 + matches.length) % matches.length; renderSlashMenu(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !searchInput.value.includes(' '))) {
      e.preventDefault();
      searchInput.value = matches[slashSelIdx].cmd + ' ';
      slashMenu.style.display = 'none';
      return;
    }
    if (e.key === 'Escape') { slashMenu.style.display = 'none'; return; }
  }
  if (e.key === 'Enter') sendChat(searchInput.value);
});
sendIcon.addEventListener('click', () => sendChat(searchInput.value));
document.querySelectorAll('.suggestions button').forEach((btn) => {
  btn.addEventListener('click', () => sendChat(btn.textContent));
});

