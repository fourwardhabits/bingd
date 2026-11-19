-- ===========================================================================
-- A SHOW YOU PLACE YOURSELF (#319, founder QA 2026-11-20)
--
-- `docs/architecture/collection-rerank.md`, "TV, dragged on the wall". Two changes.
--
-- 1. **Ranking updates are silent in the Feed, on every pool.** A first ranking posts; a
--    rewatch posts by its own rule; an update of a rating, a manual move, a change of
--    category, a correction or a Refine posts nothing. Until now a TV correction that moved
--    the title (outcome 'moved') posted one `title_ranked` marked `update: true`
--    (20261114000300). That branch is removed, and the latest watch's EXISTING post now
--    follows a TV correction's score as it follows a film's (the skip that existed only
--    because the update post carried the score is removed too). Historic `update: true`
--    posts are left exactly as they are: nothing is deleted, rewritten or backfilled.
--
-- 2. **The TV wall is dragged directly.** A series poster scored by its explicit show
--    ranking moves with `rank_reorder` in `tv_shows`, as before. A series poster scored by
--    its seasons' average (`SN AVG`) is promoted: `rank_promote_show` gives it an explicit
--    `tv_shows` ranking at the place it was dropped, with the score that place has. Its
--    seasons' rankings, scores and history are untouched, and nothing is posted or watched.
--    `rank_unpromote_show` undoes exactly that promotion, while it is still the show's latest
--    placement, and restores the collection row as it was.
--
-- Rollback: `docs/release/pr319/rollback-20261129000300.sql`.
-- ===========================================================================

-- 1. Silent corrections

create or replace function _rank_finalize(target uuid, item uuid, cat ranking_category, b taste_bucket, pos integer, session uuid, was_adjusted boolean DEFAULT false, p_replaces boolean DEFAULT false, p_new_watch boolean DEFAULT false, p_kind placement_kind DEFAULT NULL::placement_kind, p_operation_id uuid DEFAULT NULL::uuid, p_linked_placement_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  -- 20261114000300
  v_linked      uuid;
  v_tv_update   boolean := false;
  v_parent      uuid;
  v_parent_bucket taste_bucket;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Unconditional, and it must be: plpgsql raises "record is not assigned yet" on the
  -- first field access of a record no statement has written, so a null session would
  -- fail at `v_session_row.kind` rather than reading null from it. A `select into` that
  -- matches nothing assigns a row of nulls, which is exactly what the coalesces below
  -- expect. Caught by correction-is-not-a-ranking.test.mjs.
  select * into v_session_row from ranking_sessions where id = session;

  -- 20261114000300: the linked origin, from the caller when there was no session to carry it
  -- (an empty band finalises straight from _rank_start_impl), else from the session.
  v_linked := coalesce(p_linked_placement_id, v_session_row.linked_placement_id);

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
    watch_event_id, session_id, operation_id, linked_placement_id
  )
  values (
    target, item, cat, v_kind, v_outcome,
    b, pos, v_rank, v_size, v_cat_size, v_score,
    v_prior.bucket, v_prior.position, v_from_score,
    coalesce(v_session_row.strategy, 'bisect'), coalesce(v_session_row.tolerance, 0),
    v_comparisons, coalesce(v_session_row.skips, 0), was_adjusted,
    v_watch_event, session, p_operation_id, v_linked
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

  -- ---------------------------------------------------------------------------
  -- **20261114000300: what a TV correction posts.** Movies are untouched: a film's
  -- correction (Edit ranking, a band change) stays silent, exactly as above.
  --
  -- A show or a season is different because a reader's view of a show moves as they
  -- watch more of it, so re-placing one is news: a standalone correction that actually
  -- moved the title (outcome 'moved') posts one title_ranked marked "update": true. A
  -- correction that landed where it already was posts nothing, so trying it on for size
  -- is still free.
  --
  -- **A linked Update Show posts nothing, ever.** The reader has just ranked a season
  -- (which posted, or will, on its own terms) and is now adjusting the parent show in the
  -- same sitting; the season is the activity. Suppressed here, at write time: nothing is
  -- published and then deleted. Achievements and every other consequence of the
  -- placement still happen as usual.
  -- ---------------------------------------------------------------------------
  if v_linked is not null then
    v_posts := false;
  end if;
  -- 20261129000300: **no TV update post any more.** A correction is silent on every pool, a
  -- film's, a show's and a season's alike (founder, 2026-11-20): `v_posts` above is already
  -- false for a correction (`p_replaces` and no new watch), and nothing sets it back. The
  -- latest watch's existing post takes the new score through
  -- `_correction_follows_latest_watch`, whose TV skip this migration also removes.
  -- `v_tv_update` stays declared and false, so the payload below never carries `update`.

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
      || case when v_tv_update then jsonb_build_object('update', true)
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

  -- 20261114000300: a season's reply says whether its show is ranked, read now, inside the
  -- locks, so the completion screen decides "Update Show" from the database rather
  -- than from a cache that may predate the show's ranking (or its removal).
  if cat = 'tv_seasons' then
    select s.parent_id, pr.bucket
      into v_parent, v_parent_bucket
      from media_items s
      left join rankings pr
        on pr.user_id = target and pr.media_item_id = s.parent_id
     where s.id = item;
  end if;

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
    'linked_placement_id', v_linked,
    'parent', case when v_parent is not null then jsonb_build_object(
      'media_item_id', v_parent,
      'ranked', v_parent_bucket is not null,
      'bucket', v_parent_bucket
    ) end,
    'movement', jsonb_build_object(
      'outcome', v_outcome,
      'from_position', v_prior.position,
      'from_score', v_from_score,
      'kind', v_kind
    )
  );
end;
$function$;

revoke execute on function _rank_finalize(
  uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean,
  placement_kind, uuid, uuid
) from public, anon, authenticated;

create or replace function _correction_follows_latest_watch()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_post uuid;
begin
  -- 20261129000300: no pool skips this any more. A TV correction wrote an update post
  -- carrying its score until now; it writes nothing, so the latest watch's existing post is
  -- where its score lands, exactly as for a film.

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

-- ===========================================================================
-- 3. A show placed by hand: the record, and the marker its side effects listen for
--
-- **What a promotion is.** On the TV wall a series without an explicit show ranking is
-- shown at its seasons' average (`SN AVG`). Dragging that poster is the reader saying
-- "this show goes here", so it becomes an explicit `tv_shows` ranking at that place, with
-- the score that place has, exactly as if it had been ranked there. It is NOT derived from
-- the seasons (20261114000200's rule stands: nothing is computed across the two TV
-- levels); the seasons only decided where the poster was drawn before the drag.
--
-- **What it is not.** It is not a watch, a log or a post. A ranking needs a collection
-- row (I3 and `ranking_placements_collection_fk`), and creating one would ordinarily set
-- off the watch backstop (an undated "watched, time unknown" event), the rankings award
-- (an award post), the watchlist rule and the provenance flip. Each of those listens for
-- `_show_promoting`, which is true only inside the promotion's own transaction and only for
-- its own title. A placement is not a watch signal, so a show still on the watchlist (a
-- series stays there until its released seasons are seen) stays on it; nothing about it
-- has to be restored by Undo, and no watchlist award can be revoked by a promotion.
--
-- **Evidence.** The series row has no watch event of its own. W1 now accepts a series'
-- seasons' events as its evidence (`_show_seen_through_seasons`, the same rule
-- `_viewer_has_seen` already reads), and if those seasons later leave the collection while
-- the show stays ranked, the show gets the ordinary undated backstop event at that point
-- (`_a_placed_show_keeps_its_evidence`), so W1 never fails.
-- ===========================================================================

