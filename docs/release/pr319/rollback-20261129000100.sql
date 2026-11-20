-- ROLLBACK of 20261129000100_a_move_you_make_yourself (#318). STAGING ONLY unless separately approved.
-- Restores the exact prior state: rank_reorder(uuid, integer, uuid) revoked from every client
-- role (20261004000100), the latest-watch trigger firing on `correction` only (20261114000300),
-- and the prior table comment. Any `manual` placement rows written meanwhile are kept: each is a
-- true record of a move that happened, and P1 still holds for them.
-- One transaction, so a failure leaves the migration fully in place.
begin;

drop function if exists rank_reorder(uuid, integer, uuid, integer, uuid);

-- The 20260825000200 body, verbatim.
create or replace function rank_reorder(
  p_media_item_id uuid,
  p_new_position  integer,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_r     record;
  v_band  record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

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

  -- The category lock is taken *before* the band is read, which is a change from the
  -- previous version and is the same correction `_rank_finalize` already carries: a
  -- band read outside the lock describes a ranking that another transaction may be
  -- renumbering, so the bounds this refusal is measured against could be stale by the
  -- time the shifts run. Order is media then category, per the hierarchy at the top.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  select * into v_band from band_bounds(v_user, v_r.category, v_r.bucket);

  -- A drag that would cross a band boundary is refused, because crossing means the
  -- bucket changed and that path re-runs comparisons instead of guessing.
  if p_new_position < v_band.lo or p_new_position > v_band.hi then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, v_r.bucket, v_band.lo, v_band.hi
      using errcode = '22023';
  end if;

  if p_new_position = v_r.position then
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', true, 'position', v_r.position)
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

  return _record_operation_result(
    p_operation_id, jsonb_build_object('done', true, 'position', p_new_position)
  );
end;
$$;

revoke execute on function rank_reorder(uuid, integer, uuid) from public, anon, authenticated;

comment on function rank_reorder(uuid, integer, uuid) is
  'REVOKED 20261004000100. It moves a ranking without writing a ranking_placements row, '
  'so the ledger would have a gap nothing explains. It has never had a caller. To grant '
  'it back, teach it to write a manual placement first (§E.1).';

-- The 20261114000300 body, verbatim.
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
  if new.category in ('tv_shows', 'tv_seasons')
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
  when (new.kind = 'correction')
  execute function _correction_follows_latest_watch();

comment on table ranking_placements is
  'Append-only. One row per completed placement. rankings.position remains the single '
  'current ordinal (§L.1) -- nothing here is averaged, weighted, decayed or replayed into '
  'it, and no snapshot ever feeds the current score. Written by _rank_finalize and by '
  'nothing else.';

delete from supabase_migrations.schema_migrations where version = '20261129000100';

commit;
