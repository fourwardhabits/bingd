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
-- That gives two flows. **Both are correct about timing and only one of them was
-- correct about order**, which is what §2b below fixes.
--
--   * **Ranking a title straight from search.** `_rank_finalize` inserts the `rankings`
--     row and the `user_media` row and then posts `title_ranked`. The award trigger
--     fires at the end of the `user_media` statement, so the announcement is written
--     *before* the activity in insertion order -- and that is precisely why the order is
--     declared by `causal_step` rather than taken from a serial. One transaction, one
--     `causal_at`, and `causal_step DESC` puts the award on top. If the session is
--     abandoned, `_rank_finalize` never runs, no row is written by it, and nothing is
--     announced.
--
--   * **Logging from the Log sheet and then ranking.** The first tap is `set_bucket` --
--     "bucketing implies logging", so it creates the `user_media` row -- and the award
--     triggers fire there. `log_watched` creates the row on the same terms. The
--     comparisons follow and `title_ranked` is posted a minute later, so the award is
--     genuinely the OLDER row and a newest-first feed showed the ranking above it. That
--     is a real later timestamp on the activity, exactly as the goal case is a real
--     later timestamp on the celebration, and §2b is the fix.
--
-- **The canonical cause of an award earned at log time is the log**, and that is the
-- "legitimate flow that records a watch without ranking" the brief asks to be documented
-- rather than guessed at. It is a completed, durable act: the title is in the collection
-- with a bucket and a watch date, it counts toward every collection metric, and it stays
-- counted whether or not a ranking follows. So the announcement is not withheld and must
-- not be -- withholding it would mean somebody who logs without ever ranking earns
-- awards they are never told about, which is the watch-only semantics the brief forbids
-- breaking.
--
-- **Stated plainly because it is easy to misread: logging posts no feed activity.**
-- `title_logged` is a permitted type and nothing has ever written one; only ranking, a
-- season completion and a watchlist add become activity. So an award earned at log time
-- has no activity of its own to sit above, and when a ranking follows, that ranking is
-- the activity the act produced -- which is exactly what §2b hands it.
--
-- A goal is the one derived event whose cause is a watch *date* rather than a write, so
-- it commits seconds after the ranking that carried its count over and posts under a
-- `causal_at` inherited from that activity. That inheritance is what keeps it in the
-- group; the reversal above is what puts it at the top of the group.
--
-- ===========================================================================
-- 2b. AND THE ADOPTION THAT MAKES THE SECOND FLOW READ RIGHT
--
-- `causal_step` orders rows that share a `causal_at`. The Log-sheet flow produces two
-- rows that do not: the award at bucket time, the ranking a minute later. So the fix
-- for it is the same instrument the goal needed and pointed the other way -- the later
-- writer reaches back and adopts the earlier derived event into its own group.
--
-- `_rank_finalize` does it, under two facts and no interval:
--
--   * **the announcement names this title** -- `causal_media_item_id`, §2 above, written
--     by the writer that announced it rather than guessed at from a clock; and
--   * **nothing of the reader's happened in between** -- the guard
--     `_maybe_goal_completion` already applies from the other side, and what keeps a film
--     logged in March and ranked today from hauling a five-month-old award to the top of
--     the feed.
--
-- Both the award and the goal are reached even though they land at different instants:
-- the bucket tap creates the collection row and the award announces there, then the sheet
-- stamps the watch date in its own call and a goal crossing announces at *that* moment.
-- Both name this title. That is why §2 exists at all -- the first version of this bounded
-- the adoption by timestamps, and review 76b showed a second title's award slipping
-- inside every bound there was.
--
-- Only `causal_at` moves. `created_at`, the id, the payload, the reactions and the
-- comments are all untouched, so a feed that has already shown the award re-sorts it
-- rather than being handed a second one.
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
-- 2. A derived event names the title whose write announced it
--
-- The adoption below has to know that an announcement belongs to *this* title, and
-- until now nothing recorded it: an `award_earned` payload carries an award and a tier,
-- a `goal_completed` payload a year and a target, and `feed_events.media_item_id` is
-- null on both. Independent review 76b built the failure out of exactly that gap --
-- log A, log B and have B cross a tier, rank A, and B's award is adopted into A's group
-- and presented to A's followers as the consequence of ranking A.
--
-- Timestamps cannot close it. Every bound available -- the collection row's creation,
-- its last update, "nothing happened in between" -- is satisfied by B's award as
-- readily as by A's, because the two writes are seconds apart in one sitting and
-- neither produces activity. So the writers declare the fact instead, which is the same
-- move `causal_step` is: a serial could not say which post belonged where either.
--
-- **Null means "no ranking may adopt this", and that is the right default.** Eight of
-- the nine award call sites are about a comment, a reaction, a follow or an invite and
-- have no title; a goal crossed by several titles at once has no single cause; and
-- every row written before this migration keeps a null it will never lose. In each case
-- the announcement stands at its own moment, which is where it stood before.
-- ---------------------------------------------------------------------------

