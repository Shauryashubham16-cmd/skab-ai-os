const express = require('express');
const pluginLoader = require('../utils/pluginLoader');

const router = express.Router();

// GET /api/plugins — loaded plugins + any that failed to load (with why),
// plus whether the system is enabled at all.
router.get('/', (req, res) => {
  res.json({
    enabled: process.env.ENABLE_PLUGINS === 'true',
    dangerousActionsEnabled: process.env.ENABLE_PLUGIN_DANGEROUS_ACTIONS === 'true',
    loaded: pluginLoader.loadedPlugins(),
    errors: pluginLoader.loadErrors(),
  });
});

// POST /api/plugins/reload — re-scan plugins/ without restarting the server.
// Picks up new plugins, edited manifests, and edited entry files (the entry
// file's require.cache entry is invalidated first).
router.post('/reload', (req, res) => {
  if (process.env.ENABLE_PLUGINS !== 'true') {
    return res.status(409).json({ ok: false, error: 'Plugins are disabled (ENABLE_PLUGINS is not "true" in .env).' });
  }
  const loaded = pluginLoader.reloadPlugins();
  res.json({ ok: true, loaded: loaded.filter((p) => p.ok), errors: loaded.filter((p) => !p.ok) });
});

module.exports = router;
