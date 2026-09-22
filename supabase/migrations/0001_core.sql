-- To Do Dash core schema.
--
-- Everything lives in the `todo` schema so it is fenced off from the other
-- apps sharing this Supabase project. The browser reads through row level
-- security and changes state only through the functions at the bottom of this
-- file. No table grants insert, update or delete to `authenticated` except the
-- few profile columns a person may edit about themselves.
--
-- Dates that mean "a day" are `date`, interpreted in the family's time zone.
-- Weekdays are 0 = Sunday through 6 = Saturday, matching extract(dow).

create schema if not exists todo;

revoke all on schema todo from public;
grant usage on schema todo to authenticated, service_role;

-- Functions are executable by PUBLIC by default. Nothing in this schema should
-- be callable unless it is granted explicitly below.
alter default privileges in schema todo revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create or replace function todo.int_array_ok(arr int[], lo int, hi int)
returns boolean
language sql immutable
set search_path = ''
as $$
  select arr is null
      or (cardinality(arr) > 0
          and not exists (select 1 from unnest(arr) x where x is null or x < lo or x > hi))
$$;

create table todo.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  time_zone   text not null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table todo.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  family_id        uuid not null references todo.families (id) on delete cascade,
  display_name     text not null check (length(btrim(display_name)) between 1 and 40),
  role             text not null check (role in ('admin', 'member')),
  is_kid           boolean not null default false,
  username         text unique check (username ~ '^[a-z0-9_]{3,24}$'),
  summary_time     time not null default '07:00',
  summary_enabled  boolean not null default true,
  created_at       timestamptz not null default now(),
  check (not is_kid or username is not null),
  check (extract(minute from summary_time)::int % 15 = 0 and extract(second from summary_time) = 0)
);
create index profiles_family_idx on todo.profiles (family_id);

