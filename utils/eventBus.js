// Central real-time event bus (Phase 2 — "Real-Time Event Bus" from the
// upgrade plan). taskEngine (and anything else that runs multi-step work)
// emits into this bus without knowing Socket.IO exists; utils/agentSocket.js
// is the only thing that subscribes and fans events out to the right
// user's room. This keeps the task engine testable/headless and means any
// future transport (a second UI, a CLI, logging) can subscribe the same way.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// event: 'agent:state' | 'agent:log' — see agentSocket.js for the contract.
function emitAgentEvent(userId, event, payload = {}) {
  if (!userId) return; // nothing to route it to
  bus.emit('agent-event', { userId, event, payload, at: Date.now() });
}

module.exports = { bus, emitAgentEvent };
