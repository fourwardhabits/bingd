-- A block removes a rating from the community score, and public_notes gains a
-- cardinality bound.
-- Found by: independent review of 20260816000000, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- Why the block belongs in the aggregate
--
-- 20260816000000 restricted `community_score` to public, active accounts, and
-- argued that this closes the subtraction channel: a viewer can already read every
-- public account's `rankings` rows and count their bands, so every individual score
-- folded into the mean is one the viewer could compute anyway, and the aggregate
-- discloses nothing new.
--
-- That argument is sound and it has a hole in it. `rankings_read` authorises through
-- `can_i_view`, which returns false across a block in either direction. So a rater
-- who has blocked the viewer is *not* an account the viewer can read individually —
-- but it was still an account the mean included. Three raters, one of whom has
-- blocked the viewer: read the other two, derive their scores, multiply the mean by
-- the count, subtract. The blocked user's rating comes out exactly.
--
-- The population therefore has to be the accounts the caller could read one by one,
-- which means the block belongs in the filter beside visibility and status.
--
-- The cost is that the number becomes viewer-dependent: two people can see different
-- community scores for the same title. That is already true of every other social
-- surface in the schema — a block hides its parties from each other's feed,
-- leaderboard and match surfaces (PRD §22) — so an aggregate that ignored it would
-- be the inconsistent thing rather than the consistent one.
--
-- `blocked_between` rather than `can_view_profile`: the visibility and status
-- conditions are already expressed as joins the planner can use, and the remaining
-- question is only about the pair. It is server-side only and revoked from clients,
-- which is fine here — a definer function executes as its owner.
-- ---------------------------------------------------------------------------

create or replace function community_score(p_media_item_id uuid)
returns table (
  score        numeric,
  rating_count integer,
  min_ratings  integer
)
language sql stable security definer
set search_path = public
as $$
  with threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'score.community_min_ratings'),
      3
    ) as k
  ),
  rated as (
    select
      round(avg(score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)), 1) as avg_score,
      count(*)::integer as n
      from rankings r
      join profiles p
        on p.id = r.user_id
       and p.visibility = 'public'
       and p.status = 'active'
      join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
     where r.media_item_id = p_media_item_id
       -- Null caller: nobody has blocked anybody, so the whole public population
       -- counts. blocked_between short-circuits on a null argument anyway; stated
       -- because the anon case is the one a reader will wonder about.
       and (auth.uid() is null or not blocked_between(p.id, auth.uid()))
  )
  select case when rated.n >= threshold.k then rated.avg_score end,
         rated.n,
         threshold.k
    from rated, threshold;
$$;

comment on function community_score(uuid) is
  'The mean canonical score for exactly one media item, over the public active accounts the caller could also read individually, with the sample size. Null score below app_config score.community_min_ratings. Excludes accounts blocked in either direction, because rankings_read already hides those rows and including them in the mean makes a blocked user''s rating recoverable by subtraction.';

-- ---------------------------------------------------------------------------
-- A bound on how much public_notes will answer at once
--
-- The required-filter check stops the function being "every note in the database",
-- which was its job. It does not stop a caller passing two thousand profile ids in
-- one array, and profile ids are readable from `public_profiles`.
--
-- This is abuse control rather than a privacy fix: every row it would return is a
-- public note on a profile the caller may view, so nothing here is a disclosure that
-- the screens do not already make. What the cap buys is that the function's cost is
-- bounded by the shape of a screen rather than by the caller's imagination, and that
-- a client hitting the limit fails loudly instead of silently receiving a truncated
-- answer it believes is complete.
--
-- Fifty is well above what any surface asks for: the feed reads thirty events, a
-- title page reads one title, a profile reads one author.
--
-- Deliberately not attempted here: rate limiting reads. The one limiter in the
-- schema, `report.max_per_day`, counts rows in a table the write itself creates.
-- A read leaves nothing to count, so a limiter would need its own storage and its
-- own eviction, and that is infrastructure rather than a fix. Recorded rather than
-- half-built.
-- ---------------------------------------------------------------------------

create or replace function public_notes(
  p_user_ids       uuid[] default null,
  p_media_item_ids uuid[] default null,
  p_limit          integer default 50
)
returns table (
  user_id       uuid,
  media_item_id uuid,
  note          text,
  has_spoilers  boolean,
  updated_at    timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_user_ids is null and p_media_item_ids is null then
    raise exception 'public_notes requires a user or a title filter'
      using errcode = '22023';
  end if;

  if coalesce(array_length(p_user_ids, 1), 0) > 50
     or coalesce(array_length(p_media_item_ids, 1), 0) > 50 then
    raise exception 'public_notes accepts at most 50 ids per filter'
      using errcode = '22023';
  end if;

  return query
    select um.user_id,
           um.media_item_id,
           um.note,
           um.note_has_spoilers,
           um.note_updated_at
      from user_media um
     where um.note is not null
       and um.note_visibility = 'public'
       and (p_user_ids is null       or um.user_id       = any (p_user_ids))
       and (p_media_item_ids is null or um.media_item_id = any (p_media_item_ids))
       -- AD-5, from the caller's own perspective. Covers suspension, blocks,
       -- private accounts and approved follows in one place.
       and can_view_profile(auth.uid(), um.user_id)
     order by um.note_updated_at desc nulls last
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

comment on function public_notes(uuid[], uuid[], integer) is
  'Public notes for a set of authors, a set of titles, or both. The only cross-user read path for note text. Projects the note columns alone, because the row it comes from also carries the watch date, which PRD §22 keeps private at every visibility level. Refuses an unfiltered call, and refuses more than fifty ids per filter.';

-- create or replace preserves privileges, but stating them costs nothing and means
-- a reader does not have to know that rule to know these are still reachable.
grant execute on function public_notes(uuid[], uuid[], integer) to authenticated;
grant execute on function community_score(uuid)                 to authenticated;
