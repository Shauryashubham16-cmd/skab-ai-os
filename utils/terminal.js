const { spawn } = require('child_process');
const os = require('os');
const { verifyToken } = require('./passcodeAuth');
const { terminalCommand } = require('../schemas');
const permissions = require('./permissions');
const audit = require('./audit');

// Commands/patterns that are blocked outright regardless of ENABLE_TERMINAL.
// This is a minimal safety net, not a sandbox — see README "Terminal security".
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\S)/i,      // rm -rf /
  /\bmkfs\b/i,                  // formatting a filesystem
  /\bdd\s+if=.*of=\/dev\//i,    // raw disk writes
  /:\(\)\{.*\};:/,               // classic fork bomb
  /\bshutdown\b/i,
  /\breg\s+delete\b/i,          // Windows registry deletion
  /\bformat\s+[a-z]:/i,         // Windows drive format
];

function isBlocked(command) {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

// Declared permission metadata for the terminal, in the same shape every
// tool in utils/toolRegistry.js declares (see PERMISSION_META there). The
// terminal isn't driven through the tool registry today (it's its own
// Socket.IO namespace, not a request/response tool call), but authorizing
// it through the exact same utils/permissions.authorize() call means one
// audit of "how is this gated" covers both.
const TERMINAL_TOOL_META = { permission: 'dangerous', requiresCapability: 'terminal' };

function shellFor(command) {
  // Use the native shell so users can pipe/chain commands as they would normally.
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', args: ['/c', command] };
  }
  return { cmd: '/bin/bash', args: ['-c', command] };
}

/**
 * Wires up a Socket.IO namespace for live terminal streaming.
 * Client events:
 *   'terminal:run'  { command: string }  -> triggers execution
 *   'terminal:kill'                       -> kills the currently running process
 * Server events:
 *   'terminal:stdout' { chunk }
 *   'terminal:stderr' { chunk }
 *   'terminal:exit'   { code }
 *   'terminal:error'  { message }
 */
function attachTerminal(io) {
  const nsp = io.of('/terminal');

  // The terminal is the single most dangerous surface in this app: it spawns a
  // real shell on the host machine. It is now gated twice — a valid JARVIS
  // session token (issued only after the correct passcode) must be presented
  // at handshake time, and ENABLE_TERMINAL must be true — so an unauthenticated
  // socket can never reach spawn().
  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const user = verifyToken(token);
    if (!user) return next(new Error('Not signed in'));
    socket.data.user = user;
    return next();
  });

  nsp.on('connection', (socket) => {
    let activeProcess = null;

    socket.emit('terminal:ready', { platform: os.platform() });

    socket.on('terminal:run', (payload) => {
      let command = payload && payload.command;
      // Routed through the same centralized authorize() every other
      // privileged tool uses (utils/permissions.js) — terminal is
      // permission:"dangerous", requiresCapability:"terminal" (see
      // TERMINAL_TOOL_META below), so this is the same check
      // toolRegistry.runTool would apply if the terminal were ever driven
      // through the tool layer instead of its own socket.
      const auth = permissions.authorize('terminal.run', TERMINAL_TOOL_META);
      if (!auth.allowed) {
        socket.emit('terminal:error', { message: auth.reason });
        return;
      }
      const parsed = terminalCommand.safeParse({ command });
      if (!parsed.success) {
        socket.emit('terminal:error', { message: parsed.error.issues[0].message || 'A valid command string is required.' });
        return;
      }
      command = parsed.data.command;
      if (isBlocked(command)) {
        audit.record({ type: 'terminal', tool: 'terminal.run', ok: false, summary: `Blocked command from ${socket.data.user.email}: ${command}` });
        socket.emit('terminal:error', { message: 'This command is blocked for safety.' });
        return;
      }
      if (activeProcess) {
        socket.emit('terminal:error', { message: 'A command is already running. Kill it first.' });
        return;
      }

      const { cmd, args } = shellFor(command);
      activeProcess = spawn(cmd, args, { cwd: os.homedir() });
      console.log(`[terminal] ${socket.data.user.email} ran: ${command}`);
      audit.record({ type: 'terminal', tool: 'terminal.run', ok: true, summary: `Terminal: ${command}` });

      activeProcess.stdout.on('data', (data) => {
        socket.emit('terminal:stdout', { chunk: data.toString() });
      });

      activeProcess.stderr.on('data', (data) => {
        socket.emit('terminal:stderr', { chunk: data.toString() });
      });

      activeProcess.on('close', (code) => {
        socket.emit('terminal:exit', { code });
        activeProcess = null;
      });

      activeProcess.on('error', (err) => {
        socket.emit('terminal:error', { message: err.message });
        activeProcess = null;
      });
    });

    socket.on('terminal:kill', () => {
      if (activeProcess) {
        activeProcess.kill();
        activeProcess = null;
      }
    });

    socket.on('disconnect', () => {
      if (activeProcess) activeProcess.kill();
    });
  });
}

module.exports = { attachTerminal, isBlocked, BLOCKED_PATTERNS, TERMINAL_TOOL_META };
