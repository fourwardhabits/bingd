-- ---------------------------------------------------------------------------
-- T3 — the rewatch server.
--
-- `watch-history-and-ranking-calibration.md` §D.5, §K, PR N3.
--
-- ===========================================================================
-- THE DEFECT THIS CLOSES (§C.3.2, §C.3.3)
--
-- **A rewatch cannot be recorded without re-ranking**, and the re-ranking ignores the
-- position the title already holds. *Log another watch* on main is
-- `rankAgain(newWatch: true)`: a forced full re-rank that records **no watch and no
-- date** and then posts an activity indistinguishable from a first ranking.
--
-- After this migration the two acts are separate, and in the honest order:
--
--   `log_rewatch`  records the viewing. That is the whole act, and it is complete on its
--                  own -- a reader who taps Save and closes the sheet has logged a
--                  rewatch and changed no ranking.
--   the re-check   is optional, cheap (2 comparisons when nothing changed, §F.3) and
--                  reaches the SAME feed activity rather than a second one.
--
-- ===========================================================================
-- ONE EVENT, ONE POST (§K)
--
--   First ranking                              posts, unchanged
--   Rewatch + Keep                             posts iff the event is NATIVE-DATED
--                                              within 7 days: `again: true`
--   Rewatch + Re-check                         **the same single post**, its score
--                                              updated to the new one
--   Rewatch backdated, `diary`, or `none`      posts nothing
--   Legacy-client rewatch (an undated event)   posts, as that client does today
--   Remove one watch                           deletes that watch's post
--
-- **No movement reaches the feed.** `from_position` and `outcome` are not in the
-- payload, so a future client cannot render movement from history it was never sent --
-- the privacy rule is in the data rather than in a template (§K, §E.2).
--
-- A backdated rewatch posts nothing because a post is a statement about now. "Ada
-- watched Heat again" under an entry the reader has just backdated to 2019 is false in
-- the only tense the feed has.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The flag (§M.6)
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('feed.rewatch_posts',      'true'::jsonb),
  -- The window in §K, named rather than spelled 7 in three functions.
  ('feed.rewatch_post_days',  '7'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Does this event earn an activity?
--
-- One predicate, so the three callers -- `log_rewatch`, `_rank_finalize`'s legacy path
-- and `delete_watch_event`'s cleanup -- cannot drift apart on the answer.
-- ---------------------------------------------------------------------------

create or replace function _rewatch_posts(p_watched_on date, p_basis watch_date_basis)
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce((select (value)::boolean from app_config
                    where key = 'feed.rewatch_posts'), true)
     -- Native-dated only. A `diary` event is somebody else's record of a viewing, often
     -- years old, and importing a library must not announce two hundred rewatches.
     and p_basis in ('today_default', 'reader')
     and p_watched_on is not null
     and p_watched_on >= current_date - coalesce(
           (select (value)::integer from app_config where key = 'feed.rewatch_post_days'), 7
         );
$$;

comment on function _rewatch_posts(date, watch_date_basis) is
  '§K: a rewatch earns one activity when its event is native-dated within the window. '
  'A backdated, diary or undated viewing posts nothing, because a feed post is a '
  'statement about now and the feed has no other tense. `unattributed` is excluded too: '
  'only an installed client writes that basis, and its rewatch path is _rank_finalize''s '
  'legacy branch, which posts on its own terms.';

revoke execute on function _rewatch_posts(date, watch_date_basis) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. `log_rewatch` (§D.5)
-- ---------------------------------------------------------------------------

create or replace function log_rewatch(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_watched_on    date,
  p_basis         watch_date_basis
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim   record;
  v_event   uuid;
  v_count   integer;
  v_posted  uuid;
  v_rank    record;
  v_band    record;
  v_score   numeric;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'log_rewatch');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if p_basis is null or p_basis = 'diary' then
    raise exception 'basis must be today_default, reader or none' using errcode = '22023';
  end if;

  if (p_basis = 'none') <> (p_watched_on is null) then
    raise exception 'basis none means no date, and a date means a basis'
      using errcode = '22023';
  end if;

  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _lock_media(auth.uid(), p_media_item_id);

  -- **Requires a seen row** (§D.5). A rewatch of something you have not watched is not
  -- a sentence, and creating the row here would make this a second `log_title` with a
  -- different name. The client sends `log_title` for a first viewing.
  if not exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'title is not in your collection' using errcode = 'P0002';
  end if;

  insert into watch_events (user_id, media_item_id, watched_on, basis)
  values (auth.uid(), p_media_item_id, p_watched_on, p_basis)
  returning id into v_event;

  select count(*)::integer into v_count
    from watch_events
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  -- ---------------------------------------------------------------------------
  -- The activity, if this viewing earns one.
  --
  -- `title_ranked` with `again: true`, not a new type: installed clients read types
  -- through an `IN` list, so a new type would be invisible until the OTA lands. An old
  -- client renders *Ada ranked Heat*, which is true. A new one reads `again` and renders
  -- *Ada watched Heat again*.
  --
  -- Only for a title that is actually ranked. A rewatch of something seen but unranked
  -- has no score to show and no placement to name, and the feed's whole vocabulary here
  -- is "position, bucket, category, score".
  -- ---------------------------------------------------------------------------
  select r.bucket, r.position, r.category into v_rank
    from rankings r
   where r.user_id = auth.uid() and r.media_item_id = p_media_item_id;

  if v_rank.position is not null and _rewatch_posts(p_watched_on, p_basis) then
    select * into v_band from band_bounds(auth.uid(), v_rank.category, v_rank.bucket);
    v_score := score_for(v_rank.bucket, v_rank.position - v_band.lo + 1, v_band.size);

    insert into feed_events (actor_id, type, media_item_id, payload)
    values (
      auth.uid(), 'title_ranked', p_media_item_id,
      jsonb_build_object(
        'position', v_rank.position,
        'bucket',   v_rank.bucket,
        'category', v_rank.category,
        'score',    v_score,
        -- §K. The two keys a new client reads, and the two an old client ignores.
        'again',          true,
        'watch_event_id', v_event
      )
    )
    returning id into v_posted;
  end if;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object(
      'status', 'ok',
      'watch_event_id', v_event,
      'watch_count', v_count,
      'posted', v_posted is not null,
      'feed_event_id', v_posted
    )
  );
