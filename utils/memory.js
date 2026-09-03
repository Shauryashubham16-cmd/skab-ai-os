// Picks the chat-memory backend once at startup: Supabase if it's configured
// in .env, otherwise a local JSON file (utils/memoryLocal.js) so the app has
// real, persistent history out of the box with zero setup. Both modules
// export the exact same function shapes, so nothing else in the app needs to
// know or care which one is active.
const { status } = require('./supabase');

module.exports = status.configured ? require('./memorySupabase') : require('./memoryLocal');
