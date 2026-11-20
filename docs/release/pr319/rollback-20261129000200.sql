-- ROLLBACK of 20261129000200_a_move_across_a_line (#318 revised). STAGING ONLY unless separately
-- approved. Restores the 20261129000100 `rank_reorder` exactly (same-category moves only; a
-- cross-category drop is refused with 22023, and the client then shows the "refreshed" notice).
--
-- Data: nothing is undone. A title moved across a category is a valid ranking: I1-I4 hold, its
-- `user_media.bucket` agrees, and its `manual` placement is a true record of the move. The
-- client published with 20261129000200 sends `p_new_bucket` only on a cross-category move, so
-- after this rollback a same-category drag keeps working and a cross-category one is refused.
-- One transaction, so a failure leaves the migration fully in place.
begin;

-- The 20261129000100 body, verbatim except for the signature it drops.
drop function if exists rank_reorder(uuid, integer, uuid, integer, uuid, taste_bucket, taste_bucket);

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

delete from supabase_migrations.schema_migrations where version = '20261129000200';

commit;