end;
$$;

comment on function log_rewatch(uuid, uuid, date, watch_date_basis) is
  'Records a second (or eleventh) viewing of a title already in the collection, and '
  'posts at most one title_ranked {again: true, watch_event_id} for it (§K). It changes '
  'no ranking: the optional re-check is rank_again, which finds this event through the '
  'session and enriches this same post rather than making a second one.';

revoke execute on function log_rewatch(uuid, uuid, date, watch_date_basis) from public, anon;
grant execute on function log_rewatch(uuid, uuid, date, watch_date_basis) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. `edit_watch_event` and `delete_watch_event` (§D.5)
-- ---------------------------------------------------------------------------

/**
 * Edits one event's date, and **never creates a viewing**.
 *
 * A null date sets `basis = 'none'`, which is *Date not recorded* on the row. It is the
 * one control in the product that can take a date off a single viewing without taking
 * the viewing with it.
 */
create or replace function edit_watch_event(
  p_operation_id   uuid,
  p_watch_event_id uuid,
  p_watched_on     date,
  p_basis          watch_date_basis
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim record;
  v_row   record;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'edit_watch_event');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if p_basis is null or p_basis = 'diary' then
    raise exception 'basis must be reader or none' using errcode = '22023';
  end if;

  if (p_basis = 'none') <> (p_watched_on is null) then
    raise exception 'basis none means no date, and a date means a basis'
      using errcode = '22023';
  end if;

  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  select * into v_row from watch_events
   where id = p_watch_event_id and user_id = auth.uid();

  if v_row.id is null then
    raise exception 'no such watch' using errcode = 'P0002';
  end if;

  perform _lock_media(auth.uid(), v_row.media_item_id);

  update watch_events
     set watched_on = p_watched_on, basis = p_basis, updated_at = now()
   where id = p_watch_event_id
     and (watched_on is distinct from p_watched_on or basis is distinct from p_basis);

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'watch_event_id', p_watch_event_id)
  );
