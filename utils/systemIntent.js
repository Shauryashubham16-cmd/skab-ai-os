// Detects "shut down my pc" / "kill spotify" / "set volume to 40" style
// sentences and maps them to a fixed action + validated args — never to raw
// text. Anything that doesn't match a known pattern falls straight through to
// the normal LLM chat flow.
const PATTERNS = [
  { re: /^(?:please\s+)?(?:shut ?down|turn off)\s+(?:my\s+|the\s+)?(?:computer|pc|machine|system)\.?$/i, action: 'shutdown' },
  { re: /^(?:please\s+)?(?:restart|reboot)\s+(?:my\s+|the\s+)?(?:computer|pc|machine|system)\.?$/i, action: 'restart' },
  { re: /^(?:please\s+)?put\s+(?:my\s+|the\s+)?(?:computer|pc)?\s*to sleep\.?$/i, action: 'sleep' },
  { re: /^sleep\.?$/i, action: 'sleep' },
  { re: /^(?:please\s+)?hibernate(?:\s+(?:my\s+|the\s+)(?:computer|pc))?\.?$/i, action: 'hibernate' },
  { re: /^(?:please\s+)?lock\s+(?:my\s+|the\s+)?(?:screen|computer|pc)?\.?$/i, action: 'lock' },
  { re: /^(?:please\s+)?(?:log ?out|sign ?out)(?:\s+of\s+(?:my\s+|the\s+)?(?:computer|pc|account))?\.?$/i, action: 'logout' },
  { re: /^mute(?:\s+(?:the\s+)?(?:volume|audio|sound))?\.?$/i, action: 'mute' },
  { re: /^unmute(?:\s+(?:the\s+)?(?:volume|audio|sound))?\.?$/i, action: 'unmute' },
  { re: /^(?:turn\s+)?(?:the\s+)?volume\s+up\.?$/i, action: 'volume_up' },
  { re: /^(?:turn\s+)?(?:the\s+)?volume\s+down\.?$/i, action: 'volume_down' },
  { re: /^set\s+(?:the\s+)?volume\s+to\s+(\d{1,3})%?\.?$/i, action: 'volume_set', levelGroup: 1 },
  { re: /^set\s+(?:the\s+)?brightness\s+to\s+(\d{1,3})%?\.?$/i, action: 'brightness_set', levelGroup: 1 },
];

const KILL_RE = /^(?:kill|close|quit|end|terminate)\s+(?:the\s+)?(?:app\s+|process\s+|task\s+)?([a-zA-Z0-9 _.-]{2,60}?)\.?$/i;

const CONFIRM_WORDS = /^(?:yes|y|confirm|do it|go ahead|proceed)\.?$/i;
const CANCEL_WORDS = /^(?:no|n|cancel|nevermind|never mind|stop|don'?t)\.?$/i;

function detectSystemIntent(message) {
  const trimmed = message.trim();
  for (const p of PATTERNS) {
    const m = p.re.exec(trimmed);
    if (m) {
      const args = {};
      if (p.levelGroup) args.level = Math.max(0, Math.min(100, parseInt(m[p.levelGroup], 10)));
      return { action: p.action, args };
    }
  }
  const km = KILL_RE.exec(trimmed);
  if (km) return { action: 'kill_process', args: { target: km[1].trim() } };
  return null;
}

function isConfirmWord(message) { return CONFIRM_WORDS.test(message.trim()); }
function isCancelWord(message) { return CANCEL_WORDS.test(message.trim()); }

module.exports = { detectSystemIntent, isConfirmWord, isCancelWord };