create or replace function _show_promoting(p_media_item_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('bingd.show_promotion', true), '')
       = txid_current()::text || ':' || p_media_item_id::text;
$$;
comment on function _show_promoting(uuid) is
  'True inside rank_promote_show / rank_unpromote_show for that title only. The watch '
  'backstop, the rankings and watchlist awards and the provenance flip stand aside for it '
  '(20261129000300). Same construction as _watch_backstopping().';
revoke execute on function _show_promoting(uuid) from public, anon, authenticated;

create or replace function _show_seen_through_seasons(p_user uuid, p_series uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from watch_events we
      join media_items s on s.id = we.media_item_id
     where we.user_id = p_user
       and s.parent_id = p_series
       and s.kind = 'season'
  );
$$;
comment on function _show_seen_through_seasons(uuid, uuid) is
  'A season of this series has a watch event for this reader: W1''s evidence for a series '
  'with none of its own (20261129000300).';
revoke execute on function _show_seen_through_seasons(uuid, uuid) from public, anon, authenticated;

/**
 * One promoted show's evidence, checked and backfilled by one transaction at a time (Codex,
 * PR 319): the promotion's commit-time backstop and a season removal's commit-time check
 * must each see what the other committed, or both can pass and leave a ranked show with no
 * evidence at all. A transaction-scoped key, released at commit.
 */
create or replace function _lock_series_evidence(p_user uuid, p_series uuid)
returns void
language sql
set search_path = public
as $$
  select pg_advisory_xact_lock(
    hashtextextended('series-evidence:' || p_user::text || ':' || p_series::text, 0));
$$;
revoke execute on function _lock_series_evidence(uuid, uuid) from public, anon, authenticated;

create table show_promotions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  media_item_id    uuid not null references media_items(id) on delete cascade,
  -- The promotion's placement. Null once the placement is gone: an Undo that removed the
  -- collection row it created takes the row's placements with it (the FK cascades).
  placement_id     uuid references ranking_placements(id) on delete set null,
  -- The collection row before the promotion: whether there was one, and its category.
  had_row          boolean not null,
  prior_bucket     taste_bucket,
  created_at       timestamptz not null default now(),
  undone_at        timestamptz
);
comment on table show_promotions is
  'One row per TV wall promotion (rank_promote_show): what the collection row was before, so '
  'rank_unpromote_show can restore it. Server-only.';

create index show_promotions_user_item on show_promotions (user_id, media_item_id);
create unique index show_promotions_placement on show_promotions (placement_id)
  where placement_id is not null;

alter table show_promotions enable row level security;
revoke all on table show_promotions from public, anon, authenticated;


