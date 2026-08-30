-- A consequence sits above its cause, and a private account is still on the board.
-- Founder final beta correction, 2026-08-30. Two schema changes and one comment; the
-- rest of the tranche is client-side and is listed at the foot of this header so that
-- the SQL and the app can be read as one change.
--
-- ===========================================================================
-- 1. THE FEED'S CAUSAL ORDER, THE OTHER WAY UP
--
-- `20260901000100` gave every feed event a `causal_step` -- 0 for the act, 1 for the
-- goal it completed, 2 and up for the awards it earned -- so that the three rows one
-- ranking writes in one transaction, sharing `created_at` to the microsecond, could be
-- put in a fixed order instead of whatever the plan returned. That mechanism was
-- correct and is untouched. **The direction it was read in was wrong.**
--
-- It specified `causal_step ASC` inside `causal_at DESC`, which puts the ranking at the
-- top of its own group and the award it earned underneath:
--
--     Suraj ranked Fullmetal Alchemist: Brotherhood, S1     <- causal_step 0
--     Suraj earned the Hitchhiker award                     <- causal_step 2
--
-- The reasoning recorded for that was "cause before consequence", which is the right
-- order for a sentence and the wrong one for **a reverse-chronological list**. Earning
-- the award happened *after* the ranking that earned it. Everything else in this feed
-- puts a later event higher; the causal group was the one place that did not, so the
-- newest thing that had happened to a reader sat below something older.
--
-- The fix is one word at every reader: `causal_step DESC`.
--
--     Suraj earned the Hitchhiker award                     <- causal_step 2, later
--     Watched 15 non-English titles
--     Suraj ranked Fullmetal Alchemist: Brotherhood, S1     <- causal_step 0, the cause
--
-- **A higher step is a later event.** That is what the column has always recorded and
-- it is now what the sort says. Nothing about the writers moves: `_rank_finalize` still
-- posts `title_ranked` after the inserts whose triggers announce the award, the goal
-- still inherits `causal_at` from the activity that carried its count over, and two
-- awards earned by one action keep the order `_maybe_award_unlocks` walks `p_awards` in
-- -- read downwards, the last one announced is now the first one seen, which is the
-- same "later above" rule applied inside the group.
--
-- The sort stays **total** -- `(causal_at, causal_step, id)`, and `id` is a primary key
-- -- so a refetch, a page boundary and a live insertion all produce the same list. That
-- was the point of the third key and it is unaffected by reversing the second.
--
-- **Why there is no data change here.** The readers are PostgREST order clauses in
-- `src/features/feed/use-feed.ts`; the column, its values and its writers are all
-- correct already. What this migration owns is the *contract*, which lives in the
-- column comment, and a comment that still told readers to sort ascending would be the
-- next person's instruction to reintroduce the bug.
--
-- ===========================================================================
-- 2. WHEN AN AWARD IS ANNOUNCED, AND WHY NOTHING HERE MOVES
--
-- The founder's requirement is that a congratulations must not arrive before the act it
-- is congratulating has finished -- "an abandoned incomplete ranking must not emit a
-- congratulations whose visible cause has not completed". Audited, and the schema
-- already meets it, for a reason worth writing down rather than re-deriving:
--
-- **Every award and goal announcement is written inside the transaction of the act.**
-- `award_on_user_media` and `goal_on_user_media_insert` are AFTER-ROW triggers on
-- `user_media`, so the feed event and the notification they write commit exactly when
-- the writer commits and never before. There is no queue, no deferred job and no second
-- statement that could land early.
--
-- That gives two flows and both are correct:
--
--   * **Ranking a title the reader has not logged.** `_rank_finalize` inserts the
--     `rankings` row and the `user_media` row and then posts `title_ranked`. The award
--     trigger fires at the end of the `user_media` statement, so the announcement is
--     written *before* the activity in insertion order -- and that is precisely why the
--     order is declared by `causal_step` rather than taken from a serial. If the
--     ranking session is abandoned, `_rank_finalize` never runs, no `user_media` row is
--     written by it, and nothing is announced.
--
--   * **Logging a watch and then ranking it.** `log_watched` creates the `user_media`
--     row itself, so the award is earned and announced by the *log*, which is a
--     completed act with a `title_logged` activity of its own to sit above. A ranking
--     that follows is a second act; abandoning it changes nothing that was already
--     true. This is the "legitimate flow that records a watch without ranking" the
--     brief asks to be documented rather than guessed at: **the canonical cause of an
--     award earned at log time is the log**, and it is a real, visible, completed
--     event.
--
-- A goal is the one derived event whose cause is a watch *date* rather than a write, so
-- it commits seconds after the ranking that carried its count over and posts under a
-- `causal_at` inherited from that activity. That inheritance is what keeps it in the
-- group; the reversal above is what puts it at the top of the group.
--
-- Push follows the notification and cannot precede it: `_apply_notification_preference`
-- is a BEFORE trigger on `notifications` and the `push_outbox` row is written by an
-- AFTER trigger on the same insert, inside the same transaction. A row the transaction
-- rolls back takes its outbox row with it.
--
-- ===========================================================================
-- 3. A PRIVATE ACCOUNT IS ON THE LEADERBOARD, AS A ROW AND NOT AS A PROFILE
--
-- `20260828000300` filtered the board's population through `can_view_profile`, so a
-- private account the caller has not been approved by was **absent, count and all**.
-- The founder has reversed that, on the same reasoning `20260819000100` used to make a
-- private account discoverable by name: privacy is about what somebody wrote, not about
-- whether they can be found.
--
-- A board that silently omits people is also a board that lies about where you stand.
-- The reader who is fourth of ten is told they are third of nine, and the account they
-- cannot see is the one they might most want to ask to follow.
--
-- **What an unapproved viewer now gets for a private account:**
--
--     rank, display name, handle, avatar, the private flag, and the metric count
--
-- and nothing else. Match and its shared-title count are **null at the server**, not
-- hidden at the client -- `visibility` and `viewable` are returned so the row can draw
-- a lock and route to the locked shell, and every private field is simply not in the
-- result set. A modified client learns nothing a stock one does not.
--
-- **What it does not get**, and none of it is reachable from here: the ranked titles,
-- the scores, the collection, the reviews, the activity, the awards, the watch dates,
-- the goals. Those are all behind `can_view_profile` in their own policies and this
-- function neither relaxes nor consults them for anything but the Match column.
--
-- **The metric count is the disclosure, and it is the founder's decision taken
-- explicitly.** A leaderboard is a ranking, and a ranking with the number removed is
-- not a leaderboard -- the position alone would already imply a band. So one aggregate
-- becomes visible: how many titles, films, seasons or reviews. It names nothing, dates
-- nothing, and it is the same order of disclosure as the follower count a private
-- profile shell has always shown.
--
-- **Blocks and suspension are not relaxed and are not a visibility setting.**
-- Eligibility is `can_view_profile OR can_discover_profile`, and the second is
-- `20260819000100`'s: it refuses a block in either direction, refuses a non-active
-- account, and refuses the caller themselves -- which the first admits, so the union is
-- exactly "everyone the caller may read, plus everyone the caller may find". A blocked
-- account is absent rather than hidden, in both directions, and so is a suspended one.
-- A deleted account has no `profiles` row to be found.
--
-- There is no leaderboard opt-out in this pass. The founder deferred it and the
-- implementation does not argue for it: the row is the same identity `search_users` and
-- the follower lists have returned since 20260819000100, plus one number.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The causal contract, restated in the direction it is read
-- ---------------------------------------------------------------------------

