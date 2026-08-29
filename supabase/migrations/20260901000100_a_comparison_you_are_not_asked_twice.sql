-- A comparison you are not asked twice, and an award that says what it was for.
-- Founder final physical-QA tranche, 2026-08-29. Five unrelated corrections that
-- share one migration because they share one deploy.
--
-- ===========================================================================
-- 1. THE FEED'S CAUSAL ORDER
--
-- Ranking a film can finish a goal and earn an award, and the founder's device
-- showed the goal above the ranking that caused it. Nothing was racing: all
-- three events are written in ONE transaction, `feed_events.created_at` defaults
-- to `now()` -- which is transaction time, not statement time -- so the three
-- rows carry the SAME timestamp to the microsecond, and `order by created_at
-- desc` is then free to return them in any order it likes. It is unstable
-- across a refetch and across a page boundary for exactly the same reason.
--
-- Insertion order is not the answer either, and this is the part worth writing
-- down: `_rank_finalize` inserts into `rankings` and `user_media` BEFORE it
-- posts `title_ranked`, and the award and goal triggers fire at the end of
-- those statements. So a serial column would pin the derived posts ABOVE their
-- cause -- the founder's bug, made permanent.
--
-- So the writers declare the position instead. `causal_step` is 0 for the act
-- itself, 1 for the goal it completed, and 2, 3, ... for the awards it earned,
-- in the order `_maybe_award_unlocks` walks its argument. Readers order by
-- `created_at desc, causal_step asc, id asc`: unrelated activity is unaffected
-- (different transactions, different timestamps), the causal group sits together
-- because its members share a timestamp, and the ordering is TOTAL -- `id` is a
-- primary key -- so pagination and refetch cannot reshuffle it.
--
-- ===========================================================================
-- 2. COMMENTS AND REVIEWS ARE DIFFERENT AWARDS
--
-- Comment Gremlin counted comments PLUS published reviews and said so on the
-- row: "Write 100 comments or reviews". The founder's ruling is that the two are
-- different behaviours and one counter rewards neither. This makes the track
-- comments-only, keeping its names, its artwork and its thresholds; a review
-- track is deferred to its own pass (docs/product/deferred-roadmap.md).
--
-- **The historical treatment is the founder's decision, taken explicitly.** A
-- tier already on the ledger that the comments-only count no longer supports is
-- revoked, along with the announcements that hang off it -- so the ledger tells
-- the truth about the rule in force, and the inbox and the feed do not go on
-- claiming an award the Awards sheet no longer shows. It is narrow (one track,
-- and only tiers that fail the new metric), deterministic (the metric is a pure
-- function of `comments`), and it leaves every legitimately-earned tier alone.
-- A revoked tier can be earned again later and will announce then, once, through
-- the ordinary ledger.
--
-- ===========================================================================
-- 3. THE INVITEE'S WELCOME STAYS IN THE APP
--
-- `invite_welcome` leaves the push list. The persistent inbox row is untouched:
-- `redeem_invite` still writes exactly one, it is still exempt from the
-- preference gate, it still names the inviter and still routes to their profile.
-- What goes is the lock-screen copy of it, which arrives while the person is
-- already looking at the app that sent it.
--
-- ===========================================================================
-- 4. THE INBOX SAYS WHICH ACTIVITY
--
-- "commented on your Marty Supreme watch" needs to know that the activity WAS a
-- watch, so `my_notifications` returns the subject event's type. One column, off
-- a join the function already performs, under the gates it already applies.
--
-- ===========================================================================
-- 5. A PAIR IS NEVER OFFERED TWICE IN ONE SESSION
--
-- The founder's report: A versus B, "Too tough", a different comparison, one
-- answer, and A versus B again.
--
-- It reproduces exactly. `rank_skip` walks outward from the midpoint skipping
-- the first `band_skips` candidates, and resets `band_skips` whenever [lo, hi)
-- changes -- because a different band was thought to be a different set of
-- candidates. Answering the substitute narrows the range, which resets the
-- counter, and the new midpoint is the title that was skipped. With three titles
-- it happens on the very first answer.
--
-- The fix is a fact the session keeps rather than a counter it resets:
-- `seen_items` is every title this session has put in front of the reader, and
-- `_rank_offer` refuses all of them. A pair is (subject, opponent) -- the subject
-- is fixed for the life of a session -- so "this opponent, ever again" IS the
-- unordered-pair invariant the founder asked for, and it holds across skips,
-- answers and narrowings alike.
--
-- **The invariant is about comparisons the app CHOOSES.** Two paths return a
-- pair the session has already shown, both by design and neither through
-- `_rank_offer`:
--
--   · `rank_back` restores the previous frame and re-displays the comparison the
--     reader just answered. That is what Back IS. A Back that refused to show
--     you the thing you are undoing would not be an undo.
--   · a resume returns the comparison that was on screen when the reader left.
--     It is one unanswered question restored, not a second asking of it.
--
-- Both are the reader asking; the founder's report is about being asked. And
-- neither weakens what follows: answering a restored pivot goes through
-- `rank_answer`, which offers through `_rank_offer`, so the next comparison the
-- app picks still excludes everything already seen. Independent review 74 found
-- this stated too broadly here, which it was.
--
-- **Nothing is invented when the walk runs dry.** No comparison row, no tie, no
-- fabricated winner: the title is placed at the middle of the range its real
-- answers established and the reveal says it is an estimate -- the same
-- resolution the three-skip cap has always produced, which is preserved
-- unchanged and still fires first.
--
-- Per session, deliberately. A new session may reconsider the same pair, which
-- is what makes Rank again a real second opinion.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Feed events carry their place in a causal group
-- ---------------------------------------------------------------------------

