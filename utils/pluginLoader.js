// Plugin/extension system. Drop a folder under plugins/ with a plugin.json
// manifest + an entry .js file exporting `execute(args, ctx)`, and its tool
// becomes available to the task engine's planner exactly like a built-in
// tool (apps.open, system.status, etc.) — no code changes anywhere else,
// per the plan's "add new tools without modifying the entire agent".
//
// plugins/<name>/plugin.json:
//   {
//     "name": "dice.roll",              // must match ^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$
//                                        // (the same "namespace.action" shape every built-in tool uses)
//     "description": "Roll an N-sided die. args: { sides?: number }",
//     "permission": "read" | "standard" | "dangerous",   // default "standard"
//     "entry": "index.js"               // default "index.js", relative to the plugin's folder
//   }
// plugins/<name>/index.js:
//   module.exports = { execute: async (args, ctx) => ({ ok: true, ... }) };
//
// Trust model: plugin code runs in-process with the same privileges as the
// rest of the server — this is NOT a sandbox, the same honest tradeoff the
// terminal already makes. Two gates, both off by default:
//   ENABLE_PLUGINS=true                  — required for ANY plugin to load at all
//   ENABLE_PLUGIN_DANGEROUS_ACTIONS=true — required in addition, only for
//                                          tools whose manifest declares
//                                          permission:"dangerous"
// A "read"/"standard" plugin can still do anything its own code does once
// ENABLE_PLUGINS is on — the permission field is a declared-intent label the
// planner prompt and the UI can show, and a hard gate for "dangerous" ones,
// not a capability sandbox. Review plugin code before enabling it, same as
// you would before running any other local script.
const fs = require('fs');
const path = require('path');
const { z } = require('../schemas');
const { registerTool, clearPluginTools } = require('./toolRegistry');
const audit = require('./audit');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const NAME_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/;

const manifestSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'name must look like "namespace.action" (lowercase, dot-separated)'),
  description: z.string().trim().min(10).max(300),
  permission: z.enum(['read', 'standard', 'dangerous']).default('standard'),
  entry: z.string().trim().min(1).max(100).default('index.js'),
});

let lastLoaded = []; // [{ name, description, permission, folder, ok, error? }]
let loadedEntryPaths = []; // absolute paths, for require.cache invalidation on reload

function wrapExecute(manifest, folder, rawExecute) {
  return async (args, ctx) => {
    if (manifest.permission === 'dangerous' && process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS !== 'true') {
      return { ok: false, error: `"${manifest.name}" is marked dangerous and is blocked. Set ENABLE_PLUGIN_DANGEROUS_ACTIONS=true in .env to allow it.` };
    }
    try {
      const result = await rawExecute(args, ctx);
      audit.record({
        type: 'plugin', tool: manifest.name, plugin: folder,
        ok: result?.ok !== false,
        summary: result?.ok === false ? `${manifest.name} failed: ${result.error}` : `Plugin tool: ${manifest.name}`,
      });
      return result;
    } catch (err) {
      audit.record({ type: 'plugin', tool: manifest.name, plugin: folder, ok: false, summary: `${manifest.name} threw: ${err.message}` });
      return { ok: false, error: err.message };
    }
  };
}

function loadOne(folder, pluginsDir) {
  const dir = path.join(pluginsDir, folder);
  const manifestPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return { folder, ok: false, error: 'No plugin.json found.' };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { folder, ok: false, error: `plugin.json is not valid JSON: ${err.message}` };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { folder, ok: false, error: `Invalid plugin.json: ${parsed.error.issues[0].message}` };
  }
  const manifest = parsed.data;
  const entryPath = path.join(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    return { folder, ok: false, name: manifest.name, error: `Entry file "${manifest.entry}" not found.` };
  }

  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(entryPath);
    if (!mod || typeof mod.execute !== 'function') {
      return { folder, ok: false, name: manifest.name, error: `${manifest.entry} must export { execute: async (args, ctx) => {...} }.` };
    }
    registerTool(manifest.name, {
      describe: manifest.description,
      execute: wrapExecute(manifest, folder, mod.execute),
      source: folder,
      permission: manifest.permission,
      // Belt-and-suspenders with wrapExecute's own dangerous-permission
      // check above: this also makes a dangerous plugin visible to
      // utils/permissions.authorize() and therefore to runTool() in
      // toolRegistry.js, so the gate shows up the same way a built-in
      // dangerous tool's does, not just inside this file.
      requiresCapability: manifest.permission === 'dangerous' ? 'pluginDangerous' : null,
    });
    loadedEntryPaths.push(entryPath);
    return { folder, ok: true, name: manifest.name, description: manifest.description, permission: manifest.permission };
  } catch (err) {
    return { folder, ok: false, name: manifest.name, error: `Failed to load: ${err.message}` };
  }
}

function loadPlugins(pluginsDir = PLUGINS_DIR) {
  clearPluginTools();
  loadedEntryPaths.forEach((p) => { delete require.cache[p]; });
  loadedEntryPaths = [];

  if (process.env.ENABLE_PLUGINS !== 'true') {
    lastLoaded = [];
    return lastLoaded;
  }
  if (!fs.existsSync(pluginsDir)) {
    lastLoaded = [];
    return lastLoaded;
  }

  const folders = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  lastLoaded = folders.map((folder) => {
    const result = loadOne(folder, pluginsDir);
    if (!result.ok) console.warn(`[plugins] ${folder}: ${result.error}`);
    else console.log(`[plugins] loaded ${result.name} (${result.permission}) from ${folder}/`);
    return result;
  });
  return lastLoaded;
}

function reloadPlugins(pluginsDir = PLUGINS_DIR) {
  return loadPlugins(pluginsDir);
}

function loadedPlugins() {
  return lastLoaded.filter((p) => p.ok);
}

function loadErrors() {
  return lastLoaded.filter((p) => !p.ok);
}

module.exports = {
  loadPlugins, reloadPlugins, loadedPlugins, loadErrors,
  manifestSchema, NAME_PATTERN, PLUGINS_DIR,
};
