-- A ranking you have not lost yet, and the people you have not met.
-- Specification: PRD §10 (reranking never deletes viewing history) · PRD §11 · PRD §13
-- · founder tranche, 2026-08-26 (final pre-RC product pass).
--
-- ===========================================================================
-- 1. THE BUG THE FOUNDER TAPPED
--
-- Open a ranked title, choose **Rank again**, and the score disappears from the
-- collection, from the profile and from the title page **before a single comparison
-- has been answered**. Close the sheet and it stays gone: the title is back in the
-- Unranked queue with nothing to show for the position it had five seconds ago.
--
-- That is not a display bug. `rank_again` (20260825000200) is literally
--
--     if ranked then _rank_unrank_impl(...);   -- the position is destroyed here
--     return _rank_start_impl(...);            -- and the session opens after it
--
-- and `rank_rebucket` has done the same since 20260813000700. Both are *atomic* --
-- 20260825000200 bought that, and it is real -- but atomicity is a promise about
-- crashes, not about intent. The transaction commits the destruction the instant the
-- sheet opens, and the reader has not decided anything yet.
--
-- **The contract this migration establishes.** Starting a re-ranking must not alter
-- canonical visible state. The old position, the old score, the old band and the
-- collection row all survive until the new placement completes. Closing the sheet,
-- navigating away, cancelling, losing the network, or killing the app leaves the
-- ranking exactly as it was, because nothing was ever taken away.
--
-- ===========================================================================
-- 2. HOW A SESSION RUNS AGAINST A TITLE THAT IS STILL RANKED
--
-- The comparison session is a binary search over a *band*, addressed by offsets from
-- the band's first position (`ranking_sessions.lo/hi/pivot`, 20260813001600). Leaving
-- the subject in place means it is a member of the very band it is being inserted
-- into: the band is one longer than it should be, and the search can be handed the
-- subject as its own opponent.
--
-- So a provisional session does all of its arithmetic over **the ranking with the
-- subject taken out**:
--
--   * `band_bounds_excluding` counts the band as it will be once the old row is gone.
--   * `_rank_pivot_at` gains an `exclude` argument and addresses candidates by
--     `row_number()` over the same filtered set, rather than by literal `position`.
--     For a non-provisional session the two are identical -- invariant I1 keeps
--     positions contiguous from 1 -- which is why one function serves both.
--   * `_rank_finalize` drops the old row **first**, inside the category lock it
--     already takes, and only then reads the band and places. After the drop the
--     filtered numbering *is* the real numbering, so the offset the session computed
--     is the position the title gets.
--
-- Nothing else in the schema learns a new concept. A provisional session is an
-- ordinary session with two booleans on it.
--
-- ===========================================================================
-- 3. THE SECOND FOUNDER FINDING: FOUR WAR DOGS IN THE FEED
--
-- `_rank_finalize` has emitted a `title_ranked` feed event on **every** completion
-- since 20260813000700, and every re-ranking completes one. So changing your mind
-- about a film's rating three times posted three "ranked War Dogs" activities, all
-- true, all identical, none of them a thing that happened.
--
-- The product distinction the founder drew is between two acts that were one RPC:
--
--   RANK AGAIN         you watched it again and are placing it again.
--                      One new activity, on completion, and never before.
--
--   CHANGE YOUR RATING you are correcting an opinion you already recorded.
--                      No new activity at all -- the original stands.
--
-- Both reach the server through `rank_again` (same band) or `rank_rebucket` (band
-- change), so the intent cannot be inferred from the entry point and is carried
-- explicitly: `rank_again` gains a trailing `p_new_watch`, and it is the session, not
-- the call, that remembers it -- the event is written at finalise, which is a different
-- transaction from the one that opened the session.
--
-- The rule `_rank_finalize` applies, in full:
--
--     a placement that creates a position where there was none  -> one event
--     a placement that replaces a position, as a new watch      -> one event
--     a placement that replaces a position, as a correction     -> no event
--
-- A first ranking therefore still posts, unconditionally, whatever any caller says.
-- And an abandoned re-ranking posts nothing, because it never reaches finalise.
--
-- **`p_new_watch` defaults to false**, which is the conservative direction for the
-- friend-beta build installed on two devices today: it calls `rank_again` with three
-- arguments from *both* Rank again and Change your rating, and of the two possible
-- wrong answers, "an activity that should have been posted was not" is recoverable
-- and "the feed filled up with duplicates again" is the bug being fixed.
--
-- ===========================================================================
-- 4. AND THE PEOPLE HALF
--
-- Two read-only suggestion functions for the new People segment of For You. Both are
-- `security definer` and take no viewer, per 20260813001900: the only perspective
-- either can answer from is `auth.uid()`'s own.
--
-- Neither invents a similarity model. `people_taste_matches` calls `taste_match`
-- (20260817000400) -- the canonical pairwise calculation, unchanged -- in a lateral
-- join, so the number on a suggestion row is the same number the profile shows.
--
-- What they must not do is explain a suggestion by disclosing something the caller
-- could not already read. §21 of the tranche brief, and the mechanism is stated at
-- each function.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The session remembers what kind of act it is
--
-- `provisional` changes the *numbering* the session works in, so it is fixed for the
-- life of a session and a resume that disagrees with it restarts rather than adapts.
-- `new_watch` changes only what happens at the very end, so a resume may update it --
-- the last intent the reader expressed is the honest one.
--
-- Both default false, which backfills every session already open on nonprod correctly:
-- a session written before this migration destroyed the old position at open, so it is
-- not provisional, and it will post the event a first ranking posts because it is
-- replacing nothing.
-- ---------------------------------------------------------------------------