alter table feed_events add column causal_step smallint not null default 0;

comment on column feed_events.causal_step is
  'Where this event sits among the events one action produced: 0 the act itself, 1 the goal it completed, 2 and up the awards it earned. Every row of a causal group shares created_at to the microsecond -- they are written in one transaction and the default is now() -- so this is what orders them within a group, and readers sort by (causal_at desc, causal_step asc, id asc). Not a serial: _rank_finalize writes rankings before it posts title_ranked, so insertion order puts the derived events FIRST, which is the founder bug this exists to fix.';



-- The second column, and it is the one the goal needs.
--
-- Added nullable, backfilled from created_at, then made not null with a default, so
-- every existing row keeps its own instant rather than being stamped with the
-- deploy time -- which is what a plain default would have done to the whole feed.
alter table feed_events add column causal_at timestamptz;
update feed_events set causal_at = created_at;
alter table feed_events alter column causal_at set not null;
alter table feed_events alter column causal_at set default now();

comment on column feed_events.causal_at is
  'When the act that produced this event happened, which is the feed''s sort key. Equal to created_at for everything except a goal completion: a goal is completed by a watch DATE, log_watched posts no activity of its own, and the completion therefore commits SECONDS AFTER the ranking that earned it rather than beside it -- so newest-first put it above its own cause. A completion inherits the timestamp of the reader''s newest activity when that activity is about one of the titles that carried the count over, and keeps its own otherwise. created_at is untouched and is still what a row''s relative time is drawn from.';

