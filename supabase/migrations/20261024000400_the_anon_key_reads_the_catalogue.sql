-- The anon key reads the catalogue.
-- Security audit 2026-11-01, findings M-3 and M-4.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- **M-3.** `20260813001400` revoked client writes and left `anon` holding table-level SELECT
-- on nearly everything. RLS then answered a null viewer through `can_view_profile`'s
-- unauthenticated branch, which admits every public, active account. The anon key is on
-- every bingd.app page, so anybody could page through REST and export the member list,
-- rankings, watchlists, the follow graph, activity and former handles. Public is the
-- default, and the privacy page promises "read by any other Bingd user".
--
-- **M-4.** `profiles.invited_by` was selectable and filterable by both client roles:
-- `invited_by=eq.<uuid>` listed a person's invitees, and any public profile showed its
-- inviter's id, even a private inviter's. A personal invitation creates a mutual follow, so
-- this also walked around the rule that an edge is visible only when both ends are.
--
-- ===========================================================================
-- WHAT THIS DOES
--
-- **Anon gets a positive list.** Every table and view loses every privilege, and the only
-- thing granted back is the columns of `media_items` the public title page reads, which
-- describe a film and nobody else. `alter default privileges` goes with it, so a table
-- created tomorrow starts with nothing rather than joining the export.
--
-- One other thing stays, for the operator rather than the site: `list_key` and `fetched_at`
-- on `provider_list_cache`. `remote-smoke.mjs` holds only an anon key, and it is how
-- anybody finds out the Trending shelf has silently gone. Two timestamps about a TMDB list
-- say nothing about a person, and the lists themselves are not included.
--
-- **The website asks for one person, by name.** It read `profiles` for the handle in the URL.
-- `public_profile_card` returns the same three columns for one exact handle, one public
-- account at a time, and it cannot be filtered, paged or listed. A dictionary of handles
-- still works, one guess at a time, because that is what a public profile URL is.
--
-- **Anon loses four functions it no longer has a use for.** `can_i_view` and
-- `watch_tag_visible` were granted because RLS policies call them as the querying role, and
-- anon no longer reaches those policies. `list_by_id` and `list_items_by_list` are SECURITY
-- INVOKER over tables anon cannot read, and the public list page uses `list_view`.
--
-- **Avatars stop being a member list.** `avatars_read` let any caller list the bucket, and
-- its top-level folders are account ids, private accounts included. A public bucket serves
-- objects by URL without consulting this policy, so the profile pictures are unaffected and
-- the only caller it was needed for is the owner clearing their own folder.
--
-- **`invited_by` leaves both client roles.** A column-level revoke does nothing while
-- table-level SELECT remains, so the table grant goes and an explicit column list replaces
-- it. A later column on `profiles` is therefore private until somebody grants it. The
-- reader is `invite_attributions`, whose policy already limits it to the two parties.
--
-- ===========================================================================
-- WHAT THIS DOES NOT CLOSE
--
-- A free signed-in account can still read every public account through RLS, because the
-- app has to. This raises the bar from no account to a throttleable identity. Nothing
-- throttles the API yet, which is its own piece of work.
--
-- ===========================================================================
-- ORDER
--
-- The website's old `profiles` read fails once this applies, and a failed context read
-- renders the generic page rather than an error, so a page cached across the deploy
-- degrades and recovers. Migration first, then the website.
-- ===========================================================================


revoke all on all tables in schema public from anon;

alter default privileges in schema public
  revoke all on tables from anon;

grant select (
  id, parent_id, kind, title, release_date, season_number, poster_path, overview,
  runtime_minutes, genres, episode_count
) on media_items to anon;

grant select (list_key, fetched_at) on provider_list_cache to anon;


revoke execute on function can_i_view(uuid)         from anon;
revoke execute on function watch_tag_visible(uuid)  from anon;
revoke execute on function list_by_id(uuid)         from anon;
revoke execute on function list_items_by_list(uuid) from anon;


create or replace function public_profile_card(p_handle text)
returns table (username text, display_name text, avatar_path text)
language sql
stable
security definer
set search_path = public
as $$
  select p.username::text, p.display_name, p.avatar_path
    from profiles p
   where p_handle ~ '^[a-z0-9_]{3,24}$'
     and p.username = p_handle
     and can_view_profile(null, p.id)
   limit 1;
$$;

comment on function public_profile_card(text) is
  'One public account''s name and picture, for the signed-out website''s link preview. Exact handle only: a pattern is refused rather than matched, and there is no way to list, page or filter. can_view_profile''s null-viewer branch is the whole gate, so a private or suspended account answers no rows, the same as a handle that does not exist. Replaced the website''s direct read of profiles (20261024000400).';

revoke execute on function public_profile_card(text) from public, authenticated;
grant  execute on function public_profile_card(text) to anon;


revoke select on profiles from authenticated;

grant select (
  id, username, display_name, avatar_path, visibility, founding_member, created_at, status,
  bio, link_instagram, link_tiktok, link_youtube, link_x, link_website, username_changed_at
) on profiles to authenticated;


do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;

  drop policy if exists avatars_read on storage.objects;

  create policy avatars_read on storage.objects for select
    to authenticated
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
end;
$$;
