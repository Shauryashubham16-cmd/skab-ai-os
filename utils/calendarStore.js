// Calendar & tasks storage — the backend for the "Calendar" nav item that,
// until now, was a dead icon (public/services/nav.js listed it but nothing
// happened on click; there was no routes/calendar.js at all).
//
// Same pattern as memoryLocal.js / longTermMemory.js: a single local JSON
// file, read/written synchronously, scoped per userId. No new dependency.
// An "event" here covers both calendar events (start/end) and plain tasks
// (a single dueAt, no end) — one model, `end` is just optional.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'calendar.json');
const MAX_EVENTS_PER_USER = 2000;
// Hard cap on how many occurrences a single recurring event can expand to
// for one list()/upcoming() query, regardless of the requested range or an
// open-ended (no `until`/`count`) rule — without this, "every day, no end
// date" queried against { from: '2020-01-01', to: '2099-01-01' } would try
// to materialize tens of thousands of instances in memory for one event.
const MAX_OCCURRENCES_PER_EXPANSION = 500;
const RECURRENCE_FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const ALL_DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(events) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(events, null, 2));
}

function strip(userId) {
  return (e) => e.userId === userId;
}

// Pure — exported separately (like longTermMemory.js's cosineSimilarity)
// so tests/calendarStore.test.js can cover the reminder-time math without
// touching disk.
function computeRemindAt(startISO, remindMinutesBefore) {
  if (!Number.isFinite(remindMinutesBefore) || remindMinutesBefore < 0) return null;
  return new Date(startISO).getTime() - remindMinutesBefore * 60000;
}

// --- allDay date handling -------------------------------------------------
// The real bug this closes: an allDay event used to store a full ISO
// datetime (e.g. "2026-08-20T00:00:00.000Z"). That's an *instant*, not a
// calendar date — a viewer west of UTC reads local midnight UTC as still
// "Aug 19" in their own timezone, so an all-day event could visibly render
// on the wrong day depending on who's looking at it, even though nothing
// about the event changed. An all-day event isn't tied to an instant at
// all; it's tied to a calendar date, full stop. So allDay start/end are now
// required to be plain YYYY-MM-DD strings with no time or offset component
// — there is no timezone to get wrong because there's no time in the value.
// normalizeAllDayDate accepts either a plain date or a full ISO datetime
// (truncating to its date part, for callers migrating old data or passing
// a JS Date's toISOString()) and always returns a bare date string.
function normalizeAllDayDate(value) {
  if (typeof value !== 'string') throw new Error('allDay event start/end must be a date string.');
  const datePart = value.slice(0, 10);
  if (!ALL_DAY_DATE_RE.test(datePart)) {
    throw new Error(`allDay event start/end must be YYYY-MM-DD (got "${value}").`);
  }
  return datePart;
}

// Anchors a YYYY-MM-DD calendar date to a fixed instant purely for internal
// sort/range comparisons (list()'s from/to filtering, occurrence ordering).
// Deliberately UTC-midnight, not the server's local midnight or any user's
// timezone — the point is that every allDay date maps to the same instant
// no matter who's asking, so two allDay events on the same date always sort
// and compare equal regardless of server locale. Never shown to a user or
// used to decide "is this today" for someone in a specific timezone — that
// judgment belongs to the display layer, which has the viewer's actual
// timezone and this module deliberately does not.
function allDayDateToMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function eventStartMs(e) {
  return e.allDay ? allDayDateToMs(e.start) : new Date(e.start).getTime();
}

