-- Removing someone from a family, or leaving one.
--
-- Their tasks are never orphaned. A task only they were on goes to the
-- person the admin picks (the heir). On a shared task (pool or taking turns)
-- they just come off the list, and whoever the rotation lands on next takes
-- any open occurrence they held. Anything else they were holding, like a
-- task handed to them, goes to the heir.
--
-- History keeps their name: completions, checklist ticks and activity copy
-- the display name before the profile row goes.
--
-- A family always keeps at least one admin; profiles_keep_an_admin (0001)
-- enforces it at commit. leave_family checks first to give a clearer message.

alter table todo.occurrences add column completed_by_name text;
alter table todo.subtask_checks add column checked_by_name text;
alter table todo.activity add column actor_name text;

-- Moves everything off p_profile and deletes it. Callers check permissions.
create or replace function todo.detach_member(p_profile uuid, p_heir uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member todo.profiles;
  v_heir todo.profiles;
  t todo.tasks;
begin
  select * into v_member from todo.profiles where id = p_profile for update;
  select * into v_heir from todo.profiles where id = p_heir;
  if v_heir.id is null or v_heir.family_id <> v_member.family_id or v_heir.id = v_member.id then
    raise exception 'pick someone else in the family to take their tasks' using errcode = 'P0001';
  end if;

  -- Tasks only they were on: the heir takes their place.
  update todo.task_assignees a set profile_id = p_heir
  where a.profile_id = p_profile
    and not exists (select 1 from todo.task_assignees b where b.task_id = a.task_id and b.profile_id <> p_profile);

  -- Shared tasks: drop them from the list and let the rotation pick again.
  for t in
    select tk.* from todo.tasks tk
    where exists (select 1 from todo.task_assignees a where a.task_id = tk.id and a.profile_id = p_profile)
  loop
    delete from todo.task_assignees where task_id = t.id and profile_id = p_profile;
    update todo.occurrences o set responsible_id = todo.responsible_for(t, o.due_on)
    where o.task_id = t.id and o.status = 'open' and o.responsible_id = p_profile;
  end loop;

  -- Anything still on them (handed to them, single tasks just moved above).
  update todo.occurrences set responsible_id = p_heir
  where responsible_id = p_profile and status = 'open';

  update todo.occurrences set completed_by_name = v_member.display_name where completed_by = p_profile;
  update todo.subtask_checks set checked_by_name = v_member.display_name where checked_by = p_profile;
  update todo.activity set actor_name = v_member.display_name where actor_id = p_profile;

  -- Personal tasks go with them (tasks.owner_id cascades).
  delete from todo.profiles where id = p_profile;
end
$$;

drop function todo.remove_member(uuid);

create or replace function todo.remove_member(p_profile uuid, p_heir uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member todo.profiles;
begin
  if not todo.am_admin() then
    raise exception 'only admins can remove people' using errcode = '42501';
  end if;
  select * into v_member from todo.profiles where id = p_profile and family_id = todo.my_family_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_member.id = todo.my_profile_id() then
    raise exception 'use Leave family to remove yourself' using errcode = 'P0001';
  end if;
  insert into todo.activity (family_id, actor_id, kind, payload)
  values (v_member.family_id, todo.my_profile_id(), 'member_removed', jsonb_build_object('name', v_member.display_name));
  perform todo.detach_member(v_member.id, p_heir);
end
$$;

-- Adults only; a kid's phone is removed by an admin. Tasks go to the
-- longest-standing other admin.
create or replace function todo.leave_family()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_me todo.profiles;
  v_heir uuid;
begin
  select * into v_me from todo.profiles where id = todo.my_profile_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_me.is_kid then
    raise exception 'ask an admin to remove this phone' using errcode = '42501';
  end if;
  select id into v_heir from todo.profiles
  where family_id = v_me.family_id and role = 'admin' and id <> v_me.id
  order by created_at limit 1;
  if v_heir is null and v_me.role = 'admin' then
    raise exception 'make someone else an admin before you leave' using errcode = 'P0001';
  end if;
  insert into todo.activity (family_id, actor_id, kind, payload)
  values (v_me.family_id, v_me.id, 'member_left', jsonb_build_object('name', v_me.display_name));
  perform todo.detach_member(v_me.id, v_heir);
end
$$;

revoke all on function
  todo.detach_member(uuid, uuid),
  todo.remove_member(uuid, uuid),
  todo.leave_family()
from public, anon, authenticated;
grant execute on function
  todo.remove_member(uuid, uuid),
  todo.leave_family()
to authenticated, service_role;
grant execute on function todo.detach_member(uuid, uuid) to service_role;
