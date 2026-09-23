-- Assigning in bulk.
--
-- 1. add_presets takes an assignee per item (falling back to the batch
--    assignee), so the picker's "who does what" step lands in one call.
-- 2. reassign_tasks hands a set of single-owner family tasks to one person,
--    open occurrences included. Pooled and rotating tasks are skipped: their
--    people are set per task.
-- 3. profiles.needs_welcome marks adults who joined by invite and have not
--    been given tasks yet, so admins get a "give them some tasks?" prompt.

alter table todo.profiles add column needs_welcome boolean not null default false;

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
  insert into todo.profiles (user_id, family_id, display_name, role, needs_welcome)
  values (v_uid, v_invite.family_id, btrim(p_display_name), v_invite.role, true)
  returning id into v_profile;
  update todo.invites set used_by = v_profile, used_at = now() where id = v_invite.id;
  return v_invite.family_id;
end
$$;

create or replace function todo.dismiss_welcome(p_profile uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not todo.am_admin() then
    raise exception 'only admins can do this' using errcode = '42501';
  end if;
  update todo.profiles set needs_welcome = false
  where id = p_profile and family_id = todo.my_family_id();
end
$$;

-- Returns how many tasks changed hands.
create or replace function todo.reassign_tasks(p_tasks uuid[], p_to uuid)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_family uuid := todo.my_family_id();
  v_moved int := 0;
  t record;
begin
  if not todo.am_admin() then
    raise exception 'only admins can reassign tasks' using errcode = '42501';
  end if;
  if not exists (select 1 from todo.profiles where id = p_to and family_id = v_family) then
    raise exception 'that person is not in this family' using errcode = '22023';
  end if;

  for t in
    select tk.id, tk.title from todo.tasks tk
    where tk.id = any (p_tasks) and tk.family_id = v_family and tk.scope = 'family'
      and tk.deleted_at is null and tk.assign_mode = 'single'
      and not exists (select 1 from todo.task_assignees a where a.task_id = tk.id and a.profile_id = p_to)
    for update
  loop
    update todo.task_assignees set profile_id = p_to where task_id = t.id;
    update todo.occurrences set responsible_id = p_to where task_id = t.id and status = 'open';
    insert into todo.activity (family_id, actor_id, kind, task_id, payload)
    values (v_family, todo.my_profile_id(), 'reassigned', t.id, jsonb_build_object('to', p_to, 'title', t.title));
    v_moved := v_moved + 1;
  end loop;

  update todo.profiles set needs_welcome = false where id = p_to;
  return v_moved;
end
$$;

-- Same as 0003 apart from the per-item assignee.
create or replace function todo.add_presets(p jsonb)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_family uuid := todo.my_family_id();
  v_today date;
  v_default uuid := (p ->> 'assignee')::uuid;
  v_created int := 0;
  v_spread int := 0;
  r record;
  v_spec jsonb;
begin
  if not todo.am_admin() then
    raise exception 'only admins can add presets' using errcode = '42501';
  end if;
  if exists (
    select 1
    from (select coalesce((i.item ->> 'assignee')::uuid, v_default) as who
          from jsonb_array_elements(coalesce(p -> 'items', '[]')) as i(item)) w
    where w.who is null
       or not exists (select 1 from todo.profiles where id = w.who and family_id = v_family)) then
    raise exception 'assignee is not in this family' using errcode = '22023';
  end if;
  v_today := todo.family_today(v_family);

  for r in
    select pt.*, (i.item ->> 'last_done_on')::date as last_done_on,
           coalesce((i.item ->> 'assignee')::uuid, v_default) as assignee
    from jsonb_array_elements(coalesce(p -> 'items', '[]')) as i(item)
    join todo.preset_tasks pt on pt.id = (i.item ->> 'preset_task_id')::uuid
    where not exists (
      select 1 from todo.tasks t
      where t.family_id = v_family and t.preset_task_id = pt.id and t.deleted_at is null)
    order by
      pt.schedule_kind,
      case pt.interval_unit when 'day' then 1 when 'week' then 7 when 'month' then 30 when 'year' then 365 end
        * pt.interval_count nulls last,
      pt.position
  loop
    v_spec := jsonb_strip_nulls(jsonb_build_object(
      'scope', 'family',
      'title', r.title,
      'notes', r.notes,
      'buy_query', r.buy_query,
      'schedule_kind', r.schedule_kind,
      'interval_unit', r.interval_unit,
      'interval_count', r.interval_count,
      'cal_weekdays', to_jsonb(r.cal_weekdays),
      'cal_month_days', to_jsonb(r.cal_month_days),
      'cal_months', to_jsonb(r.cal_months),
      'active_months', to_jsonb(r.active_months),
      'miss_policy', r.miss_policy,
      'lead_days', r.lead_days,
      'assign_mode', 'single',
      'assignees', jsonb_build_array(r.assignee),
      'subtasks', to_jsonb(r.subtasks),
      'preset_task_id', r.id));

    if r.schedule_kind = 'countdown' and r.last_done_on is not null then
      v_spec := v_spec || jsonb_build_object('last_done_on', r.last_done_on);
    elsif r.schedule_kind = 'countdown' then
      v_spec := v_spec || jsonb_build_object('first_due_on', v_today + 1 + v_spread / 3);
      v_spread := v_spread + 1;
    else
      v_spec := v_spec || jsonb_build_object('first_due_on', v_today);
    end if;

    perform todo.create_task(v_spec);
    v_created := v_created + 1;
  end loop;

  return v_created;
end
$$;

revoke all on function todo.dismiss_welcome(uuid), todo.reassign_tasks(uuid[], uuid) from public, anon, authenticated;
grant execute on function
  todo.dismiss_welcome(uuid),
  todo.reassign_tasks(uuid[], uuid),
  todo.accept_invite(text, text),
  todo.add_presets(jsonb)
to authenticated, service_role;
