// "What is the user doing right now" — a lightweight rolling history of the
// focused window, built on top of windowManager.getActiveWindow(). This is
// not screen vision (no pixels, no content), just app-level presence, so it's
// cheap to poll continuously and safe to hand to the LLM as context.
const { getActiveWindow } = require('./windowManager');

const POLL_MS = 5000;
const MAX_HISTORY = 30;

let current = null;
let history = [];
let timer = null;
let lastError = null;

function record(win) {
  const changed = !current || current.title !== win.title || current.processName !== win.processName;
  current = { title: win.title, processName: win.processName, pid: win.pid };
  if (changed) {
    history.unshift({ ...current, at: new Date().toISOString() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  }
}

async function poll() {
  try {
    const win = await getActiveWindow();
    if (win.ok) {
      record(win);
      lastError = null;
    } else {
      lastError = win.error;
    }
  } catch (err) {
    lastError = err.message;
  }
}

function start() {
  if (timer || process.platform !== 'win32') return;
  poll();
  timer = setInterval(poll, POLL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getContext() {
  return { current, recent: history, supported: process.platform === 'win32', lastError };
}

module.exports = { start, stop, getContext };
