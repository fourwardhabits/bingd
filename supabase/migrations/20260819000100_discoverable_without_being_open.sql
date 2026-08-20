-- ===========================================================================
-- Private means "my activity is private", not "nobody can find me"
--
-- `search_users` (20260817000600) filtered every row through `can_view_profile`, and
-- its own comment recorded the consequence as settled product: "a private account is
-- therefore not discoverable by name at all, which is the existing product rule rather
-- than a new one."
--
-- **The founder has reversed that rule**, and the reasoning is that the two meanings had
-- been collapsed into one setting:
--
--   what private is meant to protect    the collection, the activity, the goals, the
--                                       notes, the ranked wall — everything somebody
--                                       chose not to publish
--
--   what it was actually doing          making the account unfindable, so a friend who
--                                       knows the handle cannot send a follow request,
--                                       and the only way to be found is to be public
--
-- The second is not privacy, it is unreachability, and it made the private setting a
-- door that locks from the outside: to be discoverable you had to publish your
-- collection. A person should be able to be found by name and still decide who reads
-- what they wrote.
--
-- ===========================================================================
-- WHAT THIS DOES **NOT** WIDEN
--
-- `can_view_profile` is untouched, and every content read still goes through it —
-- `rankings_read`, `follows_read`, `public_profiles`, `public_notes`, `following_score`,
-- the awards reads, `my_notifications`. Nothing in this migration lets anybody read a
-- private account's collection, activity, goals, notes or counts.
--
-- What becomes reachable is **identity**: the handle, the display name, the avatar, and
-- the fact that the account is private. That set is exactly what a person needs to
-- recognise somebody and decide to ask, and it is already public for every public
-- account on the same surface.
--
-- ===========================================================================
-- BLOCKS ARE NOT A VISIBILITY SETTING AND ARE NOT RELAXED
--
-- A block is the one relationship where being findable is itself the harm. It is
-- enforced here in both directions and ahead of everything else, exactly as
-- `can_view_profile` enforces it — a blocked account is absent rather than hidden, and
-- so is the blocker from the blocked account's own searches.
--
-- Suspension likewise: a suspended account is not identity worth surfacing, and
-- surfacing it would leak a moderation decision.
--
-- **The caller is excluded from their own results.** Searching for yourself is not
-- discovery, and a "You" row in a list of people to follow is a control that cannot
-- exist. The client already labelled that row and can stop.
-- ===========================================================================

create or replace function can_discover_profile(viewer uuid, subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    -- No viewer, no discovery. `search_users` is granted to `authenticated` only, so
    -- this is a defensive floor rather than a reachable branch: an anonymous people
    -- search is not a feature, and if it ever became one it would be a decision rather
    -- than an oversight.
    when viewer is null then false
    -- Yourself. Not a disclosure, just not a result.
    when viewer = subject then false
    when exists (
      select 1 from blocks
       where (blocker_id = viewer  and blocked_id = subject)
          or (blocker_id = subject and blocked_id = viewer)
    ) then false
    else coalesce((select status = 'active' from profiles where id = subject), false)
  end;
$$;

comment on function can_discover_profile(uuid, uuid) is
  'Whether one account may be *found* by another. Deliberately weaker than can_view_profile, which governs content: a private account is discoverable by name so that somebody who knows them can ask to follow, while everything they wrote stays behind can_view_profile. Blocks in either direction and suspension both make an account undiscoverable, and the caller never discovers themselves.';

-- ---------------------------------------------------------------------------
-- People search, over identity rather than over content
--
-- The select list is unchanged and was already identity-only. What changes is the
-- predicate and, with it, who the five columns are returned for.
--
-- `visibility` was already here — the client used it to tell a private account it may
-- see from a public one — and it now carries more weight: it is what lets a search row
-- say "Private" beside the handle rather than presenting a locked account as an open
-- one.
-- ---------------------------------------------------------------------------

create or replace function search_users(p_query text, p_limit integer default 10)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  with folded as (
    -- Capped like `search_titles`' query is, and for the same reason: nothing good
    -- comes of a 4kB search box.
    select media_fold(btrim(left(coalesce(p_query, ''), 100))) as text
  )
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from profiles p, folded f
   -- An empty or whitespace-only query returns nothing rather than every account in
   -- the database. `search_titles` gets this from a null tsquery; here it has to be
   -- said, and it is the difference between a search box and a directory dump.
   where f.text <> ''
     and (media_fold(p.username::text) like '%' || f.text || '%'
          or media_fold(coalesce(p.display_name, '')) like '%' || f.text || '%')
     -- Discovery, not readability. `status = 'active'`, the caller themselves, and
     -- blocks in either direction are all inside it.
     and can_discover_profile(auth.uid(), p.id)
   order by (media_fold(p.username::text) = f.text) desc,
            starts_with(media_fold(p.username::text), f.text) desc,
            starts_with(media_fold(coalesce(p.display_name, '')), f.text) desc,
            p.username,
            p.id
   -- Thirty, which the client asks for and then caps for display. A section inside a
   -- title search is a handful of rows; See all reveals the rest without a second
   -- request, which is only possible because this ceiling is the one that arrives.
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function search_users(text, integer) is
  'People search by handle or display name, folded for case and accents with media_fold. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Filters through can_discover_profile rather than can_view_profile: a private account IS findable by name, because private means "my activity is private" and not "nobody can find me" -- everything they wrote stays behind can_view_profile. A blocked account in either direction, a suspended account, and the caller themselves are all absent. Returns identity only: handle, display name, avatar, visibility.';

-- ---------------------------------------------------------------------------
-- The minimum a profile screen needs to draw somebody it may not read
--
-- Discovery is worthless if the row leads nowhere. Before this, tapping a private
-- account gave "This profile is not available" — the same answer as a handle nobody has
-- taken, which was correct while private accounts were unfindable and is now a dead end
-- somebody was deliberately sent to.
--
-- So there is a second, narrower read. `public_profiles` stays exactly as it is and
-- still returns nothing for a private account; the screen falls back to this when it
-- does, and draws avatar, name, handle and a Follow control and nothing else.
--
-- **It answers for public accounts too**, and that is deliberate rather than
-- convenient: a screen that only reached for it on private accounts would make "which
-- call answered" a disclosure of the visibility setting to anybody watching the
-- network. One call, same shape, for every discoverable account.
--
-- Still nothing for a handle nobody has taken, a blocked account, or a suspended one —
-- which is what keeps the not-available screen honest for the cases where it is true.
-- ---------------------------------------------------------------------------

create or replace function profile_identity(p_username text)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.username::text, p.display_name, p.avatar_path, p.visibility
    from profiles p
   where p.username = btrim(coalesce(p_username, ''))::citext
     and btrim(coalesce(p_username, '')) <> ''
     and can_discover_profile(auth.uid(), p.id)
   limit 1;
$$;

comment on function profile_identity(text) is
  'The minimum needed to draw somebody the caller may not read: handle, display name, avatar, visibility. Exists so that a private account found in search leads somewhere a follow request can be made from, rather than to "this profile is not available". Gated by can_discover_profile, so a blocked or suspended account and a handle nobody has taken all return nothing -- and it answers for public accounts too, so which call succeeded is not itself a disclosure of the visibility setting.';

grant execute on function can_discover_profile(uuid, uuid) to authenticated;
grant execute on function search_users(text, integer)      to authenticated;
grant execute on function profile_identity(text)           to authenticated;