-- ===========================================================================
-- 4. The backstop, which a promotion does not need (rebuilt from 20261003000100)
-- ===========================================================================

create or replace function _seen_implies_a_watch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The row may be gone by commit: logged and unlogged in one transaction, or removed by
  -- a cascade. Nothing to attach an event to, and the FK would refuse it anyway.
  if not exists (
    select 1 from user_media um
     where um.user_id = new.user_id and um.media_item_id = new.media_item_id
  ) then
    return null;
  end if;

  if (select rankable_category(m.kind) from media_items m where m.id = new.media_item_id)
     is null then
    return null;
  end if;

  -- 20261129000300: **a promoted show is seen through its seasons.** `rank_promote_show`
  -- creates a series' collection row so its explicit ranking has one (I3, and the
  -- placement's FK), and the founder's rule is that placing a show yourself is not a
  -- watch: no event, no Watch History entry. W1 accepts the seasons' events as the
  -- series' evidence (`assert_watch_history_valid` below), so the backstop has nothing to
  -- add. Scoped to the promotion's own transaction and title by the marker, and to a
  -- series that has that evidence; every other writer still gets the backstop verbatim.
  if _show_promoting(new.media_item_id) then
    -- Serialised with a season removal's own check (Codex, PR 319): whichever commits
    -- second sees the other. If the seasons' evidence went first, the show gets its
    -- ordinary backstop event below; W1 holds either way.
    perform _lock_series_evidence(new.user_id, new.media_item_id);
    if _show_seen_through_seasons(new.user_id, new.media_item_id) then
      return null;
    end if;
  end if;

  if exists (
    select 1 from watch_events we
     where we.user_id = new.user_id and we.media_item_id = new.media_item_id
  ) then
    return null;
  end if;

  -- ===========================================================================
  -- THE BACKSTOP MARKS ITSELF, AND THE WATCHLIST RULE LISTENS
  --
  -- This event is bookkeeping: it exists so the invariant holds, not because anybody
  -- said they watched anything just now. The `watch_events` watchlist triggers in §6
  -- would otherwise read it as a watch signal, and `correction-is-not-a-ranking.test.mjs`
  -- caught exactly what that costs:
  --
  --   the reader puts a film on their watchlist
  --   they write a note on it -- "someone recommended it" -- and nothing else
  --   `log_watched` creates the collection row with no bucket and no date
  --   this trigger gives it an undated event
  --   §D.2's rule reads an undated event as contemporaneous, and the entry is gone
  --
  -- A note is not a watch signal and never has been (20260815040000: the `user_media`
  -- triggers fire on a bucket, a date or a completed season, and a note is none of
  -- those). The marker is what keeps that true, and it is scoped to the insert rather
  -- than to the transaction so a deliberate write later in the same transaction still
  -- gets the ordinary rule.
  --
  -- The DELIBERATE writers -- `log_title`, `log_rewatch`, `set_watch_date`,
  -- `edit_watch_event` -- set no marker, so §D.2's rule applies to them verbatim,
  -- chronology and all.
  -- ===========================================================================
  perform set_config('bingd.watch_backstop', txid_current()::text, true);

  -- ===========================================================================
  -- **THE ROW'S OWN DATE IS CARRIED INTO ITS EVENT, AND IT HAS TO BE**
  --
  -- The obvious backstop creates an undated event unconditionally. That is wrong for any
  -- writer that inserts `user_media` with a `watched_on` already on it, and the failure
  -- is silent and total: the undated event lands, the cache trigger recomputes
  -- `watched_on` as `max(events)` -- which is now null -- and **the date the writer just
  -- wrote is erased**. `leaderboard.test.mjs` and `goal-completion.test.mjs` seed rows
  -- exactly that way and caught it; so does anything a future migration backfills.
  --
  -- No writer in the tree does this after T1 -- `log_watched` writes the event and
  -- `_import_apply_batch` writes its own -- which is precisely why it had to be handled
  -- here rather than in each of them. A backstop that only works for the writers that
  -- did not need it is not a backstop.
  --
  -- The basis is `unattributed`, for the same reason `log_watched`'s is: the server did
  -- not see a reader choose this date and will not claim it did. On an IMPORTED row it
  -- is `diary`, because there the date came from the archive and calling it native would
  -- put an import on the monthly board at T4 and flip the row's provenance to `in_app`.
  --
  -- **The row's own `source` decides that, not `_importing()`.** The marker is set by
  -- the apply path and by nothing else, so a writer that creates an imported row outside
  -- it — a backfill, a repair script, a test fixture — would have its date called
  -- native. `import-pipeline.test.mjs` does exactly that and caught it: a row inserted
  -- with `source = 'imported'` was being flipped to `in_app` by its own backstop event.
  -- `source` is the durable fact; the marker is a property of one code path.
  --
  -- `recorded_at` is the collection row's own creation instant, not `now()`. At commit
  -- those are the same thing for a live write, and they are NOT the same thing for the
  -- backfill -- where the honest recording time of "they told us they had seen this" is
  -- the day the row appeared, years ago, and `now()` would claim the whole library was
  -- disclosed during a migration.
  -- ===========================================================================
  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select um.user_id, um.media_item_id, um.watched_on,
         case
           when um.watched_on is null       then 'none'::watch_date_basis
           when um.source <> 'in_app'       then 'diary'::watch_date_basis
           else 'unattributed'::watch_date_basis
         end,
         um.created_at
    from user_media um
   where um.user_id = new.user_id and um.media_item_id = new.media_item_id;

  perform set_config('bingd.watch_backstop', '', true);

  return null;
