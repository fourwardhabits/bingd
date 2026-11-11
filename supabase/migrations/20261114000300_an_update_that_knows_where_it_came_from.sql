-- An update that knows where it came from (TV show & season ranking, WS4: Update Show and
-- the Feed contract for TV).
--
-- Depends on 20261114000200 (a show is rankable, category tv_shows).
--
-- The product contract this implements (founder brief §5-§6):
--
--   Rank a show / a season on its own          one ranking activity (unchanged)
--   Update a show / a season on its own        one ranking-update activity (NEW for TV)
--   Rank a season, then Update Show            the season's activity only
--   Abandon the linked Update Show             the season's activity remains, nothing else
--   Movies                                     unchanged: a correction posts nothing
--
-- **Provenance, carried rather than inferred.** "Update Show" is offered on the season's
-- completion screen and opens an ordinary correction of the parent show (`rank_again` with
-- the band it has, `rank_rebucket` for a band change), anchored at the show's current
-- place by the existing prior strategy. The client passes `p_linked_placement_id`, the
-- season placement that offered it. That id rides on the session
-- (`ranking_sessions.linked_placement_id`) to `_rank_finalize`, which records it on the
-- show's ledger row and posts nothing. No timestamp is read to decide any of this: a
-- ranking timestamp is not proof of a recent watch.
--
-- The link is checked, under the media lock, by `_assert_linked_show_update`: the
-- placement is the caller's own, it is a `first` or `rewatch` placement of a season of
-- this show (so never a backlog sitting's silent `import`, a Refine pass or a pure
-- correction), the show is already ranked, and no earlier placement already took that
-- link. An abandoned Update Show finalises nothing, so it spends nothing and leaves the
-- show's ranking exactly where it was (I6).
--
-- **Old clients.** `rank_again` and `rank_rebucket` gain one trailing parameter with a
-- default, so every installed call is unchanged; PostgREST resolves named arguments. The
-- old signatures are dropped, not overloaded, because two candidates for one call are an
-- ambiguity PostgreSQL refuses (the 20261004000100 precedent). `_rank_finalize`'s reply
-- gains `linked_placement_id` and, for a season, `parent` (is the show ranked, and in
-- which band); old clients ignore both. A TV update post is an ordinary `title_ranked`
-- with `"update": true`, so an installed client draws it as a ranking: the one visible
-- difference, and the recoverable direction.
--
-- Every function below is copied from its live definition and changed only where a
-- 20261114000300 comment says so.

-- ===========================================================================
-- 1. Schema, additive only
-- ===========================================================================

alter table ranking_placements
  add column if not exists linked_placement_id uuid
    references ranking_placements(id) on delete set null;
comment on column ranking_placements.linked_placement_id is
  'Set on a show correction made from a season''s completion screen (Update Show): the season placement that offered it. Provenance only: it decides that the show''s correction posts nothing, and that the same season placement cannot link a second one.';
create index if not exists ranking_placements_linked
  on ranking_placements (linked_placement_id) where linked_placement_id is not null;

alter table ranking_sessions
  add column if not exists linked_placement_id uuid
    references ranking_placements(id) on delete set null;
comment on column ranking_sessions.linked_placement_id is
  'The season placement an open Update Show session was offered by; carried to _rank_finalize. Null for every other session.';

-- ===========================================================================
-- 2. The link, checked
-- ===========================================================================

create or replace function _assert_linked_show_update(
  p_user uuid, p_show uuid, p_linked_placement_id uuid
) returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_linked_placement_id is null then
    return;
  end if;

  if not exists (
    select 1
      from ranking_placements p
      join media_items s on s.id = p.media_item_id
     where p.id = p_linked_placement_id
       and p.user_id = p_user
       and s.kind = 'season'
       and s.parent_id = p_show
       and p.kind in ('first', 'rewatch')
  ) then
    raise exception 'that is not a season of this show you just ranked'
      using errcode = 'P0002';
  end if;

  if not exists (select 1 from rankings r
                  where r.user_id = p_user and r.media_item_id = p_show) then
    raise exception 'the show is not ranked, so there is nothing to update'
      using errcode = 'P0002';
  end if;

  if exists (select 1 from ranking_placements q
              where q.user_id = p_user
                and q.linked_placement_id = p_linked_placement_id) then
    raise exception 'the show was already updated from that season'
      using errcode = '23505';
  end if;
