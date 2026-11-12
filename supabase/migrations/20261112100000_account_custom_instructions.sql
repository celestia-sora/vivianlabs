-- Custom Instructions belong to the signed-in account, like personal
-- preferences in general-purpose chat products. Keep the legacy shared
-- singleton untouched for rollback/audit; runtime reads only these tables.
create table if not exists public.vivian_user_custom_instructions (
  user_id text primary key check (length(user_id) > 0),
  instructions text not null default '' check (char_length(instructions) <= 2000),
  updated_at timestamptz not null default now()
);
alter table public.vivian_user_custom_instructions enable row level security;
revoke all on public.vivian_user_custom_instructions from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_user_custom_instructions to service_role;

create table if not exists public.vivian_user_custom_instruction_versions (
  id bigint generated always as identity primary key,
  user_id text not null check (length(user_id) > 0),
  instructions text not null default '' check (char_length(instructions) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists vivian_user_custom_instruction_versions_user_created_idx
  on public.vivian_user_custom_instruction_versions (user_id, created_at desc);
alter table public.vivian_user_custom_instruction_versions enable row level security;
revoke all on public.vivian_user_custom_instruction_versions from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_user_custom_instruction_versions to service_role;
