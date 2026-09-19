-- A search that knows whom it asked.
--
-- A founder-facing ranking-integrity fix (2026-09-19).
--
-- ---------------------------------------------------------------------------
-- THE INVARIANT
--
-- A completed answer must remain consistent with every final ordinal placement. If the
-- reader said the pivot is better, the subject lands below it; if they said the subject
-- is better, above it -- whatever else happened to the ranking in between.
--
-- ---------------------------------------------------------------------------
-- HOW IT BROKE
--
-- A ranking session keeps its binary search as INDICES into the band: `lo`, `hi`,
-- `pivot`, and every Undo frame in `history`. An index names a title only for as long as
-- the band holds still. A session is left open whenever the app dies before `rank_cancel`
-- lands, and `rank_start` then resumes it -- but in between, the reader may have ranked
-- other titles into the same band, removed some, or ranked one of its pivots again.
--
-- The smallest failure, reproduced deterministically in
-- supabase/tests/ranking-resume-integrity.test.mjs: ten loved films, Base 0 best. The
-- subject opens against Base 5 at index 5 and the reader picks Base 5, so `lo` = 6. The
-- app dies. A better film is ranked, landing above Base 5, which is now at index 6. The
-- subject resumes with `lo` = 6 and, answered honestly all the way down, is placed at
-- index 6 -- directly ABOVE Base 5, the title it lost to.
--
-- The same stale index broke four other things, all reproduced in the same file:
--
--   * `rank_answer` resolved the opponent by index, so an answer given against the title
--     on screen was recorded against whichever title now held that index -- a comparison
--     the reader never saw -- or refused as "not one of the two titles".
--   * `rank_back` restored an index, so Undo re-showed whatever now held it.
--   * `rank_skip` offered candidates from stale bounds, outside what the answers allow.
--   * the resume itself re-offered by index, so the comparison on screen changed.
--
-- ---------------------------------------------------------------------------
-- THE FIX: DETECT, THEN REBASE FROM THE ANSWERS
--
-- **Detect.** A session now records `band_digest`: md5 over the ordered ids of its band
-- (its bucket in its category, the subject excluded when the session is provisional),
-- which is exactly the list every index in the session addresses. If the digest still
-- matches, every index still names the same title, and the step runs precisely as it did
-- before this migration -- an uninterrupted ranking is unchanged. Any insertion, removal,
-- reorder or bucket move inside the band changes the list and therefore the digest; a
-- length check would miss a reorder, and a timestamp would miss a removal. Changes to
-- OTHER bands of the category do not matter -- indices are band-relative -- and do not
-- change this band's digest.
--
-- **Remember whom.** Each Undo frame `rank_answer` writes now also records `pivot_item`
-- (the opponent's id) and `won` (whether the subject won), and the session records
-- `pivot_item`, the title on screen. The live answers of a session are precisely its
-- frames: `rank_answer` pushes one per answer that does not finish the search, and
-- `rank_back` pops one per Undo.
--
-- **Rebase.** On a mismatch, `_rank_session_sync` replays the frames, in order, against
-- the band as it is now: each answer re-derives `[lo, hi)` from its opponent's current
-- index, and each frame's own `lo`/`hi`/`pivot` is rewritten to what it means now, so a
-- later Undo restores the right title. An answer about a title that has left the band,
-- or that earlier answers already imply, no longer narrows anything and is dropped. An
-- answer that CONTRADICTS earlier ones -- possible only when the reader has since
-- re-ranked one of the pivots relative to another -- makes the recorded intent
-- unsatisfiable, so the search starts again from the whole band: correctness over saving
-- a comparison or two.
--
-- **Never answer against an unseen title.** If the rebase changes the comparison on
-- screen -- its title left the band or the answers no longer bracket it -- a step that
-- arrives with an answer, a skip or an Undo about the OLD comparison is not applied. It
-- returns the comparison that is current, with its card, which every shipped client
-- already renders as the next comparison. Nothing is recorded, no skip is spent.
--
-- **No window.** Every step on an open session -- answer, skip, Undo, resume -- now takes
-- the (user, category) ranking lock right after the media lock: the order the hierarchy
-- in 20260825000200 already prescribes, and the lock `_rank_finalize`,
-- `_rank_unrank_impl` and `rank_reorder` take. Nothing can move the band between the
-- check and the write, and `_rank_finalize` taking it again is allowed within one
-- transaction. Opening a session takes no new lock: it derives `hi`, the pivot and the
-- digest from one read of the band, so they agree with each other, and a band that moves
-- straight afterwards is caught by the digest at the first step. That keeps a start
-- racing another ranking into an empty band exactly as it was (it waits inside
-- `_rank_finalize`; concurrency/races/ranking.mjs pins it).
--
-- ---------------------------------------------------------------------------
-- SESSIONS OPEN WHEN THIS DEPLOYS
--
-- They have no digest, so the first step that touches each one rebases it. A session
-- with no answers yet loses nothing. A session with answers holds frames without
-- `pivot_item`, whose indices cannot be trusted or translated, so its search starts
-- again from the whole band; the answers it had given stay in `comparisons`, exactly as
-- a cancelled session's do. Either way the first step after the deploy returns a fresh
-- comparison rather than applying an action to a screen this database can no longer
-- identify.
--
-- ---------------------------------------------------------------------------
-- Rebuilt from their latest definitions -- `_rank_start_impl` from 20260901000100,
-- `rank_answer`, `rank_skip` and `rank_back` from 20260922000100 -- and different from
-- them only where the comments dated 20260926000100 say. `_rank_offer`,
-- `_rank_session_state`, `_rank_pivot_at` and `_rank_finalize` are unchanged.
-- ---------------------------------------------------------------------------

alter table ranking_sessions
  add column pivot_item  uuid,
  add column band_digest text;

comment on column ranking_sessions.pivot_item is
  'The title on screen against the subject. Written with every offer since 20260926000100, so an answer, a skip or an Undo can be checked against the comparison the reader actually saw rather than against whatever holds the pivot index now. Null only on a session opened before that migration.';

comment on column ranking_sessions.band_digest is
  'md5 over the ordered media item ids of the session''s band (its bucket in its category, the subject excluded when provisional) as of the last time lo, hi, pivot and history were known to index it. A step whose band no longer hashes to this rebases the search from the recorded answers before doing anything (_rank_session_sync, 20260926000100). Null on a session opened before that migration, which is therefore rebased on first touch.';


/** The band a session's indices address, in position order. */
create or replace function _rank_band_members(
  p_user uuid, p_cat ranking_category, p_bucket taste_bucket, p_exclude uuid default null
) returns uuid[]
language sql stable
set search_path = public
as $$
  select coalesce(array_agg(r.media_item_id order by r.position), '{}'::uuid[])
    from rankings r
   where r.user_id = p_user
     and r.category = p_cat
     and r.bucket = p_bucket
     and (p_exclude is null or r.media_item_id <> p_exclude);
$$;

comment on function _rank_band_members(uuid, ranking_category, taste_bucket, uuid) is
  'The ordered media item ids of one band -- the list every lo, hi and pivot index of a ranking session addresses, with the subject excluded for a provisional session. Its md5 is ranking_sessions.band_digest. Internal (20260926000100).';

revoke execute on function _rank_band_members(uuid, ranking_category, taste_bucket, uuid)
  from public, anon, authenticated;


create or replace function _rank_session_sync(p_session_id uuid, p_user uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  s          record;
  v_exclude  uuid;
  v_band     uuid[];
  v_digest   text;
  v_band_lo  integer;
  v_lo       integer := 0;
  v_hi       integer;
  v_frames   jsonb := '[]'::jsonb;
  v_frame    jsonb;
  v_idx      integer;
  v_won      boolean;
  v_restart  boolean := false;
  v_seen     uuid[];
  v_pivot    integer;
  v_item     uuid;
  v_offer    record;
begin
  select * into s from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = p_user;

  if s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  -- Media lock (held by every caller) then the (user, category) lock: the hierarchy
  -- 20260825000200 documents, and the lock every writer of a position takes. From here
  -- to the end of the caller's transaction the band cannot move.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || s.category::text, 0));

  v_exclude := case when s.provisional then s.media_item_id end;
  v_band    := _rank_band_members(p_user, s.category, s.bucket, v_exclude);
  v_digest  := md5(array_to_string(v_band, ','));

  -- The band is the one the indices were written against. Nothing to do, and the step
  -- that called this runs exactly as it did before this migration.
  if s.band_digest is not distinct from v_digest then
    return false;
  end if;

  v_hi := cardinality(v_band);

  -- Replay the live answers against the band as it is now.
  for v_frame in select value from jsonb_array_elements(s.history) loop
    if not (v_frame ? 'pivot_item') then
      -- A frame from before 20260926000100 records an index and not a title. There is
      -- no honest way to translate it.
      v_restart := true;
      exit;
    end if;

    v_idx := array_position(v_band, (v_frame ->> 'pivot_item')::uuid) - 1;
    v_won := (v_frame ->> 'won')::boolean;

    -- The opponent has left the band: the answer no longer constrains a placement in it.
    continue when v_idx is null;

    if v_idx < v_lo or v_idx >= v_hi then
      -- Outside what the earlier answers leave open. Above `lo` and lost to, or below
      -- `hi` and beaten, it is implied by them and narrows nothing. The other two cases
      -- are a contradiction: the reader has re-ranked two of these pivots relative to
      -- each other since, and no single placement honours every answer.
      if (v_idx < v_lo and v_won) or (v_idx >= v_hi and not v_won) then
        v_restart := true;
        exit;
      end if;
      continue;
    end if;

    -- The frame keeps its offer and skip counts; its bounds and pivot are rewritten to
    -- what they mean in this band, so an Undo restores the right title.
    v_frames := v_frames || (
      v_frame || jsonb_build_object('lo', v_lo, 'hi', v_hi, 'pivot', v_idx)
    );

    if v_won then
      v_hi := v_idx;
    else
      v_lo := v_idx + 1;
    end if;
  end loop;

  if v_restart then
    v_lo     := 0;
    v_hi     := cardinality(v_band);
    v_frames := '[]'::jsonb;
    v_seen   := '{}'::uuid[];
  else
    v_seen := coalesce(s.seen_items, '{}'::uuid[]);
  end if;

  -- `_rank_offer` reads the seen set from the row, so the row carries it first.
  update ranking_sessions set seen_items = v_seen where id = s.id;

  v_idx := array_position(v_band, s.pivot_item) - 1;

  if not v_restart and v_idx is not null and v_idx >= v_lo and v_idx < v_hi then
    -- The comparison on screen is still one the answers allow. Keep it.
    v_pivot := v_idx;
    v_item  := s.pivot_item;
  elsif v_lo < v_hi then
    select b.lo into v_band_lo
      from band_bounds_excluding(p_user, s.category, s.bucket, v_exclude) b;

    select * into v_offer
      from _rank_offer(s.id, p_user, s.category, v_band_lo, v_lo, v_hi,
                       (v_lo + v_hi) / 2, v_exclude);

    if v_offer.item is not null then
      v_pivot := v_offer.idx;
      v_item  := v_offer.item;
    else
      -- Every title the answers still allow has been shown already. After the band
      -- moved under a suspended session, asking one of them again is the lesser wrong:
      -- the alternative is placing the title without the comparison that decides it.
      v_pivot := (v_lo + v_hi) / 2;
      v_item  := v_band[v_pivot + 1];
    end if;
  else
    -- The answers pin the slot. The next answer places it, as for a collapsed band.
    v_pivot := v_lo;
    v_item  := v_band[v_lo + 1];
  end if;

  update ranking_sessions
     set lo          = v_lo,
         hi          = v_hi,
         pivot       = v_pivot,
         pivot_item  = v_item,
         history     = v_frames,
         seen_items  = case
                         when v_item is null or v_item = any (v_seen) then v_seen
                         else v_seen || v_item
                       end,
         -- A search started again spends no skips it did not take.
         skips       = case when v_restart then 0 else skips end,
         band_digest = v_digest,
         updated_at  = now()
   where id = s.id;

  -- Did the comparison on screen change? A session from before this migration cannot
  -- say what is on screen, so its first step after the deploy always re-presents one.
  return v_restart or s.pivot_item is null or v_item is distinct from s.pivot_item;
end;
$$;

comment on function _rank_session_sync(uuid, uuid) is
  'Takes the (user, category) ranking lock and checks that the session''s band still hashes to band_digest. If it does, returns false and changes nothing. If not, replays the live answers recorded in history (pivot_item, won) against the band as it is now: rewrites lo, hi, pivot and every frame so each index names the title it did, drops answers about titles that left the band or that earlier answers imply, and starts the search again when the answers contradict each other or predate 20260926000100. Returns true when the comparison on screen changed, in which case the caller must not apply an action to the old one. Assumes the caller holds _lock_media for the subject. Internal (20260926000100).';

revoke execute on function _rank_session_sync(uuid, uuid) from public, anon, authenticated;


/** The current comparison, as a step returns it, for a step that was not applied. */
create or replace function _rank_current_comparison(p_session_id uuid)
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
           'done', false,
           'session_id', rs.id,
           'pivot', rs.pivot_item,
           'pivot_card', _rank_pivot_card(rs.pivot_item),
           'rebased', true
         )
    from ranking_sessions rs
   where rs.id = p_session_id;
$$;

comment on function _rank_current_comparison(uuid) is
  'The comparison now on a session, in the shape rank_answer, rank_skip and rank_back return for their next comparison, plus rebased: true. Returned instead of applying a step when _rank_session_sync changed the comparison the step was about. Internal (20260926000100).';

revoke execute on function _rank_current_comparison(uuid) from public, anon, authenticated;


create or replace function _rank_start_impl(
  p_user uuid, p_media_item_id uuid, p_bucket taste_bucket,
  p_provisional boolean default false,
  p_new_watch boolean default false
)
returns jsonb
language plpgsql
set search_path = public
as $$
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
    -- was one in this function. Ranking a season *is* the watch claim -- the "How was
    -- it?" that opens the flow already says the reader watched it -- so `progress` is
    -- not read here and is not written. See open-questions.md §TV-1.
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

  select * into v_existing
    from ranking_sessions
   where user_id = p_user and media_item_id = p_media_item_id;

  if v_existing.id is not null then
    if v_existing.bucket = p_bucket and v_existing.provisional = (v_exclude is not null) then
      -- The same act, resumed. `new_watch` is refreshed rather than kept: a reader who
      -- abandoned Change your rating and then chose Rank again means the second one.
      if v_existing.new_watch is distinct from p_new_watch then
        update ranking_sessions set new_watch = p_new_watch, updated_at = now()
         where id = v_existing.id;
      end if;

      -- **A resume is where a stale search comes back** (20260926000100). The band may
      -- have moved while the session sat open; rebase it from its answers before the
      -- comparison is read back. Whether the comparison changed does not matter here:
      -- the client draws whatever a resume returns.
      perform _rank_session_sync(v_existing.id, p_user);

      select * into v_state from _rank_session_state(v_existing.id, p_user);
      v_pivot_item := _rank_pivot_at(
        p_user, v_cat, v_state.band_lo + v_state.pivot, v_exclude
      );

      -- **A resume records what it re-offers.** It is the same comparison the
      -- reader was already looking at, so showing it again is not a repeat -- but
      -- the session has to remember having shown it, or that pair walks back in
      -- later through a skip. Idempotent, and it doubles as the backfill for any
      -- session opened before this column existed (20260901000100).
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

    -- The bucket changed, or the session was opened in the other numbering. Nothing
    -- answered against the old band transfers either way.
    delete from ranking_sessions where id = v_existing.id;
  end if;

  select * into v_band from band_bounds_excluding(p_user, v_cat, p_bucket, v_exclude);

  if v_band.size = 0 then
    return _rank_finalize(
      p_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null,
      false, v_exclude is not null, p_new_watch
    );
  end if;

  -- **The session is born from ONE read of its band** (20260926000100). `hi`, the
  -- pivot, the title on screen and the digest all come from this array, so they agree
  -- with each other even if the band moves a moment later -- and if it does, the digest
  -- no longer matches and the first step rebases. No ranking lock is taken here: a
  -- start that races another ranking into an empty band still reaches `_rank_finalize`
  -- and waits there, exactly as before (concurrency/races/ranking.mjs, lock ordering).
  v_members := _rank_band_members(p_user, v_cat, p_bucket, v_exclude);

  v_pivot := cardinality(v_members) / 2;
  -- Resolved BEFORE the insert now, so the session is born knowing which title it
  -- has shown. It used to be resolved in the return expression, which is exactly
  -- how the opening comparison came to be re-offerable later: the founder's report
  -- is A-versus-B, Too tough, one answer, A-versus-B again, and B is this pivot.
  v_pivot_item := v_members[v_pivot + 1];

  insert into ranking_sessions (
    user_id, media_item_id, category, bucket, lo, hi, pivot, provisional, new_watch,
    seen_items, pivot_item, band_digest
  )
  values (
    p_user, p_media_item_id, v_cat, p_bucket, 0, cardinality(v_members), v_pivot,
    v_exclude is not null, p_new_watch,
    case when v_pivot_item is null then '{}'::uuid[] else array[v_pivot_item] end,
    -- 20260926000100: the title on screen, and the band its indices address.
    v_pivot_item,
    md5(array_to_string(v_members, ','))
  )
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', v_pivot_item,
    'resumed', false
  );