end;
$$;

revoke execute on function edit_watch_event(uuid, uuid, date, watch_date_basis) from public, anon;
grant execute on function edit_watch_event(uuid, uuid, date, watch_date_basis) to authenticated;


/**
 * Removes one viewing.
 *
 * **It refuses the last one**, with `P0001 last_watch`, and the client turns that into
 * *Remove from collection…* (§J.2's ⋯ menu). The refusal is the §D.0 invariant defended
 * at its only remaining exit: a seen title has at least one watch event, and a title
 * with none is a collection row nothing explains.
 *
 * Two side effects, both §K's:
 *   - **that watch's post is deleted.** The activity said a viewing happened; the reader
 *     has said it did not.
 *   - **placement links are set to null, not deleted.** The placement is still true: the
 *     title was re-placed, and the comparisons that moved it were really answered. What
 *     is no longer true is which viewing prompted it. The FK is already
 *     `on delete set null`, so this is the schema doing it rather than a statement.
 */
create or replace function delete_watch_event(
  p_operation_id   uuid,
  p_watch_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim record;
  v_row   record;
  v_count integer;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'delete_watch_event');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  select * into v_row from watch_events
   where id = p_watch_event_id and user_id = auth.uid();

  if v_row.id is null then
    raise exception 'no such watch' using errcode = 'P0002';
  end if;

  perform _lock_media(auth.uid(), v_row.media_item_id);

  -- Re-read under the lock, so a concurrent delete of the sibling cannot leave a title
  -- with zero events by both calls seeing two.
  select count(*)::integer into v_count
    from watch_events
   where user_id = auth.uid() and media_item_id = v_row.media_item_id;

  if v_count <= 1 then
    raise exception 'last_watch' using errcode = 'P0001',
      hint = 'a title in the collection has at least one watch; remove the title instead';
  end if;

  -- That watch's post, and only that watch's. Keyed on the event id in the payload,
  -- which is why `log_rewatch` puts it there.
  delete from feed_events
   where actor_id = auth.uid()
     and type = 'title_ranked'
     and (payload ->> 'watch_event_id')::uuid = p_watch_event_id;

  delete from watch_events where id = p_watch_event_id;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'watch_count', v_count - 1)
  );
end;
$$;

