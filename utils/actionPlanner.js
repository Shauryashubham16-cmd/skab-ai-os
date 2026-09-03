// Plans are data, never executable shell text. The model/router may suggest a
// plan, but this validator is the sole authority on tools and permissions.
const { detectOpenIntent } = require('./appLauncher');
const { detectSystemIntent } = require('./systemIntent');
const audit = require('./audit');

function plan(message) {
  const steps = [];
  const app = detectOpenIntent(message)
    || (() => {
      const m = /\b(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?([a-zA-Z0-9 _.-]{2,40}?)(?:\s+(?:and|then)\b|$)/i.exec(message);
      return m ? detectOpenIntent(`open ${m[1]}`) : null;
    })();
  const system = detectSystemIntent(message);
  if (app) steps.push({ tool: 'apps.open', args: { app }, permission: 'standard', description: `Open ${app}` });
  if (system) steps.push({ tool: `system.${system.action}`, args: system.args, permission: ['shutdown', 'restart', 'sleep', 'hibernate', 'logout', 'kill_process'].includes(system.action) ? 'confirm' : 'standard', description: system.action.replace(/_/g, ' ') });
  if (/\b(status|stats|health|cpu|ram|battery|gpu)\b/i.test(message)) steps.push({ tool: 'system.status', args: {}, permission: 'read', description: 'Read live system status' });
  if (/\b(search|find|locate)\b.*\b(file|folder|document)\b/i.test(message)) steps.push({ tool: 'files.search', args: {}, permission: 'read', description: 'Search permitted folders' });
  if (/\b(open|launch)\b.*\b(chrome|browser|website|web)\b/i.test(message)) steps.push({ tool: 'browser.open', args: {}, permission: 'standard', description: 'Open the browser' });
  const result = { message, steps, requiresConfirmation: steps.some((s) => s.permission === 'confirm'), createdAt: new Date().toISOString() };
  audit.record({ type: 'plan', summary: steps.map((s) => s.description).join('; ') || 'No executable action detected' });
  return result;
}

function recent(limit = 50) { return audit.recent(limit); }
module.exports = { plan, recent, record: audit.record };