end;
$$;
revoke execute on function _seen_implies_a_watch() from public, anon, authenticated;

-- ===========================================================================
-- 5. W1, for a show seen through its seasons (rebuilt from 20261003000100)
-- ===========================================================================

create or replace function assert_watch_history_valid(p_user uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bad integer;
  v_id  text;
begin
  -- W1. A seen title of a rankable kind has at least one watch event (§D.0).
  select count(*), min(um.media_item_id::text) into v_bad, v_id
    from user_media um
    join media_items m on m.id = um.media_item_id
   where (p_user is null or um.user_id = p_user)
     and rankable_category(m.kind) is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = um.user_id and we.media_item_id = um.media_item_id
     )
     -- 20261129000300: a series is also seen through a season of it that has a watch,
     -- the same rule `_viewer_has_seen` reads. Only a promoted show relies on it: every
     -- other series row still gets its own event from the backstop.
     and not (m.kind = 'series' and _show_seen_through_seasons(um.user_id, um.media_item_id));
  if v_bad > 0 then
    raise exception 'W1 violated: % seen titles have no watch event (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W2. `basis = none` <=> no date. The table constraint enforces it row by row; this
  -- asks the same question of the whole table, which is what catches a constraint
  -- somebody dropped to make a migration pass.
  select count(*), min(we.id::text) into v_bad, v_id
    from watch_events we
   where (p_user is null or we.user_id = p_user)
     and (we.basis = 'none') <> (we.watched_on is null);
  if v_bad > 0 then
    raise exception 'W2 violated: % events disagree with their basis (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W3. The cache equals the maximum. The one that catches drift (§O.6.2), and the
  -- reason the cache is recomputed rather than advanced.
  select count(*), min(um.media_item_id::text) into v_bad, v_id
    from user_media um
    join media_items m on m.id = um.media_item_id
   where (p_user is null or um.user_id = p_user)
     and rankable_category(m.kind) is not null
     and um.watched_on is distinct from (
       select max(we.watched_on) from watch_events we
        where we.user_id = um.user_id and we.media_item_id = um.media_item_id
     );
  if v_bad > 0 then
    raise exception 'W3 violated: % cached dates differ from max(event) (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W4. No event belongs to a title that is not seen. The composite FK guarantees it;
  -- stating it here is what would catch the FK being dropped, which is exactly the shape
  -- of a "make the migration apply" fix.
  select count(*), min(we.id::text) into v_bad, v_id
    from watch_events we
   where (p_user is null or we.user_id = p_user)
     and not exists (
       select 1 from user_media um
        where um.user_id = we.user_id and um.media_item_id = we.media_item_id
     );
  if v_bad > 0 then
    raise exception 'W4 violated: % events have no collection row (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- W5. Every diary event the import recorded is present, and none was invented.
  select count(*) into v_bad
    from imported_watches iw
    join user_media um
      on um.user_id = iw.user_id and um.media_item_id = iw.media_item_id
    join media_items m on m.id = iw.media_item_id
   where (p_user is null or iw.user_id = p_user)
     and rankable_category(m.kind) is not null
     and not exists (
       select 1 from watch_events we
        where we.user_id = iw.user_id and we.import_ref = iw.diary_uri
     );
  if v_bad > 0 then
    raise exception 'W5 violated: % diary entries have no watch event', v_bad
      using errcode = 'P0001';
  end if;
end;
$$;
comment on function assert_watch_history_valid(uuid) is
  'W1 a seen rankable title has >= 1 watch event (a series: of its own or of one of its '
  'seasons, 20261129000300); W2 basis none <=> no date; W3 the '
  'user_media.watched_on cache equals max(event date); W4 no event without a collection '
  'row; W5 every imported_watches row has its diary event. Raises P0001 naming the first '
  'violation and an example. Peer of assert_ranking_valid, and the gate the staging and '
  'production verification runs call.';

