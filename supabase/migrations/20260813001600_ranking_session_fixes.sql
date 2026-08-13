-- Ranking session corrections.
-- Specification: docs/architecture/ranking.md §3–§6 · PRD §10, §11
--
-- Three defects found by independent review on 2026-08-13, each reproduced
-- against the real migrations before being fixed. Two of them corrupt a ranking
-- through ordinary documented use rather than through anything exotic.
--
-- They share a cause. A session stored `lo` and `hi` as **absolute positions**,
-- and a position is only meaningful relative to a ranking that is not moving.
-- The moment anything else changed — another title ranked, one unranked, one
-- rebucketed — the session was pointing at coordinates that no longer meant what
-- they meant when they were written.
--
-- So the bounds become **offsets within the band** instead. Offset 0 is the top
-- of the band wherever the band currently starts, and the absolute position is
-- derived at the moment it is needed rather than remembered from earlier. A band
-- that slides up or down no longer invalidates an open session, because nothing
-- about the session was expressed in terms that moved.

-- ---------------------------------------------------------------------------
-- 1. Skip showed a title the answer path then refused to accept
--
-- `rank_skip` picked an alternative pivot, returned that title to be compared,
-- and stored nothing. `rank_answer` recomputed the pivot from `(lo + hi) / 2`,
-- got the *original* midpoint back, and rejected the answer with "winner must be
-- one of the two titles being compared".
--
-- So skip was not merely imperfect, it was unusable: every skip led to a dead
-- end where the only displayed option was refused. It survived because no test
-- exercised skip followed by an answer — each covered one or the other.
--
-- The pivot is now stored, which also removes the assumption that the pivot is
-- always the midpoint. Nothing in the bisection requires that. Any pivot inside
-- [lo, hi) narrows the range correctly; the midpoint is merely the fastest
-- choice, and after a skip the whole point is to use a different one.
-- ---------------------------------------------------------------------------

alter table ranking_sessions add column pivot integer;

comment on column ranking_sessions.lo is
  'Offset within the bucket band, not an absolute position. 0 is the top of the band wherever the band currently begins.';
comment on column ranking_sessions.hi is
  'Exclusive upper offset. Equal to the band size at the start, because the title may belong after every existing member.';
comment on column ranking_sessions.pivot is
  'Offset of the title currently being compared against. Stored rather than derived, so that a skip can re-anchor to something other than the midpoint and still be answerable.';

-- ---------------------------------------------------------------------------
-- Internal: the live band, plus the session bounds clamped to fit it
--
-- Every entry point needs the same three lines, and getting them subtly
-- different in one of them is how this class of defect returns.
-- ---------------------------------------------------------------------------

create or replace function _rank_session_state(p_session_id uuid, p_user uuid)
returns table (
  session_id uuid,
  media_item_id uuid,
  category ranking_category,
  bucket taste_bucket,
  band_lo integer,
  band_size integer,
  lo integer,
  hi integer,
  pivot integer,
  skips smallint,
  history jsonb
)
language plpgsql stable
set search_path = public
as $$
declare
  s record;
  b record;
  v_hi integer;
  v_lo integer;
begin
  select * into s from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = p_user;

  if s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  select * into b from band_bounds(p_user, s.category, s.bucket);

  -- The band may have shrunk since the session opened, if titles were unranked
  -- or rebucketed away. Clamping is what keeps a stale upper bound from pointing
  -- past the end of the band and into the next one.
  v_hi := least(s.hi, b.size);
  v_lo := least(s.lo, v_hi);

  return query select
    s.id,
    s.media_item_id,
    s.category,
    s.bucket,
    b.lo,
    b.size,
    v_lo,
    v_hi,
    greatest(v_lo, least(coalesce(s.pivot, (v_lo + v_hi) / 2), greatest(v_hi - 1, v_lo))),
    s.skips,
    s.history;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A finalize could place a title outside its own band
