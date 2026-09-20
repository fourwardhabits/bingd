-- The score a feed row shows is the one its owner holds now.
--
-- Specification: founder report, 2026-09-19 -- "rank a movie, look at the Feed, rerank it,
-- look again: the Feed still shows the first score". Pre-release behavioural contract
-- audit, section 4: an activity row's HISTORICAL facts are who acted, what they did and
-- when; its score badge is a claim about CURRENT state and must read as one.
--
-- ===========================================================================
-- WHAT WAS WRONG, AND WHY THE REPORT UNDERSTATES IT
--
-- `_rank_finalize` snapshots the derived score into `feed_events.payload` and the client
-- renders that snapshot (`20260815010000`; `src/features/feed/use-feed.ts`). Two facts
-- turn that into a badge that is wrong most of the time rather than occasionally:
--
--   1. **A correction posts no event.** Since `20260826000500` a re-placement that is not
--      an explicit rewatch writes no `title_ranked` row, and `20261001000100` confirmed
--      that as the rule: *Update your rating* is a correction, not a watch. So there is no
--      new payload, and the old one is what the Feed keeps drawing. That is the report.
--
--   2. **A score is band-relative, so every ranking re-scores its whole band.**
--      `score_for(bucket, band_rank, band_size)` interpolates a rank across the band's
--      range, and inserting one title changes `band_size` for every other title in it
--      (`src/features/collection/score.ts` states this as the reason the score is never
--      stored). So ranking *anything* silently invalidates the snapshot on every earlier
--      `title_ranked` row in that band. The reporter found the loud case; the quiet one is
--      every feed row older than the reader's last ranking.
--
-- `20260815010000`'s header argued the other way and is reversed here. It said two things:
--
--   * "A snapshot is also more correct here... the feed shows the moment." The founder's
--     decision is that it is not: the badge carries no date, sits beside a note that is
--     read live precisely so its author can correct it, and a reader takes it to mean
--     "what this person thinks of this film". Score-at-the-time is a placement-history
--     fact and belongs to the T2 ledger that Watch History will add, not to a badge with
--     no temporal framing on it.
--
--   * "`rankings` is scoped to its owner by RLS, so a client reading a friend's activity
--     has no way to compute the number." **This was already untrue when it was written.**
--     `20260813001900` had made `rankings_read` `can_i_view(user_id)` two days earlier --
--     the same predicate `feed_events_read` uses. A viewer who may see the activity may
--     see the ranking behind it; what they cannot cheaply do is count the band.
--
-- ===========================================================================
-- WHAT THIS ADDS
--
-- One `stable` function that scores a set of (person, title) pairs the way the rest of the
-- schema already does, so a page of the Feed can hydrate its badges in one round trip
-- beside the notes, the companions and the comment counts it already reads that way.
--
-- **Security definer, with `public_notes`' own predicate, and the first draft was wrong
-- about this.** The tempting shape is invoker: `rankings_read` is `can_i_view(user_id)`
-- and `feed_events_read` is `can_i_view(actor_id)`, identical predicates, so RLS alone
-- would admit exactly the pairs a caller may already draw activity for. It does not work,
-- and the reason is worth keeping: a score needs a *band count*, `band_bounds` is an
-- internal helper that `20260813001800` revokes from every client role, and an invoker
-- function cannot call what its caller may not execute. Granting `band_bounds` to
-- `authenticated` to make it work would hand every client an oracle over anybody's band
-- sizes, which is a far larger disclosure than the one number this returns.
--
-- So it is definer, and it states the visibility rule the same way its neighbour does:
-- `can_view_profile(auth.uid(), r.user_id)`, which is `public_notes`' line verbatim and
-- folds suspension, blocks, private accounts and approved follows into one answer. The
-- band is then counted as the owner sees it, which is the only count that produces the
-- number the owner is actually looking at in their own Collection.
--
-- **`band_bounds` and `score_for` rather than a fourth implementation.** There are three
-- derivations of this number already -- `score.ts` for the Collection, `score_for` for
-- `_rank_finalize`, and `title_reviews_v2`, which has read the live rankings since
-- `20260825000100` for exactly the reason stated here ("the feed event's snapshot, which
-- drifts"). A fourth that disagreed in one edge case would be the same class of defect
-- this migration closes, so this composes the two that exist.
--
-- **One `band_bounds` per distinct (person, category, band) on the page**, not one per
-- row: a page of twenty activities is typically two or three people in one band each, and
-- the lateral is over the DISTINCT triples for that reason. Each call is one index scan of
-- `rankings_lookup (user_id, category, position)`.
--
-- ===========================================================================
-- WHAT DELIBERATELY DOES NOT CHANGE
--
--   * `_rank_finalize` is not rebuilt. It still writes the snapshot, and the snapshot is
--     still what an older bundle draws and what a client falls back to when this read
--     fails. Removing it would break every already-installed copy of the app.
--   * No feed event is created, deleted or re-timed. A correction still posts nothing.
--   * Nothing here widens what anybody may read: every row it returns is a row the caller
--     could already have selected from `rankings` directly.
--   * A pair with no ranking returns no row. That is the unranked-but-still-logged case
--     (`rank_unrank` leaves the activity standing, `20260818000100` §"deliberately not
--     touched"), and a reader that asked and was told nothing shows no badge rather than
--     a number its owner no longer holds.
-- ===========================================================================


create or replace function public_scores(
  p_user_ids       uuid[],
  p_media_item_ids uuid[]
)
returns table (
  user_id       uuid,
  media_item_id uuid,
  category      ranking_category,
  bucket        taste_bucket,
  -- Quoted, because `position` is a reserved word and a bare one in a RETURNS TABLE list
  -- is a syntax error. Quoted rather than renamed: the column the caller reads should be
  -- called what it is called everywhere else in the schema.
  "position"    integer,
  score         numeric
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  -- Both filters required, and both bounded. The same contract `public_notes` states:
  -- this is a cross-product of two sets, so an unfiltered call is a request for one
  -- person's whole ranking or one title's whole audience, and neither is what any caller
  -- wants. Fifty is far above a page of activity, which is twenty.
  if p_user_ids is null or p_media_item_ids is null then
    raise exception 'public_scores requires a user filter and a title filter'
      using errcode = '22023';
  end if;

  if coalesce(array_length(p_user_ids, 1), 0) > 50
     or coalesce(array_length(p_media_item_ids, 1), 0) > 50 then
    raise exception 'public_scores accepts at most 50 ids per filter'
      using errcode = '22023';
  end if;

  return query
    with wanted as (
      -- The pairs themselves, on the primary key `(user_id, media_item_id)`, filtered by
      -- AD-5 from the caller's own perspective -- `public_notes`' line verbatim. A pair
      -- that was never ranked contributes nothing either, which is what makes an
      -- unranked-but-still-logged title answer "no score" rather than an old one.
      select r.user_id, r.media_item_id, r.category, r.bucket, r.position
        from rankings r
       where r.user_id       = any (p_user_ids)
         and r.media_item_id = any (p_media_item_ids)
         and can_view_profile(auth.uid(), r.user_id)
    ),
    bands as (
      -- One count per band actually named by the page -- and only for bands whose owner
      -- the caller was already admitted to above, because `wanted` is what this reads
      -- from. A band the caller may not see produces no row here and therefore no score;
      -- a band they may see is counted whole, which is the count its owner sees in their
      -- own Collection and so the number they are actually looking at.
      select d.user_id, d.category, d.bucket, bb.lo, bb.size
        from (select distinct w.user_id, w.category, w.bucket from wanted w) d
        cross join lateral band_bounds(d.user_id, d.category, d.bucket) bb
    )
    select w.user_id,
           w.media_item_id,
           w.category,
           w.bucket,
           w.position,
           -- The band-relative rank, exactly as `_rank_finalize` computes it: absolute
           -- position less the band's first position, one-based.
           score_for(w.bucket, (w.position - b.lo + 1)::integer, b.size)
      from wanted w
      join bands b
        on b.user_id  = w.user_id
       and b.category = w.category
       and b.bucket   = w.bucket;
end;
$$;

comment on function public_scores(uuid[], uuid[]) is
  'The CURRENT 0-10 score, band and position for a set of (person, title) pairs -- the cross-user read the activity surfaces use to draw a score badge that means what its owner rates the title now, rather than the feed_events.payload snapshot of what they rated it at the moment they placed it (20260815010000), which drifts every time they rank anything else in that band. Security definer over can_view_profile(auth.uid(), user_id) -- public_notes'' predicate verbatim, and definer rather than invoker only because band_bounds is an internal helper no client role may execute; the pairs it admits are exactly the pairs rankings_read would have admitted, which is the same predicate feed_events_read applies to the activity the caller is drawing, so this widens nothing. Derives through band_bounds and score_for rather than restating the formula. Refuses an unfiltered call and more than fifty ids per filter, like public_notes. A pair with no ranking returns no row.';

-- create or replace preserves privileges on an existing function; this one is new, so the
-- grant is what makes it reachable at all.
grant execute on function public_scores(uuid[], uuid[]) to authenticated;
