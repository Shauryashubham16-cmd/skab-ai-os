/* =====================================================================
   Conversation history panel + agent picker.
   Talks to /api/sessions, which is user-scoped on the server, so this only
   ever shows the signed-in user's own threads.
   ===================================================================== */
(function () {
  const JARVIS = window.JARVIS;
  const listEl = document.getElementById('historyList');
  const newBtn = document.getElementById('historyNewBtn');
  const userEmail = document.getElementById('userEmail');
  const signOutBtn = document.getElementById('signOutBtn');
  const replyBox = document.getElementById('replyBox');
  const LAST_KEY = 'jarvis_last_session';

  function when(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
  }

  function render(sessions) {
    if (!sessions.length) {
      listEl.innerHTML = '<div class="history-empty">No conversations yet — ask something.</div>';
      return;
    }
    listEl.innerHTML = sessions
      .map((session) => `
        <div class="history-item${session.id === JARVIS.state.sessionId ? ' active' : ''}" data-id="${escapeHtml(session.id)}">
          <span class="t">${escapeHtml(session.title)}</span>
          <span class="when">${when(session.updated_at)}</span>
          <span class="del" data-del="${escapeHtml(session.id)}" title="Delete conversation">✕</span>
        </div>`)
      .join('');
  }

  async function refreshHistory() {
    if (!JARVIS.state.user) return;
    try {
      const res = await fetch('/api/sessions?limit=30');
      if (!res.ok) return;
      const { sessions } = await res.json();
      // Restore the last thread the user was on, or fall back to the newest.
      if (!JARVIS.state.sessionId) {
        const remembered = localStorage.getItem(LAST_KEY);
        const match = sessions.find((s) => s.id === remembered) || sessions[0];
        if (match) JARVIS.state.sessionId = match.id;
      }
      render(sessions);
    } catch (err) {
      console.warn('[history] could not load:', err.message);
    }
  }
  JARVIS.refreshHistory = refreshHistory;

  async function openSession(id) {
    JARVIS.state.sessionId = id;
    localStorage.setItem(LAST_KEY, id);
    refreshHistory();
    try {
      const res = await fetch(`/api/sessions/${id}/messages`);
      if (!res.ok) return;
      const { messages } = await res.json();
      const transcript = messages
        .map((m) => {
          const who = m.role === 'user' ? 'You' : `JARVIS${m.agent ? ` · ${escapeHtml(m.agent)}` : ''}`;
          return `<div class="who">${who}</div>${renderMarkdown(m.content)}`;
        })
        .join('<hr style="border:0;border-top:1px solid rgba(0,216,255,.12);margin:12px 0">');
      replyBox.style.display = 'block';
      replyBox.innerHTML = transcript || '<div class="who">JARVIS</div>This conversation is empty.';
    } catch (err) {
      console.warn('[history] could not open conversation:', err.message);
    }
  }

  listEl.addEventListener('click', async (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      event.stopPropagation();
      const id = del.getAttribute('data-del');
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (JARVIS.state.sessionId === id) {
        JARVIS.state.sessionId = null;
        replyBox.style.display = 'none';
      }
      refreshHistory();
      return;
    }
    const item = event.target.closest('.history-item');
    if (item) openSession(item.getAttribute('data-id'));
  });

  newBtn.addEventListener('click', async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return;
    const { session } = await res.json();
    JARVIS.state.sessionId = session.id;
    localStorage.setItem(LAST_KEY, session.id);
    replyBox.style.display = 'none';
    refreshHistory();
  });

  signOutBtn.addEventListener('click', () => JARVIS.signOut());

  JARVIS.onAuth((user) => {
    userEmail.textContent = 'JARVIS unlocked';
    refreshHistory();
  });
})();