end;
$$;

comment on function _rank_start_impl(uuid, uuid, taste_bucket, boolean, boolean) is
  'Opens a comparison session, or places the title outright when its band is empty. The body of rank_start, shared with rank_rebucket and rank_again. With p_provisional it opens *over* a title that is still ranked: the bucket is not written, the already-ranked refusal does not apply, and the band excludes the subject -- so nothing the reader can see changes until the placement completes. Since 20260901000100 the opening comparison is recorded in seen_items, which is what stops it being offered a second time later in the same session; a resume records the pivot it re-offers, which also backfills a session opened before that column existed. Since 20260926000100 a new session records its pivot_item and band_digest, and a resume first rebases a session whose band has moved (_rank_session_sync). Assumes the caller holds _lock_media for the same (user, media item). Internal.';

revoke execute on function _rank_start_impl(uuid, uuid, taste_bucket, boolean, boolean)
  from public, anon, authenticated;


create or replace function rank_answer(
  p_session_id   uuid,
  p_winner       uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_item  uuid;
  v_s     record;
  v_pivot_item uuid;
  v_exclude uuid;
  v_new_lo integer;
  v_new_hi integer;
  v_next   integer;
  v_offer  record;
  v_moved  boolean;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_answer');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  -- The media item is read before the lock because the lock needs it, and a session's
  -- media_item_id never changes once written -- so this is a stable key rather than a
  -- value that could be stale by the time it is used. The session is then re-read
  -- through `_rank_session_state` *inside* the lock, which is where the bounds that
  -- matter are clamped to the live band.
  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  -- 20260926000100: the band this session's indices address, checked and if need be
  -- rebased from the recorded answers, under the ranking lock.
  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

  -- The band can collapse under an open session if its other members are unranked.
  -- There is then nothing left to compare against.
  if v_s.lo >= v_s.hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.lo, v_s.session_id, false, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- **An answer about a comparison that is no longer on the session is not applied**
  -- (20260926000100). The band moved while the session was open, and the title this
  -- answer was given against either left it or is no longer one the earlier answers
  -- allow. Recording it would be a comparison against a title the reader was not
  -- shown; the current comparison goes back instead, and a replay returns the same.
  if v_moved then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot, v_exclude);

  -- An unresolvable pivot is refused before the winner is checked, rather than being
  -- allowed to fall through it.
  --
  -- It should not be reachable: `_rank_session_state` clamps `pivot` into `[lo, hi)` and
  -- `hi` into the live band, so `band_lo + pivot` addresses a member of the band that
  -- exists now. What made it worth stating is the *old* shape of this test --
  -- `p_winner <> v_pivot_item` against a null yields null, the whole condition yields
  -- null, and the function walked on to insert a comparison with a null loser against a
  -- not-null column. One refusal naming the real problem beats a constraint violation
  -- two statements later, and the client already reads P0002 as "that session is gone".
  if v_pivot_item is null then
    raise exception 'the title being compared against is no longer ranked'
      using errcode = 'P0002';
  end if;

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
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_new_lo, v_s.session_id, false, v_s.provisional, v_s.new_watch
    ));
  end if;

  v_next := (v_new_lo + v_new_hi) / 2;

  -- **The midpoint is a preference, not a demand** (20260901000100).
  --
  -- In a session with no skips it is always available and this is the binary
  -- search exactly as it was: the answered pivot is excluded from the new range by
  -- construction, so nothing in [new_lo, new_hi) has been offered before and the
  -- walk returns the midpoint on its first try. After a skip the midpoint can be a
  -- title the reader has already declined to call, and re-offering it is the
  -- founder's repeat.
  --
  -- Comparing against any index in [lo, hi) is as correct as comparing against the
  -- midpoint -- the narrowing above reads the STORED pivot rather than recomputing
  -- one -- so this costs a comparison or two on a skipped session and no
  -- correctness at all.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_new_lo, v_new_hi, v_next, v_exclude);

  if v_offer.item is null then
    -- Every remaining opponent has already been put to this reader and declined.
    -- There is no honest comparison left, so the title lands at the middle of the
    -- range the answers established, reported as adjustable -- the same resolution,
    -- and the same sentence on the reveal, as running out of skips.
    --
    -- **No comparison row is written here.** A skipped pair is an absence of
    -- evidence, and minting a win, a loss or a tie out of it is the fabrication the
    -- founder ruled out in as many words.
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_next, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_offer.idx,
         -- 20260926000100: the title now on screen.
         pivot_item = v_offer.item,
         seen_items = seen_items || v_offer.item,
         -- **The frame is the whole state the reader was looking at**
         -- (20260922000100). Bounds and pivot were all it held, so an Undo put the
         -- search back and left the offers and the skip count where the undone step
         -- had moved them. `seen` is how many titles had been offered when this
         -- comparison was on screen -- read from the row before this statement's own
         -- append -- and `skips` is how many had been spent.
         --
         -- **And whom it was against, and who won** (20260926000100). The frame is
         -- also the record of this answer, which is what lets `_rank_session_sync`
         -- re-derive the search from the answers when the band moves under it.
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot,
           'seen', cardinality(seen_items), 'skips', v_s.skips,
           'pivot_item', v_pivot_item, 'won', p_winner = v_s.media_item_id
         ),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item,
    'pivot_card', _rank_pivot_card(v_offer.item)
  ));