create table todo.invites (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references todo.families (id) on delete cascade,
  token_hash  bytea not null unique,
  role        text not null check (role in ('admin', 'member')),
  created_by  uuid references todo.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_by     uuid references todo.profiles (id) on delete set null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index invites_family_idx on todo.invites (family_id);

create table todo.presets (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  group_name  text not null,
  position    int not null default 0
);

create table todo.preset_tasks (
  id              uuid primary key default gen_random_uuid(),
  preset_id       uuid not null references todo.presets (id) on delete cascade,
  title           text not null,
  notes           text,
  schedule_kind   text not null check (schedule_kind in ('countdown', 'calendar')),
  interval_unit   text check (interval_unit in ('day', 'week', 'month', 'year')),
  interval_count  int check (interval_count between 1 and 1000),
  cal_weekdays    int[] check (todo.int_array_ok(cal_weekdays, 0, 6)),
  cal_month_days  int[] check (todo.int_array_ok(cal_month_days, 1, 31)),
  cal_months      int[] check (todo.int_array_ok(cal_months, 1, 12)),
  active_months   int[] check (todo.int_array_ok(active_months, 1, 12)),
  miss_policy     text not null default 'carry' check (miss_policy in ('carry', 'skip')),
  lead_days       int check (lead_days between 0 and 90),
  subtasks        text[] not null default '{}',
  buy_query       text,
  position        int not null default 0
);
create index preset_tasks_preset_idx on todo.preset_tasks (preset_id);

create table todo.tasks (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references todo.families (id) on delete cascade,
  scope           text not null check (scope in ('personal', 'family')),
  owner_id        uuid references todo.profiles (id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 120),
  notes           text check (length(notes) <= 2000),
  buy_query       text check (length(buy_query) <= 200),
  custom_link     text check (custom_link ~ '^https?://' and length(custom_link) <= 2000),
  schedule_kind   text not null check (schedule_kind in ('countdown', 'calendar')),
  interval_unit   text check (interval_unit in ('day', 'week', 'month', 'year')),
  interval_count  int check (interval_count between 1 and 1000),
  cal_weekdays    int[] check (todo.int_array_ok(cal_weekdays, 0, 6)),
  cal_month_days  int[] check (todo.int_array_ok(cal_month_days, 1, 31)),
  cal_months      int[] check (todo.int_array_ok(cal_months, 1, 12)),
  active_months   int[] check (todo.int_array_ok(active_months, 1, 12)),
  miss_policy     text not null default 'carry' check (miss_policy in ('carry', 'skip')),
  lead_days       int not null default 0 check (lead_days between 0 and 90),
  assign_mode     text not null default 'single'
                  check (assign_mode in ('single', 'pool', 'rotate_completion', 'rotate_period')),
  rotate_unit     text check (rotate_unit in ('day', 'week', 'month')),
  rotate_count    int check (rotate_count between 1 and 52),
  rotate_anchor   date,
  rotate_cursor   int not null default 0,
  preset_task_id  uuid references todo.preset_tasks (id) on delete set null,
  created_by      uuid references todo.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check ((scope = 'personal') = (owner_id is not null)),
  check (scope = 'family' or assign_mode = 'single'),
  check (schedule_kind <> 'countdown' or (interval_unit is not null and interval_count is not null)),
  check (schedule_kind <> 'calendar' or cal_weekdays is not null or cal_month_days is not null),
  check (assign_mode <> 'rotate_period'
         or (rotate_unit is not null and rotate_count is not null and rotate_anchor is not null))
);
create index tasks_family_idx on todo.tasks (family_id) where deleted_at is null;

-- Profile deletes are restricted while someone is assigned, so a task can
-- never silently lose its last assignee. remove_member reports what to fix.
create table todo.task_assignees (
  task_id     uuid not null references todo.tasks (id) on delete cascade,
  profile_id  uuid not null references todo.profiles (id) on delete restrict,
  position    int not null,
  primary key (task_id, profile_id),
  unique (task_id, position)
);
create index task_assignees_profile_idx on todo.task_assignees (profile_id);

create table todo.subtasks (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references todo.tasks (id) on delete cascade,
  title     text not null check (length(btrim(title)) between 1 and 120),
  position  int not null default 0
);
create index subtasks_task_idx on todo.subtasks (task_id);

create table todo.occurrences (
  id              uuid primary key default gen_random_uuid(),
  task_id         uuid not null references todo.tasks (id) on delete cascade,
  due_on          date not null,
  responsible_id  uuid references todo.profiles (id) on delete set null,
  status          text not null default 'open' check (status in ('open', 'done', 'skipped')),
  completed_by    uuid references todo.profiles (id) on delete set null,
  completed_at    timestamptz,
  -- Set only when a completion created this occurrence. Undo deletes it.
  created_from    uuid references todo.occurrences (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (task_id, due_on),
  check ((status = 'done') = (completed_at is not null))
);
create index occurrences_open_idx on todo.occurrences (task_id) where status = 'open';
create index occurrences_created_from_idx on todo.occurrences (created_from);

create table todo.subtask_checks (
  occurrence_id  uuid not null references todo.occurrences (id) on delete cascade,
  subtask_id     uuid not null references todo.subtasks (id) on delete cascade,
  checked_by     uuid references todo.profiles (id) on delete set null,
  checked_at     timestamptz not null default now(),
  primary key (occurrence_id, subtask_id)
);

create table todo.activity (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references todo.families (id) on delete cascade,
  actor_id       uuid references todo.profiles (id) on delete set null,
  kind           text not null,
  task_id        uuid references todo.tasks (id) on delete set null,
  occurrence_id  uuid references todo.occurrences (id) on delete set null,
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index activity_family_idx on todo.activity (family_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------

-- security definer so the profiles policy can call it without recursing into
-- itself.
create or replace function todo.my_family_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select family_id from todo.profiles where id = auth.uid()
$$;

create or replace function todo.am_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select role = 'admin' from todo.profiles where id = auth.uid()), false)
$$;

-- "Today" in the family's time zone. Tests pin the date with the
-- todo.today_override setting. PostgREST connects as `authenticator`, so a
-- browser request can never reach the override.
create or replace function todo.family_today(p_family uuid)
returns date
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_override text := nullif(current_setting('todo.today_override', true), '');
begin
  if v_override is not null and session_user <> 'authenticator' then
    return v_override::date;
  end if;
  return (select (now() at time zone f.time_zone)::date from todo.families f where f.id = p_family);
end
$$;

-- ---------------------------------------------------------------------------
-- Recurrence
-- ---------------------------------------------------------------------------

-- Postgres clamps month arithmetic to the end of the month:
-- 2026-01-31 + 1 month = 2026-02-28.
create or replace function todo.add_interval(p_date date, p_unit text, p_count int)
returns date
language sql immutable
set search_path = ''
as $$
  select case p_unit
    when 'day'   then p_date + p_count
    when 'week'  then p_date + 7 * p_count
    when 'month' then (p_date + make_interval(months => p_count))::date
    when 'year'  then (p_date + make_interval(years => p_count))::date
  end
$$;

create or replace function todo.in_window(p_months int[], p_date date)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_months is null or extract(month from p_date)::int = any (p_months)
$$;

-- A month day past the end of a month (31 in April) matches that month's last day.
create or replace function todo.calendar_match(
  p_weekdays int[], p_month_days int[], p_months int[], p_date date)
returns boolean
language sql immutable
set search_path = ''
as $$
  select (p_weekdays is null or extract(dow from p_date)::int = any (p_weekdays))
     and (p_month_days is null
          or extract(day from p_date)::int = any (p_month_days)
          or (p_date = (date_trunc('month', p_date) + interval '1 month - 1 day')::date
              and exists (select 1 from unnest(p_month_days) d where d > extract(day from p_date)::int)))
     and (p_months is null or extract(month from p_date)::int = any (p_months))
$$;

-- First date strictly after p_after that matches the calendar and the active window.
create or replace function todo.next_calendar(p_task todo.tasks, p_after date)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_found date;
begin
  select min(d::date) into v_found
  from generate_series(p_after + 1, p_after + 1500, interval '1 day') d
  where todo.calendar_match(p_task.cal_weekdays, p_task.cal_month_days, p_task.cal_months, d::date)
    and todo.in_window(p_task.active_months, d::date);
  if v_found is null then
    raise exception 'schedule for task % never matches a date', p_task.id;
  end if;
  return v_found;
end
$$;

-- First date on or after p_date that the task's schedule allows.
create or replace function todo.align(p_task todo.tasks, p_date date)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_date date := p_date;
begin
  if p_task.schedule_kind = 'calendar' then
    return todo.next_calendar(p_task, p_date - 1);
  end if;
  for i in 1..12 loop
    exit when todo.in_window(p_task.active_months, v_date);
    v_date := (date_trunc('month', v_date) + interval '1 month')::date;
  end loop;
  return v_date;
end
$$;

-- The next due date after an occurrence closes.
--   countdown: p_base + interval, where p_base is the completion day
--   calendar:  first matching date after p_base. Completion passes
--              greatest(due date, completion day - 1), so a daily task done
--              late still leaves today's due, and January's filter done in
--              August skips July.
-- Never lands on or before p_floor, the latest due date the task already has,
-- so completing a daily task early cannot collide with the one just closed.
create or replace function todo.next_due(p_task todo.tasks, p_base date, p_floor date)
returns date
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_task.schedule_kind = 'calendar' then
    return todo.next_calendar(p_task, greatest(p_base, p_floor));
  end if;
  return greatest(
    todo.align(p_task, todo.add_interval(p_base, p_task.interval_unit, p_task.interval_count)),
    todo.align(p_task, p_floor + 1));
end
$$;

-- Who is responsible for the occurrence due on p_due. Null only in pool mode.
create or replace function todo.responsible_for(p_task todo.tasks, p_due date)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_people uuid[];
  v_n int;
  v_idx bigint;
  v_months int;
begin
  if p_task.assign_mode = 'pool' then
    return null;
  end if;
  select array_agg(profile_id order by position) into v_people
  from todo.task_assignees where task_id = p_task.id;
  v_n := coalesce(cardinality(v_people), 0);
  if v_n = 0 then
    raise exception 'task % has no assignees', p_task.id;
  end if;
  if p_task.assign_mode = 'single' then
    return v_people[1];
  elsif p_task.assign_mode = 'rotate_completion' then
    v_idx := p_task.rotate_cursor;
  else
    if p_task.rotate_unit = 'month' then
      v_months := (extract(year from p_due) - extract(year from p_task.rotate_anchor))::int * 12
                + (extract(month from p_due) - extract(month from p_task.rotate_anchor))::int
                - case when extract(day from p_due) < extract(day from p_task.rotate_anchor) then 1 else 0 end;
      v_idx := floor(v_months::numeric / p_task.rotate_count);
    else
      v_idx := floor((p_due - p_task.rotate_anchor)::numeric
                     / (p_task.rotate_count * case p_task.rotate_unit when 'week' then 7 else 1 end));
    end if;
  end if;
  return v_people[((v_idx % v_n) + v_n) % v_n + 1];
end
$$;

-- Latest due date the task has, open or closed.
create or replace function todo.max_due(p_task uuid)
returns date
language sql stable security definer
set search_path = ''
as $$
  select max(due_on) from todo.occurrences where task_id = p_task
$$;

-- ---------------------------------------------------------------------------
-- Permission helpers
-- ---------------------------------------------------------------------------

-- Loads a live task in the caller's family, or fails with the same error
-- whether it does not exist or belongs to someone else.
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
     or (t.scope = 'personal' and t.owner_id is distinct from auth.uid()) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  return t;
end
$$;

-- May the caller complete, undo or tick subtasks on this occurrence?
create or replace function todo.can_work(p_task todo.tasks, p_occ todo.occurrences)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_task.scope = 'personal' then p_task.owner_id = auth.uid()
    when todo.am_admin() then true
    when p_task.assign_mode = 'pool' then exists (
      select 1 from todo.task_assignees where task_id = p_task.id and profile_id = auth.uid())
    else p_occ.responsible_id = auth.uid()
  end
$$;

-- ---------------------------------------------------------------------------
-- Families, invites, members
-- ---------------------------------------------------------------------------

-- A family must always have an admin. Deferred to commit so a role swap inside
-- one transaction is allowed, and so deleting a whole family is not blocked.
create or replace function todo.check_family_has_admin()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from todo.families where id = old.family_id)
     and not exists (select 1 from todo.profiles where family_id = old.family_id and role = 'admin') then
    raise exception 'a family must keep at least one admin' using errcode = 'P0001';
  end if;
  return null;
end
$$;

create constraint trigger profiles_keep_an_admin
after update or delete on todo.profiles
deferrable initially deferred
for each row execute function todo.check_family_has_admin();

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
  if exists (select 1 from todo.profiles where id = v_uid) then
    raise exception 'already in a family' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'unknown time zone %', p_time_zone using errcode = '22023';
  end if;
  insert into todo.families (name, time_zone, created_by)
  values (btrim(p_family_name), p_time_zone, v_uid)
  returning id into v_family;
  insert into todo.profiles (id, family_id, display_name, role)
  values (v_uid, v_family, btrim(p_display_name), 'admin');
  return v_family;
end
$$;

-- Returns the raw token once. Only its SHA-256 is stored.
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
  values (todo.my_family_id(), sha256(v_token), p_role, auth.uid(), now() + interval '7 days');
  return encode(v_token, 'hex');
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
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if exists (select 1 from todo.profiles where id = v_uid) then
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
  insert into todo.profiles (id, family_id, display_name, role)
  values (v_uid, v_invite.family_id, btrim(p_display_name), v_invite.role);
  update todo.invites set used_by = v_uid, used_at = now() where id = v_invite.id;
  return v_invite.family_id;
end
$$;

create or replace function todo.revoke_invite(p_invite uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not todo.am_admin() then
    raise exception 'only admins can revoke invites' using errcode = '42501';
  end if;
  update todo.invites set revoked_at = now()
  where id = p_invite and family_id = todo.my_family_id() and used_at is null and revoked_at is null;
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
  update todo.profiles set role = p_role
  where id = p_profile and family_id = todo.my_family_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
end
$$;

-- Blocked while the person is on any live family task or holds an open
-- occurrence. Their personal tasks go with them.
create or replace function todo.remove_member(p_profile uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_family uuid := todo.my_family_id();
  v_blocking int;
begin
  if not todo.am_admin() then
    raise exception 'only admins can remove members' using errcode = '42501';
  end if;
  if not exists (select 1 from todo.profiles where id = p_profile and family_id = v_family) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  select count(distinct t.id) into v_blocking
  from todo.tasks t
  where t.family_id = v_family and t.scope = 'family' and t.deleted_at is null
    and (exists (select 1 from todo.task_assignees a where a.task_id = t.id and a.profile_id = p_profile)
         or exists (select 1 from todo.occurrences o
                    where o.task_id = t.id and o.status = 'open' and o.responsible_id = p_profile));
  if v_blocking > 0 then
    raise exception 'reassign or delete % family task(s) first', v_blocking using errcode = 'P0001';
  end if;
  delete from todo.profiles where id = p_profile;
end
$$;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

-- p is a JSON object:
--   scope, title, notes, buy_query, custom_link,
--   schedule_kind, interval_unit, interval_count,
--   cal_weekdays, cal_month_days, cal_months, active_months,
--   miss_policy, lead_days,
--   assign_mode, assignees (ordered profile ids),
--   rotate_unit, rotate_count, rotate_anchor,
--   subtasks (ordered titles), preset_task_id,
--   and exactly one of: last_done_on, first_due_on, unsure (true)
create or replace function todo.create_task(p jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
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
    v_people := array[v_uid];
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
    v_family, v_scope, case when v_scope = 'personal' then v_uid end,
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
    (p ->> 'preset_task_id')::uuid, v_uid)
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

-- Soft delete. History stays, open occurrences and assignments go.
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
    values (t.family_id, auth.uid(), 'task_deleted', t.id, jsonb_build_object('title', t.title));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Occurrences
-- ---------------------------------------------------------------------------

create or replace function todo.lock_occurrence(p_occurrence uuid, out o todo.occurrences, out t todo.tasks)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_task uuid;
begin
  select task_id into v_task from todo.occurrences where id = p_occurrence;
  if not found then
    raise exception 'occurrence not found' using errcode = 'P0002';
  end if;
  t := todo.visible_task_for_update(v_task);
  select * into o from todo.occurrences where id = p_occurrence for update;
end
$$;

-- Returns the id of the next occurrence it created, or null.
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
  set status = 'done', completed_by = auth.uid(), completed_at = now()
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
    values (t.family_id, auth.uid(), 'completed', t.id, o.id,
            jsonb_build_object('due_on', o.due_on, 'responsible_id', o.responsible_id));
  end if;
  return v_new;
end
$$;

-- Reopens the task's most recent completion and removes the occurrence that
-- completion created, as long as nobody has started on it.
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
  if not (todo.can_work(t, o) or o.completed_by = auth.uid()) then
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
    values (t.family_id, auth.uid(), 'undone', t.id, o.id);
  end if;
end
$$;

-- Single mode: the task changes hands. Rotations: only this occurrence does,
-- and the rotation order stays as it was.
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
  if not (todo.am_admin() or o.responsible_id = auth.uid()) then
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
  values (t.family_id, auth.uid(), 'handed_back', t.id, o.id,
          jsonb_build_object('from', o.responsible_id, 'to', p_to, 'created_by', t.created_by));
end
$$;

-- Returns true when this check completed the occurrence.
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
    values (o.id, p_subtask, auth.uid())
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
-- Rollover: what changes when a family's day changes
-- ---------------------------------------------------------------------------

-- 1. Skip-policy occurrences past their due date become skipped, and the next
--    one lands on today or later.
-- 2. Rotate-per-period carry tasks: when the period has moved on and the only
--    open occurrence belongs to the previous holder, the new holder gets a
--    fresh one. The overdue one stays with whoever missed it.
-- Idempotent. Safe to run every 15 minutes.
create or replace function todo.rollover_family(p_family uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_today date := todo.family_today(p_family);
  v_changes int := 0;
  r record;
  t todo.tasks;
  v_next date;
  v_holder uuid;
begin
  for r in
    select o.id as occ_id, o.due_on, o.task_id
    from todo.occurrences o join todo.tasks tk on tk.id = o.task_id
    where tk.family_id = p_family and tk.deleted_at is null and tk.miss_policy = 'skip'
      and o.status = 'open' and o.due_on < v_today
    order by o.due_on
    for update of o
  loop
    select * into t from todo.tasks where id = r.task_id for update;
    update todo.occurrences set status = 'skipped' where id = r.occ_id;
    v_changes := v_changes + 1;
    if not exists (select 1 from todo.occurrences
                   where task_id = t.id and status = 'open' and due_on > r.due_on) then
      if t.schedule_kind = 'calendar' then
        v_next := todo.next_calendar(t, greatest(v_today - 1, todo.max_due(t.id)));
      else
        v_next := todo.next_due(t, r.due_on, todo.max_due(t.id));
        while v_next < v_today loop
          v_next := todo.next_due(t, v_next, v_next);
        end loop;
      end if;
      insert into todo.occurrences (task_id, due_on, responsible_id)
      values (t.id, v_next, todo.responsible_for(t, v_next));
    end if;
  end loop;

  for t in
    select tk.* from todo.tasks tk
    where tk.family_id = p_family and tk.deleted_at is null
      and tk.assign_mode = 'rotate_period' and tk.miss_policy = 'carry'
    for update
  loop
    v_holder := todo.responsible_for(t, v_today);
    if not exists (select 1 from todo.occurrences
                   where task_id = t.id and status = 'open' and due_on >= v_today)
       and exists (select 1 from todo.occurrences
                   where task_id = t.id and status = 'open' and due_on < v_today)
       and not exists (select 1 from todo.occurrences
                       where task_id = t.id and status = 'open' and responsible_id = v_holder) then
      v_next := todo.align(t, greatest(v_today, todo.max_due(t.id) + 1));
      insert into todo.occurrences (task_id, due_on, responsible_id)
      values (t.id, v_next, todo.responsible_for(t, v_next));
      v_changes := v_changes + 1;
    end if;
  end loop;

  return v_changes;
end
$$;

-- For the browser: roll the caller's own family forward on load.
create or replace function todo.rollover()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_family uuid := todo.my_family_id();
begin
  if v_family is null then
    return 0;
  end if;
  return todo.rollover_family(v_family);
end
$$;

-- For the scheduler.
create or replace function todo.rollover_all()
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_total int := 0;
  f uuid;
begin
  for f in select id from todo.families loop
    v_total := v_total + todo.rollover_family(f);
  end loop;
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table todo.families       enable row level security;
alter table todo.profiles       enable row level security;
alter table todo.invites        enable row level security;
alter table todo.presets        enable row level security;
alter table todo.preset_tasks   enable row level security;
alter table todo.tasks          enable row level security;
alter table todo.task_assignees enable row level security;
alter table todo.subtasks       enable row level security;
alter table todo.occurrences    enable row level security;
alter table todo.subtask_checks enable row level security;
alter table todo.activity       enable row level security;

create policy families_read on todo.families for select to authenticated
  using (id = todo.my_family_id());

create policy profiles_read on todo.profiles for select to authenticated
  using (family_id = todo.my_family_id());
create policy profiles_update_self on todo.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy invites_read on todo.invites for select to authenticated
  using (family_id = todo.my_family_id() and todo.am_admin());

create policy presets_read on todo.presets for select to authenticated using (true);
create policy preset_tasks_read on todo.preset_tasks for select to authenticated using (true);

create policy tasks_read on todo.tasks for select to authenticated
  using (family_id = todo.my_family_id()
         and deleted_at is null
         and (scope = 'family' or owner_id = auth.uid()));

-- These lean on tasks_read: the subquery runs with the caller's rights, so a
-- row is visible exactly when its task is.
create policy task_assignees_read on todo.task_assignees for select to authenticated
  using (exists (select 1 from todo.tasks t where t.id = task_id));
create policy subtasks_read on todo.subtasks for select to authenticated
  using (exists (select 1 from todo.tasks t where t.id = task_id));
create policy occurrences_read on todo.occurrences for select to authenticated
  using (exists (select 1 from todo.tasks t where t.id = task_id));
create policy subtask_checks_read on todo.subtask_checks for select to authenticated
  using (exists (select 1 from todo.occurrences o where o.id = occurrence_id));

create policy activity_read on todo.activity for select to authenticated
  using (family_id = todo.my_family_id());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on all tables in schema todo from public, anon, authenticated;
revoke all on all functions in schema todo from public, anon, authenticated;

grant select on
  todo.families, todo.profiles, todo.presets, todo.preset_tasks, todo.tasks,
  todo.task_assignees, todo.subtasks, todo.occurrences, todo.subtask_checks, todo.activity
to authenticated;
grant select (id, family_id, role, created_by, created_at, expires_at, used_by, used_at, revoked_at)
  on todo.invites to authenticated;
grant update (display_name, summary_time, summary_enabled) on todo.profiles to authenticated;

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
  todo.rollover()
to authenticated;

-- RLS policies call these as the requesting user.
grant execute on function todo.my_family_id(), todo.am_admin() to authenticated;

grant all on all tables in schema todo to service_role;
grant execute on all functions in schema todo to service_role;
