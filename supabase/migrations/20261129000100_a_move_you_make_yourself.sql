-- ===========================================================================
-- A MOVE YOU MAKE YOURSELF (#318, Collection drag-to-rerank)
--
-- `docs/architecture/collection-rerank.md`. Depends on 20261004000100 (the placement ledger,
-- which revoked `rank_reorder`) and 20261114000300 (the live `_correction_follows_latest_watch`).
--
-- The founder's #318 brief supersedes the placement epic's §Q ("a drag-to-reorder UI is an
-- explicit non-goal"). 20261004000100 said what granting `rank_reorder` back would take --
-- "teach it to write a `manual` placement first" -- and that is this file:
--
--   1. `rank_reorder` writes one `ranking_placements` row of kind `manual` for every move, so
--      P1 ("every ranking has a placement explaining it") holds after a drag as after any
--      ranking. A refused or no-op move writes nothing.
--
--   2. Two optional guards against a drop computed from a stale list:
--        p_expected_position   the position the client saw the title at;
--        p_anchor_media_item_id the title the client saw at the target position.
--      Either mismatch refuses with 55000 before anything moves. Absent, the call behaves as
--      it always did. The band check (22023) and the operation claim (I5) are unchanged.
--
--   3. The reply names what the client needs to reconcile: the new and old position, the
--      band and its bounds, and the score before and after.
--
--   4. A `manual` placement brings the latest watch's EXISTING post up to date, exactly as a
--      `correction` does (20261016000100, the founder's canonical rule of 2026-09-21). It
--      never creates a post: the TV "update post" that 20261114000300 writes is
--      `_rank_finalize`'s, for a TV correction, and a move is not one.
--
-- What a move never writes: `comparisons`, `watch_events`, a `feed_events` insert, a
-- notification, `user_media`, or `rankings.created_at` (so streaks, Recently ranked and the
-- watchlist triggers -- all `after insert` -- do not hear a move as a ranking).
--
-- Rebuilt from its TRUE latest body, 20260825000200 (20261004000100 only revoked it and
-- commented it). The old three-argument form is dropped rather than overloaded, the rule
-- 20261114000300 followed: every existing two- and three-argument call resolves to the new
-- form through its defaults.
-- ===========================================================================

drop function if exists rank_reorder(uuid, integer, uuid);

create or replace function rank_reorder(
  p_media_item_id        uuid,
  p_new_position         integer,
  p_operation_id         uuid    default null,
  p_expected_position    integer default null,
  p_anchor_media_item_id uuid    default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_claim     record;
  v_r         record;
  v_band      record;
  v_anchor    uuid;
  v_cat_size  integer;
  v_from_rank integer;
  v_to_rank   integer;
  v_from      numeric;
  v_to        numeric;
  v_reply     jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  -- I5: a replay is recognised before anything else is acquired, and answered from the ledger.
  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_reorder');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', true, 'position', p_new_position));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  -- Media, then category: the §9 order. The band is read inside the category lock.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  -- **Re-read inside the category lock** (Codex, PR 319). The media lock protects this
  -- title from writers naming it, not from another title's move shifting it: while this
  -- transaction waited, a move of a neighbour may have committed and renumbered it. Under
  -- READ COMMITTED this statement takes a fresh snapshot, so the guards, the shift and the
  -- ledger's `from_*` all use where the title is now. Its category cannot have changed:
  -- that takes a writer naming this title, which the media lock excludes.
  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  -- #318: the list the drop was computed from is still the list. Checked inside the lock,
  -- before the band, because a stale position makes the band arithmetic below meaningless.
  if p_expected_position is not null and v_r.position <> p_expected_position then
    raise exception 'the ranking changed: this title is at % now, not %',
      v_r.position, p_expected_position
      using errcode = '55000';
  end if;

  select * into v_band from band_bounds(v_user, v_r.category, v_r.bucket);

  -- A drag that would cross a band boundary is refused, because crossing means the bucket
  -- changed and that path (Rerank) re-runs comparisons instead of guessing.
  if p_new_position < v_band.lo or p_new_position > v_band.hi then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, v_r.bucket, v_band.lo, v_band.hi
      using errcode = '22023';
  end if;

  if p_anchor_media_item_id is not null and p_new_position <> v_r.position then
    select r.media_item_id into v_anchor from rankings r
     where r.user_id = v_user and r.category = v_r.category and r.position = p_new_position;
    if v_anchor is distinct from p_anchor_media_item_id then
      raise exception 'the ranking changed: another title is at position % now', p_new_position
        using errcode = '55000';
    end if;
  end if;

  v_from_rank := v_r.position - v_band.lo + 1;
  v_from      := score_for(v_r.bucket, v_from_rank, v_band.size);

  -- A no-op is not a placement: it writes nothing and says so.
  if p_new_position = v_r.position then
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object(
        'done', true, 'moved', false,
        'position', v_r.position, 'from_position', v_r.position,
        'category', v_r.category, 'bucket', v_r.bucket,
        'band_lo', v_band.lo, 'band_size', v_band.size,
        'score', v_from, 'from_score', v_from
      )
    );
  end if;

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

  -- A move inside one band changes no band's size, so the bounds read above still hold.
  v_to_rank := p_new_position - v_band.lo + 1;
  v_to      := score_for(v_r.bucket, v_to_rank, v_band.size);

  select count(*)::integer into v_cat_size
    from rankings r where r.user_id = v_user and r.category = v_r.category;

  -- The ledger row (§E.1). `manual` has been in `placement_kind` since 20261004000100 for
  -- exactly this caller. No session, no comparisons, no watch: a move is none of those.
  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    from_bucket, from_position, from_score,
    strategy, tolerance, comparisons, skips, adjustable,
    watch_event_id, session_id, operation_id, linked_placement_id
  )
  values (
    v_user, p_media_item_id, v_r.category, 'manual', 'moved',
    v_r.bucket, p_new_position, v_to_rank, v_band.size, v_cat_size, v_to,
    v_r.bucket, v_r.position, v_from,
    null, 0, 0, 0, false,
    null, null, p_operation_id, null
  );

  v_reply := jsonb_build_object(
    'done', true, 'moved', true,
    'position', p_new_position, 'from_position', v_r.position,
    'category', v_r.category, 'bucket', v_r.bucket,
    'band_lo', v_band.lo, 'band_size', v_band.size,
    'score', v_to, 'from_score', v_from
  );

  return _record_operation_result(p_operation_id, v_reply);
