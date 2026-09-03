// One shared, in-memory audit trail for every "Jarvis did something on this
// machine" action, regardless of which subsystem performed it. Kept small and
// process-local on purpose — this is a recent-activity feed for the user to
// glance at (GET /api/agent/activity), not a durable security log.
const audit = [];
const MAX_ENTRIES = 300;

function record(event) {
  const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, at: new Date().toISOString(), ...event };
  audit.unshift(entry);
  if (audit.length > MAX_ENTRIES) audit.pop();
  return entry;
}

function recent(limit = 50) {
  return audit.slice(0, Math.max(1, Math.min(MAX_ENTRIES, limit)));
}

module.exports = { record, recent };
