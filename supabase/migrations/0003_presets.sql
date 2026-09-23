-- Preset support: stable slugs so preset content can be refreshed by later
-- migrations without breaking the link from a family's task to its preset,
-- and one function that adds a batch of preset tasks in a single transaction.
--
-- The content itself is generated from presets/DRAFT.md by
-- scripts/build-presets.mjs into its own migration.

alter table todo.presets add column if not exists description text;
alter table todo.preset_tasks add column slug text;
alter table todo.preset_tasks add constraint preset_tasks_slug_key unique (slug);

-- p = {
--   assignee: profile id every task goes to,
--   items: [{ preset_task_id, last_done_on? }]
-- }
--
-- Countdown tasks with a last_done_on count from it. Countdown tasks without
-- one ("not sure") are spread out, three a day starting tomorrow, most
-- frequent first, so a 35-task preset never lands on one day. Calendar tasks
-- ignore last_done_on and start on their next date.
--
-- A preset task the family already has (and has not deleted) is skipped, so
-- adding a preset twice is harmless. Returns how many tasks were created.
create or replace function todo.add_presets(p jsonb)
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_family uuid := todo.my_family_id();
  v_today date;
  v_assignee uuid := (p ->> 'assignee')::uuid;
  v_created int := 0;
  v_spread int := 0;
  r record;
  v_spec jsonb;
begin
  if not todo.am_admin() then
    raise exception 'only admins can add presets' using errcode = '42501';
  end if;
  if not exists (select 1 from todo.profiles where id = v_assignee and family_id = v_family) then
    raise exception 'assignee is not in this family' using errcode = '22023';
  end if;
  v_today := todo.family_today(v_family);

  for r in
    select pt.*, (i.item ->> 'last_done_on')::date as last_done_on
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
      'assignees', jsonb_build_array(v_assignee),
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

revoke all on function todo.add_presets(jsonb) from public, anon, authenticated;
grant execute on function todo.add_presets(jsonb) to authenticated, service_role;