alter table ranking_sessions
  add column provisional boolean not null default false,
  add column new_watch   boolean not null default false;

comment on column ranking_sessions.provisional is
  'The title still holds its old position while this session runs, and lo/hi/pivot are offsets into the band with the subject excluded. Set by rank_again and rank_rebucket; false for a first ranking. _rank_finalize drops the old row before it places, so an abandoned session costs nothing.';

comment on column ranking_sessions.new_watch is
  'Completing this session is another watch, so it earns one feed activity. False for Change your rating and for a band change, which are corrections to an opinion already recorded. Ignored when the session is not provisional -- a first ranking always posts.';


-- ---------------------------------------------------------------------------
-- 2. The band, and a candidate in it, with one title taken out
--
-- `band_bounds` itself is untouched. It is read by `community_score`,
-- `following_score`, `taste_match`, `title_reviews`, `rank_reorder` and the awards,
-- and none of those has a subject to exclude. This is a second function rather than a
-- fourth argument for exactly that reason: changing a signature that many callers
-- depend on, to serve one of them, is how a rebuild goes wrong invisibly.
--
-- `_rank_pivot_at` *is* replaced, because its three-argument form has one caller
-- family -- the ranking entry points below, all rewritten here -- and a defaulted
-- fourth argument beside the old arity would make every three-argument call ambiguous.
-- ---------------------------------------------------------------------------

