-- A goal worth finishing.
-- Founder follow-up to PR #69, 2026-08-29 §§8-15: crossing an annual goal is celebrated
-- socially and personally, exactly once.
--
-- ===========================================================================
-- 1. WHAT DID NOT EXIST BEFORE THIS
--
-- `watch_goals` (20260816000800) stores a target and **nothing counts against it**. Its
-- own header says so in as many words: "nothing in the database counts against it,
-- deliberately -- the migration stores a number and leaves the product rule to be stated
-- where it can be read and tested", and that statement is `src/features/goals/goals.ts`,
-- on the device.
--
-- A client-side count cannot own a celebration. The founder's requirement is that
-- completion be **server-owned and exactly-once**, and a number computed in a React
-- Query `select` is neither: two devices would each decide they had crossed, a refetch
-- would decide again, and a relaunch would decide a third time.
--
-- So the rule moves into SQL. It is now stated twice — here and in `goals.ts` — which is
-- the thing this schema normally refuses to do. The justification is the same one
-- `_award_metric` records for reproducing `tracks.ts`: the *display* stays derived on
-- the client, and the copy here drives only the ledger and the social loop. A parity
-- test (`supabase/tests/goal-completion.test.mjs`) pins the two to the same four rules,
-- so a drift fails rather than ships.
--
-- The four rules, from `goals.ts`, unchanged:
--
--   1. `watched_on` is the only clock. Never `created_at` — the date a row entered
--      Bingd is a fact about the app, and an import would credit a decade to an
--      afternoon.
--   2. An unknown watch date counts for nothing. Onboarding logs historical favourites
--      with no date, so this is live rather than theoretical.
--   3. A series is not a season. `rankable_category` is null for a series; the TV goal
--      counts seasons.
--   4. Distinct titles. `user_media` is keyed (user, title), so a rewatch is one.
--
-- ===========================================================================
-- 2. THE CROSSING, AND THE FIVE THINGS THAT MUST NOT TRIGGER IT
--
-- A completion is a **transition caused by a watch**:
--
--     count before this watch  <  target
--     count after  this watch  >= target
--
-- Everything the founder ruled out falls out of that shape rather than needing its own
-- guard:
--
--   · **opening Profile / a query recalculating / relaunching** — no write, no trigger,
--     no completion. The trigger fires on `user_media`, not on a read.
--   · **editing a goal downward below an existing count** — `set_watch_goal` does not
--     call this at all. No watch happened, so nothing crossed. A goal is never completed
--     by moving the finish line.
--   · **a migration shipping to somebody already above their goal** — there is no
--     backfill in this file. The ledger starts empty and only the trigger writes it. The
--     next watch such an account logs has `before >= target`, so it does not cross
--     either: they were already past it, and the crossing already happened before Bingd
--     was watching.
--   · **old history being recomputed** — same reason. Recomputation is a read.
--
-- And the one that must trigger: a goal set at 25 by somebody with 24, who then watches
-- their 25th. Before = 24, after = 25. That is a crossing and it is the point.
--
-- ===========================================================================
-- 3. EXACTLY ONCE, AND WHY THE PRIMARY KEY IS THE WHOLE MECHANISM
--
-- `goal_completions` is keyed `(user_id, year, category)`. That single line answers
-- every duplication the founder listed:
--
--   · a replayed or retried write — `on conflict do nothing`;
--   · two devices crossing the same goal in the same instant — one insert wins, and the
--     announcement is gated on `row_count = 1`, the `_maybe_award_unlocks` shape;
--
-- **But the key gives at-most-once, not exactly-once**, and that distinction cost this
-- file a blocker. Independent review found that two concurrent watches can lose a
-- crossing *permanently* — neither transaction sees the other's row, so neither believes
-- it crossed, and no later watch can either. The advisory lock in `_maybe_goal_completion`
-- is what supplies the other half; the full argument is written there.
--
--   · a goal edited 25 → 30 and crossed again later in the same year — the row is
--     already there, so the second crossing is silent. **One celebration per account,
--     per year, per goal type**, which is founder §10 exactly;
--   · the next calendar year — a different key, independently eligible.
--
-- `target_at_completion` is recorded for the same reason `award_unlocks.value_at_unlock`
-- is: the goal can be edited afterwards and the achievement should still say what was
-- actually achieved. Never re-derived, never revoked.
-- ===========================================================================