-- The goal completion, rebuilt from 20260829000200 with one column added to one
-- insert. Nothing else in it moves.
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

  insert into feed_events (actor_id, type, causal_step, causal_at, payload)
  values (
    -- Step 1: after the ranking that carried the count over, before any award the
    -- same ranking earned. See the migration header.
    p_user, 'goal_completed', 1, v_at,
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

-- The four-argument arity is gone: create or replace above added a defaulted
-- parameter, which overloads rather than replaces, and a four-argument call against
-- both would be ambiguous. Dropped after the new one exists.
drop function if exists _maybe_goal_completion(uuid, integer, ranking_category, integer);

comment on function _maybe_goal_completion(uuid, integer, ranking_category, integer, uuid[]) is
  'Records a goal crossing and announces it, at most once per (account, year, medium). Refuses unless a goal already existed, unless the count now meets the target, and unless this write is what carried it there -- so editing a goal downward below an existing count, a recomputation, a relaunch and a rollout all produce nothing. The insert''s row_count is the race gate: two devices crossing together yield one celebration. Its feed event carries causal_step 1 since 20260901000100, and a causal_at inherited from the reader''s newest activity when that activity is one of the titles that carried the count over -- which is what puts the celebration under the ranking that earned it rather than above it, since log_watched commits seconds later and posts no activity of its own. Internal; the user_media trigger is the only caller.';


-- The two statement triggers, rebuilt from 20260829000200 so each group carries the
-- media items behind it. Everything else -- the transition tables, the newly-qualifying
-- test, the deterministic lock order -- is carried across whole.
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
           count(*)::integer                            as added,
           array_agg(n.media_item_id)                   as items
      from new_rows n
      join media_items m on m.id = n.media_item_id
     where n.watched_on is not null
       and rankable_category(m.kind) is not null
     group by 1, 2, 3
     -- Deterministic order, so two statements touching the same several groups take the
     -- advisory locks below in the same sequence and cannot deadlock against each other.
     order by 1, 2, 3
  loop
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added, r.items);
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
           count(*)::integer                        as added,
           array_agg(n.media_item_id)               as items
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
    perform _maybe_goal_completion(r.who, r.yr, r.cat, r.added, r.items);
  end loop;
  return null;
end;
$$;

revoke execute on function _goal_after_insert() from public, anon, authenticated;
revoke execute on function _goal_after_update() from public, anon, authenticated;



