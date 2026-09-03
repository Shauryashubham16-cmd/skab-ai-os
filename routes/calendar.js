const express = require('express');
const { asyncHandler } = require('../utils/apiError');
const { validate } = require('../middleware/validate');
const {
  calendarEventCreate, calendarEventUpdate, calendarEventParams, calendarListQuery,
} = require('../schemas');
const calendarStore = require('../utils/calendarStore');

const router = express.Router();

// GET /api/calendar/upcoming — next N incomplete events from now. What the
// dashboard card and boot summary actually want; registered before the
// generic list route isn't strictly necessary here (no param clash) but
// kept first for readability alongside the rest of the "shortcut" routes.
router.get('/upcoming', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 8, 50);
  res.json({ events: calendarStore.upcoming(req.user.id, limit) });
});

// GET /api/calendar — full list, optionally windowed by ?from=&to= (ISO)
router.get('/', validate({ query: calendarListQuery }), (req, res) => {
  const { from, to, includeCompleted } = req.query;
  res.json({ events: calendarStore.list(req.user.id, { from, to, includeCompleted }) });
});

// POST /api/calendar — create an event or task. `end` omitted means a
// point-in-time task/reminder rather than a spanned event.
router.post('/', validate({ body: calendarEventCreate }), asyncHandler((req, res) => {
  const event = calendarStore.create(req.user.id, req.body);
  res.status(201).json({ event });
}));

// GET /api/calendar/:id
router.get('/:id', validate({ params: calendarEventParams }), asyncHandler((req, res) => {
  res.json({ event: calendarStore.get(req.user.id, req.params.id) });
}));

// PATCH /api/calendar/:id — partial update; also how a task/event gets
// marked complete ({ completed: true }) or a reminder gets rescheduled.
router.patch('/:id', validate({ params: calendarEventParams, body: calendarEventUpdate }), asyncHandler((req, res) => {
  const event = calendarStore.update(req.user.id, req.params.id, req.body);
  res.json({ event });
}));

// DELETE /api/calendar/:id
router.delete('/:id', validate({ params: calendarEventParams }), asyncHandler((req, res) => {
  const removed = calendarStore.remove(req.user.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
}));

module.exports = router;