comment on column feed_events.causal_step is
  'Where this event sits among the events one action produced: 0 the act itself, 1 the goal it completed, 2 and up the awards it earned, in the order _maybe_award_unlocks walks its argument. A higher step is a LATER event. Every row of a causal group shares causal_at -- they are written in one transaction and the default is now(), and a goal completion inherits the timestamp of the activity that carried its count over -- so this is what orders them within a group. Readers sort by (causal_at desc, causal_step DESC, id asc): the feed is reverse chronological, so the award an action earned belongs ABOVE the act that earned it. It was specified ascending on 20260901000100 and corrected on 20260902000100; ascending put a ranking above the award it produced, which is the one place in the feed where an older event outranked a newer one. Not a serial: _rank_finalize writes rankings before it posts title_ranked, so insertion order is the reverse of the truth in one direction and the reverse of the reading order in the other.';


-- ---------------------------------------------------------------------------
-- 2. The board's population
--
-- One CTE renamed and one predicate widened. Everything else in this function --
-- the four metrics, the two timeframes, the date semantics, the review state-vs-event
-- distinction -- is `20260829000100` unchanged, restated whole because a
-- `create or replace` of a `language sql` body cannot be partial.
-- ---------------------------------------------------------------------------

create or replace function _leaderboard_counts(p_metric text, p_timeframe text)
returns table (user_id uuid, metric_count integer)
language sql stable security definer
set search_path = public
as $$
  with bounds as (
    select _leaderboard_month_start() as from_day,
           (_leaderboard_month_start() + interval '1 month')::date as to_day
  ),
  -- **Everyone the caller may read, plus everyone the caller may find** (20260902000100).
  --
  -- It was `can_view_profile` alone, which dropped an unapproved private account out of
  -- the board entirely. `can_discover_profile` is the identity gate `20260819000100`
  -- added for people search: it refuses a block in either direction, refuses a
  -- non-active account, and refuses the caller themselves -- and the caller is admitted
  -- by the first branch, so the union is exactly the population the founder asked for
  -- without any of the three exclusions being relaxed.
  --
  -- What the *row* then shows for somebody only the second branch admits is decided in
  -- `leaderboard` below, not here: this function returns a count and an id, and it has
  -- never returned which titles.
  eligible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and (can_view_profile(auth.uid(), p.id) or can_discover_profile(auth.uid(), p.id))
  ),
  watched_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       and um.watched_on is not null
       and um.watched_on >= b.from_day
       and um.watched_on <  b.to_day
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  watched_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
     where p_timeframe = 'all_time'
       and p_metric in ('titles', 'movies', 'tv')
       -- No date test. A watch without a date is still a watch, and with no month to
       -- attribute it to there is nothing to get wrong. `user_media` is keyed
       -- (user, title), so this is already a count of distinct titles.
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  reviews_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric = 'reviews'
       and um.note_first_published_at is not null
       and um.note_first_published_at >= (b.from_day::timestamp at time zone 'UTC')
       and um.note_first_published_at <  (b.to_day::timestamp   at time zone 'UTC')
     group by um.user_id
  ),
  reviews_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
     where p_timeframe = 'all_time'
       and p_metric = 'reviews'
       -- **A state, not an event.** The titles this account has a public review on right
       -- now. Un-sharing lowers it and re-sharing restores it, so the toggle is a way of
       -- reaching a number you already earned rather than a way of exceeding it.
       and um.note is not null
       and um.note_visibility = 'public'
     group by um.user_id
  )
  select * from watched_month
   union all
  select * from watched_all
   union all
  select * from reviews_month
   union all
  select * from reviews_all;
