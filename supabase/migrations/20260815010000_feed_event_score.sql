-- ---------------------------------------------------------------------------
-- The derived score, snapshotted into feed_events.payload
--
-- PRD §10 was amended on 2026-08-15: the number a user sees is a 0-10 score
-- rather than an ordinal. The score is derived from position and band size and
-- is deliberately *not* stored -- see ranking.md §11 for why a generated column
-- would turn a single-row insert into a whole-band update.
--
-- The feed is the one place that cannot derive it. Scoring a title needs the
-- band sizes of the user who ranked it, and `rankings` is scoped to its owner
-- by RLS, so a client reading a friend's activity has no way to compute the
-- number. `_rank_finalize` already denormalizes `position` into the payload for
-- the same reason (ranking.md §6); the score joins it.
--
-- A snapshot is also more correct here than a live value would be. An activity
-- item records what happened, and what happened was that this title landed at
-- 8.7 -- not that it currently sits at 8.4 because two more films were ranked
-- above it last Tuesday. The collection shows the live score; the feed shows
-- the moment.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The derivation, in SQL
--
-- Kept identical to src/features/collection/score.ts. Two implementations of
-- one formula is a real cost, and the alternative -- computing the score
-- client-side at finalize and passing it in -- is worse: it would let a
-- modified client write any number it liked into a feed item other people read.
--
-- The bands are closed and non-overlapping, so a bucket is always recoverable
-- from a score.
-- ---------------------------------------------------------------------------

create or replace function score_for(
  b         taste_bucket,
  band_rank integer,   -- 1-based rank within the band
  band_size integer
) returns numeric
language sql immutable
set search_path = public
as $$
  with band as (
    select
      case b when 'loved' then 10.0 when 'fine' then 6.9 else 3.4 end as high,
      case b when 'loved' then  7.0 when 'fine' then 3.5 else 0.0 end as low
  )
  select round(
    case
      -- A band of one scores its high, not its midpoint: the first title you
      -- ever call 'Loved it' is, at that moment, the best thing in your list.
      -- This branch is also what keeps the divisor below off zero.
      when band_size <= 1 or band_rank <= 1 then high
      when band_rank >= band_size           then low
      else high - (band_rank - 1) * (high - low) / (band_size - 1)
    end,
    1
  )
  from band;
$$;

comment on function score_for is
  'The 0-10 display score for a title at band_rank of band_size within bucket b. '
  'Derived, never stored. Mirrors src/features/collection/score.ts. PRD §10.';

-- ---------------------------------------------------------------------------
-- 2. _rank_finalize writes it
--
-- Recreated in full rather than patched, because a plpgsql body cannot be
-- amended in place. Everything outside the payload is carried forward verbatim
-- from 20260813001600 §2 -- the advisory lock, the band-bounds revalidation,
-- the position shift, the session delete.
--
-- Ordering matters and is easy to get wrong: `v_band` is read *before* the
-- insert, so `v_band.size` is the size the band had a moment ago. The title
-- being placed is not in it yet. The size the score needs is the one *after*
-- the insert, hence `+ 1`.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_band  record;
  v_size  integer;
  v_rank  integer;
  v_score numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw.
  select * into v_band from band_bounds(target, cat, b);

  -- Valid insertion points run from the top of the band to one past its end. An
  -- empty band yields hi = lo - 1, so the only valid point is lo, which is what
  -- this reduces to.
  if pos < v_band.lo or pos > v_band.hi + 1 then
    raise exception
      'refusing to place a % title at position %, outside the % band (% to %)',
      b, pos, b, v_band.lo, v_band.hi + 1
      using errcode = '22023';
  end if;

  update rankings
     set position = position + 1
   where user_id = target and category = cat and position >= pos;

  insert into rankings (user_id, media_item_id, category, bucket, position)
  values (target, item, cat, b, pos);

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

  insert into feed_events (actor_id, type, media_item_id, payload)
  values (
    target,
    'title_ranked',
    item,
    jsonb_build_object(
      'position', pos,
      'bucket',   b,
      'category', cat,
      'score',    v_score
    )
  );

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Existing feed events
--
-- Backfilled from the position already in the payload rather than left null, so
-- the feed does not show a permanent gap where the alpha's first activity is.
--
-- The number is approximate and honestly so: it is computed against each band's
-- size *now*, not its size when the event fired, because the earlier size was
-- never recorded. That is the same reflow every live score undergoes, applied
-- once retroactively. Rows whose band no longer contains the title -- rebucketed
-- since, or unranked -- are left alone; a wrong score is worse than none.
-- ---------------------------------------------------------------------------

update feed_events fe
   set payload = fe.payload || jsonb_build_object(
         'score',
         score_for(
           r.bucket,
           (r.position - bb.lo + 1)::integer,
           bb.size
         )
       )
  from rankings r
  join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
 where fe.type = 'title_ranked'
   and fe.payload ? 'position'
   and not (fe.payload ? 'score')
   and r.user_id = fe.actor_id
   and r.media_item_id = fe.media_item_id;
