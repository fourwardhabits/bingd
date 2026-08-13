-- The ranking engine.
-- Specification: docs/architecture/ranking.md · PRD §10, §11
--
-- Invariants held for every (user_id, category) pair outside a transaction:
--
--   I1  positions are exactly 1..n, no gaps, no duplicates
--   I2  every 'loved' position precedes every 'fine', which precedes every
--       'not_for_me'
--   I3  every rankings row has a matching user_media row with the same bucket
--   I4  no two titles share a position
--
-- I1 and I2 cannot be expressed as constraints. They hold because every write
-- goes through the functions in this file (AD-4), and because
-- assert_ranking_valid() checks them in tests and on a schedule.

-- ---------------------------------------------------------------------------
-- Bands (ranking.md §1)
--
-- A band is the contiguous run of positions belonging to one bucket. Boundaries
-- are derived, never stored, so there is no second source of truth to drift out
-- of step with the rows themselves.
--
-- An empty band returns lo > hi with size 0, which the insertion routine handles
-- as the trivial case.
-- ---------------------------------------------------------------------------

create or replace function band_bounds(
  target uuid, cat ranking_category, b taste_bucket
) returns table (lo integer, hi integer, size integer)
language sql stable
set search_path = public
as $$
  with counts as (
    select
      count(*) filter (where bucket = 'loved')      as loved,
      count(*) filter (where bucket = 'fine')       as fine,
      count(*) filter (where bucket = 'not_for_me') as nfm
    from rankings where user_id = target and category = cat
  )
  select
    (case b when 'loved' then 1
            when 'fine'  then loved + 1
            else              loved + fine + 1 end)::integer,
    (case b when 'loved' then loved
            when 'fine'  then loved + fine
            else              loved + fine + nfm end)::integer,
    (case b when 'loved' then loved
            when 'fine'  then fine
            else              nfm end)::integer
  from counts;
$$;

-- ---------------------------------------------------------------------------
-- Validation (ranking.md §8)
--
-- Called after every mutation in tests, and by a scheduled job across all users
-- in nonprod. The I2 check catches out-of-order bands and interleaving alike,
-- because any backward step in bucket order fails it.
-- ---------------------------------------------------------------------------

create or replace function assert_ranking_valid(target uuid, cat ranking_category)
returns void
language plpgsql
set search_path = public
as $$
declare
  bad integer;
begin
  -- I1: positions are exactly 1..n
  select count(*) into bad from (
    select position, row_number() over (order by position) as expected
      from rankings where user_id = target and category = cat
  ) t where t.position <> t.expected;

  if bad > 0 then
    raise exception 'ranking has % gap or duplicate positions', bad;
  end if;

  -- I2: bands are contiguous and correctly ordered
  select count(*) into bad from (
    select bucket, position, lag(bucket) over (order by position) as prev
      from rankings where user_id = target and category = cat
  ) t
  where t.prev is not null and t.prev <> t.bucket
    and array_position(array['loved','fine','not_for_me']::taste_bucket[], t.bucket)
      < array_position(array['loved','fine','not_for_me']::taste_bucket[], t.prev);

  if bad > 0 then
    raise exception 'band ordering violated at % boundaries', bad;
  end if;

  -- I3: every ranked title is also logged, with the same bucket
  select count(*) into bad
    from rankings r
    left join user_media um
      on um.user_id = r.user_id and um.media_item_id = r.media_item_id
   where r.user_id = target and r.category = cat
     and (um.media_item_id is null or um.bucket is distinct from r.bucket);

  if bad > 0 then
    raise exception '% ranked titles lack a matching logged row with the same bucket', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal: the pivot title at a given position
-- ---------------------------------------------------------------------------

create or replace function _rank_pivot_at(
  target uuid, cat ranking_category, pos integer
) returns uuid
language sql stable
set search_path = public
as $$
  select media_item_id from rankings
   where user_id = target and category = cat and position = pos;
$$;

