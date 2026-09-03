// Streams taskEngine's real Plan -> Execute -> Observe -> Verify ->
// Correct -> Retry state transitions to the frontend as they actually
// happen, over the same PIPELINE_STATES the reactor/stepper already
// understand (see PHASE1-VISUAL-UPGRADE.md). Mirrors utils/terminal.js's
// auth pattern exactly: a valid JARVIS session token is required at
// handshake time, no exceptions.
const { verifyToken } = require('./passcodeAuth');
const { bus } = require('./eventBus');

function attachAgentEvents(io) {
  const nsp = io.of('/agent');

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const user = verifyToken(token);
    if (!user) return next(new Error('Not signed in'));
    socket.data.user = user;
    return next();
  });

  nsp.on('connection', (socket) => {
    socket.join(`user:${socket.data.user.id}`);
    socket.emit('agent:ready', {});
  });

  // One shared listener, fanned out by room — cheap even with many sockets.
  bus.on('agent-event', ({ userId, event, payload }) => {
    nsp.to(`user:${userId}`).emit(event, payload);
  });
}

module.exports = { attachAgentEvents };
