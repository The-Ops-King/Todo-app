-- Icons for people and the family.
--
-- Everyone gets an emoji on a color. Adults can also use a photo; kids
-- cannot, so no picture of a child is ever stored. Photos stay in the todo
-- schema (the Storage bucket tables are shared with other apps): the browser
-- crops and shrinks them to a small WebP or JPEG before upload, and the
-- database checks size and file type again.
--
-- Who may change what:
--   your own icon and photo       yourself (photos: adults only)
--   a kid's icon                  the kid, or any admin
--   the family icon               admins

alter table todo.profiles
  add column icon_emoji text,
  add column icon_color text check (icon_color ~ '^#[0-9a-f]{6}$'),
  -- Bumped on every photo change so browsers know their copy is stale.
  -- Null means no photo.
  add column photo_version integer;

alter table todo.families
  add column icon_emoji text,
  add column icon_color text check (icon_color ~ '^#[0-9a-f]{6}$');

create table todo.photos (
  profile_id  uuid primary key references todo.profiles (id) on delete cascade,
  family_id   uuid not null references todo.families (id) on delete cascade,
  data        bytea not null check (octet_length(data) between 100 and 100000),
  updated_at  timestamptz not null default now()
);
create index photos_family_idx on todo.photos (family_id);
alter table todo.photos enable row level security;
create policy photos_read on todo.photos for select to authenticated
  using (family_id = todo.my_family_id());

-- An emoji is short and carries no ASCII letters, digits, markup or spaces.
-- The picker offers a fixed set; this only stops text posing as an icon.
create or replace function todo.valid_icon(p_emoji text, p_color text)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_emoji is not null and (char_length(p_emoji) not between 1 and 16 or p_emoji ~ '[\x01-\x7f]') then
    raise exception 'that is not an emoji' using errcode = '22023';
  end if;
  if p_color is not null and p_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'that is not a color' using errcode = '22023';
  end if;
end
$$;

create or replace function todo.set_icon(p_profile uuid, p_emoji text, p_color text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_target todo.profiles;
begin
  perform todo.valid_icon(p_emoji, p_color);
  select * into v_target from todo.profiles
  where id = p_profile and family_id = todo.my_family_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_target.id <> todo.my_profile_id() and not (v_target.is_kid and todo.am_admin()) then
    raise exception 'you can only change your own icon' using errcode = '42501';
  end if;
  update todo.profiles set icon_emoji = p_emoji, icon_color = p_color where id = v_target.id;
end
$$;

-- p_data is base64. Only WebP and JPEG are accepted, checked by their
-- leading bytes rather than anything the browser claims.
create or replace function todo.set_photo(p_data text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_me todo.profiles;
  v_bytes bytea;
  v_version integer;
begin
  select * into v_me from todo.profiles where id = todo.my_profile_id();
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_me.is_kid then
    raise exception 'kids use an emoji instead of a photo' using errcode = '42501';
  end if;
  begin
    v_bytes := decode(p_data, 'base64');
  exception when others then
    raise exception 'that photo could not be read' using errcode = '22023';
  end;
  if octet_length(v_bytes) not between 100 and 100000 then
    raise exception 'that photo is too large' using errcode = '22023';
  end if;
  if not (
    (substring(v_bytes from 1 for 4) = '\x52494646'::bytea and substring(v_bytes from 9 for 4) = '\x57454250'::bytea)
    or substring(v_bytes from 1 for 3) = '\xffd8ff'::bytea
  ) then
    raise exception 'photos must be WebP or JPEG' using errcode = '22023';
  end if;

  insert into todo.photos (profile_id, family_id, data) values (v_me.id, v_me.family_id, v_bytes)
  on conflict (profile_id) do update set data = excluded.data, updated_at = now();
  update todo.profiles set photo_version = coalesce(photo_version, 0) + 1
  where id = v_me.id returning photo_version into v_version;
  return v_version;
end
$$;

create or replace function todo.clear_photo()
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from todo.photos where profile_id = todo.my_profile_id();
  update todo.profiles set photo_version = null where id = todo.my_profile_id();
end
$$;

create or replace function todo.set_family_icon(p_emoji text, p_color text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not todo.am_admin() then
    raise exception 'only admins can change the family icon' using errcode = '42501';
  end if;
  perform todo.valid_icon(p_emoji, p_color);
  update todo.families set icon_emoji = p_emoji, icon_color = p_color where id = todo.my_family_id();
end
$$;

-- Photos as unwrapped base64 (encode() breaks lines every 76 characters), read through the caller's row level security.
create or replace function todo.family_photos()
returns table (profile_id uuid, version integer, data text)
language sql stable security invoker
set search_path = ''
as $$
  select ph.profile_id, p.photo_version, translate(encode(ph.data, 'base64'), E'\n', '')
  from todo.photos ph join todo.profiles p on p.id = ph.profile_id
$$;

revoke all on table todo.photos from public, anon, authenticated;
grant select on todo.photos to authenticated;
grant all on todo.photos to service_role;

revoke all on function
  todo.valid_icon(text, text),
  todo.set_icon(uuid, text, text),
  todo.set_photo(text),
  todo.clear_photo(),
  todo.set_family_icon(text, text),
  todo.family_photos()
from public, anon, authenticated;
grant execute on function
  todo.set_icon(uuid, text, text),
  todo.set_photo(text),
  todo.clear_photo(),
  todo.set_family_icon(text, text),
  todo.family_photos()
to authenticated, service_role;
grant execute on function todo.valid_icon(text, text) to service_role;