-- ---------------------------------------------------------------------------
-- 2. Comment Gremlin counts comments, and only comments
-- ---------------------------------------------------------------------------
--
-- Rebuilt in full from 20260828000100 -- the rule this schema keeps relearning
-- (PR #48's lost pair lock) is that a create-or-replace assembled from the wrong
-- ancestor is invisible in a diff. One branch of the case differs.

create or replace function _award_metric(p_user uuid, p_award text, p_threshold integer)
returns bigint
language plpgsql stable
set search_path = public
as $$
declare
  v bigint;
begin
  case p_award
    when 'movie-muncher' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'movie';

    when 'season-snacker' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'season';

    when 'invite-instigator' then
      -- The predicate 20260827001100 declared canonical: attributed AND activated.
      select count(*) into v
        from invite_attributions ia
       where ia.inviter_id = p_user and ia.activated_at is not null;

    when 'queue-dragon' then
      select count(*) into v
        from watchlist w join media_items m on m.id = w.media_item_id
       where w.user_id = p_user and m.kind in ('movie', 'season');

    when 'rating-rascal' then
      select count(*) into v
        from rankings r join media_items m on m.id = r.media_item_id
       where r.user_id = p_user and m.kind in ('movie', 'season');

    when 'comment-gremlin' then
      -- Comments authored, and ONLY comments (founder split, 20260901000100).
      -- The public-note term that used to be added here is gone: a review is a
      -- different behaviour from a comment and no longer moves this track.
      -- Tombstones are still counted -- a retraction does not un-say that the
      -- person wrote. Owner truth: no viewer-relative comments_read filtering,
      -- for the reason 20260828000100's header gives.
      select count(*) into v from comments c where c.author_id = p_user;

    when 'hype-courier' then
      select count(*) into v
        from title_recommendations tr
       where tr.sender_id = p_user;

    when 'scream-snack' then
      v := _award_genre_count(p_user, array['Horror']);
    when 'lol-mode' then
      v := _award_genre_count(p_user, array['Comedy']);
    when 'softie-hours' then
      v := _award_genre_count(p_user, array['Drama', 'Romance']);
    when 'space-brain' then
      v := _award_genre_count(p_user, array['Science Fiction']);
    when 'boom-club' then
      v := _award_genre_count(p_user, array['Action']);
    when 'toon-bloom' then
      v := _award_genre_count(p_user, array['Animation']);
    when 'truth-worm' then
      v := _award_genre_count(p_user, array['Documentary']);

    when 'passport-mode' then
      -- effectiveLanguage: own trimmed non-empty, else the parent's for a season.
      select count(*) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and coalesce(
               nullif(btrim(coalesce(m.original_language, '')), ''),
               case when m.kind = 'season'
                    then nullif(btrim(coalesce(par.original_language, '')), '') end
             ) not in ('en');

    when 'time-hopper' then
      -- Number(release_date.slice(0,4)) < 2000, with the same silence for a
      -- missing or malformed date the JS NaN gives.
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and m.release_date is not null
         and left(m.release_date::text, 4) ~ '^[0-9]{4}$'
         and left(m.release_date::text, 4)::integer < 2000;

    when 'genre-gremlin' then
      -- COUNT DISTINCT canonical genres present anywhere in the collection.
      select count(distinct ap.canonical) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
        cross join lateral unnest(
          _award_effective_genres(m.kind::text, m.genres, par.genres)
        ) as label
        join award_genre_patterns ap on lower(label) ~ ap.pattern
       where um.user_id = p_user
         and m.kind in ('movie', 'season');

    when 'two-screen-life' then
      -- The one tier-dependent metric: each side capped at threshold / 2
      -- (thresholds are even by construction; awards.test.ts pins cap = t/2).
      select least(count(*) filter (where m.kind = 'movie'),  p_threshold / 2)
           + least(count(*) filter (where m.kind = 'season'), p_threshold / 2)
        into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind in ('movie', 'season');

    when 'heart-magnet' then
      -- Reactions on the user's own feed events, excluding their own — the
      -- client's neq(user_id) written where the database can see it.
      select count(*) into v
        from reactions r
        join feed_events fe on fe.id = r.feed_event_id
       where fe.actor_id = p_user and r.user_id <> p_user;

    when 'mutual-mania' then
      -- Approved in both directions, with a profile that still exists. Existence,
      -- not can_i_view — the ledger has no viewer. Self is impossible
      -- (no_self_follow), stated anyway.
      select count(*) into v
        from follows a
        join follows b on b.follower_id = a.followee_id
                      and b.followee_id = a.follower_id
        join profiles p on p.id = a.followee_id
       where a.follower_id = p_user
         and a.followee_id <> p_user
         and a.state = 'approved'
         and b.state = 'approved';

    else
      raise exception 'unknown award %', p_award using errcode = '22023';
  end case;

  return coalesce(v, 0);
end;
$$;

revoke execute on function _award_metric(uuid, text, integer) from public, anon, authenticated;
comment on function _award_metric(uuid, text, integer) is
  'One track''s metric for one account, owner-truth -- src/features/awards/tracks.ts in SQL. The seeded thresholds and patterns are text-parity-tested against the TypeScript (awards-server-parity.test.ts); the metric SEMANTICS are pinned by the behavioral battery in supabase/tests/award-unlocks.test.mjs. Comment Gremlin counts comments alone as of 20260901000100: published reviews were split off it by founder decision and have no track yet. The threshold argument matters to exactly one track (Two-Screen Life''s per-tier cap) and is ignored by the rest. Internal.';


-- The unlock detector, rebuilt from 20260828000100 with the causal step added.
create or replace function _maybe_award_unlocks(p_user uuid, p_awards text[])
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
        insert into feed_events (actor_id, type, causal_step, payload)
        values (
          p_user, 'award_earned', v_step,
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

revoke execute on function _maybe_award_unlocks(uuid, text[]) from public, anon, authenticated;
comment on function _maybe_award_unlocks(uuid, text[]) is
  'The award transition: for each named track, walk the tiers ascending, record every newly-passed one on the ledger, and announce the highest -- one feed event (social tracks only) and one congratulations notification, both hanging off the insert that reported a row, so two devices crossing together announce once. Feed events carry causal_step 2 and up since 20260901000100, one step per announced track in p_awards order, so two awards earned by one action have a fixed order. Directly callable by nobody: a client that could invoke this could probe another account''s counts. Internal.';


-- A published review no longer touches this track, so the note trigger has
-- nothing left to do and the collection trigger's two branches collapse into one.

drop trigger if exists award_on_note on user_media;
drop function if exists _award_touch_note();

create or replace function _award_touch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- One list now. It was a case on whether the row carried a public note, which
  -- appended 'comment-gremlin'; reviews stopped counting toward it on
  -- 20260901000100 and the two branches became the same thirteen tracks.
  perform _maybe_award_unlocks(new.user_id,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);
  return null;
end;
$$;

revoke execute on function _award_touch_user_media() from public, anon, authenticated;


-- The reconciliation. See the header: narrow, deterministic, and the founder's
-- explicit call. The set is frozen into a temporary table first so the three
-- deletes below cannot disagree about which tiers they are about.

create temporary table _comment_gremlin_revoked as
select u.user_id, u.award_key, u.tier_key
  from award_unlocks u
  join award_tiers t
    on t.award_key = u.award_key
   and t.tier_key = u.tier_key
 where u.award_key = 'comment-gremlin'
   and _award_metric(u.user_id, 'comment-gremlin', t.threshold) < t.threshold;

-- The social post, where one was ever made. A row backfilled by 20260828000100's
-- rollout carries announced = false and has no post, so this deletes nothing for
-- it; only a tier genuinely crossed after that date has anything here.
delete from feed_events fe
 using _comment_gremlin_revoked r
 where fe.type = 'award_earned'
   and fe.actor_id = r.user_id
   and fe.payload ->> 'award' = r.award_key
   and fe.payload ->> 'tier' = r.tier_key;

-- The congratulations. Its push_outbox row, if it still has one, goes with it
-- through the foreign key's cascade.
delete from notifications n
 using _comment_gremlin_revoked r
 where n.type = 'award_earned'
   and n.recipient_id = r.user_id
   and n.payload ->> 'award' = r.award_key
   and n.payload ->> 'tier' = r.tier_key;

delete from award_unlocks u
 using _comment_gremlin_revoked r
 where u.user_id = r.user_id
   and u.award_key = r.award_key
   and u.tier_key = r.tier_key;

drop table _comment_gremlin_revoked;


-- ---------------------------------------------------------------------------
-- 3. The invitee's welcome is an inbox row and not a push
-- ---------------------------------------------------------------------------
--
-- Rebuilt from 20260831000100 with one type removed. Everything else about the
-- row is deliberately untouched -- `_apply_notification_preference` still exempts
-- it, so it is still delivered whatever the reader's categories say.

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'mention', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated', 'invite_joined',
    'award_earned', 'goal_completed'
  ]::text[]);