$$;

comment on function _leaderboard_counts(text, text) is
  'One person, one number, for one metric and one timeframe, over exactly the accounts the caller may read OR may find -- can_view_profile or can_discover_profile, which since 20260902000100 admits an unapproved private account while still refusing a block in either direction, a suspended account and a deleted one. Monthly watched reads user_media.watched_on (the watch date, not the logging date; a dateless row counts nowhere); all-time watched drops the date test, because a watch without a date is still a watch and there is no month to misattribute it to. Monthly reviews reads note_first_published_at, an event an edit cannot move; all-time reviews counts titles currently carrying a public note, a state a re-share cannot exceed. Never returns which titles. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';


-- ---------------------------------------------------------------------------
-- 3. The board
--
-- Dropped and recreated rather than replaced: the return table gains a column, and
-- `create or replace function` cannot change a return type. Nothing depends on it
-- through the catalogue -- `monthly_leaderboard`'s body is a string, resolved when it
-- runs -- so the drop is safe and the wrapper is restated below anyway.
-- ---------------------------------------------------------------------------

drop function if exists leaderboard(text, text, integer);

create function leaderboard(
  p_metric    text default 'titles',
  p_timeframe text default 'month',
  p_limit     integer default 50
)
returns table (
  user_id       uuid,
  username      text,
  display_name  text,
  avatar_path   text,
  visibility    profile_visibility,
  metric_count  integer,
  rank          integer,
  is_you        boolean,
  -- **New (20260902000100).** Whether the caller may read this account's content, as
  -- distinct from whether it is private: an approved follower of a private account is
  -- `visibility = 'private'` and `viewable = true` and gets the ordinary row. The client
  -- needs both because `visibility` decides the lock and `viewable` decides whether
  -- there is a second line to draw at all.
  viewable      boolean,
  match_percent integer,
  shared_count  integer
)
language sql stable security definer
set search_path = public
as $$
  with counted as (
    select c.user_id, c.metric_count
      from _leaderboard_counts(
             _leaderboard_metric(p_metric),
             _leaderboard_timeframe(p_timeframe)
           ) c
     where c.metric_count > 0
  ),
  page as (
    select c.user_id,
           c.metric_count,
           rank() over (order by c.metric_count desc)::integer as rnk,
           p.username, p.display_name, p.avatar_path, p.visibility
      from counted c
      join profiles p on p.id = c.user_id
     -- Ties share a rank and sort by handle, so the list is deterministic across calls
     -- without pretending the tie was broken.
     order by c.metric_count desc, p.username, c.user_id
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ),
  -- Asked **after** the limit, so the cost is the page rather than the population --
  -- the same reason `taste_match` is a lateral join below rather than a column on
  -- `counted`. The rank above is computed over the whole board and is unaffected: who
  -- is on the board and what their row may say are two questions, answered in that
  -- order.
  shown as (
    select page.*, can_view_profile(auth.uid(), page.user_id) as viewable
      from page
  )
  select shown.user_id,
         shown.username::text,
         shown.display_name,
         shown.avatar_path,
         shown.visibility,
         shown.metric_count,
         shown.rnk,
         shown.user_id = auth.uid(),
         shown.viewable,
         -- **Null for a row the caller may not read** (20260902000100), and null *here*
         -- rather than dropped at the client.
         --
         -- `taste_match` already refuses anyone `can_view_profile` does not admit and
         -- would return (null, 0) for such a row on its own. That is not enough: `0` is
         -- a claim -- "you have nothing in common" -- and it is indistinguishable from
         -- a real answer. The `case` turns both columns into an absence, which is what
         -- the row actually knows, and it means the projection is the privacy rule
         -- rather than something the client is trusted to conceal.
         case when shown.viewable then tm.score end,
         case when shown.viewable then tm.common_count end
    from shown
    left join lateral taste_match(shown.user_id) tm on true;