revoke execute on function assert_watch_history_valid(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 6. What a promotion does not set off: an award post, a watchlist removal, a provenance flip
-- ===========================================================================

create or replace function _award_touch_ranking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 20261129000300: a promotion re-arranges what the reader already told us; it is not a
  -- new ranking to celebrate (no post, founder 2026-11-20). The next real ranking counts it.
  if _show_promoting(new.media_item_id) then return null; end if;
  perform _maybe_award_unlocks(new.user_id, array['rating-rascal']);
  return null;
end;
$$;
revoke execute on function _award_touch_ranking() from public, anon, authenticated;

create or replace function _leave_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- ===========================================================================
  -- WHY THE ROW IS READ AS JSON AND NOT AS FIELDS
  --
  -- One trigger function is now attached to three tables with three different shapes.
  -- **plpgsql resolves `new.<field>` when it PARSES the statement, not when it
  -- evaluates it**, so a `case` whose `rankings` branch names `new.created_at` fails
  -- with `record "new" has no field "created_at"` the first time a `watch_events`
  -- insert reaches it -- the branch is never taken and it fails anyway. Caught by
  -- watch-events.test.mjs on the first run, which is the point of running it.
  --
  -- `to_jsonb(new)` works on any record shape, and an absent key is a null rather than
  -- an error. The branch that is not taken reads a null it never looks at.
  -- ===========================================================================
  v_new jsonb := to_jsonb(new);
  -- Whether this event is the title's FIRST viewing. See the note on the chronology
  -- guard below; only the `watch_events` branch reads it.
  v_first boolean;
begin
  -- ===========================================================================
  -- A BULK WRITE OF HISTORY IS NOT A READER WATCHING SOMETHING
  --
  -- Only for `watch_events`, and only inside an import or the T1 backfill. Replaying
  -- fifteen months of diary entries through this rule would empty every reader's
  -- watchlist, because a historical viewing is older than a watchlist entry only by
  -- accident and the chronology guard below admits the ones that are not. The importer
  -- decides the watchlist for itself -- `_import_apply_batch` writes those rows
  -- explicitly, and "watched beats wanting to watch" is already its rule.
  --
  -- Scoped to `watch_events` rather than applied to the whole function, because the
  -- `user_media` insert path DOES clear the watchlist during an import and has since
  -- 20260815040000. Widening this guard would change that behaviour silently.
  --
  -- **And the backstop event is not a watch signal either** (`_watch_backstopping`).
  -- A note written on a title nobody has watched creates a collection row, which gets
  -- an undated event from `_seen_implies_a_watch` -- and §D.2's rule reads an undated
  -- event as contemporaneous, so without this the note would clear the watchlist entry.
  -- A note has never been a watch signal. The full reasoning is on that function.
  -- ===========================================================================
  if tg_table_name = 'watch_events' and (_importing() or _watch_backstopping()) then
    return null;
  end if;

  -- 20261129000300: a promotion is a placement, not a watch signal (Codex, PR 319). A show
  -- still on the watchlist stays on it, so Undo has nothing to put back and no watchlist
  -- award can be revoked by a drag.
  if tg_table_name <> 'watch_events' and _show_promoting(new.media_item_id) then
    return null;
  end if;

  -- ===========================================================================
  -- THE CHRONOLOGY GUARD APPLIES TO A LATER VIEWING, NOT TO THE FIRST ONE
  --
  -- §D.2 states the rule as "a new event clears the watchlist row only if
  -- `coalesce(watched_on, current_date) >= watchlist.created_at::date`", and its
  -- rationale is one sentence long: *a backdated entry doesn't consume a fresh "watch
  -- again" intention*. That rationale is about a title the reader has ALREADY watched,
  -- put back on the watchlist to see again, and then back-filled with an old viewing.
  --
  -- Applied to a title's first viewing it says something the rationale does not:
  -- `watchlist-invariant.test.mjs` adds Solaris to the watchlist and immediately logs
  -- it as watched on 1 August, and the bare rule leaves it on the watchlist -- so a
  -- reader who taps *watched it* from the watchlist and picks a past date is told
  -- nothing happened. "Watched beats wanting to watch" has been the invariant since
  -- 20260815040000 and nothing in the epic proposes changing it.
  --
  -- So the guard is applied where its own reasoning applies: **when the title already
  -- had a viewing before this one.** A first viewing clears the entry whatever its date,
  -- which is exactly what `user_media_insert_leaves_watchlist` did before T1 moved the
  -- job here. A second or later viewing is compared on its own day.
  --
  -- **This is a narrowing of §D.2 as written, and it is deliberate.** It is recorded
  -- here rather than applied quietly because it is the one place in T1 where the letter
  -- of the PRD and a pinned invariant disagreed, and the founder may prefer the letter.
  -- Reverting to it is deleting the `v_first` disjunct.
  -- ===========================================================================
  if tg_table_name = 'watch_events' then
    v_first := not exists (
      select 1 from public.watch_events we
       where we.user_id = new.user_id
         and we.media_item_id = new.media_item_id
         and we.id <> new.id
    );
  end if;

  delete from public.watchlist w
   where w.user_id = new.user_id
     and w.media_item_id = new.media_item_id
     and case tg_table_name
           -- 20261001000100, transcribed. An entry the reader put on the watchlist
           -- AFTER this ranking's instant is a newer, deliberate "I want to see this
           -- again" and outlives it.
           when 'rankings'     then w.created_at <= (v_new ->> 'created_at')::timestamptz
           -- 20261003000100, §D.2. An undated event is contemporaneous by construction:
           -- it was recorded now, and `current_date` is the honest stand-in for a
           -- viewing whose timing nobody knows. A dated one is compared on its own day.
           when 'watch_events'
             then v_first
               or coalesce((v_new ->> 'watched_on')::date, current_date) >= w.created_at::date
           -- `user_media`: the rule as it was.
           else true
         end;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;
revoke execute on function _leave_watchlist() from public, anon, authenticated;

create or replace function _ranking_is_a_native_action()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if _importing() then return null; end if;
  -- 20261129000300: a promotion keeps the collection row's provenance as it was, so its
  -- Undo restores the row exactly (the in_app ratchet could not be wound back).
  if _show_promoting(new.media_item_id) then return null; end if;

  update user_media
     set source = 'in_app'
   where user_id = new.user_id
     and media_item_id = new.media_item_id
     and source = 'imported';

  return null;
end;
$$;
revoke execute on function _ranking_is_a_native_action() from public, anon, authenticated;

create or replace function _source_follows_the_watch()
returns trigger
language plpgsql
-- SECURITY DEFINER for the reason 20260917000200 gave: it calls `_importing()`, whose
-- EXECUTE is revoked from `authenticated`, and it now calls `_watch_caching()` too.
security definer
set search_path = public
as $$
begin
  -- The ratchet. Applies during an import too: an import may not reclaim a row that a
  -- native action has already taken, which is exactly what a second import of the same
  -- archive would otherwise do.
  if old.source = 'in_app' then
    new.source := 'in_app';
    return new;
  end if;

  -- Inside an import, nothing else here applies: the import is allowed to write watch
  -- signals onto its own rows without that counting as having done it here.
  if _importing() then
    return new;
  end if;

  -- 20261129000300: a promotion's (and its Undo's) category change on a show is not a
  -- native watch signal; the row keeps its provenance, so Undo restores it exactly.
  if _show_promoting(new.media_item_id) then
    return new;
  end if;

  -- 20261003000100. The cache is bookkeeping, not an act, and it now follows diary
  -- dates as readily as native ones. The provenance flip moved to `watch_events`
  -- (`_provenance_follows_the_event` below), where the basis is visible.
  if _watch_caching() then
    return new;
  end if;

  -- A watch signal recorded in the app. `is distinct from` rather than `<>` so a
  -- transition out of null counts, and the `not null` test so that *removing* a signal --
  -- `clear_watch_date` -- is not mistaken for recording one.
  --
  -- 20261003000100: the `watched_on` clause is kept for the one case the cache marker
  -- does not cover -- a direct write by something that is not the cache trigger. There
  -- is no such writer in the tree after this migration, and leaving the clause costs
  -- nothing; removing it would silently widen the window if one ever came back.
  if (new.watched_on is not null and new.watched_on is distinct from old.watched_on)
     or (new.bucket is not null and new.bucket is distinct from old.bucket)
     or (new.progress = 'completed' and new.progress is distinct from old.progress)
  then
    new.source := 'in_app';
  end if;

  return new;
