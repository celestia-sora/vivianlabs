-- Phase 3 (§9.0 item 6): additive version history for custom instructions.
-- Keeps the last N (10) saved persona-profile values so a bad edit is
-- recoverable via "Restore previous version" in Settings. Rollback: drop
-- this table; the singleton vivian_custom_instructions is unchanged.
-- D7: Reset Vivian KEEPS custom instructions, so this history also
-- persists across Reset (it is persona data, not conversation data).
create table if not exists public.custom_instruction_versions (
  id bigint generated always as identity primary key,
  instructions text not null default '' check (char_length(instructions) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists custom_instruction_versions_created_at_idx
  on public.custom_instruction_versions (created_at desc);
alter table public.custom_instruction_versions enable row level security;
revoke all on public.custom_instruction_versions from public, anon, authenticated;
grant select, insert, update, delete on public.custom_instruction_versions to service_role;
