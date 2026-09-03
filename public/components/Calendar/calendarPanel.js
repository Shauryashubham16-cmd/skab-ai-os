/* ---------------- CALENDAR & TASKS PANEL (live, via backend /api/calendar) ----------------
   Wires up the "Calendar" nav item, which until now was a dead icon in
   services/nav.js (listed, but nothing happened on click) with no backend
   route behind it at all. Follows the same fetch/render pattern as
   components/Memory/memoryPanel.js. */
const calList = document.getElementById('calList');
const calTitleInput = document.getElementById('calTitleInput');
const calStartInput = document.getElementById('calStartInput');
const calRemindSelect = document.getElementById('calRemindSelect');
const calAddBtn = document.getElementById('calAddBtn');
const calendarCard = document.getElementById('calendarCard');

let calItems = [];

function calEscapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function calFormatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar/upcoming?limit=10');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    calItems = data.events || [];
  } catch (err) {
    console.warn('[calendar] failed to load', err);
    calItems = [];
  }
  renderCalendar();
}

function renderCalendar() {
  if (!calItems.length) {
    calList.innerHTML = `<div class="cal-empty-state">Nothing on the calendar — add something above.</div>`;
    return;
  }
  calList.innerHTML = calItems.map((e) => `
    <div class="cal-item ${e.completed ? 'done' : ''}" data-id="${calEscapeHtml(e.id)}">
      <input type="checkbox" class="cal-check" ${e.completed ? 'checked' : ''} title="Mark done" />
      <span class="cal-dot ${e.priority || 'normal'}"></span>
      <span class="cal-body">
        <div class="cal-title">${calEscapeHtml(e.title)}</div>
        <div class="cal-time">${calFormatTime(e.start)}</div>
      </span>
      <button type="button" class="cal-del" title="Delete">✕</button>
    </div>
  `).join('');
}

calList.addEventListener('click', async (e) => {
  const row = e.target.closest('.cal-item');
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.classList.contains('cal-check')) {
    const completed = e.target.checked;
    row.classList.toggle('done', completed);
    try {
      await fetch(`/api/calendar/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed }),
      });
    } catch (err) { console.warn('[calendar] update failed', err); }
    return;
  }

  if (e.target.classList.contains('cal-del')) {
    row.remove();
    try {
      await fetch(`/api/calendar/${id}`, { method: 'DELETE' });
    } catch (err) { console.warn('[calendar] delete failed', err); }
    calItems = calItems.filter((it) => it.id !== id);
    if (!calItems.length) renderCalendar();
  }
});

async function addCalendarEvent() {
  const title = calTitleInput.value.trim();
  if (!title) { calTitleInput.focus(); return; }
  // Default to "in 1 hour" if no time was picked, so a bare quick-add still works.
  const start = calStartInput.value
    ? new Date(calStartInput.value).toISOString()
    : new Date(Date.now() + 3600000).toISOString();
  const remindRaw = calRemindSelect.value;
  const remindMinutesBefore = remindRaw === '' ? null : Number(remindRaw);

  calAddBtn.disabled = true;
  try {
    const res = await fetch('/api/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, start, remindMinutesBefore }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    calTitleInput.value = '';
    calStartInput.value = '';
    calRemindSelect.value = '';
    await loadCalendar();
  } catch (err) {
    console.warn('[calendar] add failed', err);
  } finally {
    calAddBtn.disabled = false;
  }
}

calAddBtn.addEventListener('click', addCalendarEvent);
calTitleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCalendarEvent(); });

// ---- reminder toast ----------------------------------------------------
// calendar:reminder arrives over the same /agent socket taskEngine already
// streams state onto (see utils/calendarReminders.js -> utils/eventBus.js);
// `agentSocket` is declared in components/Terminal/terminal.js, loaded
// earlier in index.html, so it already exists by the time this runs.
function showCalendarToast(payload) {
  const toast = document.createElement('div');
  toast.className = 'cal-toast';
  toast.innerHTML = `<b>Reminder</b>${calEscapeHtml(payload.title)}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
  if (typeof setReactorState === 'function') {
    setReactorState('complete', { main: 'Reminder', sub: payload.title, revertAfter: 4000 });
  }
  loadCalendar(); // refresh so the reminded item's state stays in sync
}

if (typeof agentSocket !== 'undefined') {
  agentSocket.on('calendar:reminder', showCalendarToast);
}

// Nav wiring: clicking the "Calendar" nav item scrolls the dashboard card
// into view and focuses quick-add, the same "make the icon actually do
// something" treatment Imagination already got in services/nav.js.
function openCalendarPanel() {
  if (!calendarCard) return;
  if (window.JARVIS && window.JARVIS.focusPanel) {
    window.JARVIS.focusPanel(calendarCard, { focus: calTitleInput });
  } else {
    calendarCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    calTitleInput.focus();
  }
}

loadCalendar();
setInterval(loadCalendar, 60000); // keep "Today"/"Tomorrow" labels and due items fresh