-- ---------------------------------------------------------------------------
-- Internal: finalize an insertion (ranking.md §6)
--
-- The advisory lock removes a race that would otherwise be real but almost never
-- reproducible: two sessions finalizing at once for the same user interleave
-- their shifts and corrupt I1. Ranking is a deliberate single-device act, so
-- contention is close to nonexistent — which is exactly the kind of bug that
-- surfaces once and is never seen again. The lock costs nothing.
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
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- 1. Open the slot. This transiently duplicates a position, which is why the
  --    unique constraint is deferrable initially deferred.
  update rankings
     set position = position + 1
   where user_id = target and category = cat and position >= pos;

  -- 2. Fill it.
  insert into rankings (user_id, media_item_id, category, bucket, position)
  values (target, item, cat, b, pos);

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  -- The position is denormalized into the payload so the feed shows what was
  -- true when it happened (data-model.md §6).
  insert into feed_events (actor_id, type, media_item_id, payload)
  values (
    target,
    'title_ranked',
    item,
    jsonb_build_object('position', pos, 'bucket', b, 'category', cat)
  );

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'adjustable', was_adjusted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_start(media_item_id, bucket) -> { session_id, pivot } | { position }
-- (ranking.md §3)
-- ---------------------------------------------------------------------------

create or replace function rank_start(p_media_item_id uuid, p_bucket taste_bucket)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_kind     media_kind;
  v_cat      ranking_category;
  v_band     record;
  v_existing record;
  v_session  uuid;
  v_pivot    integer;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select kind into v_kind from media_items where id = p_media_item_id;
  if v_kind is null then
    raise exception 'unknown media item' using errcode = 'P0002';
  end if;

  v_cat := rankable_category(v_kind);
  if v_cat is null then
    -- PRD §10 forbids ranking a whole series. Seasons are the unit.
    raise exception 'a series cannot be ranked; rank its seasons'
      using errcode = '22023';
  end if;

  -- Step 2 is the structural expression of PRD §11: bucketing and ranking are
  -- separate acts, and abandoning the second does not undo the first. The title
  -- is Logged from here on, whatever happens next, so the recommendation engine
  -- can still use the bucket.
  insert into user_media (user_id, media_item_id, bucket)
  values (v_user, p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id)
    do update set bucket = excluded.bucket, updated_at = now();

  -- Already ranked? Changing a bucket is a different operation (rank_rebucket).
  if exists (select 1 from rankings
              where user_id = v_user and media_item_id = p_media_item_id) then
    raise exception 'title is already ranked; use rank_rebucket to move it'
      using errcode = '23505';
  end if;

  -- Resume rather than restart, per the unique constraint on the session table.
  select id, lo, hi into v_existing
    from ranking_sessions
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_existing.id is not null then
    return jsonb_build_object(
      'done', false,
      'session_id', v_existing.id,
      'pivot', _rank_pivot_at(v_user, v_cat, (v_existing.lo + v_existing.hi) / 2),
      'resumed', true
    );
  end if;

  select * into v_band from band_bounds(v_user, v_cat, p_bucket);

  -- An empty band inserts directly. No comparison is asked, because there is
  -- nothing to compare against.
  if v_band.size = 0 then
    return _rank_finalize(v_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null);
  end if;

  -- hi starts at band.hi + 1 because the new title may belong after every
  -- existing member: the range of possible insertion points has one more element
  -- than the band has members.
  insert into ranking_sessions (user_id, media_item_id, category, bucket, lo, hi)
  values (v_user, p_media_item_id, v_cat, p_bucket, v_band.lo, v_band.hi + 1)
  returning id into v_session;

  v_pivot := (v_band.lo + v_band.hi + 1) / 2;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', _rank_pivot_at(v_user, v_cat, v_pivot),
    'resumed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_answer(session_id, winner) -> { pivot } | { position }
-- (ranking.md §4)
-- ---------------------------------------------------------------------------

