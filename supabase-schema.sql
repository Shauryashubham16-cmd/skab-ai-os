-- JARVIS cloud-memory schema. Run this once in the Supabase SQL editor.
-- Jarvis authenticates locally with its passcode/JWT, so it deliberately does
-- not depend on Supabase Auth or an auth.users record.

create table if not exists public.chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  title       text not null default 'New conversation',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists chat_sessions_user_updated_idx
  on public.chat_sessions (user_id, updated_at desc);

create table if not exists public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  session_id  uuid not null references public.chat_sessions(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null,
  agent       text,
  provider    text,
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_session_created_idx
  on public.chat_messages (session_id, created_at);
create index if not exists chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at desc);

-- The backend uses only the server-side service_role key. It bypasses RLS and
-- must never be copied to the browser or committed to this repository.
grant all on public.chat_sessions to service_role;
grant all on public.chat_messages to service_role;

alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