create table goal_completions (
  user_id             uuid             not null references profiles(id) on delete cascade,
  year                integer          not null,
  category            ranking_category not null,
  -- The target as it stood when it was crossed. The goal may be edited afterwards; the
  -- achievement does not move with it (award_unlocks.value_at_unlock's argument).
  target_at_completion integer         not null,
  -- The qualifying count at the moment of crossing, which is >= target and may exceed it
  -- when one write adds several titles.
  count_at_completion  integer         not null,
  completed_at        timestamptz      not null default now(),
  primary key (user_id, year, category)
);

alter table goal_completions enable row level security;
revoke all on goal_completions from public, anon, authenticated;
grant select on goal_completions to authenticated;

-- Own rows only, matching `watch_goals` itself: a goal is the caller's own until a
-- decision places it on a shareable surface. The *public* surface of a completion is the
-- feed event, which carries its own visibility contract.
create policy goal_completions_own on goal_completions for select
  using (user_id = auth.uid());

comment on table goal_completions is
  'The durable goal crossings: account X finished its year-Y category-Z goal, at most once, ever. Written only by _maybe_goal_completion (the user_media trigger); there is deliberately no backfill, so an account already past its goal when this shipped produced no historical celebration. The primary key is the exactly-once mechanism -- a replay, a two-device race, and a goal edited upward and re-crossed all resolve to the same row.';

-- ---------------------------------------------------------------------------
-- 4. The count, as `goals.ts` defines it
--
-- Kept as its own function so the trigger reads it twice — before and after — through
-- one definition, and so the parity test has something to point at.
-- ---------------------------------------------------------------------------

create or replace function _goal_qualifying_count(
  p_user     uuid,
  p_year     integer,
  p_category ranking_category
)
returns integer
language sql stable
set search_path = public
as $$
  select count(*)::integer
    from user_media um
    join media_items m on m.id = um.media_item_id
   where um.user_id = p_user
     -- Rule 1 and rule 2 together: the watch date is the only clock, and a row without
     -- one counts for nothing rather than being guessed into the current year.
     and um.watched_on is not null
     and extract(year from um.watched_on) = p_year
     -- Rule 3, through the same mapping `rankable_category` states: a series is neither
     -- a movie nor a season and belongs to no goal.
     and rankable_category(m.kind) = p_category;
  -- Rule 4 needs no `distinct`: user_media is keyed (user_id, media_item_id), so a
  -- rewatch cannot produce a second row. Stated here because a future watch-history
  -- table must not quietly turn a goal of 52 into a goal of 52 viewings.
$$;

comment on function _goal_qualifying_count(uuid, integer, ranking_category) is
  'How many titles count toward one account''s goal for one year and one medium -- the SQL statement of the four rules in src/features/goals/goals.ts: watched_on is the only clock, a dateless row counts nowhere, a series belongs to no goal, and a title counts once. Held to the TypeScript by supabase/tests/goal-completion.test.mjs. Internal.';

-- ---------------------------------------------------------------------------
-- 5. The crossing
--
-- `p_before` is passed in rather than recomputed, because the only honest way to know
-- the count *before* a write is to subtract this write from the count after it. The
-- trigger is AFTER, so the row is already there; taking `count - 1` would be wrong the
-- moment one statement inserts several rows, and re-querying in a BEFORE trigger would
-- race the insert it is about to allow.
--
-- So the trigger computes the count once, and derives "before" from the transition it
-- knows it caused: exactly the rows this statement made qualify.
-- ---------------------------------------------------------------------------

create or replace function _maybe_goal_completion(
  p_user     uuid,
  p_year     integer,
  p_category ranking_category,
  p_added    integer
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
  insert into feed_events (actor_id, type, payload)
  values (
    p_user, 'goal_completed',
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

revoke execute on function _maybe_goal_completion(uuid, integer, ranking_category, integer)
  from public, anon, authenticated;

comment on function _maybe_goal_completion(uuid, integer, ranking_category, integer) is
  'Records a goal crossing and announces it, at most once per (account, year, medium). Refuses unless a goal already existed, unless the count now meets the target, and unless this write is what carried it there -- so editing a goal downward below an existing count, a recomputation, a relaunch and a rollout all produce nothing. The insert''s row_count is the race gate: two devices crossing together yield one celebration. Internal; the user_media trigger is the only caller.';

-- ---------------------------------------------------------------------------
-- 6. The triggers — per STATEMENT, over transition tables
--
-- **A per-row trigger cannot do this, and the reason is worth writing down** because the
-- row form is the obvious one and it is silently wrong.
--
-- Postgres queues AFTER ROW triggers and fires them once the *statement* is complete, so
-- by the time the first one runs every row of a multi-row insert is already visible. A
-- five-row insert that carries somebody from two to seven against a target of three would
-- see, on every one of its five firings, a count of seven and an "added" of one — so
-- `count - added = 6 >= 3` on all five, and the crossing that plainly happened produces
-- nothing. The first draft of this file did exactly that and its own batch test caught it.
--
-- A statement-level trigger with transition tables knows how many rows it moved, which is
-- the number the arithmetic actually needs. It is also strictly cheaper: one call per
-- (account, year, medium) touched, rather than one per row.
--
-- Two triggers rather than one, because insert and update have different questions:
--
--   INSERT  every new qualifying row is newly qualifying
--   UPDATE  only a row that did *not* qualify for this (year, medium) before and does
--           now — which is what keeps a note edit, a bucket change or a visibility
--           toggle from doing goal arithmetic, and what stops a date corrected within
--           the same year from counting twice
--
-- A row that *stops* qualifying — a date cleared by `clear_watched_on` (20260824000100),
-- or moved to another year — is deliberately not examined. A completion is never revoked,
-- for the reason `award_unlocks` records: counts can fall and the achievement stands.
-- ---------------------------------------------------------------------------

create or replace function _goal_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select n.user_id                                    as who,
           extract(year from n.watched_on)::integer     as yr,
           rankable_category(m.kind)                    as cat,
           count(*)::integer                            as added
      from new_rows n
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
     group by 1, 2, 3
     -- Deterministic order, so two statements touching the same several groups take the
     -- advisory locks below in the same sequence and cannot deadlock against each other.
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added);
  end loop;
  return null;
end;
$$;

create or replace function _goal_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select n.user_id                                as who,
           extract(year from n.watched_on)::integer as yr,
           rankable_category(m.kind)                as cat,
           count(*)::integer                        as added
      from new_rows n
      -- `user_media` is keyed (user_id, media_item_id), so this pairs each updated row
      -- with its own previous state.
      join old_rows o on o.user_id = n.user_id and o.media_item_id = n.media_item_id
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
       -- Newly qualifying for *this* year: it either had no date, or had one in a
       -- different year. A date corrected from March to April is not a new title.
       and (o.watched_on is null
            or extract(year from o.watched_on) <> extract(year from n.watched_on))
     group by 1, 2, 3
     -- Deterministic order, so two statements touching the same several groups take the
     -- advisory locks below in the same sequence and cannot deadlock against each other.
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added);
  end loop;
  return null;
end;
$$;

revoke execute on function _goal_after_insert() from public, anon, authenticated;
revoke execute on function _goal_after_update() from public, anon, authenticated;

create trigger goal_on_user_media_insert
  after insert on user_media
  referencing new table as new_rows
  for each statement execute function _goal_after_insert();

-- **No `of watched_on` column list**, and it is not an oversight: Postgres refuses
-- transition tables on a column-limited trigger ("transition tables cannot be specified
-- for triggers with column lists"). So this fires on every `user_media` update — a note
-- edit, a bucket change, a visibility toggle — and the filtering moves into the query
-- above, where the newly-qualifying test already had to live anyway.
--
-- The cost of the wider trigger is one aggregate over the transition table, which for
-- those writes matches nothing and returns immediately. The alternative — a per-row
-- trigger with the column list — is the shape that cannot count a batch at all, which is
-- the defect this section exists to explain.
create trigger goal_on_user_media_update
  after update on user_media
  referencing old table as old_rows new table as new_rows
  for each statement execute function _goal_after_update();

-- ---------------------------------------------------------------------------
-- 7. The feed and notification surface for the new type
-- ---------------------------------------------------------------------------

alter table feed_events drop constraint feed_events_known_type;
alter table feed_events add constraint feed_events_known_type check (type in (
  'title_ranked',
  'title_logged',
  'season_completed',
  'list_created',
  'list_added',
  'milestone_reached',
  'joined_from_invitation',
  'watchlist_added',
  'award_earned',
  'goal_completed'
));

-- The backstops. The mechanism is the `goal_completions` primary key; these state the
-- invariant where a future writer cannot miss it (the `feed_events_one_award_post`
-- pattern).
create unique index feed_events_one_goal_post
  on feed_events (actor_id, (payload ->> 'year'), (payload ->> 'category'))
  where type = 'goal_completed';

create unique index notifications_one_goal_congrats
  on notifications (recipient_id, (payload ->> 'year'), (payload ->> 'category'))
  where type = 'goal_completed';

-- ---------------------------------------------------------------------------
-- 8. Preference category and push eligibility
--
-- **`goals` rides the `awards` category** rather than getting one of its own. Founder
-- §14: use the closest existing achievement mapping rather than a new settings row for
-- one type. They are the same thing to a reader — "you achieved something" — and a
-- switch labelled Awards that leaves goal congratulations arriving would be the more
-- confusing outcome of the two.
--
-- Rebuilt from 20260828000100 with `goal_completed` added to both functions. Everything
-- else is verbatim; a `create or replace` over a body nobody re-read is how
-- `_assert_operation_rate` lost its advisory lock invisibly.
-- ---------------------------------------------------------------------------

create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  if new.type = 'follow_request' then
    return new;
  end if;

  if new.type = 'invite_welcome' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'                then 'follows'
    when 'follow_approved'       then 'follow_accepted'
    when 'comment'               then 'comments'
    when 'reaction'              then 'reactions'
    when 'watch_tag'             then 'watch_tags'
    when 'recommendation'        then 'recommendations'
    when 'recommendation_ranked' then 'recommendations'
    when 'invite_activated'      then 'invites'
    when 'award_earned'          then 'awards'
    when 'goal_completed'        then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added later
  -- and forgotten here should reach its recipient, not vanish -- the failure mode of the
  -- other default is silent and undetectable.
  if v_category is null then
    return new;
  end if;

  if _notifies(new.recipient_id, v_category) then
    return new;
  end if;

  return null;
end;
$fn$;

comment on function _apply_notification_preference() is
  'Before-insert gate on notifications. Drops a row whose category the recipient has '
  'switched off. follow_request and invite_welcome are exempt and always delivered. '
  'recommendation_ranked shares the recommendations category (20260827000600); '
  'goal_completed shares awards (20260829000200) -- both are "you achieved something", '
  'and one switch for the pair is what a reader expects of a control labelled Awards.';

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated',
    'invite_welcome', 'award_earned', 'goal_completed'
  ]::text[]);
$$;

comment on function _push_eligible(p_type text) is
  'Which notification types may leave the inbox for the lock screen. Eleven of the thirteen: follow_approved is excluded by PRD §15, and friendship is the reader''s own action (20260827000200). award_earned joined on 20260828 and goal_completed on 20260829, each with its writer. An unmapped type is not eligible, so a new type has to be added here deliberately.';