end;
$$;

comment on function rank_reorder(uuid, integer, uuid, integer, uuid) is
  'Moves a ranked title within its own band (Collection drag-to-rerank, #318). A drag across '
  'a band boundary is refused (22023), because crossing means the bucket changed and that '
  'path re-runs comparisons. Optional guards refuse a move computed from a stale list (55000): '
  'the position the client saw, and the title it saw at the target. Every move writes one '
  'manual ranking_placements row; a no-op or a refusal writes nothing. Never writes a '
  'comparison, watch, feed post or notification. Granted back by 20261129000100.';

revoke execute on function rank_reorder(uuid, integer, uuid, integer, uuid) from public, anon;
grant  execute on function rank_reorder(uuid, integer, uuid, integer, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The latest watch follows a manual move, as it follows a correction
--
-- Copied from the live 20261114000300 body. One change: the TV skip applies to a
-- `correction` only. That skip exists because a TV correction that moved writes an update
-- post of its own carrying the new score; a `manual` move writes no post, so on TV as on
-- movies the latest watch's existing post is the one that follows it.
-- ---------------------------------------------------------------------------

create or replace function _correction_follows_latest_watch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_post uuid;
begin
  -- 20261114000300: the update post carries this correction's score; see above.
  -- 20261129000100: a correction only. A manual move writes no update post.
  if new.kind = 'correction'
     and new.category in ('tv_shows', 'tv_seasons')
     and new.outcome = 'moved'
     and new.linked_placement_id is null then
    return new;
  end if;

  v_post := _latest_watch_post(new.user_id, new.media_item_id);
  if v_post is null then
    return new;
  end if;

  -- Score, band, position and category together, as the rewatch enrichment writes them
  -- (20261005000100 §K): a post whose score and band disagree is internally inconsistent.
  -- No `from_*` and no outcome: the payload carries no movement.
  update feed_events
     set payload = payload || jsonb_build_object(
           'score',    new.score,
           'bucket',   new.bucket,
           'position', new.position,
           'category', new.category
         )
   where id = v_post;

  return new;
end;
$function$;

revoke execute on function _correction_follows_latest_watch() from public, anon, authenticated;

drop trigger if exists ranking_placements_correction_follows_latest_watch on ranking_placements;
create trigger ranking_placements_correction_follows_latest_watch
  after insert on ranking_placements
  for each row
  when (new.kind in ('correction', 'manual'))
  execute function _correction_follows_latest_watch();

comment on table ranking_placements is
  'Append-only. One row per completed placement. rankings.position remains the single '
  'current ordinal (§L.1) -- nothing here is averaged, weighted, decayed or replayed into '
  'it, and no snapshot ever feeds the current score. Written by _rank_finalize and, since '
  '20261129000100, by rank_reorder (kind manual), and by nothing else.';
