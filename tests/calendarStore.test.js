// Covers the pure reminder-time math (computeRemindAt) without touching
// disk — create()/update()/takeDueReminders()'s file I/O is an integration
// concern, deliberately not exercised here, same convention as
// tests/longTermMemory.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRemindAt } = require('../utils/calendarStore');

test('computeRemindAt: N minutes before start, in ms', () => {
  const start = '2026-01-01T12:00:00.000Z';
  assert.equal(computeRemindAt(start, 15), new Date('2026-01-01T11:45:00.000Z').getTime());
});

test('computeRemindAt: 0 minutes before means "at start"', () => {
  const start = '2026-01-01T12:00:00.000Z';
  assert.equal(computeRemindAt(start, 0), new Date(start).getTime());
});

test('computeRemindAt: null/undefined minutesBefore means no reminder', () => {
  const start = '2026-01-01T12:00:00.000Z';
  assert.equal(computeRemindAt(start, null), null);
  assert.equal(computeRemindAt(start, undefined), null);
});

test('computeRemindAt: a negative offset is invalid, not a reminder in the future', () => {
  const start = '2026-01-01T12:00:00.000Z';
  assert.equal(computeRemindAt(start, -5), null);
});

// --- allDay timezone-safety (normalizeAllDayDate) ---------------------------
const { normalizeAllDayDate, expandOccurrences } = require('../utils/calendarStore');

test('normalizeAllDayDate: truncates a full ISO instant to its bare calendar date', () => {
  // This is the actual bug fix: allDay events used to store a full instant,
  // which could render on a different calendar date depending on the
  // viewer's timezone. Storing (and comparing) a bare date has no timezone
  // to get wrong.
  assert.equal(normalizeAllDayDate('2026-08-20T23:45:00.000Z'), '2026-08-20');
});

test('normalizeAllDayDate: accepts a bare date unchanged', () => {
  assert.equal(normalizeAllDayDate('2026-08-20'), '2026-08-20');
});

test('normalizeAllDayDate: rejects a non-date string', () => {
  assert.throws(() => normalizeAllDayDate('not-a-date'), /YYYY-MM-DD/);
});

// --- recurrence expansion ----------------------------------------------------
test('expandOccurrences: non-recurring event returns itself iff in range', () => {
  const event = { id: 'e1', start: '2026-01-10T10:00:00.000Z', allDay: false };
  const from = new Date('2026-01-01').getTime();
  const to = new Date('2026-02-01').getTime();
  assert.equal(expandOccurrences(event, from, to).length, 1);
  assert.equal(expandOccurrences(event, new Date('2027-01-01').getTime(), to).length, 0);
});

test('expandOccurrences: weekly recurrence produces one instance per week, capped by count', () => {
  const event = {
    id: 'e2', start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T09:30:00.000Z', allDay: false,
    recurrence: { freq: 'weekly', interval: 1, until: null, count: 4 },
  };
  const occurrences = expandOccurrences(event, new Date('2026-01-01').getTime(), new Date('2026-03-01').getTime());
  assert.equal(occurrences.length, 4);
  assert.equal(occurrences[0].id, 'e2'); // first occurrence keeps the base id
  assert.equal(occurrences[1].id, 'e2::1'); // later occurrences get a stable ::N suffix
  assert.equal(occurrences[3].start, '2026-01-26T09:00:00.000Z');
});

test('expandOccurrences: monthly recurrence clamps to the target month\'s last day, then recovers', () => {
  // The real calendar-correctness bug this covers: naive "add 1 month" via
  // setUTCMonth on Jan 31 rolls over into March (Feb 31 doesn't exist).
  // Correct behavior is Google/Outlook-style: clamp to the short month's
  // last day, then return to the original day-of-month once a long-enough
  // month comes around again — not permanently drift to the clamped day.
  const event = {
    id: 'e3', start: '2026-01-31', allDay: true,
    recurrence: { freq: 'monthly', interval: 1, until: null, count: 4 },
  };
  const occurrences = expandOccurrences(event, new Date('2026-01-01').getTime(), new Date('2026-06-01').getTime());
  assert.deepEqual(occurrences.map((o) => o.start), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('expandOccurrences: yearly recurrence on Feb 29 clamps in non-leap years, recovers in leap years', () => {
  const event = {
    id: 'e4', start: '2024-02-29', allDay: true,
    recurrence: { freq: 'yearly', interval: 1, until: null, count: 5 },
  };
  const occurrences = expandOccurrences(event, new Date('2026-01-01').getTime(), new Date('2029-01-01').getTime());
  assert.deepEqual(occurrences.map((o) => o.start), ['2026-02-28', '2027-02-28', '2028-02-29']);
});

test('expandOccurrences: caps total expansion so an open-ended recurring event can\'t blow up a wide-range query', () => {
  const event = { id: 'e5', start: '2020-01-01', allDay: true, recurrence: { freq: 'daily', interval: 1, until: null, count: null } };
  const occurrences = expandOccurrences(event, new Date('2020-01-01').getTime(), new Date('2099-01-01').getTime());
  assert.ok(occurrences.length <= 500);
});