// --- recurrence ------------------------------------------------------------
// A recurring event is stored ONCE (the base event, with its original
// start/end and a `recurrence` rule) — occurrences are never materialized
// into separate stored rows. list()/upcoming() call expandOccurrences() to
// generate the instances that actually fall in the requested range, on
// read, the same way most real calendar apps avoid pre-writing years of
// rows for "every Monday, forever."
//
// recurrence shape: { freq: 'daily'|'weekly'|'monthly'|'yearly',
//                      interval?: number (default 1, e.g. 2 = "every other
//                      week"), until?: ISO string (last date recurrence is
//                      allowed to reach, inclusive), count?: number (max
//                      total occurrences, alternative to `until`) }
//
// Month/year math uses UTC calendar-field arithmetic (setUTCMonth etc.),
// not millisecond addition — adding "1 month" as a fixed duration breaks on
// months of different lengths (Jan 31 + 1 month should land on Feb 28, not
// roll into March). This is calendar-field recurrence, not fixed-interval
// recurrence — the same distinction real calendar software makes between
// "every month on the 31st" and "every 30 days."
//
// Known simplification, documented rather than hidden: occurrence times
// are computed by shifting the base start by a fixed UTC calendar amount.
// For a non-allDay event with a wall-clock recurrence rule that should
// stay pinned to e.g. "9am local time" across a DST transition, the UTC
// instant will shift by an hour on the DST boundary rather than holding
// the local wall-clock time fixed — genuine "float to local wall-clock
// across DST" recurrence needs an IANA-timezone-aware date library, which
// this app doesn't currently depend on. allDay recurrence is unaffected
// (calendar dates have no wall-clock/DST concept at all).
function validateRecurrence(recurrence) {
  if (recurrence == null) return null;
  if (!RECURRENCE_FREQS.has(recurrence.freq)) {
    throw new Error(`recurrence.freq must be one of ${[...RECURRENCE_FREQS].join(', ')}.`);
  }
  const interval = Number.isFinite(recurrence.interval) && recurrence.interval >= 1 ? Math.floor(recurrence.interval) : 1;
  const until = recurrence.until ? new Date(recurrence.until).toISOString() : null;
  const count = Number.isFinite(recurrence.count) && recurrence.count >= 1 ? Math.floor(recurrence.count) : null;
  return { freq: recurrence.freq, interval, until, count };
}

function addRecurrenceStep(date, freq, interval, originalDay) {
  const d = new Date(date.getTime());
  if (freq === 'daily') {
    d.setUTCDate(d.getUTCDate() + interval);
  } else if (freq === 'weekly') {
    d.setUTCDate(d.getUTCDate() + interval * 7);
  } else if (freq === 'monthly' || freq === 'yearly') {
    // Naive setUTCMonth(m + interval) on Jan 31 rolls over into March
    // (Feb 31 doesn't exist, so JS Date normalizes it forward) instead of
    // landing on the last real day of the target month — "rent due the
    // 31st" would silently drift to the 1st-2nd-3rd of later months every
    // time a short month is crossed. Clamp explicitly instead: compute the
    // target month, find how many days it actually has, and use
    // min(originalDay, daysInTargetMonth).
    //
    // Critically, `originalDay` is the event's ORIGINAL day-of-month (from
    // its very first start, passed in by the caller) — not the previous
    // occurrence's clamped day. Deriving it from the evolving cursor would
    // make a clamp permanent (Jan 31 -> Feb 28 -> Mar 28 -> Apr 28...,
    // silently losing the 31st forever after the first short month). Using
    // the fixed original day instead gives the same recovering behavior
    // real calendar apps use: Jan 31, Feb 28 (clamped), Mar 31 (recovered,
    // because March actually has 31 days again), Apr 30 (clamped again), ...
    const targetMonthIndex = d.getUTCMonth() + (freq === 'monthly' ? interval : 0);
    const targetYear = d.getUTCFullYear() + (freq === 'yearly' ? interval : 0);
    d.setUTCDate(1); // park on a day that exists in every month before changing month/year — avoids the same rollover bug while we compute the target
    d.setUTCFullYear(targetYear);
    d.setUTCMonth(targetMonthIndex);
    const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  }
  return d;
}

