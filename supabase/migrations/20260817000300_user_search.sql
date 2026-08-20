-- Finding people.
-- Specification: founder addendum 2026-08-16 §2 — "a new user must be able to find
-- another user before the external beta". Global Search gains All | Movies | TV | Users.
--
-- ---------------------------------------------------------------------------
-- WHY THIS CANNOT FOLLOW `search_titles`
--
-- `search_titles` is `security invoker` and says why: `media_items` is world-readable,
-- so it needs no elevated rights, and a definer version would silently keep returning
-- rows if a future policy ever hid some.
--
-- Neither half of that holds for people. `profiles_read` is `can_i_view(id)`, so the
-- table is emphatically not world-readable, and the rows a search must *not* return
-- are the entire point rather than a hypothetical future policy.
--
-- The naive version is `select ... from public_profiles where username ilike '%q%'`
-- straight from the client. `public_profiles` is `security_invoker`, so RLS does
-- apply and that is very nearly safe — which is exactly what makes it the dangerous
-- option. It puts the shape of the query in the client, where the next change to it
-- is one nobody reviews, and it offers no place to bound the result set, order it, or
-- refuse an empty query. So this is a definer function that applies
-- `can_view_profile` explicitly, per row, the way `public_notes` does.
--
-- Definer, and therefore the rule from 20260813001900 applies: it takes no viewer.
-- The only perspective it can answer from is `auth.uid()`'s own.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT DISCOVERABLE
--
-- `can_view_profile(auth.uid(), p.id)` is the filter, and it is the same predicate
-- every other read in this schema uses. What that means concretely, stated so the
-- behaviour is a decision rather than a discovery:
--
--   public + active          found by anyone signed in
--   suspended or deactivated found by nobody, including people who follow them
--   blocked, either way      found by neither party
--   private, not followed    **not found**
--   private, followed        found, because the follower may already view them
--   the caller themselves    found, and not specially excluded — searching your own
--                            handle and getting nothing would read as a bug, and the
--                            client is what decides not to draw a "Follow yourself"
--                            control
--
-- The private case is the one worth being explicit about, because it is a product
-- decision the schema already made and this function only inherits. A private account
-- is undiscoverable by name in Bingd; it is reached by holding its id, which in
-- practice means an invite link (api.md §7). `follow` (20260817000200) is deliberately
-- built to accept an id this function will never return, which is what keeps the
-- pending-request flow reachable without making private accounts searchable.
--
-- ---------------------------------------------------------------------------
-- MATCHING
--
-- The founder asked for username/handle and display name, case-insensitive, prefix,
-- "mild fuzziness — using what the database already offers. No new search
-- infrastructure."
--
-- So: no tsvector, no generated column, no GIN index. `profiles` is small — one row
-- per account, against a catalogue of millions of titles — and the ordering below is
-- what a person actually wants. `media_fold` is reused for the case and accent fold,
-- because it is already IMMUTABLE and already the thing both sides of title search
-- agree on; a second fold would be a second set of rules to keep in step.
--
-- The match is a substring rather than a prefix. "burton" should find "tim_burton",
-- and a handle is often somebody's surname with a first name in front of it. A
-- substring scan over one row per account is cheap; the same choice on `media_items`
-- would not be, which is why title search is built the other way.
--
-- The ordering is four tiers, and each exists because of a case the tier above gets
-- wrong:
--
--   1. exact handle          typing somebody's whole handle means them, always
--   2. handle prefix         "an" should offer "anna" before "deanna"
--   3. display-name prefix   the same rule for the name people actually read
--   4. handle, then id       total, so paging cannot lie
--
-- Deliberately absent: any popularity, follower-count or mutual-follow ordering.
-- Ranking people by how many followers they have is a product decision nobody made,
-- and ordering by mutuals would leak the shape of the caller's graph into a list they
-- can screenshot.
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
     and p.status = 'active'
     and (media_fold(p.username::text) like '%' || f.text || '%'
          or media_fold(coalesce(p.display_name, '')) like '%' || f.text || '%')
     -- AD-5, from the caller's own perspective. One predicate covering suspension,
     -- blocks in either direction, private accounts, and approved follows.
     and can_view_profile(auth.uid(), p.id)
   order by (media_fold(p.username::text) = f.text) desc,
            starts_with(media_fold(p.username::text), f.text) desc,
            starts_with(media_fold(coalesce(p.display_name, '')), f.text) desc,
            p.username,
            p.id
   -- Ten by default. A Users section inside All is a handful of rows under the films,
   -- not a page of its own; the Users tab asks for more.
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function search_users(text, integer) is
  'People search by handle or display name, folded for case and accents with media_fold. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Filters every row through can_view_profile, so a suspended, blocked or unfollowed-private account is absent rather than hidden -- and a private account is therefore not discoverable by name at all, which is the existing product rule rather than a new one. Refuses a blank query.';

-- `like` with a leading wildcard cannot use a btree index, and this deliberately does
-- not add one: `profiles` holds one row per account and the fold would need an
-- expression index per column to help at all. Stated so that the absence reads as a
-- measurement rather than an omission -- if the account table ever reaches a size
-- where this matters, the fix is `pg_trgm`, which is the extension `20260814040000`
-- explains the harness cannot load.

grant execute on function search_users(text, integer) to authenticated;