revoke execute on function delete_watch_event(uuid, uuid) from public, anon;
grant execute on function delete_watch_event(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. `_rank_finalize`, rebuilt from 20261004000100
--
-- Two changes, and both are about the rewatch reaching ONE activity:
--
--   1. **Enrichment.** A `rewatch` session that carries a `watch_event_id` finds the post
--      `log_rewatch` already made and updates its score to the new one. It does not post
--      again. §K: "the **same** single event, enriched".
--
--   2. **The legacy branch.** `rank_again(new_watch = true)` from an installed client
--      carries no event, because that client has never heard of one. It gets an
--      **undated** event created here -- no fabricated date, §B.2 -- linked to the
--      placement, and posts `again: true` as that client does today. §D.5's last row and
--      §D.6 path 15.
--
-- Everything else is transcribed from 20261004000100.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false,
  p_replaces boolean default false,
  p_new_watch boolean default false,
  p_kind placement_kind default null,
  p_operation_id uuid default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_band      record;
  v_size      integer;
  v_rank      integer;
  v_score     numeric;
  v_activated boolean;
  v_replaced  boolean := false;
  v_event_id  uuid;
  v_causal_at timestamptz;
  v_kept_at   timestamptz;
  v_prior       record;
  v_from_band   record;
  v_from_score  numeric;
  v_kind        placement_kind;
  v_outcome     text;
  v_noop        boolean := false;
  v_placement   uuid;
  v_cat_size    integer;
  v_session_row record;
  v_comparisons integer := 0;
  -- 20261005000100
  v_watch_event uuid;
  v_enriched    boolean := false;
  v_legacy_watch boolean := false;
  v_event_row   record;
  v_posts       boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Unconditional, and it must be: plpgsql raises "record is not assigned yet" on the
  -- first field access of a record no statement has written, so a null session would
  -- fail at `v_session_row.kind` rather than reading null from it. A `select into` that
  -- matches nothing assigns a row of nulls, which is exactly what the coalesces below
  -- expect. Caught by correction-is-not-a-ranking.test.mjs.
  select * into v_session_row from ranking_sessions where id = session;

  v_kind := coalesce(
    p_kind,
    v_session_row.kind,
    case when not p_replaces then 'first'::placement_kind
         when p_new_watch   then 'rewatch'::placement_kind
         else 'correction'::placement_kind end
  );

  v_watch_event := v_session_row.watch_event_id;

  -- **The live state immediately before** (§E.2 form B), read inside the lock.
  select r.bucket, r.position, r.created_at into v_prior
    from rankings r
   where r.user_id = target and r.media_item_id = item;

  if v_prior.position is not null then
    select * into v_from_band from band_bounds(target, cat, v_prior.bucket);
    v_from_score := score_for(
      v_prior.bucket, v_prior.position - v_from_band.lo + 1, v_from_band.size
    );
  end if;

  -- **The no-op finalize** (§E.3.2).
  if p_replaces and v_prior.position is not null
     and v_prior.bucket = b and v_prior.position = pos then
    v_noop := true;
  end if;

  if not v_noop then
    if p_replaces and v_prior.position is not null then
      v_kept_at := v_prior.created_at;
      perform _rank_unrank_impl(target, item);
      v_replaced := true;
    end if;

    select * into v_band from band_bounds(target, cat, b);

    if pos < v_band.lo or pos > v_band.hi + 1 then
      raise exception
        'refusing to place a % title at position %, outside the % band (% to %)',
        b, pos, b, v_band.lo, v_band.hi + 1
        using errcode = '22023';
    end if;

    update rankings
       set position = position + 1
     where user_id = target and category = cat and position >= pos;

    insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
    values (
      target, item, cat, b, pos,
      case
        when v_replaced and v_kind in ('correction', 'refine', 'manual')
          then coalesce(v_kept_at, now())
        when v_replaced and not p_new_watch and v_kind not in ('first', 'rewatch', 'import')
          then coalesce(v_kept_at, now())
        else now()
      end
    );

    insert into user_media (user_id, media_item_id, bucket)
    values (target, item, b)
    on conflict (user_id, media_item_id) do update
      set bucket = excluded.bucket, updated_at = now()
     where user_media.bucket is distinct from excluded.bucket;

    select * into v_band from band_bounds(target, cat, b);
    v_size := v_band.size;
    v_rank := pos - v_band.lo + 1;
  else
    v_replaced := true;
    select * into v_band from band_bounds(target, cat, b);
    v_size := v_band.size;
    v_rank := pos - v_band.lo + 1;
  end if;

  v_score := score_for(b, v_rank, v_size);

  -- ---------------------------------------------------------------------------
  -- **A rewatch from an installed client brings no event, so one is made here.**
  --
  -- Undated, always. That client offered the reader no date control, so the server has
  -- nothing to date it with, and `now()` would be a fabricated watch date -- the exact
  -- class of write §B.2 forbids and §C.3.7 was about. "Watched at some point" is the
  -- true statement, and Watch History will show it as *Earlier · date not recorded*.
  -- ---------------------------------------------------------------------------
  if v_kind = 'rewatch' and v_watch_event is null then
    insert into watch_events (user_id, media_item_id, watched_on, basis)
    values (target, item, null, 'none')
    returning id into v_watch_event;
    v_legacy_watch := true;
  end if;

  -- The ledger row (§E.1), and the answers that produced it.
  select count(*)::integer into v_comparisons
    from comparisons c
   where c.session_id = session and c.withdrawn_at is null;

  select count(*)::integer into v_cat_size
    from rankings r where r.user_id = target and r.category = cat;

  v_outcome := case
    when v_prior.position is null then 'placed'
    when v_prior.bucket <> b or v_prior.position <> pos then 'moved'
    when was_adjusted then 'kept'
    else 'unchanged'
  end;

  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    from_bucket, from_position, from_score,
    strategy, tolerance, comparisons, skips, adjustable,
    watch_event_id, session_id, operation_id
  )
  values (
    target, item, cat, v_kind, v_outcome,
    b, pos, v_rank, v_size, v_cat_size, v_score,
    v_prior.bucket, v_prior.position, v_from_score,
    coalesce(v_session_row.strategy, 'bisect'), coalesce(v_session_row.tolerance, 0),
    v_comparisons, coalesce(v_session_row.skips, 0), was_adjusted,
    v_watch_event, session, p_operation_id
  )
  returning id into v_placement;

  if session is not null then
    update comparisons c
       set placement_id = v_placement
     where c.session_id = session and c.withdrawn_at is null;
  end if;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  -- ---------------------------------------------------------------------------
  -- **Enrichment: the same single event** (§K).
  --
  -- `log_rewatch` already posted for this viewing; the re-check is the second half of
  -- one act, not a second act. The score is brought up to the one the reader has just
  -- settled on, and `position`, `bucket` and `category` with it -- a post whose score
  -- says 9.1 and whose position says the old #118 is internally inconsistent, and the
  -- reveal and the feed would disagree.
  --
  -- **`from_position` and `outcome` are deliberately NOT written.** §K: the payload
  -- carries no movement, so a future client cannot render movement from history it was
  -- never sent. That is the privacy rule living in the data.
  --
  -- Nothing is posted when enrichment found the row, and that is the whole point: one
  -- viewing, one activity, whichever order the reader does the two halves in.
  -- ---------------------------------------------------------------------------
  if v_kind = 'rewatch' and v_watch_event is not null then
    update feed_events fe
       set payload = fe.payload || jsonb_build_object(
             'position', pos, 'bucket', b, 'category', cat, 'score', v_score
           )
     where fe.actor_id = target
       and fe.type = 'title_ranked'
       and (fe.payload ->> 'watch_event_id')::uuid = v_watch_event;

    if found then
      v_enriched := true;
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Does this finalize post?
  --
  -- The founder's four War Dogs (20260826000500), with §I.5 and §H.1's silent kinds
  -- (20261004000100) and §K's rewatch rules (20261005000100) in front of them.
  --
  -- **The EVENT decides whether a rewatch posts, not the session.** Caught by
  -- `rewatch.test.mjs`: a backdated rewatch posts nothing from `log_rewatch`, so
  -- enrichment finds no row to update -- and without this the re-check would then fall
  -- through to the ordinary "a new watch always posts" branch and announce, today, a
  -- viewing the reader has just told us happened in 2019. §K lists that row as **no**,
  -- and the reason is that a feed post has no past tense.
  --
  -- The legacy branch is the exception §K states in as many words: an installed client's
  -- rewatch posts "as today (the act is contemporaneous)". That client offered no date
  -- control at all, so its undated event is not a reader saying "long ago" -- it is the
  -- server declining to invent a date for something that is happening now.
  -- ---------------------------------------------------------------------------
  if v_kind = 'rewatch' and not v_legacy_watch then
    select we.watched_on, we.basis into v_event_row
      from watch_events we where we.id = v_watch_event;
    v_posts := _rewatch_posts(v_event_row.watched_on, v_event_row.basis);
  else
    v_posts := (p_new_watch or not v_replaced);
  end if;

  if not v_enriched
     and v_posts
     and v_kind not in ('import', 'refine', 'manual') then
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
      -- The legacy rewatch marks itself, so a new client renders it as what it is and
      -- `delete_watch_event` can find it.
      || case when v_kind = 'rewatch'
              then jsonb_build_object('again', true, 'watch_event_id', v_watch_event)
              else '{}'::jsonb end
    )
    returning id, causal_at into v_event_id, v_causal_at;

    /**
     * **The award that was announced before its own activity existed**
     * (20260902000100). Transcribed unchanged.
     */
    update feed_events fe
       set causal_at = v_causal_at
     where fe.actor_id = target
       and fe.type in ('award_earned', 'goal_completed')
       and fe.causal_at < v_causal_at
       and exists (
         select 1 from feed_event_causes fc
          where fc.feed_event_id = fe.id
            and fc.user_id = target
            and fc.media_item_id = item
       )
       and not exists (
         select 1
           from feed_events act
          where act.actor_id = target
            and act.type in ('title_ranked', 'season_completed', 'watchlist_added')
            and act.id <> v_event_id
            and act.causal_at >= fe.causal_at
            and act.causal_at <  v_causal_at
       );
  end if;

  -- NEW (20260827000600), with §E.3.5's import exclusion (20261004000100).
  if not v_replaced and v_kind <> 'import' then
    with fulfilled as (
      update title_recommendations tr
         set fulfilled_at = now()
       where tr.recipient_id = target
         and tr.media_item_id = item
         and tr.state = 'delivered'
         and tr.fulfilled_at is null
      returning tr.id, tr.sender_id
    )
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select f.sender_id,
           'recommendation_ranked',
           target,
           'feed_event',
           v_event_id,
           jsonb_build_object('recommendation_id', f.id)
      from fulfilled f
      join profiles sp
        on sp.id = f.sender_id
       and sp.status = 'active'
     where can_view_profile(f.sender_id, target)
    on conflict (((payload ->> 'recommendation_id')::uuid))
      where type = 'recommendation_ranked'
      do nothing;
  end if;

  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated,
    'placement_id', v_placement,
    'watch_event_id', v_watch_event,
    'movement', jsonb_build_object(
      'outcome', v_outcome,
      'from_position', v_prior.position,
      'from_score', v_from_score,
      'kind', v_kind
    )
  );