// Returns the event's occurrences (as full event-shaped objects, each with
// `occurrenceIndex` and, for recurring events, `id` suffixed with the
// index so the frontend has a stable per-instance key) whose start falls
// within [rangeFromMs, rangeToMs]. Non-recurring events just return
// themselves (0 or 1 result, same as before recurrence existed). Pure —
// takes the range as plain numbers, no disk I/O — so it's directly
// testable the same way computeRemindAt is.
function expandOccurrences(event, rangeFromMs, rangeToMs) {
  if (!event.recurrence) {
    const startMs = eventStartMs(event);
    return startMs >= rangeFromMs && startMs <= rangeToMs ? [event] : [];
  }
  const { freq, interval, until, count } = event.recurrence;
  const untilMs = until ? new Date(until).getTime() : Infinity;
  const durationMs = event.end ? new Date(event.end).getTime() - new Date(event.start).getTime() : null;

  const results = [];
  const originalDay = event.allDay ? Number(event.start.slice(8, 10)) : new Date(event.start).getUTCDate();
  let cursor = event.allDay ? new Date(`${event.start}T00:00:00.000Z`) : new Date(event.start);
  for (let i = 0; i < MAX_OCCURRENCES_PER_EXPANSION && (count == null || i < count); i += 1) {
    const occurStartMs = cursor.getTime();
    if (occurStartMs > untilMs || occurStartMs > rangeToMs) break;
    if (occurStartMs >= rangeFromMs) {
      const occurStart = event.allDay ? normalizeAllDayDate(cursor.toISOString()) : cursor.toISOString();
      results.push({
        ...event,
        id: i === 0 ? event.id : `${event.id}::${i}`,
        start: occurStart,
        end: durationMs != null ? new Date(occurStartMs + durationMs).toISOString() : event.end,
        occurrenceIndex: i,
        isRecurringInstance: i > 0,
      });
    }
    cursor = addRecurrenceStep(cursor, freq, interval, originalDay);
  }
  return results;
}