$$;

comment on function _push_eligible(p_type text) is
  'Which notification types may leave the inbox for the lock screen. Twelve of the fifteen: follow_approved is excluded by PRD §15, friendship is the reader''s own action (20260827000200), and invite_welcome left on 20260901000100 -- the founder''s call, because it fires while the new account is already looking at the app that sent it. The in-app welcome row itself is unchanged and still exempt from the preference gate. An unmapped type is not eligible, so a new type has to be added here deliberately.';

-- Anything already queued. A welcome that has not been sent yet should not be
-- sent now; one that has already gone out is history and is not chased.
delete from push_outbox p
 using notifications n
 where n.id = p.notification_id
   and n.type = 'invite_welcome';


-- ---------------------------------------------------------------------------
-- 4. The inbox learns what kind of activity a row is about
-- ---------------------------------------------------------------------------
--
-- Rebuilt from 20260830000100 with one column added to the return and one
-- expression added to the select. The joins, the three ownership rules, the
-- comment-excerpt conditions and the discovery filter are carried across whole.

drop function if exists my_notifications(integer);

create function my_notifications(p_limit integer default 50)
returns table (
  id                 uuid,
  kind               text,
  created_at         timestamptz,
  read_at            timestamptz,
  actor_id           uuid,
  actor_username     text,
  actor_display_name text,
  actor_avatar_path  text,
  subject_type       text,
  subject_id         uuid,
  media_item_id      uuid,
  media_kind         media_kind,
  media_title        text,
  series_title       text,
  payload            jsonb,
  -- One line of what was written, or null. See the header for the three
  -- conditions and for why the server rather than the client withholds it.
  comment_excerpt    text,
  -- True when the live comment this row is about is spoiler-marked. The reason
  -- there is no excerpt, said out loud, so the row can draw "Contains spoilers"
  -- rather than an empty second line that reads as a rendering bug.
  comment_spoilers   boolean,
  -- `watch_tag` only: whether this reader has already ranked the title. Decides
  -- whether the row offers Rank, and goes true on the next refetch after they do.
  viewer_ranked      boolean,
  -- The subject feed event's own type, for the row's sentence (20260901000100).
  --
  -- The inbox says "commented on your Marty Supreme watch", and *watch* is a claim
  -- about the activity rather than about the title: a comment under a watchlist
  -- addition is not a watch. The client reads the noun off this instead of
  -- assuming one, and falls back to the neutral "activity" when it is null --
  -- which is every row with no event, and every row read by a bundle older than
  -- this column.
  --
  -- It discloses nothing the row did not already carry: it comes from the same
  -- join that resolves media_title, under the same three ownership rules and the
  -- same can_view_profile gate on the mention case.
  subject_activity_type text
)
language sql stable security definer
set search_path = public
as $$
  select n.id,
         n.type,
         n.created_at,
         n.read_at,
         n.actor_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         n.subject_type,
         n.subject_id,
         m.id,
         m.kind,
         m.title,
         parent.title,
         n.payload,
         case
           when n.type in ('comment', 'mention') then (
             select left(c.body, 140)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and can_view_profile(auth.uid(), c.author_id)
           )
         end,
         coalesce(
           case
             when n.type in ('comment', 'mention') then (
               select c.has_spoilers
                 from comments c
                where c.id = (n.payload ->> 'comment_id')::uuid
                  and c.deleted_at is null
                  and can_view_profile(auth.uid(), c.author_id)
             )
           end,
           false
         ),
         case
           when n.type = 'watch_tag' then exists (
             select 1 from rankings r
              where r.user_id = auth.uid()
                and r.media_item_id = case
                                        when n.subject_type = 'media_item' then n.subject_id
                                        else null
                                      end
           )
           else false
         end,
         fe.type
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one.
     *
     * A `comment` or `reaction` is on the reader's own activity, which is the general
     * case and the original constraint. A `recommendation_ranked` is the *actor's* own
     * ranking, which is the post the row reports (20260827000600).
     *
     * **A `mention` is on whichever activity the comment was made under**, which is very
     * often neither party's -- so the reader's-own constraint would leave exactly those
     * rows with no title, and a mention on somebody else's post is the ordinary case
     * rather than the edge one.
     *
     * That widening is gated on `can_view_profile` **at read time**, and the gate is not
     * belt-and-braces. `_can_mention` established that the recipient could see the
     * activity when the mention was written; it says nothing about later. The activity's
     * owner is a *third party* to this notification -- the actor is the commenter -- so
     * the outer `can_discover_profile` filter below, which is about the actor, does not
     * cover them, and neither does `block()`, which deletes rows between the pair it
     * names and not rows about them. Without this the reader keeps the title of an
     * activity whose owner has since blocked them or gone private. Independent review
     * 68 found it.
     */
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and case
                when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                when n.type = 'mention' then can_view_profile(auth.uid(), fe.actor_id)
                else fe.actor_id = auth.uid()
              end
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    left join media_items parent
           on parent.id = m.parent_id
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300. The feed-event join resolves the recipient''s own event for comment and reaction rows, the actor''s own for recommendation_ranked (20260827000600), and the event''s own for mention (20260830000100). Since 20260830000100 it also returns one line of the comment (withheld for a deleted, spoiler-marked or unviewable one, with comment_spoilers saying which) and, for watch_tag, whether the reader has already ranked the title. Since 20260901000100 it returns the subject event''s type, so the row can say "your Marty Supreme watch" without assuming that every activity is one.';