end;
$$;

revoke execute on function _assert_linked_show_update(uuid, uuid, uuid)
  from public, anon, authenticated;

-- ===========================================================================
-- 3. The session opener and the finaliser carry the link
-- ===========================================================================

drop function if exists _rank_start_impl(
  uuid, uuid, taste_bucket, boolean, boolean, placement_kind, uuid, integer
);

create or replace function _rank_start_impl(p_user uuid, p_media_item_id uuid, p_bucket taste_bucket, p_provisional boolean DEFAULT false, p_new_watch boolean DEFAULT false, p_kind placement_kind DEFAULT NULL::placement_kind, p_watch_event_id uuid DEFAULT NULL::uuid, p_tolerance integer DEFAULT 0, p_linked_placement_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_kind     media_kind;
  v_cat      ranking_category;
  v_band     record;
  v_existing record;
  v_state    record;
  v_session  uuid;
  v_pivot    integer;
  v_pivot_item uuid;
  v_exclude  uuid;
  v_members  uuid[];
  -- 20261004000100
  v_act      placement_kind;
  v_strategy text;
  v_prior    integer;
  v_position integer;
begin
  select kind into v_kind from media_items where id = p_media_item_id;
  if v_kind is null then
    raise exception 'unknown media item' using errcode = 'P0002';
  end if;

  v_cat := rankable_category(v_kind);
  if v_cat is null then
    raise exception 'a series cannot be ranked; rank its seasons'
      using errcode = '22023';
  end if;

  if not p_provisional then
    -- PRD §11: bucketing and ranking are separate acts and abandoning the second does
    -- not undo the first. The title is Logged from here on, whatever happens next.
    --
    -- **TV-1, decided 2026-08-24.** There is no completion prerequisite and there never
    -- was one in this function.
    --
    -- **And it writes no watch event and no date** (§D.6 paths 3, 10 and 12). The
    -- deferred trigger from 20261003000100 gives a row this creates its undated event at
    -- commit, which is the honest record: ranking a title says it was seen, not when.
    insert into user_media (user_id, media_item_id, bucket)
    values (p_user, p_media_item_id, p_bucket)
    on conflict (user_id, media_item_id)
      do update set bucket = excluded.bucket, updated_at = now();

    if exists (select 1 from rankings
                where user_id = p_user and media_item_id = p_media_item_id) then
      raise exception 'title is already ranked; use rank_rebucket to move it'
        using errcode = '23505';
    end if;
  end if;

  -- Null unless the subject is genuinely still holding a position. A provisional call
  -- against a title that lost its ranking in the meantime is an ordinary first
  -- ranking, and excluding an absent row from the band would be arithmetic about
  -- nothing.
  if p_provisional and exists (select 1 from rankings
                                where user_id = p_user and media_item_id = p_media_item_id) then
    v_exclude := p_media_item_id;
  end if;

  v_act := coalesce(
    p_kind,
    case when v_exclude is null then 'first'::placement_kind
         when p_new_watch       then 'rewatch'::placement_kind
         else 'correction'::placement_kind end
  );

  select * into v_existing
    from ranking_sessions
   where user_id = p_user and media_item_id = p_media_item_id;

  -- The strategy this act wants. A first placement has no prior to anchor to, so it
  -- bisects however the flag is set; everything provisional anchors.
  v_strategy := case
    when v_exclude is null then 'bisect'
    when v_act = 'import'  then 'bisect'   -- §F's table: bisect in v1 (§I.4)
    else 'prior'
  end;

  if v_existing.id is not null then
    -- **§F.4's resume matrix.** Kind X resumed as kind Y restarts. `new_watch` is no
    -- longer refreshed in place: the act, not just its flag, has to be the same one.
    if v_existing.bucket = p_bucket
       and v_existing.provisional = (v_exclude is not null)
       and coalesce(v_existing.kind, 'correction'::placement_kind) = v_act
       and coalesce(v_existing.strategy, 'bisect'::text) = v_strategy
       -- 20261114000300: a linked Update Show and a standalone correction are different acts.
       and v_existing.linked_placement_id is not distinct from p_linked_placement_id
    then
      -- **A resume is where a stale search comes back** (20260926000100). The band may
      -- have moved while the session sat open; rebase it from its answers before the
      -- comparison is read back.
      perform _rank_session_sync(v_existing.id, p_user);

      select * into v_state from _rank_session_state(v_existing.id, p_user);
      v_pivot_item := _rank_pivot_at(
        p_user, v_cat, v_state.band_lo + v_state.pivot, v_exclude
      );

      -- **A resume records what it re-offers.** It is the same comparison the
      -- reader was already looking at, so showing it again is not a repeat -- but
      -- the session has to remember having shown it, or that pair walks back in
      -- later through a skip.
      if v_pivot_item is not null
         and not (v_pivot_item = any (coalesce(v_existing.seen_items, '{}'::uuid[]))) then
        update ranking_sessions
           set seen_items = seen_items || v_pivot_item
         where id = v_existing.id;
      end if;

      return jsonb_build_object(
        'done', false,
        'session_id', v_state.session_id,
        'pivot', v_pivot_item,
        'resumed', true
      );
    end if;

    -- The bucket changed, the session was opened in the other numbering, or this is a
    -- different act. Nothing answered under the old one transfers.
    delete from ranking_sessions where id = v_existing.id;
  end if;

  select * into v_band from band_bounds_excluding(p_user, v_cat, p_bucket, v_exclude);

  if v_band.size = 0 then
    return _rank_finalize(
      p_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null,
      false, v_exclude is not null, p_new_watch, v_act, null, p_linked_placement_id
    );
  end if;

  -- **The session is born from ONE read of its band** (20260926000100).
  v_members := _rank_band_members(p_user, v_cat, p_bucket, v_exclude);

  -- ---------------------------------------------------------------------------
  -- The prior, in the session's own coordinates.
  --
  -- The subject sits at `position`; the band it is in starts at `v_band.lo`; the members
  -- above it inside that band number `position - band.lo`. That count IS its insertion
  -- point in the subject-excluded list, so it is directly comparable with `lo`, `hi` and
  -- `pivot` and needs no translation anywhere else.
  --
  -- A band change (`rank_rebucket`) has a prior in the OLD band, which is meaningless as
  -- an index into the new one -- so it is null, the strategy is `prior` but
  -- `_rank_next_index` falls through to the midpoint, and the search is the bisection
  -- PRD §10 requires for a band change.
  -- ---------------------------------------------------------------------------
  if v_exclude is not null then
    select r.position into v_position
      from rankings r
     where r.user_id = p_user and r.media_item_id = p_media_item_id and r.bucket = p_bucket;
    if v_position is not null then
      v_prior := greatest(0, least(v_position - v_band.lo, cardinality(v_members)));
    end if;
  end if;

  v_pivot := _rank_next_index(
    0, cardinality(v_members), v_strategy, v_prior, p_tolerance, cardinality(v_members)
  );
  v_pivot_item := v_members[v_pivot + 1];

  insert into ranking_sessions (
    user_id, media_item_id, category, bucket, lo, hi, pivot, provisional, new_watch,
    seen_items, pivot_item, band_digest,
    kind, strategy, prior_offset, tolerance, watch_event_id, linked_placement_id
  )
  values (
    p_user, p_media_item_id, v_cat, p_bucket, 0, cardinality(v_members), v_pivot,
    v_exclude is not null, p_new_watch,
    case when v_pivot_item is null then '{}'::uuid[] else array[v_pivot_item] end,
    v_pivot_item,
    md5(array_to_string(v_members, ',')),
    v_act, v_strategy, v_prior, coalesce(p_tolerance, 0), p_watch_event_id, p_linked_placement_id
  )
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', v_pivot_item,
    'resumed', false
  );