--
-- With absolute bounds, ranking anything while a session was open moved the
-- target band without moving the session. Answering that session to completion
-- then inserted the title at a position belonging to a different bucket, which
-- is invariant I2 — every 'loved' precedes every 'fine' precedes every
-- 'not_for_me' — broken by following the interface exactly as designed.
--
-- Band-relative offsets remove the cause. This check stays as a backstop,
-- because I2 is not expressible as a constraint and a silent violation is
-- discovered weeks later by a user whose ranking is quietly wrong.
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
  v_band record;
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
-- 3. Resuming with a different bucket produced a title in two bands at once
--
-- `rank_start` upserts the logged bucket, then resumes any existing session for
-- the title. It never compared the two. So starting a session as 'loved',
-- abandoning it, and starting again as 'fine' left `user_media.bucket = 'fine'`
-- and a session still carrying 'loved' — and finalizing wrote a `rankings` row
-- with the stale bucket, which is invariant I3 broken.
--
-- That is not an exotic sequence. It is exactly what a user does when they
-- change their mind about a title halfway through placing it.
--
-- Changing your mind restarts the comparison rather than resuming it. The old
-- session is discarded: its comparisons were answered against a different band
-- and mean nothing in the new one.
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
  v_state    record;
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
    raise exception 'a series cannot be ranked; rank its seasons'
      using errcode = '22023';
  end if;

  insert into user_media (user_id, media_item_id, bucket)
  values (v_user, p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id)
    do update set bucket = excluded.bucket, updated_at = now();

  if exists (select 1 from rankings
              where user_id = v_user and media_item_id = p_media_item_id) then
    raise exception 'title is already ranked; use rank_rebucket to move it'
      using errcode = '23505';
  end if;

  select * into v_existing
    from ranking_sessions
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_existing.id is not null then
    if v_existing.bucket = p_bucket then
      select * into v_state from _rank_session_state(v_existing.id, v_user);
      return jsonb_build_object(
        'done', false,
        'session_id', v_state.session_id,
        'pivot', _rank_pivot_at(v_user, v_cat, v_state.band_lo + v_state.pivot),
        'resumed', true
      );
    end if;

    -- The bucket changed. Nothing answered in the old band transfers.
    delete from ranking_sessions where id = v_existing.id;
  end if;

  select * into v_band from band_bounds(v_user, v_cat, p_bucket);

  if v_band.size = 0 then
    return _rank_finalize(v_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null);
  end if;

  v_pivot := v_band.size / 2;

  insert into ranking_sessions (user_id, media_item_id, category, bucket, lo, hi, pivot)
  values (v_user, p_media_item_id, v_cat, p_bucket, 0, v_band.size, v_pivot)
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', _rank_pivot_at(v_user, v_cat, v_band.lo + v_pivot),
    'resumed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_answer, on stored offsets
-- ---------------------------------------------------------------------------

create or replace function rank_answer(p_session_id uuid, p_winner uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_s     record;
  v_pivot_item uuid;
  v_new_lo integer;
  v_new_hi integer;
  v_next   integer;
begin
  select * into v_s from _rank_session_state(p_session_id, v_user);

  -- The band can collapse under an open session if its other members are
  -- unranked. There is then nothing left to compare against.
  if v_s.lo >= v_s.hi then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.lo, v_s.session_id
    );
  end if;

  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot);

  if p_winner <> v_s.media_item_id and p_winner <> v_pivot_item then
    raise exception 'winner must be one of the two titles being compared'
      using errcode = '22023';
  end if;

  if p_winner = v_s.media_item_id then
    v_new_lo := v_s.lo;
    v_new_hi := v_s.pivot;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_s.media_item_id, v_pivot_item);
  else
    v_new_lo := v_s.pivot + 1;
    v_new_hi := v_s.hi;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_pivot_item, v_s.media_item_id);
  end if;

  if v_new_lo >= v_new_hi then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_new_lo, v_s.session_id
    );
  end if;

  v_next := (v_new_lo + v_new_hi) / 2;

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_next,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot
         ),
         updated_at = now()
   where id = v_s.session_id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_next)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_skip, now persisting what it displayed
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
  select * into v_s from _rank_session_state(p_session_id, v_user);

  select coalesce((value)::integer, 3) into v_max_skips
    from app_config where key = 'ranking.max_skips';

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
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

  if v_pivot is null then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    );
  end if;

  -- Persisting the pivot is the fix. Without it the answer path recomputed the
  -- midpoint and refused the title it had just displayed.
  update ranking_sessions
     set skips = skips + 1,
         pivot = v_pivot,
         updated_at = now()
   where id = v_s.session_id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_pivot),
    'skipped', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rank_back, restoring the pivot along with the range
--
-- Restoring lo and hi without the pivot would land the user on the midpoint
-- rather than on the comparison they actually saw, which is the same defect as
-- the skip one by a different route.
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
  select * into v_s from _rank_session_state(p_session_id, v_user);

  if jsonb_array_length(v_s.history) = 0 then
    delete from ranking_sessions where id = v_s.session_id;
    return jsonb_build_object('done', false, 'cancelled', true);
  end if;

  v_prev := v_s.history -> -1;

  update ranking_sessions
     set lo = (v_prev ->> 'lo')::integer,
         hi = (v_prev ->> 'hi')::integer,
         pivot = (v_prev ->> 'pivot')::integer,
         history = v_s.history - (jsonb_array_length(v_s.history) - 1),
         skips = greatest(skips - 1, 0),
         updated_at = now()
   where id = v_s.session_id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(
      v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer
    )
  );
end;
$$;

-- Internal, and therefore not reachable by a client. Same rule as the other
-- underscore-prefixed helpers (20260813001400 §2).
revoke execute on function _rank_session_state(uuid, uuid) from public, anon, authenticated;
