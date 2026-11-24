-- Per-account user profile & onboarding state (display name, relationship preset,
-- pronouns, style/interest notes, and onboarded flag).
create table if not exists public.vivian_user_profiles (
  user_id text primary key check (length(trim(user_id)) > 0),
  display_name text not null default '' check (char_length(display_name) <= 60),
  relationship text not null default 'close_friend' check (relationship in ('close_friend', 'new_friend', 'senior_junior', 'crush_partner')),
  pronouns text not null default '' check (char_length(pronouns) <= 80),
  style_notes text not null default '' check (char_length(style_notes) <= 500),
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vivian_user_profiles enable row level security;
revoke all on public.vivian_user_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_user_profiles to service_role;