end;
$$;

comment on function rank_answer(uuid, uuid, uuid) is
  'Records one comparison and either narrows the search or finalises the placement. With an operation id, a replay returns the stored answer -- the same position, score and activation flag -- so a retry cannot record a second comparison, move the title twice, or emit a second feed event. For a provisional session the opponents come from the band with the subject excluded, and the placement replaces the subject''s old position rather than filling a hole left behind at the start. Since 20260901000100 the next opponent is the nearest index to the midpoint that this session has not already shown; when every remaining one has been shown the title is placed at the midpoint and reported as adjustable, with no comparison recorded, because a skipped pair is an absence of evidence rather than a tie. Since 20260922000100 each history frame records the offer count and skip count as well as the bounds, so rank_back restores the whole state, and the next comparison carries its opponent''s card. Since 20260926000100 each frame also records the opponent and the outcome, the session is rebased from them first if its band has moved, and an answer about a comparison the rebase replaced is not applied: the current comparison is returned with rebased: true.';

create or replace function rank_skip(
  p_session_id   uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_claim      record;
  v_item       uuid;
  v_s          record;
  v_exclude    uuid;
  v_max_skips  integer;
  v_mid        integer;
  v_offer      record;
  v_moved      boolean;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_skip');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  -- 20260926000100: see rank_answer.
  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

  -- 20260926000100: Too tough was pressed on a comparison the rebase replaced. The
  -- reader has not seen the new one, so they cannot have declined it; no skip is spent.
  if v_moved and v_s.lo < v_s.hi then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  -- The subquery form, not `select coalesce(...) into … from app_config where …`.
  -- 20260813002100 §2: with no matching row the second form assigns null and the
  -- default never applies, so a missing config key disabled the skip cap entirely.
  v_max_skips := coalesce(
    (select (value)::integer from app_config where key = 'ranking.max_skips'),
    3
  );

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- **The candidate walk is now the seen-set walk** (20260901000100), and this is
  -- the founder's repeat fixed at its cause.
  --
  -- It was mid+1, mid-1, mid+2, ... skipping the first band_skips candidates, with
  -- band_skips reset whenever [lo, hi) changed. That reset is the defect: the
  -- reader skips A-versus-B, is offered A-versus-C, answers it, the range narrows,
  -- the counter resets, and the new midpoint is B again -- a pair they have already
  -- said they cannot call.
  --
  -- _rank_offer walks the same outward path from the same midpoint and refuses any
  -- title this SESSION has offered, which no narrowing resets. It subsumes the old
  -- counter and closes the case the counter could not see. band_skips, skip_lo and
  -- skip_hi are left on the table and are no longer written; see the comment on
  -- those columns.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_s.lo, v_s.hi, v_mid, v_exclude);

  -- Genuinely out of distinct comparisons for this band. Placing at the midpoint is
  -- the same resolution as running out of patience, and is reported as adjustable.
  if v_offer.item is null then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- Persisting the pivot is 20260813001600's fix. Without it the answer path
  -- recomputed the midpoint and refused the title it had just displayed. Persisting
  -- the ITEM beside it is this migration's: a pivot is an index into a band that
  -- moves under it, and the invariant the founder asked for is about the pair.
  update ranking_sessions
     set skips      = skips + 1,
         pivot      = v_offer.idx,
         -- 20260926000100: the title now on screen.
         pivot_item = v_offer.item,
         seen_items = seen_items || v_offer.item,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item,
    'pivot_card', _rank_pivot_card(v_offer.item),
    'skipped', true
  ));