end;
$$;
revoke execute on function _source_follows_the_watch() from public, anon, authenticated;

-- ===========================================================================
-- 7. Evidence that outlives its seasons
--
-- A promoted show is seen through its seasons (W1). If every season with a watch leaves
-- the collection while the show stays, the show keeps its ranking and is still seen: the
-- reader placed it. At that point, and only then, it gets the ordinary undated backstop
-- event ("watched, time unknown"), marked as the backstop so the watchlist rules ignore it
-- exactly as they ignore the backstop's own. Deferred to commit, like the backstop, so a
-- transaction that removes the show too leaves nothing behind.
-- ===========================================================================

create or replace function _a_placed_show_keeps_its_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_series uuid;
begin
  select m.parent_id into v_series
    from media_items m where m.id = old.media_item_id and m.kind = 'season';
  if v_series is null then
    return null;
  end if;

  -- One check-and-backfill per reader and series at a time (Codex, PR 319): two devices
  -- removing the last two seasons each see the other's season still there unless the
  -- second waits for the first to commit. Every read below is a new statement, so it sees
  -- what the first committed.
  perform _lock_series_evidence(old.user_id, v_series);

  if not exists (
       select 1 from user_media um
        where um.user_id = old.user_id and um.media_item_id = v_series
     )
     or exists (
       select 1 from watch_events we
        where we.user_id = old.user_id and we.media_item_id = v_series
     )
     or _show_seen_through_seasons(old.user_id, v_series)
  then
    return null;
  end if;

  perform set_config('bingd.watch_backstop', txid_current()::text, true);

  insert into watch_events (user_id, media_item_id, watched_on, basis, recorded_at)
  select um.user_id, um.media_item_id, um.watched_on,
         case
           when um.watched_on is null       then 'none'::watch_date_basis
           when um.source <> 'in_app'       then 'diary'::watch_date_basis
           else 'unattributed'::watch_date_basis
         end,
         um.created_at
    from user_media um
   where um.user_id = old.user_id and um.media_item_id = v_series;

  perform set_config('bingd.watch_backstop', '', true);
  return null;
end;
$$;
comment on function _a_placed_show_keeps_its_evidence() is
  'When a season leaves the collection and its series is left seen with no watch of its '
  'own or of any season (a promoted show, 20261129000300), the series gets the backstop''s '
  'undated event. Keeps W1 true without ever creating an event at promotion time.';
revoke execute on function _a_placed_show_keeps_its_evidence() from public, anon, authenticated;

create constraint trigger user_media_placed_show_keeps_its_evidence
  after delete on user_media
  deferrable initially deferred
  for each row execute function _a_placed_show_keeps_its_evidence();