end;
$$;

revoke execute on function _rank_finalize(
  uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean,
  placement_kind, uuid
) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. `rank_again` learns the watch event it is a re-check of
--
-- A new client logs the rewatch first and then, if the reader taps *Re-check placement*,
-- passes that event's id here. The session carries it, `_rank_finalize` finds it, and
-- the two halves reach one activity.
--
-- **A new parameter, not a new function.** It is defaulted null, so every installed
-- client's four-argument call resolves exactly as before -- PostgREST matches on the
-- names in the body, and an omitted defaulted argument is the one case where that is
-- unambiguous because there is only one `rank_again`.
-- ---------------------------------------------------------------------------

drop function if exists rank_again(uuid, taste_bucket, uuid, boolean);

create or replace function rank_again(
  p_media_item_id  uuid,
  p_bucket         taste_bucket,
  p_operation_id   uuid default null,
  p_new_watch      boolean default false,
  p_watch_event_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_event uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  if p_bucket is null then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_again');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  -- The event must be this reader's, and about this title. A re-check pointed at
  -- somebody else's viewing would link a placement to a row the reader cannot read.
  if p_watch_event_id is not null then
    select we.id into v_event
      from watch_events we
     where we.id = p_watch_event_id
       and we.user_id = v_user
       and we.media_item_id = p_media_item_id;

    if v_event is null then
      raise exception 'no such watch' using errcode = 'P0002';
    end if;
  end if;

  -- No unrank. `_rank_start_impl` opens the session over the ranking that is still
  -- there, and `_rank_finalize` replaces it only if and when the reader finishes.
  return _record_operation_result(
    p_operation_id,
    _rank_start_impl(
      v_user, p_media_item_id, p_bucket, true, coalesce(p_new_watch, false),
      case when coalesce(p_new_watch, false) then 'rewatch'::placement_kind
           else 'correction'::placement_kind end,
      v_event, 0
    )
  );
end;
$$;

revoke execute on function rank_again(uuid, taste_bucket, uuid, boolean, uuid) from public, anon;
grant execute on function rank_again(uuid, taste_bucket, uuid, boolean, uuid) to authenticated;

comment on function rank_again(uuid, taste_bucket, uuid, boolean, uuid) is
  'Opens a provisional session over the position the title already holds. With '
  'p_new_watch it is a rewatch: a new client passes the watch event it has just logged, '
  'so the placement links to that viewing and its feed activity is ENRICHED rather than '
  'duplicated (§K). An installed client passes four arguments and no event, and '
  '_rank_finalize gives it an undated one -- a rewatch with no fabricated date.';
