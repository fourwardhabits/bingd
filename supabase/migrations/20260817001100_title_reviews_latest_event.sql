-- The reaction-count fix, as a migration the deployed database can actually receive.
-- Specification: independent review 16 · founder acceptance corrections 2026-08-17.
--
-- ===========================================================================
-- WHY THIS FILE EXISTS AT ALL, WHICH IS THE ONLY INTERESTING THING ABOUT IT
--
-- Review 16 found that `title_reviews` summed reactions across **every** `title_ranked`
-- event a (user, title) pair had ever had. `_rank_finalize` writes a new event every
-- time a ranking completes — unranking, reranking and rebucketing all complete one, and
-- the old events and their reactions stay — so the count was a lifetime total that a
-- rebucket inflates permanently, and under `top` those stale reactions push a review
-- above one that earned its own.
--
-- **The fix was made by editing `20260817000800` in place, and that migration had
-- already been applied to bingd-nonprod.** `supabase db push` applies a migration once
-- and never looks at its contents again, so the corrected definition existed in the
-- repository, passed every local test — the local suite replays the file as it now
-- reads — and could not reach the one database anybody was using. The local test run is
-- structurally incapable of noticing: it builds its schema from the files, so an edit to
-- an applied file is indistinguishable from a new one.
--
-- That is the same class of gap the Phase E and F deployments hit twice (see
-- `20260817000700`), in a new costume: **the file is not the database.** An applied
-- migration is immutable in effect, and the only way to change what is deployed is a new
-- file. This is that file.
--
-- It is deliberately a verbatim copy of the definition `20260817000800` now holds rather
-- than a fresh attempt at it. `create or replace` in a schema with a history is how
-- `_assert_operation_rate` lost its advisory lock invisibly, and the protection against
-- repeating that is not care — it is copying the whole body rather than the part that
-- changed. Applying it to a database that already has the corrected function is a no-op,
-- which is what makes it safe to run without first establishing which version is out
-- there.
--
-- No grant is repeated: `execute` was granted to `authenticated` when the function was
-- created and `create or replace` does not disturb it.
-- ===========================================================================

create or replace function title_reviews(
  p_media_item_id uuid,
  p_sort          text default 'top',
  p_limit         integer default 25
)
returns table (
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  note           text,
  has_spoilers   boolean,
  updated_at     timestamptz,
  score          numeric,
  reaction_count integer
)
language sql stable security definer
set search_path = public
as $$
  select um.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         um.note,
         um.note_has_spoilers,
         um.note_updated_at,
         -- Null when they wrote a note without ranking it, which is a real state.
         (select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)
            from rankings r
            join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
           where r.user_id = um.user_id
             and r.media_item_id = um.media_item_id),
         reacted.n
    from user_media um
    join profiles p on p.id = um.user_id
    -- **The latest event, not every event.** Independent review 16, and it is a real
    -- defect rather than a nicety: `_rank_finalize` writes a *new* `title_ranked` row
    -- every time a ranking completes, and `rank_unrank`, reranking and rebucketing all
    -- complete one. The old rows stay, and so do the reactions on them. Summing across
    -- all of them is therefore not "the reaction count of the activity this note
    -- belongs to" -- it is a lifetime total that a rebucket can inflate, and under
    -- `top` those stale reactions push a review above one that earned its own.
    --
    -- One event, chosen by recency, which is the activity the note is attached to now.
    -- `id` breaks a tie so two events written in the same statement resolve the same
    -- way on every call.
    left join lateral (
      select fe.id
        from feed_events fe
       where fe.actor_id = um.user_id
         and fe.media_item_id = um.media_item_id
         and fe.type = 'title_ranked'
       order by fe.created_at desc, fe.id desc
       limit 1
    ) latest on true
    -- Computed once, in a join, rather than as a correlated subquery repeated in the
    -- select list and again in the order by. The repetition was only a cost, but a
    -- metric written twice is a metric that can disagree with itself after one edit.
    left join lateral (
      select count(*)::integer as n
        from reactions re
       where re.feed_event_id = latest.id
    ) reacted on true
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     -- The same predicate `public_notes` uses, and deliberately the same expression:
     -- suspension, blocks, private accounts and approved follows in one place.
     and can_view_profile(auth.uid(), um.user_id)
   order by
     case when p_sort = 'top' then coalesce(reacted.n, 0) end desc nulls last,
     um.note_updated_at desc nulls last,
     -- Stable, so two calls with the same data return the same order. Without it two
     -- unreacted notes with equal timestamps swap places and the list reorders under a
     -- reader who has not moved.
     um.user_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

comment on function title_reviews(uuid, text, integer) is
  'The Bingd Reviews tab for one title: every public Note on it the caller may read, with the author named, their live Bingd score, and how many people reacted to the activity it belongs to -- the *latest* title_ranked event for that pair, because reranking writes a new one and the old reactions stay behind. Not a second content model -- a review is a public Note, which is the same text the Feed shows. Reuses public_notes'' visibility predicate verbatim. Sorted by reactions then recency for `top`, recency alone for `recent`, with a stable tiebreak either way. The score is derived from live rankings rather than from the feed event''s snapshot, which drifts. Recreated unchanged by 20260817001100 because the correction was made by editing an already-applied migration, which no deployed database would ever have read.';