function create(userId, { title, notes = '', start, end = null, allDay = false, remindMinutesBefore = null, priority = 'normal', recurrence = null }) {
  const events = load();
  const userCount = events.filter(strip(userId)).length;
  if (userCount >= MAX_EVENTS_PER_USER) {
    const err = new Error(`Calendar is full (${MAX_EVENTS_PER_USER} events max) — delete something first.`);
    err.status = 400;
    throw err;
  }
  // allDay events store a bare calendar date, never a full timestamp — see
  // the long comment above normalizeAllDayDate() for why. Non-allDay events
  // keep the caller's ISO datetime as-is (including whatever offset it
  // carries — this module stores instants for timed events verbatim; it's
  // the allDay case specifically that has no meaningful offset to keep).
  const normalizedStart = allDay ? normalizeAllDayDate(start) : start;
  const normalizedEnd = allDay && end ? normalizeAllDayDate(end) : end;
  const now = new Date().toISOString();
  const remindAt = allDay ? null : computeRemindAt(normalizedStart, remindMinutesBefore); // "remind N minutes before" isn't meaningful for a dateless allDay event
  const event = {
    id: crypto.randomUUID(),
    userId,
    title: String(title).trim().slice(0, 200),
    notes: String(notes || '').trim().slice(0, 2000),
    start: normalizedStart,
    end: normalizedEnd,
    allDay: !!allDay,
    priority,
    recurrence: validateRecurrence(recurrence),
    remindMinutesBefore: allDay ? null : (Number.isFinite(remindMinutesBefore) ? remindMinutesBefore : null),
    remindAt,
    reminded: false,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  events.push(event);
  save(events);
  return event;
}

// Expands recurring events into their in-range occurrences (see
// expandOccurrences above) before applying the from/to filter, so "show me
// this week" correctly surfaces this week's instance of a weekly recurring
// event, not just its original creation date.
function list(userId, { from, to, includeCompleted = true } = {}) {
  const events = load().filter(strip(userId));
  const fromMs = from ? new Date(from).getTime() : -Infinity;
  const toMs = to ? new Date(to).getTime() : Infinity;
  return events
    .filter((e) => includeCompleted || !e.completed)
    .flatMap((e) => expandOccurrences(e, fromMs, toMs))
    .sort((a, b) => eventStartMs(a) - eventStartMs(b));
}

// Next N upcoming, incomplete events from now — what the dashboard card
// and the boot-time "what's coming up" summary actually want, rather than
// the full list().
function upcoming(userId, limit = 8) {
  const now = Date.now();
  // A year out is plenty for "what's upcoming" purposes and keeps a
  // yearly-recurring event's expansion cheap; a genuinely far-future
  // occurrence will surface once it falls inside this window on a later call.
  const horizonMs = now + 366 * 24 * 60 * 60 * 1000;
  return load()
    .filter((e) => e.userId === userId && !e.completed)
    .flatMap((e) => expandOccurrences(e, now - 5 * 60000, horizonMs))
    .sort((a, b) => eventStartMs(a) - eventStartMs(b))
    .slice(0, limit);
}

// Occurrence ids from expandOccurrences() look like "<baseId>::<index>" —
// get/update/remove/takeDueReminders only ever operate on the stored base
// event (see expandOccurrences' comment: occurrences aren't separate rows),
// so any id coming back from the frontend needs the suffix stripped before
// looking it up. Documented simplification: this means update()/remove()
// always act on the WHOLE recurring series, never a single occurrence —
// genuine per-occurrence edits/deletes (recurrence "exceptions") are a
// materially bigger feature (an exceptions list per event, or materializing
// deviating occurrences into real standalone events) that's out of scope
// here; better to make the series-wide behavior explicit than to silently
// no-op or corrupt state pretending single-occurrence edits work.
function baseEventId(id) {
  return String(id).split('::')[0];
}

function get(userId, id) {
  const event = load().find((e) => e.id === baseEventId(id) && e.userId === userId);
  if (!event) {
    const err = new Error('Event not found');
    err.status = 404;
    throw err;
  }
  return event;
}

function update(userId, id, patch) {
  const events = load();
  const event = events.find((e) => e.id === baseEventId(id) && e.userId === userId);
  if (!event) {
    const err = new Error('Event not found');
    err.status = 404;
    throw err;
  }
  const willBeAllDay = patch.allDay !== undefined ? !!patch.allDay : event.allDay;
  for (const key of ['title', 'notes', 'end', 'priority', 'completed']) {
    if (patch[key] !== undefined) event[key] = patch[key];
  }
  if (patch.allDay !== undefined) event.allDay = willBeAllDay;
  if (patch.start !== undefined) event.start = willBeAllDay ? normalizeAllDayDate(patch.start) : patch.start;
  if (patch.end !== undefined && willBeAllDay) event.end = event.end ? normalizeAllDayDate(event.end) : event.end;
  if (patch.recurrence !== undefined) event.recurrence = validateRecurrence(patch.recurrence);

  if (willBeAllDay) {
    // Same rule as create(): a dateless allDay event has no meaningful
    // "N minutes before" instant to remind at.
    event.remindMinutesBefore = null;
    event.remindAt = null;
  } else if (patch.remindMinutesBefore !== undefined) {
    event.remindMinutesBefore = patch.remindMinutesBefore;
    event.remindAt = computeRemindAt(event.start, patch.remindMinutesBefore);
    event.reminded = false; // re-arm if the reminder time changed
  } else if (patch.start !== undefined && event.remindMinutesBefore != null) {
    // start moved but reminder offset didn't — recompute remindAt so the
    // reminder still fires the right number of minutes before the new time.
    event.remindAt = computeRemindAt(event.start, event.remindMinutesBefore);
    event.reminded = false;
  }
  event.updatedAt = new Date().toISOString();
  save(events);
  return event;
}

function remove(userId, id) {
  const events = load();
  const targetId = baseEventId(id);
  const next = events.filter((e) => !(e.id === targetId && e.userId === userId));
  const removed = next.length !== events.length;
  if (removed) save(next);
  return removed;
}

// Reminders due right now, across all users — polled by calendarReminders.js.
// Marks them reminded=true in the same pass so a reminder never fires twice.
function takeDueReminders() {
  const events = load();
  const now = Date.now();
  const due = events.filter((e) => !e.reminded && !e.completed && e.remindAt != null && e.remindAt <= now);
  if (due.length) {
    due.forEach((e) => { e.reminded = true; });
    save(events);
  }
  return due;
}

module.exports = {
  create, list, upcoming, get, update, remove, takeDueReminders, computeRemindAt,
  normalizeAllDayDate, expandOccurrences, validateRecurrence,
};
