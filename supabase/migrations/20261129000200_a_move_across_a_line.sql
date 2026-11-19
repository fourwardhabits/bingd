-- ===========================================================================
-- A MOVE ACROSS A LINE (#318 revised, founder decision 2026-11-19)
--
-- `docs/architecture/collection-rerank.md`. Builds on 20261129000100, which granted
-- `rank_reorder` back for drag-to-rerank and refused any drop outside the title's own
-- rating category (22023, "drag it within that group, or use Rerank").
--
-- The founder rejected that restriction: a reader may drag any ranked title to any place in
-- the same ranking, and a drop among another category's titles puts it in that category.
-- Dragging "Heat" from among the I liked it titles to a place among the It was fine titles
-- makes it It was fine, at that place, with the score that place has.
--
-- What changes, and only this:
--
--   1. `rank_reorder` takes `p_new_bucket` (default null: the title's own category, so every
--      existing call means what it meant). The target position must be a place in THAT
--      category once the title has left its own: band_bounds_excluding(new bucket) gives
--      `lo .. lo + size`. Anything else is still refused with 22023.
--
--   2. A move that changes category writes `rankings.bucket` and `user_media.bucket`
--      together, inside the media lock and the category lock (I3: the two never disagree).
--      Positions shift exactly as before: the title is lifted out of position p and set
--      down at q, the titles between close up. Because the target is inside the new
--      category's run, the categories stay contiguous and in order (I1, I2, I4).
--
--   3. A bucket-only move is allowed: the last title of one category becoming the first of
--      the next keeps its position and changes category. A no-op is a move that changes
--      neither.
--
--   4. The `manual` placement records `from_bucket` and `bucket`, and its score is read
--      from the band sizes AFTER the move. The latest watch's existing post follows it with
--      its new score and bucket (the trigger 20261129000100 installed). No post, comparison,
--      watch, session or notification is created, and `rankings.created_at` is kept.
--
--   5. A third guard, `p_expected_bucket`: the category the client saw the title in (Codex,
--      PR 319). The position guard cannot see a change of category that kept the position,
--      so without it a stale Undo could overwrite another device's newer rating. A mismatch
--      refuses with 55000, like the other two.
--
-- Undo is an ordinary move back with the original category passed explicitly. It carries
-- the same guards, so it is refused rather than misapplied if anything moved in between.
--
-- Pools: the category of the move is the title's own ranking category, read under the
-- lock. A season is moved among seasons and a show among shows; there is no way to name
-- another pool.
--
-- Rollback: `docs/release/pr319/rollback-20261129000200.sql` restores the 20261129000100
-- function. Rankings already moved across a category stay valid rankings: every invariant
-- holds for them, and nothing has to be undone in the data.
-- ===========================================================================

drop function if exists rank_reorder(uuid, integer, uuid, integer, uuid);
drop function if exists rank_reorder(uuid, integer, uuid, integer, uuid, taste_bucket);

create or replace function rank_reorder(
  p_media_item_id        uuid,
  p_new_position         integer,
  p_operation_id         uuid    default null,
  p_expected_position    integer default null,
  p_anchor_media_item_id uuid    default null,
  p_new_bucket           taste_bucket default null,
  p_expected_bucket      taste_bucket default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_claim     record;
  v_r         record;
  v_from_band record;
  v_to_band   record;
  v_after     record;
  v_bucket    taste_bucket;
  v_anchor    uuid;
  v_cat_size  integer;
  v_from_rank integer;
  v_to_rank   integer;
  v_from      numeric;
  v_to        numeric;
  v_crosses   boolean;
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

  -- Media, then category: the §9 order. Everything below is read inside the category lock.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  -- Re-read inside the category lock (Codex, PR 319): a neighbour's move may have
  -- renumbered this title while it waited. Its category and bucket cannot have changed:
  -- that takes a writer naming this title, which the media lock excludes.
  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if p_expected_position is not null and v_r.position <> p_expected_position then
    raise exception 'the ranking changed: this title is at % now, not %',
      v_r.position, p_expected_position
      using errcode = '55000';
  end if;

  -- The category the client saw, which the position guard cannot see change on its own.
  if p_expected_bucket is not null and v_r.bucket <> p_expected_bucket then
    raise exception 'the ranking changed: this title is % now, not %',
      v_r.bucket, p_expected_bucket
      using errcode = '55000';
  end if;

  v_bucket  := coalesce(p_new_bucket, v_r.bucket);
  v_crosses := v_bucket <> v_r.bucket;

  -- Where the title is now, and its score there.
  select * into v_from_band from band_bounds(v_user, v_r.category, v_r.bucket);
  v_from_rank := v_r.position - v_from_band.lo + 1;
  v_from      := score_for(v_r.bucket, v_from_rank, v_from_band.size);

  -- Where it may go: a place in the target category once it has left its own. For a move
  -- inside one category this is exactly the band it is in (lo .. hi); across, it is the
  -- target category's run with one more place, at whichever end the title arrives from.
  select * into v_to_band
    from band_bounds_excluding(v_user, v_r.category, v_bucket, p_media_item_id);

  if p_new_position < v_to_band.lo or p_new_position > v_to_band.lo + v_to_band.size then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, v_bucket, v_to_band.lo, v_to_band.lo + v_to_band.size
      using errcode = '22023';
  end if;

  -- The title the client saw at the target is still there. Skipped when the target is the
  -- title's own position, where the only title there is the one being moved.
  if p_anchor_media_item_id is not null and p_new_position <> v_r.position then
    select r.media_item_id into v_anchor from rankings r
     where r.user_id = v_user and r.category = v_r.category and r.position = p_new_position;
    if v_anchor is distinct from p_anchor_media_item_id then
      raise exception 'the ranking changed: another title is at position % now', p_new_position
        using errcode = '55000';
    end if;
  end if;

  -- A no-op is not a placement: it writes nothing and says so.
  if p_new_position = v_r.position and not v_crosses then
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object(
        'done', true, 'moved', false,
        'position', v_r.position, 'from_position', v_r.position,
        'category', v_r.category, 'bucket', v_r.bucket, 'from_bucket', v_r.bucket,
        'band_lo', v_from_band.lo, 'band_size', v_from_band.size,
        'score', v_from, 'from_score', v_from
      )
    );
  end if;

  if p_new_position < v_r.position then
    update rankings set position = position + 1
     where user_id = v_user and category = v_r.category
       and position >= p_new_position and position < v_r.position;
  elsif p_new_position > v_r.position then
    update rankings set position = position - 1
     where user_id = v_user and category = v_r.category
       and position > v_r.position and position <= p_new_position;
  end if;

  update rankings
     set position = p_new_position,
         bucket   = v_bucket
   where user_id = v_user and media_item_id = p_media_item_id;

  -- I3: the collection row says what the ranking says. The same upsert `_rank_finalize`
  -- writes after a correction, and only when the category actually changed.
  if v_crosses then
    insert into user_media (user_id, media_item_id, bucket)
    values (v_user, p_media_item_id, v_bucket)
    on conflict (user_id, media_item_id) do update
      set bucket = excluded.bucket, updated_at = now()
     where user_media.bucket is distinct from excluded.bucket;
  end if;

  -- The score at the new place, from the band sizes as they are now.
  select * into v_after from band_bounds(v_user, v_r.category, v_bucket);
  v_to_rank := p_new_position - v_after.lo + 1;
  v_to      := score_for(v_bucket, v_to_rank, v_after.size);

  select count(*)::integer into v_cat_size
    from rankings r where r.user_id = v_user and r.category = v_r.category;

  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    from_bucket, from_position, from_score,
    strategy, tolerance, comparisons, skips, adjustable,
    watch_event_id, session_id, operation_id, linked_placement_id
  )
  values (
    v_user, p_media_item_id, v_r.category, 'manual', 'moved',
    v_bucket, p_new_position, v_to_rank, v_after.size, v_cat_size, v_to,
    v_r.bucket, v_r.position, v_from,
    null, 0, 0, 0, false,
    null, null, p_operation_id, null
  );

  v_reply := jsonb_build_object(
    'done', true, 'moved', true,
    'position', p_new_position, 'from_position', v_r.position,
    'category', v_r.category, 'bucket', v_bucket, 'from_bucket', v_r.bucket,
    'band_lo', v_after.lo, 'band_size', v_after.size,
    'score', v_to, 'from_score', v_from
  );

  return _record_operation_result(p_operation_id, v_reply);
end;
$$;

comment on function rank_reorder(uuid, integer, uuid, integer, uuid, taste_bucket, taste_bucket) is
  'Moves a ranked title to another place in its own ranking (Collection drag-to-rerank, #318). '
  'p_new_bucket (default: its own) is the rating category of the place it is dropped in; the '
  'position must be a place in that category once the title has left its own, else 22023. '
  'A change of category writes rankings.bucket and user_media.bucket together. Optional '
  'guards refuse a move computed from a stale list (55000): position, target title and '
  'category. Every move writes one manual '
  'ranking_placements row; a no-op or a refusal writes nothing. Never writes a comparison, '
  'watch, feed post or notification. Cross-category since 20261129000200.';

revoke execute on function rank_reorder(uuid, integer, uuid, integer, uuid, taste_bucket, taste_bucket)
  from public, anon;
grant  execute on function rank_reorder(uuid, integer, uuid, integer, uuid, taste_bucket, taste_bucket)
  to authenticated;