create or replace function band_bounds_excluding(
  target uuid, cat ranking_category, b taste_bucket, exclude uuid
) returns table (lo integer, hi integer, size integer)
language sql stable
set search_path = public
as $$
  with counts as (
    select
      count(*) filter (where bucket = 'loved')      as loved,
      count(*) filter (where bucket = 'fine')       as fine,
      count(*) filter (where bucket = 'not_for_me') as nfm
    from rankings
   where user_id = target
     and category = cat
     and (exclude is null or media_item_id <> exclude)
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

comment on function band_bounds_excluding(uuid, ranking_category, taste_bucket, uuid) is
  'band_bounds over the ranking with one title removed: the bounds a provisional re-ranking session must use, because the subject is still holding a position inside the band it is being placed into. A null exclude is exactly band_bounds. Internal to the ranking family.';

revoke execute on function band_bounds_excluding(uuid, ranking_category, taste_bucket, uuid)
  from public, anon, authenticated;

drop function if exists _rank_pivot_at(uuid, ranking_category, integer);

create or replace function _rank_pivot_at(
  target uuid, cat ranking_category, pos integer, exclude uuid default null
) returns uuid
language sql stable
set search_path = public
as $$
  select t.media_item_id
    from (
      select r.media_item_id,
             row_number() over (order by r.position) as rn
        from rankings r
       where r.user_id = target
         and r.category = cat
         and (exclude is null or r.media_item_id <> exclude)
    ) t
   where t.rn = pos;
$$;

comment on function _rank_pivot_at(uuid, ranking_category, integer, uuid) is
  'The title at one position in a category, optionally with one title excluded from the numbering. Addressed by row_number rather than by rankings.position so that the excluded form is contiguous; for a null exclude the two agree, because I1 keeps positions 1..n. Internal.';

revoke execute on function _rank_pivot_at(uuid, ranking_category, integer, uuid)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. `_rank_session_state` reports the kind of session it is
--
-- Rebuilt in full from `20260813001600`, not patched -- the rule this schema keeps
-- learning (`_assert_operation_rate`, and 20260825000200's own §3): a `create or
-- replace` assembled from the wrong ancestor is invisible in a diff. Every line is
-- carried across; what is new is the two flags in the return, and
-- `band_bounds_excluding` in place of `band_bounds`.
--
-- The clamp below is now doing slightly more work than it was. It was written for a
-- band that shrank under an open session; a provisional session's band can also *grow*
-- relative to what the session recorded -- the reader ranks something else into it from
-- another device -- and `least(s.hi, b.size)` is still the right answer, because `hi`
-- is an exclusive bound over the members that existed when the search narrowed.
-- ---------------------------------------------------------------------------

drop function if exists _rank_session_state(uuid, uuid);

create or replace function _rank_session_state(p_session_id uuid, p_user uuid)
returns table (
  session_id    uuid,
  media_item_id uuid,
  category      ranking_category,
  bucket        taste_bucket,
  band_lo       integer,
  band_size     integer,
  lo            integer,
  hi            integer,
  pivot         integer,
  skips         smallint,
  history       jsonb,
  provisional   boolean,
  new_watch     boolean
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

  -- The subject is excluded from its own band exactly when it is still sitting in it,
  -- which is what `provisional` means.
  select * into b from band_bounds_excluding(
    p_user, s.category, s.bucket,
    case when s.provisional then s.media_item_id end
  );

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
    -- Carried verbatim from 20260813001600: a stored pivot that a shrunken band has
    -- put out of range is clamped back inside it rather than left to address a title
    -- that is no longer there.
    greatest(v_lo, least(coalesce(s.pivot, (v_lo + v_hi) / 2), greatest(v_hi - 1, v_lo))),
    s.skips,
    s.history,
    s.provisional,
    s.new_watch;
end;
$$;

comment on function _rank_session_state(uuid, uuid) is
  'One open session with its band resolved and its bounds clamped to the live band, plus the two flags that say what kind of act it is. For a provisional session the band is computed with the subject excluded, because the subject is still ranked inside it. Internal.';

revoke execute on function _rank_session_state(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. `_rank_finalize` is where a re-ranking finally costs something
--
-- Rebuilt in full from `20260825000200` §3. Everything that migration added -- the
-- category lock, the band recomputed inside it, the placement guard, the `user_media`
-- re-assertion that closes I1 and I3 -- is carried across unchanged. Two things are
-- new, and they are the whole of this tranche's server-side behaviour change.
--
-- **The drop, and where it sits.** `p_replaces` says the subject may still be holding
-- an old position. The drop happens *inside* the advisory lock and *before*
-- `band_bounds` is read, which is what makes the offset the session computed and the
-- band this insert is measured against describe the same ranking. `_rank_unrank_impl`
-- takes the same category lock; advisory transaction locks are re-entrant for one
-- session, so taking it twice costs a hash lookup and buys the impl being callable
-- from anywhere in the family.
--
-- It is guarded by an `exists` rather than trusting the flag, because the row can
-- legitimately have gone in the gap: `unlog` on another device removes it, and
-- `_rank_unrank_impl` raises P0002 on a title that is not ranked. A session whose
-- subject lost its position while the reader was answering comparisons is not an
-- error -- it is a first ranking now, and it is finalised as one.
--
-- **The event, and when it is not written.** `v_replaced` is the fact rather than the
-- flag: it is true only if a row was genuinely removed. A placement that created a
-- position where there was none always posts, whatever `p_new_watch` says, because
-- that is a first ranking by observation and PRD §11 has always posted one.
-- ---------------------------------------------------------------------------

drop function if exists
  _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean);

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false,
  p_replaces boolean default false,
  p_new_watch boolean default false
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
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- NEW. The old position, dropped at the last possible moment rather than at the
  -- first. Everything above this line in the reader's session -- opening the sheet,
  -- every comparison, every skip, closing it and coming back -- left the ranking they
  -- already had exactly where it was.
  if p_replaces and exists (
    select 1 from rankings where user_id = target and media_item_id = item
  ) then
    perform _rank_unrank_impl(target, item);
    v_replaced := true;
  end if;

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw. With the drop above, that
  -- is now also the numbering the session's offsets were computed in.
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

  -- The collection row this ranking is a claim about, re-asserted from the ranking
  -- itself (20260825000200 §3). It closes I1 and I3 against anything that committed in
  -- the gap between the session opening and this transaction -- and since this
  -- migration it is also the *only* writer of a provisional band change: `rank_rebucket`
  -- no longer moves `user_media.bucket` up front, because moving it up front is the
  -- visible state change this tranche exists to stop.
  insert into user_media (user_id, media_item_id, bucket)
  values (target, item, b)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket, updated_at = now()
   where user_media.bucket is distinct from excluded.bucket;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

  -- NEW, and the founder's four War Dogs. A correction to an opinion already recorded
  -- is not a thing that happened to anybody else, so it does not become an activity.
  -- A first ranking always is one; another watch always is one.
  if p_new_watch or not v_replaced then
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
    );
  end if;

  -- PRD §28's activation, from the one place a ranking is created.
  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated
  );
end;
$$;

comment on function
  _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean)
is
  'Places one title and closes its session. p_replaces drops the subject''s previous position first, inside the category lock and before the band is read, which is what lets a re-ranking session run without ever taking the old score off the screen. The title_ranked activity is written only when the placement created a position that did not exist, or when the session was declared another watch -- a Change your rating writes none.';

revoke all on function
  _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. `_rank_start_impl` learns to open a session over a title that is still ranked
--
-- Rebuilt in full from `20260825000200` §4. What changes is guarded by
-- `p_provisional`, and every guard is stated:
--
--   * **The bucket is not written.** A provisional session must not move
--     `user_media.bucket`: that is the chip on the title page and the band the
--     collection files it under, and both are canonical visible state. `_rank_finalize`
--     writes it at the end instead. For a first ranking the upsert is unchanged and
--     PRD §11 still holds -- bucketing and ranking are separate acts, and abandoning
--     the second does not undo the first.
--
--   * **Already ranked is the point, not a 23505.** The refusal stays for a first
--     ranking, where it is what stops `rank_start` silently double-placing a title.
--
--   * **The band excludes the subject**, per §2 above.
--
--   * **A resume that disagrees about `provisional` restarts.** The flag decides which
--     numbering `lo`/`hi`/`pivot` are expressed in, so a session opened one way cannot
--     be continued the other -- the stored offsets would address the wrong titles.
--     `new_watch` is different: it changes only what happens at finalise, so a resume
--     updates it and the last intent the reader expressed wins.
-- ---------------------------------------------------------------------------

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
  v_exclude  uuid;
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

      select * into v_state from _rank_session_state(v_existing.id, p_user);
      return jsonb_build_object(
        'done', false,
        'session_id', v_state.session_id,
        'pivot', _rank_pivot_at(
          p_user, v_cat, v_state.band_lo + v_state.pivot, v_exclude
        ),
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

  v_pivot := v_band.size / 2;

  insert into ranking_sessions (
    user_id, media_item_id, category, bucket, lo, hi, pivot, provisional, new_watch
  )
  values (
    p_user, p_media_item_id, v_cat, p_bucket, 0, v_band.size, v_pivot,
    v_exclude is not null, p_new_watch
  )
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', _rank_pivot_at(p_user, v_cat, v_band.lo + v_pivot, v_exclude),
    'resumed', false
  );
end;
$$;

comment on function _rank_start_impl(uuid, uuid, taste_bucket, boolean, boolean) is
  'Opens a comparison session, or places the title outright when its band is empty. The body of rank_start, shared with rank_rebucket and rank_again. With p_provisional it opens *over* a title that is still ranked: the bucket is not written, the already-ranked refusal does not apply, and the band excludes the subject -- so nothing the reader can see changes until the placement completes. Assumes the caller holds _lock_media for the same (user, media item). Internal.';

revoke execute on function _rank_start_impl(uuid, uuid, taste_bucket, boolean, boolean)
  from public, anon, authenticated;

-- The three-argument arity is gone: `create or replace` above added two defaulted
-- parameters, which creates an overload rather than replacing, and a three-argument
-- call against both would be ambiguous. Dropped after the new one exists so there is
-- no window in which the name resolves to nothing.
drop function if exists _rank_start_impl(uuid, uuid, taste_bucket);


-- ---------------------------------------------------------------------------
-- 6. The entry points that open a session
--
-- `rank_start` is rebuilt only because `_rank_start_impl`'s signature moved; its
-- behaviour is identical. `rank_rebucket` and `rank_again` are where the product
-- change lands.
-- ---------------------------------------------------------------------------

create or replace function rank_start(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_start');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  -- A first ranking: not provisional, and the feed event is unconditional at finalise
  -- because it will not be replacing anything.
  return _record_operation_result(
    p_operation_id, _rank_start_impl(v_user, p_media_item_id, p_bucket, false, true)
  );
end;
$$;

comment on function rank_start(uuid, taste_bucket, uuid) is
  'Logs a title with its bucket and opens a comparison session, or places it outright when its band is empty. Takes the media lock, so it cannot interleave with set_bucket, unlog or clear_watch_date on the same title. With an operation id, a replay returns the first call''s answer rather than resuming or refusing.';


-- rank_rebucket -------------------------------------------------------------
--
-- **The unrank is gone from the top of this function**, and so is the bucket update.
-- Both were canonical state changing at the moment a sheet opened: a reader who moved
-- a film from Loved to Fine and then closed the sheet without answering one comparison
-- had already lost the position and moved the band. `_rank_finalize` does both now, at
-- the end, in the transaction that has something to replace them with.
--
-- The 22023 on a bucket that is not moving stays. It is the refusal `rank_again` was
-- built to be the other side of, and an installed client relies on it.

create or replace function rank_rebucket(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
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

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  if v_r.bucket = p_bucket then
    raise exception 'title is already in that bucket' using errcode = '22023';
  end if;

  -- PRD §10 requires that changing a bucket re-runs comparisons rather than estimating
  -- a new position, and it still does: the session below is a full binary search over
  -- the new band. What has changed is that the old position is not surrendered to open
  -- it. Never a new watch -- changing your mind about a rating is not a second viewing.
  return _record_operation_result(
    p_operation_id, _rank_start_impl(v_user, p_media_item_id, p_bucket, true, false)
  );
end;
$$;

comment on function rank_rebucket(uuid, taste_bucket, uuid) is
  'Moves an already-ranked title into a different band by re-running its comparisons there. Since 20260826000500 the old position and the old bucket survive until the new placement completes, so abandoning the sheet costs nothing. Writes no feed activity: a band change is a correction to an opinion already recorded. Refuses 22023 for a bucket that is not moving -- rank_again is the same-band case.';


-- rank_again ----------------------------------------------------------------
--
-- **Two things happen here that did not.** The unrank is gone -- it is the founder's
-- disappearing score, and `_rank_finalize` does it at the end instead -- and the call
-- now says whether it is another watch or a correction.
--
-- The two callers were indistinguishable before: the Ranked menu's *Rank again* and
-- the log sheet's *Change your rating* re-choosing the band it already has both
-- arrive here, and only the first is a viewing. `p_new_watch` is how they differ, and
-- it is stored on the session rather than acted on immediately, because the activity
-- is written at finalise -- several transactions and possibly several minutes later.
--
-- **It defaults to false.** The friend-beta build on two devices calls this with three
-- arguments from both places, and under-posting an activity is the recoverable
-- direction; the duplicate feed entries are the bug.

drop function if exists rank_again(uuid, taste_bucket, uuid);

create or replace function rank_again(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null,
  p_new_watch     boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
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

  -- No unrank. `_rank_start_impl` opens the session over the ranking that is still
  -- there, and `_rank_finalize` replaces it only if and when the reader finishes.
  return _record_operation_result(
    p_operation_id,
    _rank_start_impl(v_user, p_media_item_id, p_bucket, true, coalesce(p_new_watch, false))
  );
end;
$$;

comment on function rank_again(uuid, taste_bucket, uuid, boolean) is
  'Ranks a title again without giving up the position it already has. The same-band case rank_rebucket refuses, and it serves a band change too. Since 20260826000500 nothing visible changes until the new placement completes: abandoning, cancelling or losing the connection leaves the old score, band and position exactly as they were. p_new_watch declares the act another viewing, which earns exactly one feed activity at completion; false -- the default, and what Change your rating passes -- writes none.';


-- ---------------------------------------------------------------------------
-- 7. The three session steps, rebuilt for the four-argument pivot
--
-- Carried verbatim from `20260825000200` §5 except at the marked lines: every
-- `_rank_pivot_at` gains the exclusion, and every `_rank_finalize` passes the
-- session's two flags through. Rebuilt in full rather than patched, for the reason
-- that migration gives about its own rebuild.
-- ---------------------------------------------------------------------------

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

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_next,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot
         ),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_next, v_exclude)
  ));
end;
$$;

comment on function rank_answer(uuid, uuid, uuid) is
  'Records one comparison and either narrows the search or finalises the placement. With an operation id, a replay returns the stored answer -- the same position, score and activation flag -- so a retry cannot record a second comparison, move the title twice, or emit a second feed event. For a provisional session the opponents come from the band with the subject excluded, and the placement replaces the subject''s old position rather than filling a hole left behind at the start.';


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
  v_offset     integer := 1;
  v_seen       integer := 0;
  v_candidate  integer;
  v_pivot      integer := null;
  v_band_skips integer;
  v_skip_lo    integer;
  v_skip_hi    integer;
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

  select * into v_s from _rank_session_state(p_session_id, v_user);
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

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

  select rs.band_skips, rs.skip_lo, rs.skip_hi
    into v_band_skips, v_skip_lo, v_skip_hi
    from ranking_sessions rs where rs.id = v_s.session_id;

  -- A different band means a different set of candidates, so nothing offered
  -- before counts against this one.
  if v_skip_lo is distinct from v_s.lo or v_skip_hi is distinct from v_s.hi then
    v_band_skips := 0;
  end if;

  -- mid+1, mid-1, mid+2, mid-2, … skipping candidates outside [lo, hi), and stopping
  -- on the one after however many have been offered against this band. Carried from
  -- `_rank_skip_unguarded` (20260813002100 §3) unchanged.
  while v_offset <= (v_s.hi - v_s.lo) loop
    v_candidate := v_mid + v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_band_skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_candidate := v_mid - v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_band_skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_offset := v_offset + 1;
  end loop;

  -- Genuinely out of distinct comparisons for this band. Placing at the midpoint is
  -- the same resolution as running out of patience, and is reported as adjustable.
  if v_pivot is null then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- Persisting the pivot is 20260813001600's fix. Without it the answer path
  -- recomputed the midpoint and refused the title it had just displayed.
  update ranking_sessions
     set skips      = skips + 1,
         band_skips = v_band_skips + 1,
         skip_lo    = v_s.lo,
         skip_hi    = v_s.hi,
         pivot      = v_pivot,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_pivot, v_exclude),
    'skipped', true
  ));
end;
$$;

comment on function rank_skip(uuid, uuid) is
  'Re-anchors to a different opponent without narrowing the range; the configured skip limit places the title at the midpoint instead. Carries an operation id because a skip mutates -- a replay without one spends a second skip against the limit and shows a third title. For a provisional session the candidates exclude the subject, which is still ranked inside the band.';


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

  select * into v_s from _rank_session_state(p_session_id, v_user);

  if jsonb_array_length(v_s.history) = 0 then
    delete from ranking_sessions where id = v_s.session_id;
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', false, 'cancelled', true)
    );
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

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(
      v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer,
      case when v_s.provisional then v_s.media_item_id end
    )
  ));
end;
$$;

comment on function rank_back(uuid, uuid) is
  'One comparison back, restoring the pivot along with the range. At the first comparison the session is deleted -- and for a provisional session that is the whole undo: the title still holds the position it always had. Carries an operation id because a replay would pop a second frame off the history.';


-- ---------------------------------------------------------------------------
-- 8. Grants, restated for every signature that was dropped
--
-- `drop function` drops its grants with it, and the two rebuilt entry points below are
-- the only public ones affected. `rank_start`, `rank_rebucket`, `rank_answer`,
-- `rank_skip` and `rank_back` were `create or replace`d, which does not disturb a
-- grant -- restated anyway, because a grant that is present for a reason nobody can
-- see is a grant the next rebuild loses.
-- ---------------------------------------------------------------------------

revoke execute on function rank_again(uuid, taste_bucket, uuid, boolean) from public, anon;
grant  execute on function rank_again(uuid, taste_bucket, uuid, boolean) to authenticated;

revoke execute on function rank_start(uuid, taste_bucket, uuid)     from public, anon;
grant  execute on function rank_start(uuid, taste_bucket, uuid)     to authenticated;
revoke execute on function rank_rebucket(uuid, taste_bucket, uuid)  from public, anon;
grant  execute on function rank_rebucket(uuid, taste_bucket, uuid)  to authenticated;
revoke execute on function rank_answer(uuid, uuid, uuid)            from public, anon;
grant  execute on function rank_answer(uuid, uuid, uuid)            to authenticated;
revoke execute on function rank_skip(uuid, uuid)                    from public, anon;
grant  execute on function rank_skip(uuid, uuid)                    to authenticated;
revoke execute on function rank_back(uuid, uuid)                    from public, anon;
grant  execute on function rank_back(uuid, uuid)                    to authenticated;


-- ===========================================================================
-- 9. PEOPLE DISCOVERY
--
-- Two suggestion lists for the People segment of For You. Both answer only about
-- `auth.uid()`, both return identity plus one number, and neither returns anything a
-- caller could not already have assembled for themselves.
--
-- **What is deliberately not here.** No contacts, no phone numbers, no address book,
-- no second taste algorithm, no popularity ranking, no "because you follow X" naming.
-- The founder deferred the first three explicitly and the last is a privacy decision
-- taken below.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 9a. Mutuals -- people followed by people you follow
--
-- The graph query, and then the two predicates that make it safe to run at all.
--
-- **Every edge counted is an edge the caller could select individually.**
-- `follows_read` (20260813001900) admits an approved row when the caller can view both
-- of its parties, so restricting the intermediary *and* the candidate to
-- `can_view_profile` makes this an aggregate over rows the caller already has. That is
-- the same argument `following_score` and `taste_match` record, and it is what stops
-- this being a graph oracle: it cannot tell you about an edge you were not already
-- entitled to read.
--
-- **The count, and not the names.** "Followed by Sarah and two others" would be
-- defensible on the same argument -- those rows are readable -- but it puts a specific
-- person's following list on somebody else's screen as a *claim*, in a list they can
-- screenshot, and the founder's instruction is to fall back to a number if naming
-- creates any doubt. It does. So: a number.
--
-- **The consequence for private accounts, stated rather than discovered.** A private
-- account the caller does not follow fails `can_view_profile`, so no edge into it is
-- readable and it cannot be suggested here -- even though `can_discover_profile` would
-- let it be *found* by name. That is the existing contract rather than a new
-- restriction: surfacing them would mean disclosing that somebody the caller follows
-- follows a private account, which is exactly the hidden relationship §21 forbids
-- explaining a suggestion with. `can_discover_profile` is still applied on top, because
-- it is what excludes suspension, blocks in either direction, and the caller
-- themselves.
--
-- **Pending is excluded along with approved.** `not exists` over the caller's outgoing
-- edge in *any* state: a request already sent is not a person to suggest following.
-- ---------------------------------------------------------------------------

create or replace function people_mutuals(p_limit integer default 10)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  mutual_count integer
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- The caller's own approved outgoing edges. Every one of these is a row where the
  -- caller is the follower, so `follows_read` would admit it directly.
  mine as (
    select f.followee_id as via
      from follows f, me
     where f.follower_id = me.id
       and f.state = 'approved'
       and can_view_profile(me.id, f.followee_id)
  ),
  candidates as (
    select f.followee_id as subject, count(*)::integer as mutuals
      from follows f
      join mine on mine.via = f.follower_id
      cross join me
     where f.state = 'approved'
       and f.followee_id <> me.id
       -- The candidate side of the same readability test. Without it this would count
       -- edges into accounts the caller may not view, and the count itself would be
       -- the disclosure.
       and can_view_profile(me.id, f.followee_id)
       -- Suspension, blocks either way, and never yourself.
       and can_discover_profile(me.id, f.followee_id)
       -- Already followed, or already asked. Neither is a suggestion.
       and not exists (
         select 1 from follows own
          where own.follower_id = me.id and own.followee_id = f.followee_id
       )
     group by f.followee_id
  )
  select c.subject, p.username::text, p.display_name, p.avatar_path, p.visibility, c.mutuals
    from candidates c
    join profiles p on p.id = c.subject
   -- Most connected first, then a stable tie-break so two calls with the same graph
   -- return the same order and the list does not shuffle under a reader.
   order by c.mutuals desc, p.username, c.subject
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function people_mutuals(integer) is
  'People followed by the people the caller follows, most shared connections first. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Every edge counted is one follows_read would admit to the caller individually -- both parties must pass can_view_profile -- so the count discloses nothing new, and the mutuals are never named. Excludes the caller, anyone they already follow or have asked to follow, blocks in either direction and suspended accounts.';

revoke execute on function people_mutuals(integer) from public, anon;
grant  execute on function people_mutuals(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 9b. Taste matches -- people whose rankings agree with yours
--
-- **`taste_match` is the calculation, unchanged and uncopied.** The founder's rule for
-- this screen is that there is one taste algorithm in the product, and the way to keep
-- that true is to call it: the lateral join below invokes `taste_match(candidate)` per
-- row, so a suggestion showing 87% and a profile showing 87% are the same arithmetic
-- and cannot drift apart. It also inherits every refusal that function already makes --
-- self, suspension, blocks, and a private account that has not approved this follower
-- all come back as no score.
--
-- **Candidates are narrowed before the expensive part.** `taste_match` reads two
-- catalogues and computes a rank correlation, which is not something to run against
-- every account in the database. The `overlap` CTE is a cheap join on
-- `rankings.media_item_id` that finds only accounts sharing at least the configured
-- minimum number of exact titles with the caller -- which is precisely the population
-- that could have a score at all -- and the ordering takes the most-overlapping
-- candidates first before the cap.
--
-- **The minimum-data gate is `taste.min_common` and not a second number.** A row is
-- returned only when `taste_match` produced a score, so this screen cannot claim a
-- precision the profile would refuse to show.
-- ---------------------------------------------------------------------------

create or replace function people_taste_matches(p_limit integer default 10)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  match_score  integer
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'taste.min_common'),
      5
    ) as k
  ),
  mine as (
    select r.media_item_id from rankings r, me where r.user_id = me.id
  ),
  overlap as (
    select r.user_id as subject, count(*) as shared
      from rankings r
      join mine on mine.media_item_id = r.media_item_id
      cross join me
     where r.user_id <> me.id
     group by r.user_id
  ),
  candidates as (
    select o.subject, o.shared
      from overlap o, me, threshold t
     where o.shared >= t.k
       -- Readable, because a score over rankings the caller may not select would be an
       -- aggregate leak. `taste_match` enforces this too; stated here as well so the
       -- expensive call is not made for a row that can only come back empty.
       and can_view_profile(me.id, o.subject)
       and can_discover_profile(me.id, o.subject)
       and not exists (
         select 1 from follows own
          where own.follower_id = me.id and own.followee_id = o.subject
       )
     order by o.shared desc, o.subject
     -- Bounded before the arithmetic. Thirty pairwise matches is the most this screen
     -- will ever ask for, and the ten it shows come from the most-overlapping thirty.
     limit 30
  )
  select c.subject, p.username::text, p.display_name, p.avatar_path, p.visibility, tm.score
    from candidates c
    join profiles p on p.id = c.subject
    join lateral taste_match(c.subject) tm on true
   -- The one canonical gate: no score, no row. Below taste.min_common shared titles
   -- `taste_match` returns null and this screen says nothing rather than guessing.
   where tm.score is not null
   order by tm.score desc, c.shared desc, p.username, c.subject
   limit least(greatest(coalesce(p_limit, 10), 0), 30);
$$;

comment on function people_taste_matches(integer) is
  'People whose rankings agree most with the caller''s, scored by taste_match itself rather than by a second algorithm -- so a suggestion and a profile can never show different numbers. Definer and takes no viewer (20260813001900). Candidates are narrowed to accounts sharing at least taste.min_common exact titles, must pass can_view_profile and can_discover_profile, and exclude anyone the caller already follows or has asked to follow. A candidate with no score is not returned, so the screen never claims a precision the profile would refuse.';

revoke execute on function people_taste_matches(integer) from public, anon;
grant  execute on function people_taste_matches(integer) to authenticated;
