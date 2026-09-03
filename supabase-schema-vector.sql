-- Real vector-based long-term memory (pgvector), replacing the brute-force
-- in-process cosine scan in utils/longTermMemory.js at scale. This is the
-- one item the original plan flagged as still open ("Suggested next steps"
-- in README.md). Additive: run this alongside supabase-schema.sql, it does
-- not touch chat_sessions/chat_messages.
--
-- Opt-in. Set USE_PGVECTOR_MEMORY=true in .env once this has been run and
-- SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured. Without that
-- flag, utils/longTermMemory.js keeps using the existing JSON-file +
-- brute-force-cosine backend exactly as before — nothing about this
-- migration is required for the rest of the app to work.
--
-- DIMENSION NOTE: vector(768) matches Gemini's text-embedding-004, which is
-- this project's default/recommended embedding provider (see
-- utils/llmProviders.js EMBEDDING_MODELS). If you're using
-- OPENAI_API_KEY / text-embedding-3-small instead (1536 dims), change every
-- `vector(768)` below to `vector(1536)` before running this file. Mixing
-- providers across entries isn't supported — pick one and keep it fixed,
-- since a pgvector column has one fixed dimension.

create extension if not exists vector;

create table if not exists public.long_term_memory (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  type        text not null check (type in ('fact', 'preference', 'note')),
  content     text not null,
  tags        text[] not null default '{}',
  embedding   vector(768),
  created_at  timestamptz not null default now()
);

create index if not exists long_term_memory_user_idx
  on public.long_term_memory (user_id, created_at desc);

-- ivfflat needs at least ~1000 rows and an ANALYZE to be worth much; at the
-- scale this app runs at (personal assistant, not a fleet) a plain index-free
-- table with the RPC below doing an exact scan is plenty fast, and avoids
-- tuning `lists` for a table size nobody knows in advance. Add one later
-- (`create index ... using ivfflat (embedding vector_cosine_ops)`) if a
-- single user's memory ever actually reaches the tens of thousands of rows
-- mentioned in README.md.

-- Cosine-similarity search, scoped to one user, with a keyword fallback
-- score blended in exactly like the original in-process implementation
-- (utils/longTermMemory.js search()) so ranking behavior doesn't change
-- when this backend is swapped in.
create or replace function public.match_long_term_memory(
  p_user_id text,
  p_query_embedding vector(768),
  p_match_count int default 10
)
returns table (
  id uuid,
  type text,
  content text,
  tags text[],
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    id, type, content, tags, created_at,
    1 - (embedding <=> p_query_embedding) as similarity
  from public.long_term_memory
  where user_id = p_user_id and embedding is not null
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant all on public.long_term_memory to service_role;
alter table public.long_term_memory enable row level security;
