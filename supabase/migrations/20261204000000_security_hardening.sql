-- Security hardening (RLS/Auth audit 2026-11-26) + fix tg_op case in memory trigger.

-- 1) Fix tg_op = 'INSERT' (Postgres passes uppercase), pin search_path = '',
--    and revoke EXECUTE from API roles on public.vivian_memory_sync_importance().
create or replace function public.vivian_memory_sync_importance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.importance_01 is null then
    new.importance_01 := (new.importance::real - 1) / 4;
  elsif tg_op = 'INSERT' and new.importance is null then
    new.importance := least(5, greatest(1, round(new.importance_01 * 4 + 1)::smallint));
  end if;
  return new;
end;
$$;

revoke execute on function public.vivian_memory_sync_importance() from public, anon, authenticated;
grant execute on function public.vivian_memory_sync_importance() to service_role;

-- 2) Scenes are only accessed via service_role (D1 identities, not Supabase Auth).
--    Remove legacy Supabase-Auth SELECT policies and authenticated table grants.
drop policy if exists "Read own scenes" on public.vivian_scenes;
drop policy if exists "Read own scene preferences" on public.vivian_scene_preferences;
revoke select on public.vivian_scenes, public.vivian_scene_preferences from authenticated;