end;
$$;

comment on function rank_skip(uuid, uuid) is
  'Re-anchors to a different opponent without narrowing the range; the configured skip limit places the title at the midpoint instead. Carries an operation id because a skip mutates -- a replay without one spends a second skip against the limit and shows a third title. For a provisional session the candidates exclude the subject, which is still ranked inside the band. Since 20260901000100 the candidate walk refuses every title this session has already offered rather than counting offers against the current band, which is what stopped a skipped pair returning after the next answer narrowed the range. Since 20260922000100 the replacement comparison carries its opponent''s card. Since 20260926000100 the session is rebased first if its band has moved, and a skip pressed on a comparison the rebase replaced spends nothing and returns the current comparison.';

create or replace function rank_back(
  p_session_id   uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_item  uuid;
  v_s     record;
  v_prev  jsonb;
  v_pivot_item uuid;
  v_moved boolean;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_back');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  -- 20260926000100: see rank_answer. The rebase rewrites every frame, so the one
  -- popped below names the title that was compared, not the one that holds its index.
  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);

  -- 20260926000100: Undo pressed on a comparison the rebase replaced. The reader has not
  -- seen the current one; show it, and let the next Undo be about what is on screen.
  if v_moved and v_s.lo < v_s.hi then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  if jsonb_array_length(v_s.history) = 0 then
    delete from ranking_sessions where id = v_s.session_id;
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', false, 'cancelled', true)
    );
  end if;

  v_prev := v_s.history -> -1;

  -- 20260926000100: the frame's own title where it records one, which after a rebase is
  -- the whole point; an index lookup only for a frame that predates it.
  v_pivot_item := coalesce(
    (v_prev ->> 'pivot_item')::uuid,
    _rank_pivot_at(
      v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer,
      case when v_s.provisional then v_s.media_item_id end
    )
  );

  update ranking_sessions
     set lo = (v_prev ->> 'lo')::integer,
         hi = (v_prev ->> 'hi')::integer,
         pivot = (v_prev ->> 'pivot')::integer,
         -- 20260926000100: the title the restored comparison is against.
         pivot_item = v_pivot_item,
         history = v_s.history - (jsonb_array_length(v_s.history) - 1),
         -- **Undo withdraws what the undone step offered** (20260922000100).
         --
         -- Restoring the bounds and not the offers is the reported defect: the title
         -- the undone answer put on screen stayed in `seen_items`, so answering the
         -- restored comparison the same way again reached the same midpoint, found it
         -- "already shown", and walked past it -- to a neighbour on a wide range, and
         -- to an early, adjustable placement when it was the only title left. The
         -- offers are a stack in the order they were made, so truncating to the length
         -- the frame recorded removes exactly the ones made after it.
         --
         -- **Except what the reader declined.** `rank_skip` pushes no frame, so an Undo
         -- taken after Too tough pops the answer *before* the skip. The title that
         -- answer offered, and every one skipped past since, were put to the reader and
         -- refused: handing them back would re-offer a pair the reader has just said
         -- they cannot call, and a reader who kept skipping and undoing would never
         -- finish. A skip since the frame shows as a count higher than the frame
         -- recorded, and then only the comparison on screen -- the last offer, which
         -- nobody answered or declined -- is withdrawn.
         --
         -- A frame written before this migration has no `seen`; it keeps the old
         -- behaviour rather than guessing, and only a session that was open across the
         -- deploy can hold one.
         seen_items = case
           when not (v_prev ? 'seen') then seen_items
           when v_s.skips > (v_prev ->> 'skips')::integer
             then seen_items[1:cardinality(seen_items) - 1]
           else seen_items[1:(v_prev ->> 'seen')::integer]
         end,
         -- **Undo never refunds a skip.** It used to take one off on every Undo, whatever
         -- had been undone. Only `rank_skip` raises the count and no frame this
         -- migration writes lowers it, so the count stays: equal to the frame's when no
         -- skip followed the answer, and still spent when one did.
         skips = case
           when v_prev ? 'skips' then skips
           else greatest(skips - 1, 0)
         end,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_pivot_item,
    'pivot_card', _rank_pivot_card(v_pivot_item)
  ));
end;
$$;

comment on function rank_back(uuid, uuid) is
  'One comparison back. Restores the range, the pivot and the offers to what they were when that comparison was shown (20260922000100), so answering it the same way again is the same progression as the first time -- except that a skip is never refunded, and titles declined by a skip taken after that comparison stay declined. At the first comparison the session is deleted -- and for a provisional session that is the whole undo: the title still holds the position it always had. Carries an operation id because a replay would pop a second frame off the history. A frame written before 20260922000100 restores the range and pivot only. Since 20260926000100 the session is rebased first if its band has moved, the restored comparison is the frame''s own opponent by id, and an Undo pressed on a comparison the rebase replaced returns the current comparison instead.';

-- `create or replace` keeps a grant, and these were granted before. Restated, because a
-- grant present for a reason nobody can see is a grant the next rebuild loses.
revoke execute on function rank_answer(uuid, uuid, uuid) from public, anon;
grant  execute on function rank_answer(uuid, uuid, uuid) to authenticated;
revoke execute on function rank_skip(uuid, uuid)         from public, anon;
grant  execute on function rank_skip(uuid, uuid)         to authenticated;
revoke execute on function rank_back(uuid, uuid)         from public, anon;
grant  execute on function rank_back(uuid, uuid)         to authenticated;
