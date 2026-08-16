-- ---------------------------------------------------------------------------
-- Avatars: a storage bucket, its policies, and the one write that names a file
--
-- `profiles.avatar_url` has existed since 20260813000200 and nothing has ever
-- been able to set it. The column was read by every social surface in the app
-- and written by nobody, so every account was initials on a Parchment circle
-- and looked, correctly, unfinished.
--
-- Two halves, and they are separate on purpose. The bytes go to Supabase
-- Storage, which the client uploads to directly -- routing an image through
-- Postgres would be absurd. The *pointer* goes through an RPC, because
-- `profiles` has no update policy by design (20260813000200: writes go through
-- SECURITY DEFINER functions so RLS and invariants are enforced in one place)
-- and this is not the change that should become the exception.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The column stores a path, and is renamed to say so
--
-- The obvious design stores the full public URL. It needs the project origin,
-- which is not knowable from inside Postgres, so it would have to arrive as a
-- per-environment setting -- and an environment where somebody forgets to set
-- it ships broken images rather than an error. Restoring a dump into a second
-- project would also leave every avatar pointing at the first one.
--
-- So the column holds `{uuid}/{filename}` and the client composes the URL from
-- the project it is already talking to. A column named `avatar_url` holding
-- `9f2.../1755230000.jpg` is a trap for whoever reads it next, hence the rename.
-- ---------------------------------------------------------------------------

alter table profiles rename column avatar_url to avatar_path;

comment on column profiles.avatar_path is
  'Object path within the public avatars bucket, always {profiles.id}/{filename}. Not a URL: the origin belongs to the deployment, not to the row. Resolve with src/lib/images.ts avatarUri.';

-- The projection in api.md §12. Recreated rather than altered because a view's
-- column list is fixed at creation; `security_invoker` must be carried over or
-- the view starts running as its owner and publishes every private account.
drop view if exists public_profiles;

create view public_profiles with (security_invoker = true) as
select id, username, display_name, avatar_path, visibility, created_at
  from profiles
 where status = 'active';

-- ---------------------------------------------------------------------------
-- 2. The bucket
--
-- Public read. An avatar appears in feeds, on profiles, in search results and
-- on the share card, which is the definition of a public image, and signing
-- every one of those URLs would mean a round trip per face on screen for a
-- secret that is a face.
--
-- Privacy is not lost by this, but it is worth being exact about what is kept.
-- A private account's *content* stays behind `can_i_view`; its avatar is
-- reachable by anyone holding the URL. The URL contains the account's uuid and
-- nothing else identifying, so holding it means having already read the profile
-- row, which RLS governs. What is forfeited is deniability against someone who
-- kept an old URL -- the same bargain every social product makes, and the reason
-- the delete policy below matters.
--
-- Guarded because the storage schema is Supabase's, not ours. On a database
-- with no storage schema this section is inert rather than fatal.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'no storage schema; skipping the avatars bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'avatars',
    'avatars',
    true,
    -- 2 MB. The client downscales to 512px and re-encodes as JPEG before
    -- uploading, so anything near this ceiling is a client that did not -- and
    -- the ceiling is the only part of that pipeline a modified client cannot
    -- skip.
    2 * 1024 * 1024,
    array['image/jpeg', 'image/png', 'image/webp']
  )
  on conflict (id) do update
     set public             = excluded.public,
         file_size_limit    = excluded.file_size_limit,
         allowed_mime_types = excluded.allowed_mime_types;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Who may write where
--
-- Ownership is carried by the **path**, not by `storage.objects.owner`.
--
-- Deliberate: `owner` is a column Supabase populates and has already deprecated
-- once, so a policy keyed to it depends on their upload path continuing to fill
-- it in. A path prefix is ours. The first folder segment is the account's uuid,
-- and `auth.uid()` either matches it or does not.
--
-- Four policies rather than one `for all`, so the read rule can be public while
-- the write rules are not. A combined policy would either publish the delete or
-- hide the read.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;

  drop policy if exists avatars_read   on storage.objects;
  drop policy if exists avatars_insert on storage.objects;
  drop policy if exists avatars_update on storage.objects;
  drop policy if exists avatars_delete on storage.objects;

  -- anon included: profile pages are served signed-out.
  create policy avatars_read on storage.objects for select
    using (bucket_id = 'avatars');

  create policy avatars_insert on storage.objects for insert
    with check (
      bucket_id = 'avatars'
      and auth.uid() is not null
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  -- Present so overwriting one's own avatar at a stable path works. The client
  -- does not do that -- it writes a fresh name each time so the CDN cannot keep
  -- serving the previous face -- but a policy set that forbids update while
  -- allowing insert and delete is a trap for the next person.
  create policy avatars_update on storage.objects for update
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    )
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );

  -- The policy that makes "I changed my picture" mean something. Without it,
  -- every avatar an account has ever set stays fetchable by anyone who kept a
  -- URL.
  create policy avatars_delete on storage.objects for delete
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Setting the pointer
--
-- Validates rather than trusts. The path must name the caller's own folder, so
-- the reachable values are exactly the objects that account is allowed to have
-- written -- the same rule as the storage policy, restated where the profile
-- row is touched, because these two are enforced by different subsystems and
-- neither can see the other.
--
-- Null clears it, which is how "remove my picture" is expressed.
-- ---------------------------------------------------------------------------

create or replace function set_avatar(p_object_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_path text := nullif(btrim(coalesce(p_object_path, '')), '');
begin
  perform assert_can_write();

  -- An avatar existing before a profile does is what the age gate in
  -- create_profile cannot survive: that path deletes the auth.users row, and a
  -- storage object referencing it would block the delete and leave a refused
  -- child's account in place. 20260813002200 names the hazard exactly.
  -- Refusing here makes it unreachable by construction rather than by where the
  -- upload button happens to live.
  if not exists (select 1 from profiles where id = v_user) then
    raise exception 'no profile to set an avatar on' using errcode = '42704';
  end if;

  if v_path is null then
    update profiles set avatar_path = null where id = v_user;
    return null;
  end if;

  -- The security argument in one regex: begins with the caller's own uuid
  -- folder, one segment deep, and cannot climb out of it. `.` is permitted for
  -- the extension and `..` cannot appear without a `/` to be useful.
  if v_path !~ ('^' || v_user::text || '/[A-Za-z0-9._-]{1,80}$') then
    raise exception 'avatar path must be %/<filename>', v_user
      using errcode = '22023';
  end if;

  update profiles set avatar_path = v_path where id = v_user;
  return v_path;
end;
$$;

comment on function set_avatar(text) is
  'Points profiles.avatar_path at an object in the avatars bucket under the caller''s own uuid folder, or clears it when passed null. Raises 42704 when the caller has no profile, 22023 for a path outside their folder.';

revoke execute on function set_avatar(text) from public, anon, authenticated;
grant  execute on function set_avatar(text) to authenticated;