grant execute on function my_notifications(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. A ranking session remembers every title it has offered
-- ---------------------------------------------------------------------------

alter table ranking_sessions
  add column seen_items uuid[] not null default '{}';

comment on column ranking_sessions.seen_items is
  'Every title this session has put in front of the reader, in the order it did. The subject is fixed for the life of a session, so this IS the set of unordered pairs already shown, and _rank_offer refuses all of them -- which is the founder''s no-repeat invariant (20260901000100). Bounded by the band size and in practice by the log of it. Per session on purpose: a new session may reconsider the same pair, which is what makes Rank again a second opinion rather than a replay.';

comment on column ranking_sessions.band_skips is
  'Superseded by seen_items (20260901000100) and no longer written. It counted how many candidates had been offered against the current [lo, hi) and reset whenever that range changed -- which is precisely how a skipped pair came back: answering the substitute narrows the range, the counter resets, and the midpoint is the title that was skipped. Left in place rather than dropped because dropping a column is not what fixed the bug.';


/**
 * The next opponent: the nearest index to a preferred one whose title this session
 * has not already shown.
 *
 * The walk is the one rank_skip has always used -- preferred, +1, -1, +2, -2, ...,
 * clamped to [lo, hi) -- with the stopping rule changed from "however many have been
 * offered against this band" to "not in seen_items". The old rule was per band and
 * the new one is per session, which is the whole correction.
 *
 * Returns no rows when every index in the range resolves to a title already shown.
 * Callers read that as "nothing honest left to ask" and finalise; a select … into
 * against zero rows leaves the record null, which is what the item is null tests
 * downstream are reading.
 *
 * stable and read-only: recording the offer is the caller's, because each caller
 * has an update to make anyway and a second one here would be a write nobody asked
 * for on a path that also has to set lo, hi and history.
 */
create or replace function _rank_offer(
  p_session    uuid,
  p_user       uuid,
  p_category   ranking_category,
  p_band_lo    integer,
  p_lo         integer,
  p_hi         integer,
  p_preferred  integer,
  p_exclude    uuid default null
)
returns table (idx integer, item uuid)
language plpgsql stable
set search_path = public
as $$
declare
  v_seen      uuid[];
  v_offset    integer := 0;
  v_candidate integer;
  v_item      uuid;
begin
  select coalesce(rs.seen_items, '{}'::uuid[]) into v_seen
    from ranking_sessions rs where rs.id = p_session;
  v_seen := coalesce(v_seen, '{}'::uuid[]);

  -- The furthest any candidate can be from the preferred index and still be inside
  -- the range, so the loop terminates having considered every member of it exactly
  -- once and cannot spin on a sparse band.
  while v_offset <= (p_hi - p_lo) loop
    -- Offset zero is the preferred index itself, and it is tried once rather than
    -- twice: +0 and -0 are the same candidate.
    for v_candidate in
      select c from unnest(
        case when v_offset = 0
          then array[p_preferred]
          else array[p_preferred + v_offset, p_preferred - v_offset]
        end
      ) as c
    loop
      if v_candidate >= p_lo and v_candidate < p_hi then
        v_item := _rank_pivot_at(p_user, p_category, p_band_lo + v_candidate, p_exclude);
        if v_item is not null and not (v_item = any (v_seen)) then
          idx := v_candidate;
          item := v_item;
          return next;
          return;
        end if;
      end if;
    end loop;

    v_offset := v_offset + 1;
  end loop;

  return;
end;
$$;

comment on function _rank_offer(uuid, uuid, ranking_category, integer, integer, integer, integer, uuid) is
  'The nearest index to a preferred one, inside [lo, hi), whose title this session has not already offered -- or no rows at all when there is none. Read-only: the caller records the offer, because the caller has an update to make anyway. Internal to the ranking family.';

revoke execute on function
  _rank_offer(uuid, uuid, ranking_category, integer, integer, integer, integer, uuid)
  from public, anon, authenticated;


-- The three session steps, rebuilt from 20260826000500. Every other line is
-- carried across; what differs is where a pivot comes from and that the session
-- now records it.

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

  v_pivot := v_band.size / 2;
  -- Resolved BEFORE the insert now, so the session is born knowing which title it
  -- has shown. It used to be resolved in the return expression, which is exactly
  -- how the opening comparison came to be re-offerable later: the founder's report
  -- is A-versus-B, Too tough, one answer, A-versus-B again, and B is this pivot.
  v_pivot_item := _rank_pivot_at(p_user, v_cat, v_band.lo + v_pivot, v_exclude);

  insert into ranking_sessions (
    user_id, media_item_id, category, bucket, lo, hi, pivot, provisional, new_watch,
    seen_items
  )
  values (
    p_user, p_media_item_id, v_cat, p_bucket, 0, v_band.size, v_pivot,
    v_exclude is not null, p_new_watch,
    case when v_pivot_item is null then '{}'::uuid[] else array[v_pivot_item] end
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
  'Opens a comparison session, or places the title outright when its band is empty. The body of rank_start, shared with rank_rebucket and rank_again. With p_provisional it opens *over* a title that is still ranked: the bucket is not written, the already-ranked refusal does not apply, and the band excludes the subject -- so nothing the reader can see changes until the placement completes. Since 20260901000100 the opening comparison is recorded in seen_items, which is what stops it being offered a second time later in the same session; a resume records the pivot it re-offers, which also backfills a session opened before that column existed. Assumes the caller holds _lock_media for the same (user, media item). Internal.';

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
         seen_items = seen_items || v_offer.item,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot
         ),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item
  ));
