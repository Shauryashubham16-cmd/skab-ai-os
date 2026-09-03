// Fires calendar reminders as they come due, over the same real-time event
// bus taskEngine uses (utils/eventBus.js -> utils/agentSocket.js -> the
// frontend's already-open `/agent` socket) — no new socket namespace, no
// new frontend connection needed.
//
// Deliberately simple, same spirit as utils/scheduler.js: a plain setInterval
// poll, in-memory only where it needs to be (the "reminded" flag itself is
// persisted in calendar.json by calendarStore, so a restart won't re-fire an
// already-sent reminder, but a reminder that comes due *while the server is
// down* fires late, on the next tick after restart, rather than being lost).
const calendarStore = require('./calendarStore');
const { emitAgentEvent } = require('./eventBus');

const TICK_MS = 15 * 1000;
let ticking = false;

function tick() {
  const due = calendarStore.takeDueReminders();
  for (const event of due) {
    emitAgentEvent(event.userId, 'calendar:reminder', {
      id: event.id,
      title: event.title,
      start: event.start,
      priority: event.priority,
    });
  }
}

function startReminderTicker() {
  if (ticking) return;
  ticking = true;
  setInterval(tick, TICK_MS).unref();
}

module.exports = { startReminderTicker, TICK_MS };