create or replace function rank_answer(p_session_id uuid, p_winner uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_s     record;
  v_pivot_pos  integer;
  v_pivot_item uuid;
  v_new_lo integer;
  v_new_hi integer;
begin
  select * into v_s from ranking_sessions
   where id = p_session_id and user_id = v_user;

  if v_s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  v_pivot_pos  := (v_s.lo + v_s.hi) / 2;
  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_pivot_pos);

  if p_winner <> v_s.media_item_id and p_winner <> v_pivot_item then
    raise exception 'winner must be one of the two titles being compared'
      using errcode = '22023';
  end if;

  if p_winner = v_s.media_item_id then
    -- The new title ranks above the pivot.
    v_new_lo := v_s.lo;
    v_new_hi := v_pivot_pos;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_s.media_item_id, v_pivot_item);
  else
    v_new_lo := v_pivot_pos + 1;
    v_new_hi := v_s.hi;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_pivot_item, v_s.media_item_id);
  end if;

  if v_new_lo = v_new_hi then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket, v_new_lo, v_s.id
    );
  end if;

  -- history is a stack of prior (lo, hi, pivot) states, which is what makes Back
  -- work.
  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_pivot_pos
         ),
         updated_at = now()
   where id = v_s.id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.id,
    'pivot', _rank_pivot_at(v_user, v_s.category, (v_new_lo + v_new_hi) / 2)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_skip(session_id) (ranking.md §5)
--
-- Re-anchors to a different pivot without narrowing the range. The replacement
-- steps outward from the midpoint — mid+1, mid-1, mid+2 — rather than being
-- chosen randomly, which keeps the remaining search near-balanced so a skip
-- costs little.
--
-- After the configured skip limit the title is placed at the midpoint of the
-- surviving range and the response carries adjustable: true. That flag comes
-- from the server so PRD §10's "you can change this from Rankings" message
-- cannot appear in the wrong circumstances.
-- ---------------------------------------------------------------------------

create or replace function rank_skip(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_s         record;
  v_max_skips integer;
  v_mid       integer;
  v_offset    integer := 1;
  v_candidate integer;
  v_pivot     integer := null;
begin
  select * into v_s from ranking_sessions
   where id = p_session_id and user_id = v_user;

  if v_s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  select coalesce((value)::integer, 3) into v_max_skips
    from app_config where key = 'ranking.max_skips';

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket, v_mid, v_s.id, true
    );
  end if;

  -- Step away from the midpoint, staying inside [lo, hi).
  while v_offset <= (v_s.hi - v_s.lo) loop
    v_candidate := v_mid + v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_pivot := v_candidate;
      exit;
    end if;
    v_candidate := v_mid - v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_pivot := v_candidate;
      exit;
    end if;
    v_offset := v_offset + 1;
  end loop;

  update ranking_sessions
     set skips = skips + 1, updated_at = now()
   where id = v_s.id;

  -- No alternative pivot exists, so the range is too narrow to re-anchor.
  if v_pivot is null then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket, v_mid, v_s.id, true
    );
  end if;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_pivot),
    'skipped', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_back(session_id) (ranking.md §5)
--
-- Back at the first comparison cancels the session and returns to the bucket
-- choice. The user_media bucket remains, so the title stays Logged.
-- ---------------------------------------------------------------------------