end;
$$;

comment on function rank_answer(uuid, uuid, uuid) is
  'Records one comparison and either narrows the search or finalises the placement. With an operation id, a replay returns the stored answer -- the same position, score and activation flag -- so a retry cannot record a second comparison, move the title twice, or emit a second feed event. For a provisional session the opponents come from the band with the subject excluded, and the placement replaces the subject''s old position rather than filling a hole left behind at the start. Since 20260901000100 the next opponent is the nearest index to the midpoint that this session has not already shown; when every remaining one has been shown the title is placed at the midpoint and reported as adjustable, with no comparison recorded, because a skipped pair is an absence of evidence rather than a tie.';

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
         seen_items = seen_items || v_offer.item,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item,
    'skipped', true
  ));
end;
$$;

comment on function rank_skip(uuid, uuid) is
  'Re-anchors to a different opponent without narrowing the range; the configured skip limit places the title at the midpoint instead. Carries an operation id because a skip mutates -- a replay without one spends a second skip against the limit and shows a third title. For a provisional session the candidates exclude the subject, which is still ranked inside the band. Since 20260901000100 the candidate walk refuses every title this session has already offered rather than counting offers against the current band, which is what stopped a skipped pair returning after the next answer narrowed the range.';

-- create or replace does not disturb a grant, and these were granted by
-- 20260826000500. Restated anyway, because a grant that is present for a reason
-- nobody can see is a grant the next rebuild loses.
revoke execute on function rank_answer(uuid, uuid, uuid) from public, anon;
grant  execute on function rank_answer(uuid, uuid, uuid) to authenticated;
revoke execute on function rank_skip(uuid, uuid)   from public, anon;
grant  execute on function rank_skip(uuid, uuid)   to authenticated;
