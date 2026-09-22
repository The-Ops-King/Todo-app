-- Kid accounts and separate profile ids.
--
-- A profile used to be the auth user. Kids break that: a parent creates the
-- kid before any device exists, and when a kid gets a new phone their chores
-- and history have to move to a new session. So a profile now has its own id
-- and points at whichever auth user currently holds it (user_id).
--
-- Kid accounts store a first name and nothing else. A parent creates them and
-- links a device with a short-lived setup code; the device then keeps an
-- anonymous Supabase session, so the app opens straight to the kid's list.
-- Kids can never be admins. Buy links are shown by account type: never to
-- kids, and to adults unless an admin hides them for that person.

-- ---------------------------------------------------------------------------
-- Profiles: own id, current holder in user_id
-- ---------------------------------------------------------------------------

alter table todo.profiles add column user_id uuid unique references auth.users (id) on delete set null;
update todo.profiles set user_id = id;
alter table todo.profiles drop constraint profiles_id_fkey;
alter table todo.profiles alter column id set default gen_random_uuid();

-- Kids are identified by first name only. Dropping the column also drops the
-- check that required it.
alter table todo.profiles drop column username;

alter table todo.profiles add column hide_buy_links boolean not null default false;
alter table todo.profiles add constraint profiles_kids_are_members check (not is_kid or role = 'member');
-- An adult always has a login. A kid may be between devices.
alter table todo.profiles add constraint profiles_adults_have_login check (is_kid or user_id is not null);

create or replace function todo.my_profile_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from todo.profiles where user_id = auth.uid()
$$;

create or replace function todo.my_family_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select family_id from todo.profiles where user_id = auth.uid()
$$;

create or replace function todo.am_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select role = 'admin' from todo.profiles where user_id = auth.uid()), false)
$$;

-- Anonymous sessions exist only for kid devices. They can never create a
-- family or take an adult invite.
create or replace function todo.is_anonymous()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

drop policy profiles_update_self on todo.profiles;
create policy profiles_update_self on todo.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy tasks_read on todo.tasks;
create policy tasks_read on todo.tasks for select to authenticated
  using (family_id = todo.my_family_id()
         and deleted_at is null
         and (scope = 'family' or owner_id = todo.my_profile_id()));

-- ---------------------------------------------------------------------------
-- Families and invites, keyed on the auth user
-- ---------------------------------------------------------------------------