alter table feed_events
  add column causal_media_item_id uuid references media_items(id) on delete set null;

comment on column feed_events.causal_media_item_id is
  'The title whose collection write announced this derived event -- set on award_earned and goal_completed, null everywhere else and null on every row written before 20260902000100. It exists so _rank_finalize can adopt an announcement its own act produced early into the group of the activity that act finally posts: the Log sheet buckets, stamps a date and only then ranks, so those announcements are minutes older than the ranking they belong to, and no timestamp bound can tell one title''s unclaimed award from another''s. Deliberately NOT media_item_id, which is what an activity is *about* and decides where a tap goes -- an award row must keep routing to the Awards sheet. On delete set null rather than cascade: losing a catalogue row must not delete the record that somebody earned something.';

-- Index deliberately absent. The one reader is `_rank_finalize`'s adoption, which is
-- already filtering by `actor_id` -- `feed_events_actor_created` serves it, and the
-- residual is a handful of that actor's rows.

create or replace function _maybe_award_unlocks(
  p_user  uuid,
  p_awards text[],
  -- The title whose collection write is announcing this, when there is one
  -- (20260902000100). Defaulted, because eight of the nine call sites are about a
  -- comment, a reaction, a follow or an invite and have no title to name -- and a null
  -- here means "no ranking may adopt this", which is the right answer for all of them.
  p_media_item_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_award    text;
  v_tier     record;
  v_metric   bigint;
  v_count    integer;
  v_top      record;
  v_top_val  bigint;
  v_event_id uuid;
  -- Which derived post this is within one causal action. See the migration
  -- header: 2 is the first award, and a second award in the same breath is 3.
  v_step     smallint := 2;
begin
  -- A deleted inviter, a null actor: nothing to record and nobody to tell.
  if p_user is null then
    return;
  end if;

  foreach v_award in array p_awards loop
    v_top := null;

    for v_tier in
      select t.award_key, t.tier_key, t.tier_label, t.display_name, t.threshold, t.social
        from award_tiers t
       where t.award_key = v_award
       order by t.tier_index
    loop
      -- One index probe answers the common path — the tier is already on the
      -- ledger — before any counting happens (_maybe_activate_invite's shape).
      if exists (
        select 1 from award_unlocks u
         where u.user_id = p_user
           and u.award_key = v_tier.award_key
           and u.tier_key = v_tier.tier_key
      ) then
        continue;
      end if;

      v_metric := _award_metric(p_user, v_award, v_tier.threshold);

      -- Thresholds ascend, and every metric is monotone in its own cap, so a
      -- tier that fails settles every tier above it.
      exit when v_metric < v_tier.threshold;

      insert into award_unlocks (user_id, award_key, tier_key, value_at_unlock)
      values (p_user, v_tier.award_key, v_tier.tier_key, v_metric)
      on conflict (user_id, award_key, tier_key) do nothing;

      get diagnostics v_count = row_count;
      if v_count = 1 then
        -- Ours to announce — but only the HIGHEST tier this call crossed. Two
        -- tiers crossed in one sync (rare: a whole tier span between actions)
        -- would otherwise post twice in one breath.
        v_top := v_tier;
        v_top_val := v_metric;
      end if;
    end loop;

    if v_top is not null then
      if v_top.social then
        insert into feed_events (actor_id, type, causal_step, causal_media_item_id, payload)
        values (
          p_user, 'award_earned', v_step, p_media_item_id,
          jsonb_build_object(
            'award',      v_top.award_key,
            'tier',       v_top.tier_key,
            'award_name', v_top.display_name,
            'tier_label', v_top.tier_label
          )
        )
        on conflict (actor_id, ((payload ->> 'award')), ((payload ->> 'tier')))
          where type = 'award_earned'
          do nothing
        returning id into v_event_id;
      end if;

      -- The congratulations, to the earner, actorless — nobody did this to them.
      -- The awards preference (default on as of this migration) gates it in the
      -- BEFORE trigger; push eligibility rides the ordinary pipeline.
      insert into notifications (recipient_id, type, payload)
      values (
        p_user, 'award_earned',
        jsonb_build_object(
          'award',      v_top.award_key,
          'tier',       v_top.tier_key,
          'award_name', v_top.display_name,
          'tier_label', v_top.tier_label
        )
      )
      on conflict (recipient_id, ((payload ->> 'award')), ((payload ->> 'tier')))
        where type = 'award_earned'
        do nothing;

      update award_unlocks
         set announced = true
       where user_id = p_user
         and award_key = v_top.award_key
         and tier_key = v_top.tier_key;

      -- Incremented per announced track, so two awards crossed by one action have
      -- a fixed order rather than whichever one a reader's page happens to return
      -- first. The order is p_awards' own, which is a literal array at every one
      -- of the nine call sites.
      v_step := v_step + 1;
    end if;
  end loop;
end;
$$;

-- The two-argument arity is gone: `create or replace` above added a defaulted
-- parameter, which overloads rather than replaces, and a two-argument call against both
-- would be ambiguous. The same treatment `_maybe_goal_completion` had on 20260901000100.
-- Dropped after the new one exists; the nine trigger functions call it positionally with
-- two arguments and resolve to the new one unchanged.
drop function if exists _maybe_award_unlocks(uuid, text[]);

revoke execute on function _maybe_award_unlocks(uuid, text[], uuid) from public, anon, authenticated;
comment on function _maybe_award_unlocks(uuid, text[], uuid) is
  'The award transition: for each named track, walk the tiers ascending, record every newly-passed one on the ledger, and announce the highest -- one feed event (social tracks only) and one congratulations notification, both hanging off the insert that reported a row, so two devices crossing together announce once. Feed events carry causal_step 2 and up since 20260901000100, one step per announced track in p_awards order. Since 20260902000100 they also carry causal_media_item_id when the caller names the title whose collection write announced them, which is what lets the ranking that follows adopt them; the eight call sites with no title pass nothing and their announcements are never adopted. Directly callable by nobody: a client that could invoke this could probe another account''s counts. Internal.';


-- The collection trigger, rebuilt to name the title it is about. It is a per-row
-- trigger, so `new.media_item_id` is exact rather than an aggregate.
create or replace function _award_touch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.user_id,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life'],
    new.media_item_id);
  return null;
end;
$$;

revoke execute on function _award_touch_user_media() from public, anon, authenticated;


create or replace function _maybe_goal_completion(
  p_user     uuid,
  p_year     integer,
  p_category ranking_category,
  p_added    integer,
  -- The titles whose watch dates carried the count over, so the completion can find
  -- the activity that caused it (20260901000100). Defaulted, because a caller that
  -- does not know produces a completion timed at its own moment, which is the
  -- behaviour this function had before.
  p_media_items uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target integer;
  v_count  integer;
  v_rows   integer;
  v_source record;
  v_at     timestamptz := now();
begin
  if p_user is null or p_year is null or p_category is null or coalesce(p_added, 0) < 1 then
    return;
  end if;

  -- **The goal must already exist.** Founder §9: "user had a goal configured BEFORE the
  -- qualifying watch". No row, nothing to cross.
  select target into v_target
    from watch_goals
   where user_id = p_user and year = p_year and category = p_category;

  if v_target is null then
    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- Serialised per (account, year, medium), and this is the correctness of the whole
  -- function rather than an optimisation.
  --
  -- **The ledger's primary key gives at-most-once. It does not give at-least-once**, and
  -- independent review found the gap: without this lock two devices can lose a crossing
  -- *permanently*, which is a worse failure than the duplicate the key prevents.
  --
  --   goal is 2, count is 0
  --   A inserts its film; B inserts a different film, concurrently
  --   under READ COMMITTED neither sees the other's uncommitted row, so both count 1
  --   1 < 2, so both return without inserting, and both commit
  --   the count is now 2 and nothing was ever announced
  --   every later watch finds `count - added >= target` and stays silent for ever
  --
  -- Taking the lock *before* counting is what closes it. The second transaction waits for
  -- the first to commit, and its `select count(*)` is a new statement under READ
  -- COMMITTED — so it takes a fresh snapshot, sees the committed row, counts 2, and
  -- correctly recognises itself as the crossing. The first transaction counted 1 and was
  -- honestly not the one that crossed.
  --
  -- Same idiom `_rank_finalize` uses to serialise a user's category (20260813000700).
  perform pg_advisory_xact_lock(
    hashtextextended('goal:' || p_user::text || ':' || p_year::text || ':' || p_category::text, 0)
  );

  v_count := _goal_qualifying_count(p_user, p_year, p_category);

  -- The crossing, and both halves are load-bearing. `v_count >= v_target` alone would
  -- fire on every subsequent watch for the rest of the year; `v_count - p_added <
  -- v_target` is what makes it a *transition* and what makes an account that was already
  -- past its goal when this shipped produce nothing.
  if v_count < v_target or (v_count - p_added) >= v_target then
    return;
  end if;

  insert into goal_completions (user_id, year, category, target_at_completion, count_at_completion)
  values (p_user, p_year, p_category, v_target, v_count)
  on conflict (user_id, year, category) do nothing;

  get diagnostics v_rows = row_count;
  -- Not ours: a concurrent transaction crossed the same goal first, or this year's
  -- completion already happened and the goal has since been edited upward and re-crossed.
  -- Either way there is exactly one celebration and it is not this one.
  if v_rows <> 1 then
    return;
  end if;

  -- The social half. `payload` carries what the row needs to render a sentence without
  -- reading `watch_goals`, which is owner-only — a viewer must be able to draw
  -- "Suraj hit their 2026 Movies goal" without being entitled to Suraj's goals table.
  -- ---------------------------------------------------------------------------
  -- WHICH ACTIVITY THIS COMPLETION BELONGS UNDER
  --
  -- A goal is completed by a watch DATE, and `log_watched` posts no activity of its
  -- own -- so unlike an award, a completion is never in the same transaction as the
  -- thing that caused it. In the founder's flow the ranking commits, the post-rank
  -- sheet takes the date a few seconds later, and the completion is genuinely the
  -- LATER row: newest-first then puts it above the ranking that earned it, which is
  -- the founder's report and is not a tie a sort key could break.
  --
  -- So a completion says where it belongs rather than where it happened.
  -- `causal_at` is the ranking's own timestamp when the ranking is the reader's
  -- NEWEST activity and is about one of the titles that carried this count over --
  -- which is exactly the case where the two are one act. `created_at` is untouched
  -- and is still what the row's "2m ago" is drawn from.
  --
  -- **The newest-activity test is the guard, and it is a fact rather than an
  -- interval.** Correcting the date on a film ranked last year can also complete a
  -- goal; inheriting that film's timestamp would bury the celebration a year down
  -- the feed. That ranking is not the reader's newest activity, so nothing is
  -- inherited and the completion stands at its own moment, at the top, alone. No
  -- arithmetic on timestamps anywhere: the question asked is "is this the post it
  -- would sit directly under", and the answer is yes or no.
  select fe.created_at, fe.media_item_id
    into v_source
    from feed_events fe
   where fe.actor_id = p_user
     and fe.type in ('title_ranked', 'title_logged', 'season_completed')
   order by fe.created_at desc, fe.id desc
   limit 1;

  if v_source.media_item_id is not null
     and v_source.media_item_id = any (coalesce(p_media_items, '{}'::uuid[])) then
    v_at := v_source.created_at;
  end if;

  insert into feed_events (actor_id, type, causal_step, causal_at, causal_media_item_id, payload)
  values (
    -- Step 1: after the ranking that carried the count over, before any award the
    -- same ranking earned. See the migration header.
    p_user, 'goal_completed', 1, v_at,
    -- The title this completion belongs to, when exactly one carried the count over
    -- (20260902000100). A batch that crossed the goal with several titles at once has
    -- no single cause, and null there means no ranking adopts it -- which is correct:
    -- there is no one ranking it belongs under.
    case when array_length(p_media_items, 1) = 1 then p_media_items[1] end,
    jsonb_build_object(
      'year',     p_year,
      'category', p_category,
      'target',   v_target
    )
  )
  on conflict (actor_id, ((payload ->> 'year')), ((payload ->> 'category')))
    where type = 'goal_completed'
    do nothing;

  -- The congratulations, to the earner, actorless — nobody did this to them, which is
  -- the `award_earned` shape (20260828000100) and the reason `claim_push_batch` already
  -- tolerates a null actor.
  insert into notifications (recipient_id, type, payload)
  values (
    p_user, 'goal_completed',
    jsonb_build_object(
      'year',     p_year,
      'category', p_category,
      'target',   v_target
    )
  )
  on conflict (recipient_id, ((payload ->> 'year')), ((payload ->> 'category')))
    where type = 'goal_completed'
    do nothing;
end;
$$;

revoke execute on function _maybe_goal_completion(uuid, integer, ranking_category, integer, uuid[])
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The ranking adopts the award its own act announced early
--
-- `_rank_finalize`, rebuilt from 20260827000600. Three edits and nothing else moves:
-- two locals, a read of `user_media.created_at`, and the adoption `update` beside the
-- `title_ranked` insert. The drop-inside-the-lock, the band recomputation, the
-- placement guard, the recommendation fulfilment and the invite activation are all
-- 20260827000600's, carried whole.
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
  v_event_id  uuid;
  -- 20260902000100. The instant this activity sits at, which is what the adoption
  -- below moves an earlier announcement of this same act up to.
  v_causal_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- The old position, dropped at the last possible moment rather than at the
  -- first (20260826000500). Everything above this line in the reader's session --
  -- opening the sheet, every comparison, every skip, closing it and coming back --
  -- left the ranking they already had exactly where it was.
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
  -- the gap between the session opening and this transaction -- and it is the *only*
  -- writer of a provisional band change: `rank_rebucket` does not move
  -- `user_media.bucket` up front (20260826000500).
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

  -- The founder's four War Dogs (20260826000500). A correction to an opinion already
  -- recorded is not a thing that happened to anybody else, so it does not become an
  -- activity. A first ranking always is one; another watch always is one. The id is
  -- kept now, because the fulfilment below points at it.
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
    )
    returning id, causal_at into v_event_id, v_causal_at;

    /**
     * **The award that was announced before its own activity existed**
     * (20260902000100, and it is the mirror of the goal case).
     *
     * The Log sheet's first tap is `set_bucket`, which creates the `user_media` row --
     * "bucketing implies logging" -- and the collection award triggers fire on that
     * insert. The comparisons follow, and `title_ranked` is posted here, seconds or a
     * minute later. So the award is genuinely the OLDER row, by a real timestamp no
     * tiebreak can reach, and a newest-first feed put the ranking above the award it
     * looks like it earned. `causal_step` cannot help: it only orders rows that share a
     * `causal_at`, and these do not.
     *
     * That is the same shape as the goal completion `causal_at` was added for, pointing
     * the other way. A goal commits AFTER its cause and looks backwards to adopt it;
     * an award earned at log time commits BEFORE its cause, so the cause reaches back
     * and adopts the award.
     *
     * **Two facts decide it, and the first is stated rather than inferred.**
     *
     *   **The announcement names this title.** `causal_media_item_id` (§2) is written by
     *   the collection award trigger and by a single-title goal crossing, and it is what
     *   makes this exact. It replaced a timestamp window, and independent review 76b is
     *   why: log A, log B and have B cross a tier, then rank A, and every timestamp
     *   bound available -- the row's creation, its last update, "nothing happened in
     *   between" -- is satisfied by B's award as readily as by A's. B's award was being
     *   adopted into A's group and shown to A's followers as the consequence of ranking
     *   A. Two writes seconds apart in one sitting, neither producing activity: nothing
     *   about *when* could tell them apart, so the writer says *which*.
     *
     *   **and nothing of the reader's happened in between.** That is the `not exists`,
     *   and it is `_maybe_goal_completion`'s own guard -- "is this the post it would sit
     *   directly under" -- asked from the other side. An award earned when a film was
     *   logged in March and ranked for the first time today has twenty activities
     *   between the two: it belongs where it is, and hauling it to the top of the feed
     *   would be the bug that guard was written to avoid, in a new place.
     *
     * Both the award and the goal are reached, and they arrive at different instants:
     * the Log sheet's bucket tap creates the collection row and the award triggers
     * announce there, then the sheet stamps the watch date in its own call and a goal
     * crossing announces at *that* moment. Both name this title, and both are unclaimed
     * until this ranking posts.
     *
     * When this transaction created the collection row itself the award shares
     * `causal_at` with the activity already, the strict inequality is false, nothing is
     * updated, and `causal_step` does the ordering as before.
     *
     * Only `causal_at` moves. `created_at` is untouched, so the row still says how long
     * ago it happened, and its id, payload, reactions and comments are all unchanged --
     * a feed that has already shown it re-sorts it rather than seeing a new event.
     */
    update feed_events fe
       set causal_at = v_causal_at
     where fe.actor_id = target
       and fe.type in ('award_earned', 'goal_completed')
       and fe.causal_media_item_id = item
       and fe.causal_at < v_causal_at
       and not exists (
         select 1
           from feed_events act
          where act.actor_id = target
            and act.type in ('title_ranked', 'season_completed', 'watchlist_added')
            and act.id <> v_event_id
            and act.causal_at > fe.causal_at
            and act.causal_at < v_causal_at
       );
  end if;

  -- NEW (20260827000600). A first ranking settles the recommendations that asked
  -- for it. `not v_replaced` is the same fact that just decided the feed event, so
  -- a fulfilling rank always has an event to point at -- and a Rank Again or a
  -- bucket change, being `v_replaced`, settles nothing and notifies nobody.
  --
  -- Fulfilment and notification are decided separately, in one statement: every
  -- outstanding delivered recommendation gets its timestamp -- once, ever, by the
  -- `fulfilled_at is null` guard -- and only senders the feed itself would answer
  -- get a row. `can_view_profile(sender, ranker)` refuses a block either way, a
  -- suspended sender's view of nothing, and a private ranker the sender does not
  -- follow; the active-status join refuses a suspended or half-deleted sender. A
  -- sender refused now is not queued for later: the moment passed.
  --
  -- One notification per sender because there is one recommendation row per
  -- sender (`unique (sender_id, recipient_id, media_item_id)`), each carrying its
  -- own id in the payload -- which is what the backstop index measures.
  if not v_replaced then
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

comment on function _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean) is
  'The one moment in the schema where a ranking is created. Carries 20260826000500''s behaviour whole: the drop happens inside the category lock, the band is recomputed there, and the title_ranked event posts iff p_new_watch or the placement created a position where there was none. Since 20260827000600 a first ranking also fulfils every outstanding delivered recommendation for the title -- once each, by the fulfilled_at guard -- and notifies the senders the feed itself would answer, pointing at the exact event it just posted. Since 20260902000100 it also adopts any award or goal announced by the insert that first put this title in the collection, when nothing of the reader''s happened in between: the Log sheet buckets before it ranks, so that announcement is a real minute older than the activity it belongs to, and a newest-first feed would otherwise show the ranking above the award it earned. Internal.';


-- ---------------------------------------------------------------------------
-- 4. The board's population
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
-- 5. The board
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
-- 6. The old name, still delegating
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
-- 7. Where the caller stands
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