-- ===========================================================================
-- 8. rank_promote_show: the SN AVG poster, placed where it was dropped
--
-- Guards, in the §9 order (media lock, then the category locks: the seasons', so no
-- season of this show can be unranked under it, then the shows'):
--   * a series, not already ranked as a show (55000: the client's wall is stale);
--   * with at least one ranked season, which is what drew it at an average (55000);
--   * a target inside the chosen category's run, with one more place: lo .. lo + size
--     (22023), the same rule `rank_reorder` applies to a title arriving from outside;
--   * the anchor: the show the client saw at that position is still there (55000), or,
--     for a drop past the last show, that there is still none.
-- Writes, and nothing else: the ranking (positions at and below the target shift down
-- by one, as an insertion), the collection row's bucket (I3), one `manual` placement with
-- outcome `placed` (P4: no prior), and the `show_promotions` record. No comparison,
-- watch, session, post, notification or award, and the watchlist is left as it is (a
-- placement is not a watch signal). Season rankings are not read for scoring and not
-- written.
-- ===========================================================================

create or replace function rank_promote_show(
  p_media_item_id        uuid,
  p_new_position         integer,
  p_new_bucket           taste_bucket,
  p_operation_id         uuid default null,
  p_anchor_media_item_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_claim     record;
  v_band      record;
  v_after     record;
  v_anchor    uuid;
  v_cat_size  integer;
  v_rank      integer;
  v_score     numeric;
  v_had_row   boolean;
  v_prior     taste_bucket;
  v_placement uuid;
  v_reply     jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  if p_new_bucket is null or p_new_position is null then
    raise exception 'a promotion needs a place and a rating category' using errcode = '22023';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_promote_show');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', true, 'position', p_new_position));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  if (select m.kind from media_items m where m.id = p_media_item_id) is distinct from 'series' then
    raise exception 'only a whole show is promoted' using errcode = '22023';
  end if;

  if exists (select 1 from rankings r
              where r.user_id = v_user and r.media_item_id = p_media_item_id) then
    raise exception 'the ranking changed: this show is already ranked' using errcode = '55000';
  end if;

  -- The seasons' category lock, then the shows' (Codex, PR 319). A season of this show
  -- can be unranked only under the first, so the check below, made inside it, still holds
  -- at commit. No other writer holds two category locks, so the order cannot deadlock.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || 'tv_seasons', 0));
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || 'tv_shows', 0));

  if not exists (
    select 1 from rankings r join media_items s on s.id = r.media_item_id
     where r.user_id = v_user and r.category = 'tv_seasons'
       and s.parent_id = p_media_item_id and s.kind = 'season'
  ) then
    raise exception 'the ranking changed: this show has no ranked season' using errcode = '55000';
  end if;

  select * into v_band from band_bounds(v_user, 'tv_shows', p_new_bucket);
  if p_new_position < v_band.lo or p_new_position > v_band.lo + v_band.size then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, p_new_bucket, v_band.lo, v_band.lo + v_band.size
      using errcode = '22023';
  end if;

  select r.media_item_id into v_anchor from rankings r
   where r.user_id = v_user and r.category = 'tv_shows' and r.position = p_new_position;
  if p_anchor_media_item_id is distinct from v_anchor then
    raise exception 'the ranking changed: another show is at position % now', p_new_position
      using errcode = '55000';
  end if;

  select true, um.bucket into v_had_row, v_prior
    from user_media um where um.user_id = v_user and um.media_item_id = p_media_item_id;
  v_had_row := coalesce(v_had_row, false);

  perform set_config('bingd.show_promotion', txid_current()::text || ':' || p_media_item_id::text, true);

  update rankings set position = position + 1
   where user_id = v_user and category = 'tv_shows' and position >= p_new_position;

  insert into user_media (user_id, media_item_id, bucket)
  values (v_user, p_media_item_id, p_new_bucket)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket, updated_at = now()
   where user_media.bucket is distinct from excluded.bucket;

  insert into rankings (user_id, media_item_id, category, bucket, position)
  values (v_user, p_media_item_id, 'tv_shows', p_new_bucket, p_new_position);

  select * into v_after from band_bounds(v_user, 'tv_shows', p_new_bucket);
  v_rank  := p_new_position - v_after.lo + 1;
  v_score := score_for(p_new_bucket, v_rank, v_after.size);
  select count(*)::integer into v_cat_size
    from rankings r where r.user_id = v_user and r.category = 'tv_shows';

  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    from_bucket, from_position, from_score,
    strategy, tolerance, comparisons, skips, adjustable,
    watch_event_id, session_id, operation_id, linked_placement_id
  )
  values (
    v_user, p_media_item_id, 'tv_shows', 'manual', 'placed',
    p_new_bucket, p_new_position, v_rank, v_after.size, v_cat_size, v_score,
    null, null, null,
    null, 0, 0, 0, false,
    null, null, p_operation_id, null
  )
  returning id into v_placement;

  insert into show_promotions (user_id, media_item_id, placement_id, had_row, prior_bucket)
  values (v_user, p_media_item_id, v_placement, v_had_row, v_prior);

  -- The marker stays set until commit on purpose: the backstop it excuses is deferred.

  v_reply := jsonb_build_object(
    'done', true, 'promoted', true, 'moved', true,
    'position', p_new_position, 'category', 'tv_shows',
    'bucket', p_new_bucket, 'band_lo', v_after.lo, 'band_size', v_after.size,
    'score', v_score, 'placement_id', v_placement
  );
  return _record_operation_result(p_operation_id, v_reply);