create or replace function todo.create_family(p_family_name text, p_display_name text, p_time_zone text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_family uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if todo.is_anonymous() then
    raise exception 'sign in with your email to create a family' using errcode = '42501';
  end if;
  if exists (select 1 from todo.profiles where user_id = v_uid) then
    raise exception 'already in a family' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone using errcode = '22023';
  end if;
  insert into todo.families (name, time_zone, created_by)
  values (btrim(p_family_name), p_time_zone, v_uid)
  returning id into v_family;
  insert into todo.profiles (user_id, family_id, display_name, role)
  values (v_uid, v_family, btrim(p_display_name), 'admin');
  return v_family;
end
$$;

create or replace function todo.accept_invite(p_token text, p_display_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite todo.invites;
  v_hash bytea;
  v_profile uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if todo.is_anonymous() then
    raise exception 'sign in with your email to join a family' using errcode = '42501';
  end if;
  if exists (select 1 from todo.profiles where user_id = v_uid) then
    raise exception 'already in a family' using errcode = 'P0001';
  end if;
  begin
    v_hash := sha256(decode(p_token, 'hex'));
  exception when others then
    raise exception 'invite is invalid or expired' using errcode = 'P0002';
  end;
  select * into v_invite from todo.invites
  where token_hash = v_hash and used_at is null and revoked_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'invite is invalid or expired' using errcode = 'P0002';
  end if;
  insert into todo.profiles (user_id, family_id, display_name, role)
  values (v_uid, v_invite.family_id, btrim(p_display_name), v_invite.role)
  returning id into v_profile;
  update todo.invites set used_by = v_profile, used_at = now() where id = v_invite.id;
  return v_invite.family_id;
end
$$;

create or replace function todo.set_role(p_profile uuid, p_role text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not todo.am_admin() then
    raise exception 'only admins can change roles' using errcode = '42501';
  end if;
  if p_role = 'admin' and exists (select 1 from todo.profiles where id = p_profile and is_kid) then
    raise exception 'kid accounts cannot be admins' using errcode = 'P0001';
  end if;
  update todo.profiles set role = p_role
  where id = p_profile and family_id = todo.my_family_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Kid accounts
-- ---------------------------------------------------------------------------

create table todo.kid_setup_codes (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references todo.profiles (id) on delete cascade,
  code_hash   bytea not null,
  created_by  uuid references todo.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index kid_setup_codes_hash_idx on todo.kid_setup_codes (code_hash) where used_at is null;
alter table todo.kid_setup_codes enable row level security;

-- Codes are compared case-insensitively and without separators, so
-- "abcd-efgh" and "ABCDEFGH" are the same code.
create or replace function todo.normalize_setup_code(p_code text)
returns text
language sql immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create or replace function todo.add_kid(p_display_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_profile uuid;
begin
  if not todo.am_admin() then
    raise exception 'only admins can add kids' using errcode = '42501';
  end if;
  insert into todo.profiles (family_id, display_name, role, is_kid)
  values (todo.my_family_id(), btrim(p_display_name), 'member', true)
  returning id into v_profile;
  return v_profile;
end
$$;

-- Eight characters from a 32 letter alphabet without I or O: 40 bits, good
-- for 15 minutes and one use. Making a new code cancels the kid's old ones.
create or replace function todo.kid_setup_code(p_profile uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_random bytea := sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8'));
  v_code text := '';
begin
  if not todo.am_admin() then
    raise exception 'only admins can set up kid devices' using errcode = '42501';
  end if;
  if not exists (select 1 from todo.profiles
                 where id = p_profile and family_id = todo.my_family_id() and is_kid) then
    raise exception 'kid not found' using errcode = 'P0002';
  end if;
  for i in 0..7 loop
    v_code := v_code || substr(v_alphabet, get_byte(v_random, i) % 32 + 1, 1);
  end loop;
  update todo.kid_setup_codes set used_at = now() where profile_id = p_profile and used_at is null;
  insert into todo.kid_setup_codes (profile_id, code_hash, created_by, expires_at)
  values (p_profile, sha256(convert_to(v_code, 'UTF8')), todo.my_profile_id(), now() + interval '15 minutes');
  return v_code;
end
$$;

-- Run from the kid's device on an anonymous session. Moves the kid to this
-- device; whatever device held them before loses access.
create or replace function todo.claim_kid_setup(p_code text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row todo.kid_setup_codes;
  v_family uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not todo.is_anonymous() then
    raise exception 'setup codes are for kid devices' using errcode = '42501';
  end if;
  if exists (select 1 from todo.profiles where user_id = v_uid) then
    raise exception 'this device is already set up' using errcode = 'P0001';
  end if;
  select * into v_row from todo.kid_setup_codes
  where code_hash = sha256(convert_to(todo.normalize_setup_code(p_code), 'UTF8'))
    and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'that code is wrong or has expired' using errcode = 'P0002';
  end if;
  update todo.kid_setup_codes set used_at = now() where id = v_row.id;
  update todo.profiles set user_id = v_uid where id = v_row.profile_id and is_kid
  returning family_id into v_family;
  if v_family is null then
    raise exception 'that code is wrong or has expired' using errcode = 'P0002';
  end if;
  return v_family;
end
$$;

create or replace function todo.set_buy_links_hidden(p_profile uuid, p_hidden boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not todo.am_admin() then
    raise exception 'only admins can change this' using errcode = '42501';
  end if;
  update todo.profiles set hide_buy_links = p_hidden
  where id = p_profile and family_id = todo.my_family_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Everything that compared a profile to auth.uid() now uses my_profile_id()
-- ---------------------------------------------------------------------------

create or replace function todo.visible_task_for_update(p_task uuid)
returns todo.tasks
language plpgsql security definer
set search_path = ''
as $$
declare
  t todo.tasks;
begin
  select * into t from todo.tasks where id = p_task for update;
  if not found
     or t.deleted_at is not null
     or t.family_id is distinct from todo.my_family_id()
     or (t.scope = 'personal' and t.owner_id is distinct from todo.my_profile_id()) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  return t;
end
$$;

create or replace function todo.can_work(p_task todo.tasks, p_occ todo.occurrences)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_task.scope = 'personal' then p_task.owner_id = todo.my_profile_id()
    when todo.am_admin() then true
    when p_task.assign_mode = 'pool' then exists (
      select 1 from todo.task_assignees where task_id = p_task.id and profile_id = todo.my_profile_id())
    else p_occ.responsible_id = todo.my_profile_id()
  end
$$;

create or replace function todo.create_invite(p_role text default 'member')
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token bytea := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
begin
  if not todo.am_admin() then
    raise exception 'only admins can invite' using errcode = '42501';
  end if;
  insert into todo.invites (family_id, token_hash, role, created_by, expires_at)
  values (todo.my_family_id(), sha256(v_token), p_role, todo.my_profile_id(), now() + interval '7 days');
  return encode(v_token, 'hex');
end
$$;

create or replace function todo.create_task(p jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_me uuid := todo.my_profile_id();
  v_family uuid := todo.my_family_id();
  v_today date;
  v_scope text := coalesce(p ->> 'scope', 'family');
  v_mode text := coalesce(p ->> 'assign_mode', 'single');
  v_people uuid[];
  v_n int;
  t todo.tasks;
  v_first date;
  v_starts int := (p ? 'last_done_on')::int + (p ? 'first_due_on')::int
                  + coalesce((p ->> 'unsure')::boolean, false)::int;
begin
  if v_family is null then
    raise exception 'not in a family' using errcode = '42501';
  end if;
  if v_scope = 'family' and not todo.am_admin() then
    raise exception 'only admins can create family tasks' using errcode = '42501';
  end if;
  if v_starts <> 1 then
    raise exception 'give exactly one of last_done_on, first_due_on, unsure' using errcode = '22023';
  end if;
  v_today := todo.family_today(v_family);

  if v_scope = 'personal' then
    v_mode := 'single';
    v_people := array[v_me];
  else
    select coalesce(array_agg(x::uuid order by ord), '{}') into v_people
    from jsonb_array_elements_text(coalesce(p -> 'assignees', '[]')) with ordinality as e(x, ord);
  end if;
  v_n := cardinality(v_people);
  if v_n = 0 or v_n <> (select count(distinct x) from unnest(v_people) x) then
    raise exception 'assignees must be a non-empty list without repeats' using errcode = '22023';
  end if;
  if (v_mode = 'single') <> (v_n = 1) then
    raise exception 'single needs exactly one assignee; pool and rotations need two or more' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_people) x
             where not exists (select 1 from todo.profiles where id = x and family_id = v_family)) then
    raise exception 'assignee is not in this family' using errcode = '22023';
  end if;

  insert into todo.tasks (
    family_id, scope, owner_id, title, notes, buy_query, custom_link,
    schedule_kind, interval_unit, interval_count,
    cal_weekdays, cal_month_days, cal_months, active_months,
    miss_policy, lead_days, assign_mode, rotate_unit, rotate_count, rotate_anchor,
    preset_task_id, created_by)
  values (
    v_family, v_scope, case when v_scope = 'personal' then v_me end,
    btrim(p ->> 'title'), nullif(btrim(p ->> 'notes'), ''), nullif(btrim(p ->> 'buy_query'), ''),
    nullif(btrim(p ->> 'custom_link'), ''),
    p ->> 'schedule_kind', p ->> 'interval_unit', (p ->> 'interval_count')::int,
    (select array_agg(x::int) from jsonb_array_elements_text(p -> 'cal_weekdays') as e(x)),
    (select array_agg(x::int) from jsonb_array_elements_text(p -> 'cal_month_days') as e(x)),
    (select array_agg(x::int) from jsonb_array_elements_text(p -> 'cal_months') as e(x)),
    (select array_agg(x::int) from jsonb_array_elements_text(p -> 'active_months') as e(x)),
    coalesce(p ->> 'miss_policy', 'carry'), coalesce((p ->> 'lead_days')::int, 0),
    v_mode, p ->> 'rotate_unit', (p ->> 'rotate_count')::int,
    case when v_mode = 'rotate_period' then coalesce((p ->> 'rotate_anchor')::date, v_today) end,
    (p ->> 'preset_task_id')::uuid, v_me)
  returning * into t;

  insert into todo.task_assignees (task_id, profile_id, position)
  select t.id, x, ord - 1 from unnest(v_people) with ordinality as u(x, ord);

  insert into todo.subtasks (task_id, title, position)
  select t.id, btrim(x), ord - 1
  from jsonb_array_elements_text(coalesce(p -> 'subtasks', '[]')) with ordinality as s(x, ord);

  if p ? 'first_due_on' then
    v_first := todo.align(t, (p ->> 'first_due_on')::date);
  elsif p ? 'last_done_on' then
    v_first := todo.next_due(t, (p ->> 'last_done_on')::date, (p ->> 'last_done_on')::date);
  else
    v_first := todo.align(t, v_today + 7);
  end if;

  insert into todo.occurrences (task_id, due_on, responsible_id)
  values (t.id, v_first, todo.responsible_for(t, v_first));

  return t.id;
end
$$;

create or replace function todo.delete_task(p_task uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  t todo.tasks := todo.visible_task_for_update(p_task);
begin
  if t.scope = 'family' and not todo.am_admin() then
    raise exception 'only admins can delete family tasks' using errcode = '42501';
  end if;
  update todo.tasks set deleted_at = now(), updated_at = now() where id = t.id;
  delete from todo.occurrences where task_id = t.id and status = 'open';
  delete from todo.task_assignees where task_id = t.id;
  if t.scope = 'family' then
    insert into todo.activity (family_id, actor_id, kind, task_id, payload)
    values (t.family_id, todo.my_profile_id(), 'task_deleted', t.id, jsonb_build_object('title', t.title));
  end if;
end
$$;

create or replace function todo.complete_occurrence(p_occurrence uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lock record;
  o todo.occurrences;
  t todo.tasks;
  v_today date;
  v_next date;
  v_new uuid;
begin
  select * into v_lock from todo.lock_occurrence(p_occurrence);
  o := v_lock.o;
  t := v_lock.t;
  if not todo.can_work(t, o) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then
    raise exception 'already closed' using errcode = 'P0001';
  end if;
  v_today := todo.family_today(t.family_id);

  update todo.occurrences
  set status = 'done', completed_by = todo.my_profile_id(), completed_at = now()
  where id = o.id;

  if t.assign_mode = 'rotate_completion' then
    update todo.tasks set rotate_cursor = rotate_cursor + 1 where id = t.id
    returning * into t;
  end if;

  -- A later open occurrence already exists when a rotation period has moved on
  -- and the new holder got a fresh one. Do not spawn a second.
  if not exists (select 1 from todo.occurrences
                 where task_id = t.id and status = 'open' and due_on > o.due_on) then
    if t.schedule_kind = 'calendar' then
      v_next := todo.next_due(t, greatest(o.due_on, v_today - 1), todo.max_due(t.id));
    else
      v_next := todo.next_due(t, v_today, todo.max_due(t.id));
    end if;
    insert into todo.occurrences (task_id, due_on, responsible_id, created_from)
    values (t.id, v_next, todo.responsible_for(t, v_next), o.id)
    returning id into v_new;
  end if;

  if t.scope = 'family' then
    insert into todo.activity (family_id, actor_id, kind, task_id, occurrence_id, payload)
    values (t.family_id, todo.my_profile_id(), 'completed', t.id, o.id,
            jsonb_build_object('due_on', o.due_on, 'responsible_id', o.responsible_id));
  end if;
  return v_new;
end
$$;

create or replace function todo.undo_completion(p_occurrence uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lock record;
  o todo.occurrences;
  t todo.tasks;
  v_next todo.occurrences;
begin
  select * into v_lock from todo.lock_occurrence(p_occurrence);
  o := v_lock.o;
  t := v_lock.t;
  if not (todo.can_work(t, o) or o.completed_by = todo.my_profile_id()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'done' then
    raise exception 'not completed' using errcode = 'P0001';
  end if;
  if exists (select 1 from todo.occurrences
             where task_id = t.id and status = 'done' and completed_at > o.completed_at) then
    raise exception 'only the latest completion can be undone' using errcode = 'P0001';
  end if;

  select * into v_next from todo.occurrences where created_from = o.id for update;
  if found then
    if v_next.status <> 'open'
       or exists (select 1 from todo.subtask_checks where occurrence_id = v_next.id) then
      raise exception 'the next one has already been started' using errcode = 'P0001';
    end if;
    delete from todo.occurrences where id = v_next.id;
  end if;

  update todo.occurrences
  set status = 'open', completed_by = null, completed_at = null
  where id = o.id;

  if t.assign_mode = 'rotate_completion' then
    update todo.tasks set rotate_cursor = rotate_cursor - 1 where id = t.id;
  end if;

  if t.scope = 'family' then
    insert into todo.activity (family_id, actor_id, kind, task_id, occurrence_id)
    values (t.family_id, todo.my_profile_id(), 'undone', t.id, o.id);
  end if;
end
$$;

create or replace function todo.hand_back(p_occurrence uuid, p_to uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lock record;
  o todo.occurrences;
  t todo.tasks;
begin
  select * into v_lock from todo.lock_occurrence(p_occurrence);
  o := v_lock.o;
  t := v_lock.t;
  if t.scope <> 'family' or t.assign_mode = 'pool' then
    raise exception 'this task cannot be handed to someone else' using errcode = 'P0001';
  end if;
  if not (todo.am_admin() or o.responsible_id = todo.my_profile_id()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then
    raise exception 'already closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from todo.profiles where id = p_to and family_id = t.family_id) then
    raise exception 'that person is not in this family' using errcode = '22023';
  end if;
  if p_to = o.responsible_id then
    return;
  end if;

  if t.assign_mode = 'single' then
    update todo.task_assignees set profile_id = p_to where task_id = t.id;
    update todo.occurrences set responsible_id = p_to where task_id = t.id and status = 'open';
  else
    update todo.occurrences set responsible_id = p_to where id = o.id;
  end if;

  insert into todo.activity (family_id, actor_id, kind, task_id, occurrence_id, payload)
  values (t.family_id, todo.my_profile_id(), 'handed_back', t.id, o.id,
          jsonb_build_object('from', o.responsible_id, 'to', p_to, 'created_by', t.created_by));
end
$$;

create or replace function todo.set_subtask(p_occurrence uuid, p_subtask uuid, p_checked boolean)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lock record;
  o todo.occurrences;
  t todo.tasks;
begin
  select * into v_lock from todo.lock_occurrence(p_occurrence);
  o := v_lock.o;
  t := v_lock.t;
  if not todo.can_work(t, o) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if o.status <> 'open' then
    raise exception 'already closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from todo.subtasks where id = p_subtask and task_id = t.id) then
    raise exception 'subtask not found' using errcode = 'P0002';
  end if;

  if p_checked then
    insert into todo.subtask_checks (occurrence_id, subtask_id, checked_by)
    values (o.id, p_subtask, todo.my_profile_id())
    on conflict do nothing;
  else
    delete from todo.subtask_checks where occurrence_id = o.id and subtask_id = p_subtask;
  end if;

  if p_checked and not exists (
    select 1 from todo.subtasks s
    where s.task_id = t.id
      and not exists (select 1 from todo.subtask_checks c
                      where c.occurrence_id = o.id and c.subtask_id = s.id)) then
    perform todo.complete_occurrence(o.id);
    return true;
  end if;
  return false;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on todo.kid_setup_codes from public, anon, authenticated;
revoke all on all functions in schema todo from public, anon, authenticated;

grant execute on function
  todo.create_family(text, text, text),
  todo.create_invite(text),
  todo.accept_invite(text, text),
  todo.revoke_invite(uuid),
  todo.set_role(uuid, text),
  todo.remove_member(uuid),
  todo.create_task(jsonb),
  todo.delete_task(uuid),
  todo.complete_occurrence(uuid),
  todo.undo_completion(uuid),
  todo.hand_back(uuid, uuid),
  todo.set_subtask(uuid, uuid, boolean),
  todo.rollover(),
  todo.add_kid(text),
  todo.kid_setup_code(uuid),
  todo.claim_kid_setup(text),
  todo.set_buy_links_hidden(uuid, boolean),
  todo.my_family_id(),
  todo.my_profile_id(),
  todo.am_admin()
to authenticated;

grant all on all tables in schema todo to service_role;
grant execute on all functions in schema todo to service_role;
