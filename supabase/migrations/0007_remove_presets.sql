-- Removing a preset (sold the boat, the dog passed) deletes the family tasks
-- that came from it. The admin confirms a list and can keep some, so this
-- takes task ids rather than a preset. All or nothing: one bad id and none
-- are deleted. Completion history stays, as with any deleted task.
create or replace function todo.delete_tasks(p_tasks uuid[])
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  if not todo.am_admin() then
    raise exception 'only admins can remove presets' using errcode = '42501';
  end if;
  for v_id in select distinct unnest(coalesce(p_tasks, '{}')) loop
    perform todo.delete_task(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke all on function todo.delete_tasks(uuid[]) from public, anon, authenticated;
grant execute on function todo.delete_tasks(uuid[]) to authenticated, service_role;
