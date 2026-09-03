// Central Supabase wiring — storage only now.
//
// Auth used to live here too (authClient / getUserFromToken), but the app
// switched to a local passcode + JWT (see utils/passcodeAuth.js) and no
// longer talks to Supabase Auth at all. This file now only exports the
// service-role admin client used for reading/writing chat history and memory,
// already scoped per-request by the app layer (see utils/memory.js).
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

const adminClient = url && serviceKey ? createClient(url, serviceKey, noPersist) : null;

function requireAdmin() {
  if (!adminClient) {
    const err = new Error('Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    err.status = 503;
    throw err;
  }
  return adminClient;
}

const status = {
  get configured() { return !!adminClient; },
};

module.exports = { adminClient, requireAdmin, status };