end;
$function$;


revoke execute on function _rank_start_impl(
  uuid, uuid, taste_bucket, boolean, boolean, placement_kind, uuid, integer, uuid
) from public, anon, authenticated;

drop function if exists _rank_finalize(
  uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean,
  placement_kind, uuid
);

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
  elsif v_kind = 'correction'
        and cat in ('tv_shows', 'tv_seasons')
        and v_outcome = 'moved' then
    v_tv_update := true;
    v_posts := true;
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

-- ===========================================================================
-- 4. The two correction RPCs accept the link
-- ===========================================================================

drop function if exists rank_again(uuid, taste_bucket, uuid, boolean, uuid);

create or replace function rank_again(p_media_item_id uuid, p_bucket taste_bucket, p_operation_id uuid DEFAULT NULL::uuid, p_new_watch boolean DEFAULT false, p_watch_event_id uuid DEFAULT NULL::uuid, p_linked_placement_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 20261114000300: Update Show, linked to the season placement that offered it.
  perform _assert_linked_show_update(v_user, p_media_item_id, p_linked_placement_id);

  if p_linked_placement_id is not null and coalesce(p_new_watch, false) then
    raise exception 'Update Show records no watch' using errcode = '22023';
  end if;

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
      v_event, 0, p_linked_placement_id
    )
  );
