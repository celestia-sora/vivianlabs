-- Per-user data isolation, user tiers (free / selected / sorachan),
-- daily Bangkok-midnight chat quotas, and Selected tier upgrade requests.

-- 1. User tier accounts & legacy migration marker.
create table if not exists public.vivian_user_accounts (
  user_id text primary key check (length(trim(user_id)) > 0),
  email text not null check (length(trim(email)) > 0),
  tier text not null default 'free' check (tier in ('free', 'selected', 'sorachan')),
  legacy_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vivian_user_accounts_email_idx
  on public.vivian_user_accounts (lower(email));
create index if not exists vivian_user_accounts_tier_idx
  on public.vivian_user_accounts (tier, updated_at desc);

alter table public.vivian_user_accounts enable row level security;
revoke all on public.vivian_user_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_user_accounts to service_role;

-- 2. Daily chat quota usage keyed by Asia/Bangkok (UTC+7) calendar date.
create table if not exists public.vivian_daily_chat_usage (
  user_id text not null check (length(trim(user_id)) > 0),
  usage_date date not null,
  used_count integer not null default 0 check (used_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create index if not exists vivian_daily_chat_usage_date_idx
  on public.vivian_daily_chat_usage (usage_date desc, user_id);

alter table public.vivian_daily_chat_usage enable row level security;
revoke all on public.vivian_daily_chat_usage from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_daily_chat_usage to service_role;

-- 3. Selected tier upgrade requests (at most one pending request per user).
create table if not exists public.vivian_tier_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (length(trim(user_id)) > 0),
  email text not null check (length(trim(email)) > 0),
  display_name text not null default '' check (char_length(display_name) <= 120),
  reason text not null default '' check (char_length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  review_note text not null default '' check (char_length(review_note) <= 500),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vivian_tier_requests_one_pending_per_user
  on public.vivian_tier_requests (user_id)
  where status = 'pending';
create index if not exists vivian_tier_requests_status_created_idx
  on public.vivian_tier_requests (status, created_at desc);
create index if not exists vivian_tier_requests_user_created_idx
  on public.vivian_tier_requests (user_id, created_at desc);

alter table public.vivian_tier_requests enable row level security;
revoke all on public.vivian_tier_requests from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_tier_requests to service_role;

-- 4. Per-user scoping on memory_consolidation_runs, voice & model preferences.
alter table public.memory_consolidation_runs
  add column if not exists user_key text not null default 'default' check (length(trim(user_key)) > 0);

drop index if exists public.memory_consolidation_runs_running_idx;
create index if not exists memory_consolidation_runs_user_running_idx
  on public.memory_consolidation_runs (user_key, started_at desc)
  where status = 'running';

revoke all on public.memory_consolidation_runs from public, anon, authenticated;
grant select, insert, update, delete on public.memory_consolidation_runs to service_role;

revoke all on public.memories, public.companion_state from public, anon, authenticated;
grant select, insert, update, delete on public.memories, public.companion_state to service_role;
grant usage, select on sequence public.memories_id_seq to service_role;

-- Allow per-user IDs in vivian_voice_preferences and vivian_model_preferences
-- (replacing the legacy `id = 'global'` singleton check constraint).
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.vivian_voice_preferences'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%global%'
  loop
    execute format('alter table public.vivian_voice_preferences drop constraint %I', c.conname);
  end loop;
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.vivian_model_preferences'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%global%'
  loop
    execute format('alter table public.vivian_model_preferences drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.vivian_voice_preferences
  drop constraint if exists vivian_voice_preferences_nonempty_id,
  add constraint vivian_voice_preferences_nonempty_id check (length(trim(id)) > 0);

alter table public.vivian_model_preferences
  drop constraint if exists vivian_model_preferences_nonempty_id,
  add constraint vivian_model_preferences_nonempty_id check (length(trim(id)) > 0);

revoke all on public.vivian_voice_preferences, public.vivian_model_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_voice_preferences, public.vivian_model_preferences to service_role;

-- 5. Per-user conversation save RPC (replaces 4-arg signature cleanly).
drop function if exists public.vivian_save_conversation(uuid, text, jsonb, boolean);
create or replace function public.vivian_save_conversation(
  p_id uuid,
  p_title text,
  p_messages jsonb,
  p_create boolean default true,
  p_user_key text default 'default'
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  entry jsonb;
  owner_key text;
  target_key text;
begin
  target_key := nullif(trim(coalesce(p_user_key, '')), '');
  if p_id is null or target_key is null or p_title is null or length(trim(p_title)) not between 1 and 80
    or jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages) not between 1 and 100 then
    raise exception 'Invalid conversation data' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  if p_create then
    insert into public.conversations(id, user_key, title)
      values(p_id, target_key, trim(p_title))
      on conflict(id) do nothing;
  end if;
  select user_key into owner_key from public.conversations where id = p_id for update;
  if not found then raise exception 'Conversation no longer exists' using errcode = 'P0002'; end if;
  if owner_key <> target_key then raise exception 'Conversation identity mismatch' using errcode = '42501'; end if;
  for entry in select value from jsonb_array_elements(p_messages) loop
    if entry->>'role' not in ('user', 'assistant') or entry->>'role' is null
      or entry->>'id' is null or entry->>'created_at' is null
      or entry->>'content' is null or length(trim(entry->>'content')) not between 1 and 16000 then
      raise exception 'Invalid message' using errcode = '22023';
    end if;
    insert into public.messages(conversation_id, client_message_id, role, content, created_at)
      values(p_id, (entry->>'id')::uuid, entry->>'role', entry->>'content', (entry->>'created_at')::timestamptz)
      on conflict(conversation_id, client_message_id) do nothing;
  end loop;
  update public.conversations set
    title = case when title in ('Daily Talk', 'Vivian conversation') then trim(p_title) else title end,
    updated_at = greatest(updated_at, (select max(created_at) from public.messages where conversation_id = p_id))
    where id = p_id;
end $$;

revoke all on function public.vivian_save_conversation(uuid, text, jsonb, boolean, text) from public, anon, authenticated;
grant execute on function public.vivian_save_conversation(uuid, text, jsonb, boolean, text) to service_role;

-- 6. Per-user 512 MiB R2 storage quota enforcement (selected tier) + global 8GB cap.
create or replace function public.vivian_storage_accounting() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_tier text;
  v_user_used bigint;
begin
  if tg_op in ('INSERT', 'DELETE') then
    -- Lock BOTH global category counters in fixed order, then per-user lock.
    perform category from public.vivian_storage_quotas order by category for update;
    if tg_op = 'INSERT' then
      if (select count(*) from public.vivian_storage_quotas) <> 2 or
        (select sum(used_bytes + external_bytes) from public.vivian_storage_quotas) + new.byte_size > 8000000000 then
        raise exception 'Storage quota exceeded' using errcode = '23514';
      end if;

      if new.user_id is not null then
        perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 1001));
        select tier into v_tier
          from public.vivian_user_accounts
          where user_id = new.user_id::text;
        if v_tier = 'free' then
          raise exception 'Cloud storage requires Selected tier' using errcode = '23514';
        elsif v_tier = 'selected' then
          if coalesce(new.library_scope, 'private') <> 'private' then
            raise exception 'Selected accounts can only store private cloud objects' using errcode = '23514';
          end if;
          select coalesce(sum(byte_size), 0)::bigint into v_user_used
            from public.vivian_storage_objects
            where user_id = new.user_id;
          if v_user_used + new.byte_size > 536870912 then
            raise exception 'Personal storage quota exceeded' using errcode = '23514';
          end if;
        end if;
      end if;

      update public.vivian_storage_quotas set used_bytes = used_bytes + new.byte_size where category = new.category;
      if not found then raise exception 'Storage quota missing' using errcode = '23514'; end if;
      return new;
    end if;
    update public.vivian_storage_quotas set used_bytes = used_bytes - old.byte_size where category = old.category;
    return old;
  elsif new.category <> old.category or new.byte_size <> old.byte_size or new.object_key <> old.object_key or new.id <> old.id then
    raise exception 'Storage reservation is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 7. Idempotent legacy data migration ONLY for suphloeksangko@gmail.com.
create or replace function public.vivian_claim_legacy_data(p_user_id text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_email text;
  v_claimed_at timestamptz;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    raise exception 'Invalid user ID' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vivian_claim_legacy_data', 0));

  select email, legacy_claimed_at into v_email, v_claimed_at
    from public.vivian_user_accounts
    where user_id = p_user_id
    for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'account_not_found');
  end if;
  if v_claimed_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'already_claimed', 'claimed_at', v_claimed_at);
  end if;
  if lower(trim(coalesce(v_email, ''))) <> 'suphloeksangko@gmail.com' then
    return jsonb_build_object('claimed', false, 'reason', 'not_primary_legacy_owner');
  end if;

  update public.conversations
    set user_key = p_user_id
    where user_key = 'default';

  update public.memories m
    set user_key = p_user_id
    where m.user_key = 'default'
      and not exists (
        select 1 from public.memories existing
        where existing.user_key = p_user_id and existing.memory = m.memory
      );
  delete from public.memories where user_key = 'default';

  insert into public.companion_state (
    user_key, affinity, trust, familiarity, mood, mood_intensity,
    conversation_summary, last_idle_at, last_interaction_at, updated_at, memory_summary
  )
  select
    p_user_id, affinity, trust, familiarity, mood, mood_intensity,
    conversation_summary, last_idle_at, last_interaction_at, updated_at, memory_summary
  from public.companion_state
  where user_key = 'default'
  on conflict (user_key) do nothing;
  delete from public.companion_state where user_key = 'default';

  update public.memory_consolidation_runs
    set user_key = p_user_id
    where user_key = 'default';

  insert into public.vivian_voice_preferences (id, speaking_speed, speech_language, voice_id, updated_at)
  select p_user_id, speaking_speed, speech_language, voice_id, updated_at
  from public.vivian_voice_preferences
  where id = 'global'
  on conflict (id) do nothing;
  delete from public.vivian_voice_preferences where id = 'global';

  insert into public.vivian_model_preferences (id, selected_model_id, last_selected_at, revision, updated_at)
  select p_user_id, selected_model_id, last_selected_at, revision, updated_at
  from public.vivian_model_preferences
  where id = 'global'
  on conflict (id) do nothing;
  delete from public.vivian_model_preferences where id = 'global';

  insert into public.vivian_user_custom_instructions (user_id, instructions, updated_at)
  select p_user_id, instructions, updated_at
  from public.vivian_custom_instructions
  where id = 'global' and length(trim(instructions)) > 0
  on conflict (user_id) do nothing;

  update public.vivian_user_accounts
    set legacy_claimed_at = now(), updated_at = now()
    where user_id = p_user_id
    returning legacy_claimed_at into v_claimed_at;

  return jsonb_build_object('claimed', true, 'claimed_at', v_claimed_at);
end;
$$;

revoke all on function public.vivian_claim_legacy_data(text) from public, anon, authenticated;
grant execute on function public.vivian_claim_legacy_data(text) to service_role;

-- 8. Atomic daily chat quota consumption and refund RPCs (Asia/Bangkok midnight reset).
create or replace function public.vivian_consume_chat_quota(
  p_user_id text,
  p_limit integer,
  p_usage_date date default (timezone('Asia/Bangkok', now()))::date
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_date date;
  v_used integer;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 or p_limit is null or p_limit < 0 then
    raise exception 'Invalid quota arguments' using errcode = '22023';
  end if;
  v_date := coalesce(p_usage_date, (timezone('Asia/Bangkok', now()))::date);

  insert into public.vivian_daily_chat_usage (user_id, usage_date, used_count, updated_at)
    values (p_user_id, v_date, 0, now())
    on conflict (user_id, usage_date) do nothing;

  update public.vivian_daily_chat_usage
    set used_count = used_count + 1, updated_at = now()
    where user_id = p_user_id
      and usage_date = v_date
      and used_count < p_limit
    returning used_count into v_used;

  if found then
    return jsonb_build_object(
      'allowed', true,
      'used', v_used,
      'limit', p_limit,
      'remaining', greatest(0, p_limit - v_used),
      'usage_date', v_date::text
    );
  end if;

  select used_count into v_used
    from public.vivian_daily_chat_usage
    where user_id = p_user_id and usage_date = v_date;

  return jsonb_build_object(
    'allowed', false,
    'used', coalesce(v_used, p_limit),
    'limit', p_limit,
    'remaining', 0,
    'usage_date', v_date::text
  );
end;
$$;

revoke all on function public.vivian_consume_chat_quota(text, integer, date) from public, anon, authenticated;
grant execute on function public.vivian_consume_chat_quota(text, integer, date) to service_role;

create or replace function public.vivian_refund_chat_quota(
  p_user_id text,
  p_usage_date date default (timezone('Asia/Bangkok', now()))::date
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_date date;
  v_used integer;
begin
  if p_user_id is null or length(trim(p_user_id)) = 0 then
    raise exception 'Invalid quota arguments' using errcode = '22023';
  end if;
  v_date := coalesce(p_usage_date, (timezone('Asia/Bangkok', now()))::date);

  update public.vivian_daily_chat_usage
    set used_count = greatest(0, used_count - 1), updated_at = now()
    where user_id = p_user_id
      and usage_date = v_date
      and used_count > 0
    returning used_count into v_used;

  if found then
    return jsonb_build_object('refunded', true, 'used', v_used, 'usage_date', v_date::text);
  end if;

  select used_count into v_used
    from public.vivian_daily_chat_usage
    where user_id = p_user_id and usage_date = v_date;

  return jsonb_build_object('refunded', false, 'used', coalesce(v_used, 0), 'usage_date', v_date::text);
end;
$$;

revoke all on function public.vivian_refund_chat_quota(text, date) from public, anon, authenticated;
grant execute on function public.vivian_refund_chat_quota(text, date) to service_role;

-- 9. Atomic tier request review + promotion RPC.
create or replace function public.vivian_review_tier_request(
  p_request_id uuid,
  p_action text,
  p_reviewed_by text,
  p_review_note text default ''
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_req public.vivian_tier_requests%rowtype;
  v_target_status text;
begin
  if p_request_id is null or p_action not in ('approve', 'reject')
    or p_reviewed_by is null or length(trim(p_reviewed_by)) = 0 then
    raise exception 'Invalid tier review arguments' using errcode = '22023';
  end if;

  v_target_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  select * into v_req
    from public.vivian_tier_requests
    where id = p_request_id
    for update;

  if not found then
    raise exception 'Tier request not found' using errcode = 'P0002';
  end if;

  if v_req.status <> 'pending' then
    if v_req.status = v_target_status then
      return jsonb_build_object('already_reviewed', true, 'request', to_jsonb(v_req));
    end if;
    raise exception 'Tier request already reviewed' using errcode = '23514';
  end if;

  update public.vivian_tier_requests
    set status = v_target_status,
        reviewed_by = trim(p_reviewed_by),
        review_note = left(coalesce(p_review_note, ''), 500),
        reviewed_at = now(),
        updated_at = now()
    where id = p_request_id
    returning * into v_req;

  if p_action = 'approve' then
    insert into public.vivian_user_accounts (user_id, email, tier, updated_at)
      values (v_req.user_id, lower(trim(v_req.email)), 'selected', now())
      on conflict (user_id) do update
        set tier = case
          when public.vivian_user_accounts.tier = 'sorachan' then 'sorachan'
          else 'selected'
        end,
        updated_at = now();
  end if;

  return jsonb_build_object('already_reviewed', false, 'request', to_jsonb(v_req));
end;
$$;

revoke all on function public.vivian_review_tier_request(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.vivian_review_tier_request(uuid, text, text, text) to service_role;
