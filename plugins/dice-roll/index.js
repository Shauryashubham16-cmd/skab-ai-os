// Example plugin — intentionally trivial (no filesystem/network/system
// access) so it's safe to leave enabled and demonstrates the plugin shape
// end to end: plugin.json declares the tool, this file implements it,
// pluginLoader.js registers it, and it shows up in GET /api/tasks/tools
// and GET /api/plugins exactly like a built-in tool would.
function execute(args = {}) {
  const sides = Number.isInteger(args.sides) && args.sides >= 2 && args.sides <= 1000 ? args.sides : 6;
  const count = Number.isInteger(args.count) && args.count >= 1 && args.count <= 20 ? args.count : 1;
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  return {
    ok: true,
    sides,
    rolls,
    total: rolls.reduce((a, b) => a + b, 0),
  };
}

module.exports = { execute };