end;
$function$;


revoke execute on function rank_again(uuid, taste_bucket, uuid, boolean, uuid, uuid)
  from public, anon;
grant execute on function rank_again(uuid, taste_bucket, uuid, boolean, uuid, uuid)
  to authenticated;

drop function if exists rank_rebucket(uuid, taste_bucket, uuid);

create or replace function rank_rebucket(p_media_item_id uuid, p_bucket taste_bucket, p_operation_id uuid DEFAULT NULL::uuid, p_linked_placement_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_r     record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_rebucket');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  -- 20261114000300: Update Show, linked to the season placement that offered it.
  perform _assert_linked_show_update(v_user, p_media_item_id, p_linked_placement_id);

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  if v_r.bucket = p_bucket then
    raise exception 'title is already in that bucket' using errcode = '22023';
  end if;

  return _record_operation_result(
    p_operation_id,
    _rank_start_impl(v_user, p_media_item_id, p_bucket, true, false, 'correction', null, 0,
                     p_linked_placement_id)
  );
end;
$function$;


revoke execute on function rank_rebucket(uuid, taste_bucket, uuid, uuid) from public, anon;
grant execute on function rank_rebucket(uuid, taste_bucket, uuid, uuid) to authenticated;

-- ===========================================================================
-- 5. A TV update post keeps its own score
--
-- `_correction_follows_latest_watch` (20261016000100) keeps the most recent viewing's
-- post in step with a correction. When that viewing is the first one, it matches a post
-- with no watch_event_id, which a TV update post also is. Without this the next
-- correction would rewrite the update post's score.
-- ===========================================================================

create or replace function _latest_watch_post(p_user uuid, p_item uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with latest as (
    select w.id,
           (select count(*) from watch_events w0
             where w0.user_id = p_user and w0.media_item_id = p_item) = 1
           or w.id = (select w1.id from watch_events w1
                       where w1.user_id = p_user and w1.media_item_id = p_item
                       order by w1.recorded_at, w1.id limit 1) as is_first
      from watch_events w
     where w.user_id = p_user and w.media_item_id = p_item
     order by w.recorded_at desc, w.id desc
     limit 1
  )
  select fe.id
    from feed_events fe, latest
   where fe.actor_id = p_user
     and fe.media_item_id = p_item
     and fe.type = 'title_ranked'
     and (
       fe.payload ->> 'watch_event_id' = latest.id::text
       or (latest.is_first and fe.payload ->> 'watch_event_id' is null)
     )
     -- 20261114000300: a TV ranking update is its own post with its own score, never a
     -- viewing's, so a later correction must not rewrite it.
     and coalesce(fe.payload ->> 'update', 'false') <> 'true'
   order by fe.created_at desc, fe.id desc
   limit 1;
$function$;
