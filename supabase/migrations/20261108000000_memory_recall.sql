-- OpenAmika-style memory recall: paraphrase corrections get linked to the
-- claim they replaced (kept, never string-matched away), and facts carry
-- an embedding for hybrid BM25 + vector retrieval. Everything is nullable /
-- defaulted so existing rows and code paths keep working unchanged.
alter table public.memories add column if not exists embedding double precision[];
alter table public.memories add column if not exists superseded boolean not null default false;
alter table public.memories add column if not exists supersedes_id bigint references public.memories(id) on delete set null;
alter table public.memories add column if not exists source_kind text not null default 'fact' check (source_kind in ('event', 'fact', 'consolidated'));
create index if not exists memories_user_superseded_idx on public.memories(user_key, superseded, importance desc, updated_at desc);