$$;

comment on function leaderboard(text, text, integer) is
  'The leaderboard over titles | movies | tv | reviews, for this calendar month or for all time, as far as the caller is allowed to know. Definer and takes no viewer -- auth.uid() is the perspective, so there is no third-party question to pose (20260813001900). Since 20260902000100 an unapproved private account APPEARS, as a minimal row: rank, handle, display name, avatar, visibility and the metric count, with viewable false and match_percent and shared_count null at the server. Everything else about that account stays behind can_view_profile, and blocks in either direction, suspension and deletion remove the row entirely. Ties share a rank and sort by handle. People with a zero are absent. Returns counts, never titles and never dates.';


-- ---------------------------------------------------------------------------
-- 4. The old name, still delegating
--
-- Restated because the function it wraps was dropped and recreated, and because the
-- 20260827000900 rule has not expired: a phone that has not taken this update still
-- calls `monthly_leaderboard(p_metric, p_limit)`.
--
-- **An un-relaunched client now sees private rows too**, and that is correct rather
-- than merely tolerable: the eight columns it reads are exactly the minimal row, so it
-- shows the rank, the name, the handle, the avatar and the count and no Match at all --
-- it has never had the Match columns. What it lacks is the lock glyph beside the
-- handle, so the row looks ordinary until it is tapped, at which point the private
-- profile shell and its Follow request are the same as they have always been. No
-- private field reaches it.
-- ---------------------------------------------------------------------------

create or replace function monthly_leaderboard(
  p_metric text default 'titles',
  p_limit  integer default 50
)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  metric_count integer,
  rank         integer,
  is_you       boolean
)
language sql stable security definer
set search_path = public
as $$
  select l.user_id, l.username, l.display_name, l.avatar_path, l.visibility,
         l.metric_count, l.rank, l.is_you
    from leaderboard(p_metric, 'month', p_limit) l;
$$;

comment on function monthly_leaderboard(text, integer) is
  'This month''s board, in the eight-column shape the 2026-08-28 beta OTA calls. Kept as a delegating wrapper over leaderboard() so a phone that has not taken today''s update still works (the 20260827000900 rule about un-relaunched clients). Carries no timeframe argument and no Match columns, so an old client can neither reach the all-time view nor be surprised by a wider row -- and since 20260902000100 the eight columns it does read are exactly the minimal private row, so a private account reaches it without a single private field.';


-- ---------------------------------------------------------------------------
-- 5. Where the caller stands
--
-- Not rewritten -- `my_leaderboard_standing` reads `_leaderboard_counts`, so its
-- population widened with the board's and its `entrants` denominator is the board's
-- size again rather than a smaller number the reader could contradict by scrolling.
-- Restated as a comment only, so the contract does not go stale beside the function it
-- describes.
-- ---------------------------------------------------------------------------

comment on function my_leaderboard_standing(text, text) is
  'The caller''s own row in the same board leaderboard() draws, for pinning when their rank is past the end of the page. Rank is null when they have not done the thing in this timeframe -- a person with nothing to count has no position, and 0 would claim a last place they have not earned. entrants is the size of the board this caller can see, which since 20260902000100 includes the private accounts the board now lists, so the denominator matches what scrolling would count. Always exactly one row.';


-- Grants restated. `leaderboard` was dropped, so it lost the ones 20260829000100 gave
-- it; the other two are here so this migration stands alone if the grants are audited.
revoke execute on function _leaderboard_counts(text, text)             from public, anon, authenticated;
revoke execute on function leaderboard(text, text, integer)            from public, anon, authenticated;
revoke execute on function monthly_leaderboard(text, integer)          from public, anon, authenticated;
revoke execute on function my_leaderboard_standing(text, text)         from public, anon, authenticated;
grant  execute on function leaderboard(text, text, integer)            to authenticated;
grant  execute on function monthly_leaderboard(text, integer)          to authenticated;
grant  execute on function my_leaderboard_standing(text, text)         to authenticated;