end;
$$;

comment on function rank_promote_show(uuid, integer, taste_bucket, uuid, uuid) is
  'TV wall drag of a show shown at its seasons'' average (#319, 20261129000300): gives it '
  'an explicit tv_shows ranking at p_new_position in p_new_bucket, with that place''s score. '
  'Refuses a non-series (22023), a show already ranked or with no ranked season (55000), a '
  'place outside lo..lo+size of the category (22023) and a stale anchor (55000). Writes one '
  'manual placed placement; never a watch, comparison, post, notification or award. Seasons '
  'are untouched. Undo: rank_unpromote_show.';

revoke execute on function rank_promote_show(uuid, integer, taste_bucket, uuid, uuid) from public, anon;
grant  execute on function rank_promote_show(uuid, integer, taste_bucket, uuid, uuid) to authenticated;


-- ===========================================================================
-- 9. rank_unpromote_show: Undo, exactly, or not at all
--
-- Restores the average-only state the promotion replaced, and only while nothing has
-- happened to the show since: the promotion must still be its latest placement and not
-- already undone, and the show must be where the client last saw it (55000 otherwise; the
-- client then says the ranking changed, as every other stale Undo does).
--
-- The show's ranking is removed and the shows below close up. The collection row goes
-- back to what it was: removed if the promotion created it and it still carries nothing
-- of its own (no note, no progress, no watch), else its category is set back. The
-- watchlist was never touched. Seasons, their rankings and every watch are untouched.
-- ===========================================================================

create or replace function rank_unpromote_show(
  p_media_item_id     uuid,
  p_placement_id      uuid,
  p_operation_id      uuid    default null,
  p_expected_position integer default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_claim  record;
  v_r      record;
  v_promo  record;
  v_latest uuid;
  v_bare   boolean;
  v_reply  jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_unpromote_show');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || 'tv_shows', 0));

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id and category = 'tv_shows';
  if v_r.media_item_id is null then
    raise exception 'the ranking changed: this show is not ranked now' using errcode = '55000';
  end if;

  if p_expected_position is not null and v_r.position <> p_expected_position then
    raise exception 'the ranking changed: this show is at % now, not %',
      v_r.position, p_expected_position using errcode = '55000';
  end if;

  select * into v_promo from show_promotions sp
   where sp.user_id = v_user and sp.media_item_id = p_media_item_id
     and sp.placement_id = p_placement_id and sp.undone_at is null
   for update;
  if v_promo.id is null then
    raise exception 'the ranking changed: that promotion cannot be undone' using errcode = '55000';
  end if;

  select p.id into v_latest from ranking_placements p
   where p.user_id = v_user and p.media_item_id = p_media_item_id
   order by p.created_at desc, p.id desc
   limit 1;
  if v_latest is distinct from p_placement_id then
    raise exception 'the ranking changed: this show was placed again since' using errcode = '55000';
  end if;

  perform set_config('bingd.show_promotion', txid_current()::text || ':' || p_media_item_id::text, true);

  update show_promotions set undone_at = now() where id = v_promo.id;

  delete from rankings where user_id = v_user and media_item_id = p_media_item_id;
  update rankings set position = position - 1
   where user_id = v_user and category = 'tv_shows' and position > v_r.position;

  select um.note is null and um.progress is null
         and not exists (select 1 from watch_events we
                          where we.user_id = um.user_id and we.media_item_id = um.media_item_id)
    into v_bare
    from user_media um where um.user_id = v_user and um.media_item_id = p_media_item_id;

  if not v_promo.had_row and coalesce(v_bare, false) then
    delete from user_media where user_id = v_user and media_item_id = p_media_item_id;
  else
    update user_media set bucket = v_promo.prior_bucket, updated_at = now()
     where user_id = v_user and media_item_id = p_media_item_id
       and bucket is distinct from v_promo.prior_bucket;
  end if;

  v_reply := jsonb_build_object(
    'done', true, 'unpromoted', true,
    'from_position', v_r.position, 'category', 'tv_shows', 'from_bucket', v_r.bucket
  );
  return _record_operation_result(p_operation_id, v_reply);
end;
$$;

comment on function rank_unpromote_show(uuid, uuid, uuid, integer) is
  'Undo of rank_promote_show (#319, 20261129000300). Only while that promotion is the show''s '
  'latest placement, not undone, and the show is at p_expected_position (55000 otherwise). '
  'Removes the show ranking, closes up the shows below and restores the collection row as it '
  'was. Seasons, watches and the watchlist are untouched; nothing is posted.';

revoke execute on function rank_unpromote_show(uuid, uuid, uuid, integer) from public, anon;
grant  execute on function rank_unpromote_show(uuid, uuid, uuid, integer) to authenticated;