create or replace function rank_back(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_s    record;
  v_prev jsonb;
begin
  select * into v_s from ranking_sessions
   where id = p_session_id and user_id = v_user;

  if v_s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  if jsonb_array_length(v_s.history) = 0 then
    delete from ranking_sessions where id = v_s.id;
    return jsonb_build_object('done', false, 'cancelled', true);
  end if;

  v_prev := v_s.history -> -1;

  update ranking_sessions
     set lo = (v_prev ->> 'lo')::integer,
         hi = (v_prev ->> 'hi')::integer,
         history = v_s.history - (jsonb_array_length(v_s.history) - 1),
         skips = greatest(skips - 1, 0),
         updated_at = now()
   where id = v_s.id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.id,
    'pivot', _rank_pivot_at(v_user, v_s.category, (v_prev ->> 'pivot')::integer)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_unrank(media_item_id) (ranking.md §7)
--
-- Deletes the rankings row and closes the gap, leaving user_media intact. The
-- title reverts to Logged with its bucket: PRD §10 requires that reranking and
-- recalibration never delete viewing history.
-- ---------------------------------------------------------------------------

create or replace function rank_unrank(p_media_item_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_r    record;
begin
  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  delete from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  update rankings
     set position = position - 1
   where user_id = v_user and category = v_r.category and position > v_r.position;

  return jsonb_build_object('done', true, 'unranked', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_reorder(media_item_id, new_position) (ranking.md §7)
--
-- A drag that would cross a band boundary is refused, because crossing means the
-- bucket changed and that path re-runs comparisons instead of guessing.
-- ---------------------------------------------------------------------------

create or replace function rank_reorder(p_media_item_id uuid, p_new_position integer)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_r    record;
  v_band record;
begin
  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  select * into v_band from band_bounds(v_user, v_r.category, v_r.bucket);

  if p_new_position < v_band.lo or p_new_position > v_band.hi then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, v_r.bucket, v_band.lo, v_band.hi
      using errcode = '22023';
  end if;

  if p_new_position = v_r.position then
    return jsonb_build_object('done', true, 'position', v_r.position);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  if p_new_position < v_r.position then
    update rankings set position = position + 1
     where user_id = v_user and category = v_r.category
       and position >= p_new_position and position < v_r.position;
  else
    update rankings set position = position - 1
     where user_id = v_user and category = v_r.category
       and position > v_r.position and position <= p_new_position;
  end if;

  update rankings set position = p_new_position
   where user_id = v_user and media_item_id = p_media_item_id;

  return jsonb_build_object('done', true, 'position', p_new_position);
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_rebucket(media_item_id, bucket) (ranking.md §7)
--
-- Removal followed by a fresh insertion session in the new band. PRD §10
-- requires that changing a bucket re-runs comparisons, so the title genuinely
-- re-enters comparison rather than being dropped at an estimated position.
--
-- Band bounds are recomputed *after* the removal. Computing them before places
-- the title one position off whenever it moves from a higher band to a lower
-- one, which is the easy mistake here.
-- ---------------------------------------------------------------------------

create or replace function rank_rebucket(p_media_item_id uuid, p_bucket taste_bucket)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_r    record;
begin
  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  if v_r.bucket = p_bucket then
    raise exception 'title is already in that bucket' using errcode = '22023';
  end if;

  perform rank_unrank(p_media_item_id);

  update user_media set bucket = p_bucket, updated_at = now()
   where user_id = v_user and media_item_id = p_media_item_id;

  return rank_start(p_media_item_id, p_bucket);
end;
$$;

-- ---------------------------------------------------------------------------
-- The unranked queue (ranking.md §10)
--
-- Highest bucket first. Whether the prompt appears is a client decision based on
-- the ranked count, not a server one: the endpoint always answers honestly, and
-- the interface decides whether to ask. That keeps PRD §11's "never imply the
-- collection is incomplete" rule in the layer that renders copy.
-- ---------------------------------------------------------------------------

create or replace function unranked_queue(p_limit integer default 5)
returns table (media_item_id uuid, bucket taste_bucket)
language sql stable security definer
set search_path = public
as $$
  select um.media_item_id, um.bucket
    from user_media um
    left join rankings r
      on r.user_id = um.user_id and r.media_item_id = um.media_item_id
   where um.user_id = auth.uid()
     and um.bucket is not null
     and r.media_item_id is null
   order by array_position(
     array['loved','fine','not_for_me']::taste_bucket[], um.bucket
   ), um.created_at
   limit least(greatest(p_limit, 1), 50);
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- Clients hold select on tables (mediated by RLS) and execute on the RPCs. There
-- is no client insert, update, or delete grant anywhere in the schema (AD-4).
-- ---------------------------------------------------------------------------

revoke all on function _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean) from public;
revoke all on function _rank_pivot_at(uuid, ranking_category, integer) from public;
