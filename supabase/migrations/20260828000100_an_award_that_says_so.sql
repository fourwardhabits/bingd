-- An award that says so.
-- Founder tranche 2026-08-28: newly earning a bingd. Award creates a social feed
-- post and a personal congratulations notification, push-eligible. This is the
-- durable unlock ledger deferred-roadmap §5 said the feature was waiting for.
--
-- ---------------------------------------------------------------------------
-- THE CANONICAL TRANSITION, AND WHERE IT LIVES
--
-- Awards have been computed entirely on the client (src/features/awards) — a
-- delight layer with no server state — and that stays true for DISPLAY: the sheet
-- goes on deriving progress from facts. What the client model cannot give the
-- founder's contract is the *transition*: "user X newly earned tier Y" must
-- happen exactly once across devices, must fire on the qualifying action rather
-- than on the next time a sheet happens to open, and for three of the twenty
-- tracks the qualifying action is SOMEBODY ELSE'S — a reaction moves the event
-- actor's Heart Magnet, an approval moves both parties' Mutual Mania, and an
-- invitee's tenth ranking moves the INVITER'S Invite Instigator while the
-- inviter's app may not even be running. So the transition is detected here,
-- where the facts change, and recorded in `award_unlocks`.
--
-- ---------------------------------------------------------------------------
-- TRIGGERS, NOT WRITER REBUILDS
--
-- Fourteen writer functions change award facts, six of them for somebody other
-- than the caller, and one (`set_profile_visibility`) for an unbounded set. This
-- schema's own history says what rebuilding fourteen functions costs: a
-- `create or replace` assembled from the wrong ancestor is how `add_comment`
-- lost a pair lock once (PR #48) and it is invisible in a diff. Row-level AFTER
-- triggers on the eight source tables reach every current writer and every
-- future one by construction, run inside the same transaction, and follow the
-- shape the notification pipeline already established (`_enqueue_push` is an
-- AFTER trigger on `notifications`). Only count-increasing events carry a
-- trigger: an unlock is a historical fact and is never revoked — the same
-- irreversibility `invite_attributions.activated_at` records
-- (20260819000500: "It is a historical fact.").
--
-- ---------------------------------------------------------------------------
-- EXACTLY-ONCE, AND NO HISTORICAL SPAM
--
-- The transition is `insert into award_unlocks … on conflict do nothing` under
-- READ COMMITTED: of two devices crossing the same tier simultaneously, the
-- second blocks on the first's row and then inserts nothing, and both side
-- effects — the feed event and the notification — hang off the insert that
-- reported a row. Replays never reach the trigger at all: every client writer
-- claims its operation id before touching a table. Partial unique indexes on
-- `feed_events` and `notifications` restate the invariant as backstops, the
-- `notifications_one_fulfillment_per_recommendation` pattern.
--
-- Rollout: this migration BACKFILLS every currently-earned tier for every
-- existing account, quietly (`announced = false`), BEFORE the triggers are
-- created. Only crossings after this migration announce. A fresh database (the
-- test harness) backfills nobody and announces every genuine crossing, which is
-- what its fixtures then observe.
--
-- ---------------------------------------------------------------------------
-- OWNER-TRUTH METRICS, AND THE TWO DELIBERATE DIVERGENCES
--
-- `_award_metric` reproduces src/features/awards/tracks.ts over the canonical
-- tables. Two client filters are viewer-relative and have no meaning for a
-- ledger, so the server counts owner-truth:
--   · the client's comment count is filtered by `comments_read` (a comment on a
--     since-blocked account's event disappears from the viewer's sheet); the
--     ledger counts the comments the author wrote;
--   · Mutual Mania's client count drops accounts `can_i_view` refuses; the
--     ledger requires only that the profile row exists.
-- The ledger can therefore unlock at a value a particular viewer's sheet does
-- not show. That is the correct direction: an achievement, once earned against
-- real activity, does not flicker with other people's block lists. The display
-- stays derived; the ledger drives only the social loop.
--
-- The seeded thresholds and genre vocabulary are COPIES of tracks.ts/genres.ts,
-- which those files say must never exist — so the copies are held to the source
-- by parity tests (src/features/awards/awards-server-parity.test.ts reads this
-- file's seeds against the TypeScript, the genre-ladder-report pattern), and a
-- drift fails CI rather than shipping.
--
-- ---------------------------------------------------------------------------
-- PRIVACY
--
-- The feed event's payload carries award key, tier key and their display names —
-- nothing else. `feed_events_read` is type-independent (`can_i_view(actor_id)`),
-- so award posts obey exactly the visibility every other activity obeys, and
-- comments/reactions work on them because nothing in those writers reads the
-- type. Invite Instigator participates: its COUNT became public achievement data
-- on 2026-08-27 (20260827001100) and the payload names no invitee, no token, no
-- timestamp — deferred-roadmap §5's standing constraint. Hype Courier's progress
-- is still withheld from visitors, so it is the one track marked `social =
-- false`: earning it files the private congratulations and no feed post, because
-- a public post would disclose the crossing of a count the product refuses to
-- show.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The canonical tier table — 20 tracks × 3 tiers, tracks.ts's numbers
-- ---------------------------------------------------------------------------

create table award_tiers (
  award_key    text not null,
  tier_index   integer not null check (tier_index in (1, 2, 3)),
  tier_key     text not null,
  tier_label   text not null,
  display_name text not null,
  threshold    integer not null check (threshold > 0),
  -- Whether a crossing posts to the feed. False only for Hype Courier — see the
  -- header. The congratulations notification is unconditional.
  social       boolean not null default true,
  primary key (award_key, tier_key),
  unique (award_key, tier_index)
);

alter table award_tiers enable row level security;
revoke all on award_tiers from public, anon, authenticated;

comment on table award_tiers is
  'The canonical award ladder, seeded from src/features/awards/tracks.ts and held to it by a parity test. Not client-readable: the client has the source. Internal.';

insert into award_tiers (award_key, tier_index, tier_key, tier_label, display_name, threshold, social) values
  ('movie-muncher',     1, 'bronze',          'Bronze',          'Movie Muncher',     50,   true),
  ('movie-muncher',     2, 'silver',          'Silver',          'Movie Muncher',     200,  true),
  ('movie-muncher',     3, 'gold',            'Gold',            'Movie Muncher',     1000, true),
  ('season-snacker',    1, 'bronze',          'Bronze',          'Season Snacker',    15,   true),
  ('season-snacker',    2, 'silver',          'Silver',          'Season Snacker',    60,   true),
  ('season-snacker',    3, 'gold',            'Gold',            'Season Snacker',    250,  true),
  ('invite-instigator', 1, 'bronze',          'Bronze',          'Invite Instigator', 3,    true),
  ('invite-instigator', 2, 'silver',          'Silver',          'Invite Instigator', 15,   true),
  ('invite-instigator', 3, 'gold',            'Gold',            'Invite Instigator', 50,   true),
  ('queue-dragon',      1, 'seedling',        'Seedling',        'Queue Dragon',      25,   true),
  ('queue-dragon',      2, 'hoarder',         'Hoarder',         'Queue Dragon',      100,  true),
  ('queue-dragon',      3, 'queue-dragon',    'Queue Dragon',    'Queue Dragon',      300,  true),
  ('rating-rascal',     1, 'scribbler',       'Scribbler',       'Rating Rascal',     100,  true),
  ('rating-rascal',     2, 'score-goblin',    'Score Goblin',    'Rating Rascal',     500,  true),
  ('rating-rascal',     3, 'rank-beast',      'Rank Beast',      'Rating Rascal',     2000, true),
  ('comment-gremlin',   1, 'whisper',         'Whisper',         'Comment Gremlin',   20,   true),
  ('comment-gremlin',   2, 'chatterbox',      'Chatterbox',      'Comment Gremlin',   100,  true),
  ('comment-gremlin',   3, 'megaphone',       'Megaphone',       'Comment Gremlin',   500,  true),
  ('hype-courier',      1, 'nudge',           'Nudge',           'Hype Courier',      25,   false),
  ('hype-courier',      2, 'messenger',       'Messenger',       'Hype Courier',      100,  false),
  ('hype-courier',      3, 'hype-train',      'Hype Train',      'Hype Courier',      500,  false),
  ('scream-snack',      1, 'spooky-sip',      'Spooky Sip',      'Scream Snack',      25,   true),
  ('scream-snack',      2, 'slash-snack',     'Slash Snack',     'Scream Snack',      100,  true),
  ('scream-snack',      3, 'nightmare-fuel',  'Nightmare Fuel',  'Scream Snack',      300,  true),
  ('lol-mode',          1, 'giggle',          'Giggle',          'LOL Mode',          25,   true),
  ('lol-mode',          2, 'cackle',          'Cackle',          'LOL Mode',          100,  true),
  ('lol-mode',          3, 'wheeze',          'Wheeze',          'LOL Mode',          300,  true),
  ('softie-hours',      1, 'sniffle',         'Sniffle',         'Softie Hours',      25,   true),
  ('softie-hours',      2, 'tearjerker',      'Tearjerker',      'Softie Hours',      100,  true),
  ('softie-hours',      3, 'sob-lord',        'Sob Lord',        'Softie Hours',      300,  true),
  ('space-brain',       1, 'liftoff',         'Liftoff',         'Space Brain',       25,   true),
  ('space-brain',       2, 'moonwalker',      'Moonwalker',      'Space Brain',       100,  true),
  ('space-brain',       3, 'galaxy-mind',     'Galaxy Mind',     'Space Brain',       300,  true),
  ('boom-club',         1, 'spark',           'Spark',           'Boom Club',         25,   true),
  ('boom-club',         2, 'blast',           'Blast',           'Boom Club',         100,  true),
  ('boom-club',         3, 'detonation',      'Detonation',      'Boom Club',         300,  true),
  ('toon-bloom',        1, 'sketch',          'Sketch',          'Toon Bloom',        20,   true),
  ('toon-bloom',        2, 'ink-pop',         'Ink Pop',         'Toon Bloom',        75,   true),
  ('toon-bloom',        3, 'cartoon-chaos',   'Cartoon Chaos',   'Toon Bloom',        250,  true),
  ('truth-worm',        1, 'curious',         'Curious',         'Truth Worm',        15,   true),
  ('truth-worm',        2, 'investigator',    'Investigator',    'Truth Worm',        50,   true),
  ('truth-worm',        3, 'deep-dive',       'Deep Dive',       'Truth Worm',        150,  true),
  ('passport-mode',     1, 'hitchhiker',      'Hitchhiker',      'Passport Mode',     15,   true),
  ('passport-mode',     2, 'jetsetter',       'Jetsetter',       'Passport Mode',     75,   true),
  ('passport-mode',     3, 'globetrotter',    'Globetrotter',    'Passport Mode',     250,  true),
  ('time-hopper',       1, 'retro-snack',     'Retro Snack',     'Time Hopper',       25,   true),
  ('time-hopper',       2, 'vhs-vibes',       'VHS Vibes',       'Time Hopper',       100,  true),
  ('time-hopper',       3, 'time-traveler',   'Time Traveler',   'Time Hopper',       300,  true),
  ('genre-gremlin',     1, 'dabbler',         'Dabbler',         'Genre Gremlin',     14,   true),
  ('genre-gremlin',     2, 'mixer',           'Mixer',           'Genre Gremlin',     16,   true),
  ('genre-gremlin',     3, 'chaos-collector', 'Chaos Collector', 'Genre Gremlin',     17,   true),
  ('two-screen-life',   1, 'tourist',         'Tourist',         'Two-Screen Life',   30,   true),
  ('two-screen-life',   2, 'resident',        'Resident',        'Two-Screen Life',   100,  true),
  ('two-screen-life',   3, 'mayor',           'Mayor',           'Two-Screen Life',   300,  true),
  ('heart-magnet',      1, 'warmup',          'Warmup',          'Heart Magnet',      50,   true),
  ('heart-magnet',      2, 'favorite',        'Favorite',        'Heart Magnet',      250,  true),
  ('heart-magnet',      3, 'scene-stealer',   'Scene Stealer',   'Heart Magnet',      1000, true),
  ('mutual-mania',      1, 'hello',           'Hello',           'Mutual Mania',      5,    true),
  ('mutual-mania',      2, 'inner-circle',    'Inner Circle',    'Mutual Mania',      25,   true),
  ('mutual-mania',      3, 'main-character',  'Main Character',  'Mutual Mania',      100,  true);

-- ---------------------------------------------------------------------------
-- 2. The genre vocabulary — genres.ts's 18 patterns, JS \b rendered as POSIX \y
-- ---------------------------------------------------------------------------

create table award_genre_patterns (
  canonical text primary key,
  pattern   text not null
);

alter table award_genre_patterns enable row level security;
revoke all on award_genre_patterns from public, anon, authenticated;

comment on table award_genre_patterns is
  'genres.ts''s canonical vocabulary, with JS \b word boundaries rendered as POSIX \y. Held to the source by a parity test and a shared classification battery run against both engines. Internal.';

insert into award_genre_patterns (canonical, pattern) values
  ('Action',          '\yaction\y'),
  ('Adventure',       '\yadventure\y'),
  ('Animation',       '\yanimat(ed|ion)\y|\yanime\y|\ycartoon\y'),
  ('Comedy',          '\ycomed(y|ies|ic)\y'),
  ('Crime',           '\ycrime\y|\yheist\y|\ygangster\y'),
  ('Documentary',     '\ydocumentar'),
  ('Drama',           '\ydrama\y|\ymelodrama\y'),
  ('Family',          '\yfamily\y|\ychildren''?s\y'),
  ('Fantasy',         '\yfantas(y|tique)\y|\ysword and sorcery\y'),
  ('History',         '\yhistor(y|ical)\y|\yperiod (piece|drama)\y|\ybiographical\y'),
  ('Horror',          '\yhorror\y|\yslasher\y'),
  ('Music',           '\ymusic(al)?\y|\yconcert film\y'),
  ('Mystery',         '\ymyster(y|ies)\y|\ydetective\y|\ywhodunn?it\y'),
  ('Romance',         '\yromance\y|\yromantic\y'),
  ('Science Fiction', '\yscience fiction\y|\ysci-?fi\y|\ydystopian\y|\ypost-apocalyptic\y|\yspace opera\y'),
  ('Thriller',        '\ythriller\y|\ysuspense\y|\yneo-noir\y|\yfilm noir\y'),
  ('War',             '\ywar\y|\ymilitary\y'),
  ('Western',         '\ywestern\y');

-- ---------------------------------------------------------------------------
-- 3. The ledger
-- ---------------------------------------------------------------------------

create table award_unlocks (
  user_id         uuid not null references profiles(id) on delete cascade,
  award_key       text not null,
  tier_key        text not null,
  -- The metric at the moment of unlock, for the record. Never re-derived and
  -- never revoked: counts can fall (an unranking, an unfollow) and the unlock
  -- stands, exactly as activated_at does.
  value_at_unlock bigint not null,
  -- False on the rollout backfill and on lower tiers skipped past in one
  -- crossing; true exactly when this row produced the feed post / notification.
  announced       boolean not null default false,
  earned_at       timestamptz not null default now(),
  primary key (user_id, award_key, tier_key),
  foreign key (award_key, tier_key) references award_tiers (award_key, tier_key)
);

create index award_unlocks_user on award_unlocks (user_id);

alter table award_unlocks enable row level security;
revoke all on award_unlocks from public, anon, authenticated;
grant select on award_unlocks to authenticated;

-- Own rows only. The public surface of an unlock is the feed event; the ledger
-- itself is bookkeeping the owner may read and nobody may write directly.
create policy award_unlocks_own on award_unlocks for select
  using (user_id = auth.uid());

comment on table award_unlocks is
  'The durable award transitions: user X earned tier Y, at most once, ever. Written only by _maybe_award_unlocks (triggers); the rollout backfill rows carry announced = false so pre-existing progress produced no social event. Display stays client-derived; this table drives only the feed post and the congratulations.';

-- ---------------------------------------------------------------------------
-- 4. The metric, per track — tracks.ts in SQL, owner-truth
-- ---------------------------------------------------------------------------

create or replace function _award_effective_genres(
  p_kind text, p_genres text[], p_parent_genres text[]
)
returns text[]
language sql immutable
set search_path = public
as $$
  -- media-metadata.ts's inheritance: a season with no genres of its own borrows
  -- the series'; a movie never inherits.
  select case
    when p_kind = 'season' and coalesce(array_length(p_genres, 1), 0) = 0
      then coalesce(p_parent_genres, '{}'::text[])
    else coalesce(p_genres, '{}'::text[])
  end;
$$;

revoke execute on function _award_effective_genres(text, text[], text[]) from public, anon, authenticated;
comment on function _award_effective_genres(text, text[], text[]) is
  'effectiveGenres from src/lib/media-metadata.ts: own genres, else the parent''s for a season. Internal.';

create or replace function _award_matches_genre(p_genres text[], p_canonical text[])
returns boolean
language sql stable
set search_path = public
as $$
  -- hasAnyGenre: any label matching any of the named canonical genres' patterns.
  -- Lowered first, matched case-sensitively — the exact JS order of operations.
  select exists (
    select 1
      from unnest(coalesce(p_genres, '{}'::text[])) as label
      join award_genre_patterns ap on ap.canonical = any (p_canonical)
     where lower(label) ~ ap.pattern
  );
$$;

revoke execute on function _award_matches_genre(text[], text[]) from public, anon, authenticated;
comment on function _award_matches_genre(text[], text[]) is
  'hasAnyGenre from src/features/awards/genres.ts over the seeded vocabulary. Internal.';

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
      -- Comments authored (tombstones included — a retraction does not un-say
      -- that the person wrote) plus public notes on resolvable titles. Owner
      -- truth: no viewer-relative comments_read filtering — see the header.
      select (select count(*) from comments c where c.author_id = p_user)
           + (select count(*)
                from user_media um join media_items m on m.id = um.media_item_id
               where um.user_id = p_user
                 and um.note is not null
                 and um.note_visibility = 'public'
                 and m.kind in ('movie', 'season'))
        into v;

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
  'One track''s metric for one account, owner-truth — src/features/awards/tracks.ts in SQL. The seeded thresholds and patterns are text-parity-tested against the TypeScript (awards-server-parity.test.ts); the metric SEMANTICS are pinned by the behavioral battery in supabase/tests/award-unlocks.test.mjs, which is where a drift in inheritance, filtering, caps or counting fails. The threshold argument matters to exactly one track (Two-Screen Life''s per-tier cap) and is ignored by the rest. Internal.';

create or replace function _award_genre_count(p_user uuid, p_canonical text[])
returns bigint
language sql stable
set search_path = public
as $$
  select count(*)
    from user_media um
    join media_items m on m.id = um.media_item_id
    left join media_items par on par.id = m.parent_id
   where um.user_id = p_user
     and m.kind in ('movie', 'season')
     and _award_matches_genre(
           _award_effective_genres(m.kind::text, m.genres, par.genres),
           p_canonical
         );
$$;

revoke execute on function _award_genre_count(uuid, text[]) from public, anon, authenticated;
comment on function _award_genre_count(uuid, text[]) is
  'Distinct titles carrying any of the named canonical genres — one each, however many labels match, which is inGenre''s rule. Internal.';

-- ---------------------------------------------------------------------------
-- 5. The detector
-- ---------------------------------------------------------------------------

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
        insert into feed_events (actor_id, type, payload)
        values (
          p_user, 'award_earned',
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
    end if;
  end loop;
end;
$$;

revoke execute on function _maybe_award_unlocks(uuid, text[]) from public, anon, authenticated;
comment on function _maybe_award_unlocks(uuid, text[]) is
  'The award transition: for each named track, walk the tiers ascending, record every newly-passed one on the ledger, and announce the highest — one feed event (social tracks only) and one congratulations notification, both hanging off the insert that reported a row, so two devices crossing together announce once. Directly callable by nobody: a client that could invoke this could probe another account''s counts. Internal.';

-- ---------------------------------------------------------------------------
-- 6. Feed and notification surface for the new type
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
  'award_earned'
));

-- The backstops. The mechanism is the award_unlocks insert; these state the
-- invariant where a future writer cannot miss it (the
-- notifications_one_fulfillment_per_recommendation pattern).
create unique index feed_events_one_award_post
  on feed_events (actor_id, (payload ->> 'award'), (payload ->> 'tier'))
  where type = 'award_earned';

create unique index notifications_one_award_congrats
  on notifications (recipient_id, (payload ->> 'award'), (payload ->> 'tier'))
  where type = 'award_earned';

-- ---------------------------------------------------------------------------
-- 7. The awards preference default flips on — the writer exists now
-- ---------------------------------------------------------------------------
--
-- The 20260820000100 mechanism, applied to the last category: accounts with no
-- row get the new default; an account with a row chose, and `_notifies`
-- coalesces to the row without ever reaching this function. No DML, because a
-- backfill is exactly the thing that would break that.

create or replace function _notification_default(p_category text)
returns boolean
language sql immutable
set search_path = public
as $$
  -- Absence means *this*, rather than meaning true — and as of 20260828000100 it
  -- is true for all eight. `awards` was the last holdout, false only because
  -- nothing wrote one; _maybe_award_unlocks writes one now, so the reasoning
  -- that kept it off ("do not pretend the functionality exists") now keeps it
  -- on: a notification that arrives unwanted is a setting somebody turns off,
  -- and one that never arrives is a bug nobody can see.
  select true;
$$;

comment on function _notification_default(text) is
  'What a category means when the account has no row for it: on, for all eight. awards joined the other seven on 20260828 when the award-unlock ledger gave award_earned its writer. Accounts with an explicit row are unaffected -- _notifies coalesces to the row and never reaches this. Internal.';

-- ---------------------------------------------------------------------------
-- 8. Push eligibility — rebuilt from 20260827000600, plus award_earned
-- ---------------------------------------------------------------------------

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated',
    'invite_welcome', 'award_earned'
  ]::text[]);
$$;

comment on function _push_eligible(p_type text) is
  'Which notification types may leave the inbox for the lock screen. Ten of the twelve: follow_approved is excluded by PRD §15, and friendship is the reader''s own action (20260827000200). award_earned joined on 20260828 with its writer. An unmapped type is not eligible, so a new type has to be added here deliberately.';

-- ---------------------------------------------------------------------------
-- 9. `claim_push_batch`, rebuilt from 20260827000600
--
-- Two changes, everything else verbatim: an actorless notification survives the
-- final filter (`p.id is not null` existed to drop jobs whose actor has gone,
-- and read "has no actor" as "actor has gone" — award congratulations are the
-- first actorless push, and the old predicate silently discarded them after
-- claiming), and the job carries `award_name` so the sender can say which award
-- without a second read.
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
begin
  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        -- The conversation this push is about, so a tap on the lock screen lands where
        -- a tap on the inbox row lands. See 20260826000600 §6.
        'feed_event_id',   j.feed_event_id,
        -- What the person wrote, when it may be shown at all. See 20260827000300.
        'comment_excerpt', j.comment_excerpt,
        -- Which award, for the one actorless congratulations (20260828000100).
        -- The display name only: the payload's keys stay server-side.
        'award_name',      j.award_name,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           -- Comment jobs only. Live, spoiler-free, and bounded: 180 characters is
           -- more than any lock screen draws, and the client does the tidy ellipsis.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
           ) end                                   as comment_excerpt,
           case when n.type = 'award_earned'
                then n.payload ->> 'award_name' end as award_name,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      -- Whose feed event this type means -- the same rule, in the same words, as
      -- `my_notifications`: the recipient's own post for a comment or a reaction,
      -- the actor's own ranking for a fulfilment (20260827000600).
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            and fe.actor_id = case
                                when n.type = 'recommendation_ranked' then n.actor_id
                                else n.recipient_id
                              end
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- An actorless notification has nobody to have gone. The award
       -- congratulations is the first such push (20260828000100); before it,
       -- this predicate doubled as the actorless filter by accident.
       and (p.id is not null or n.actor_id is null)
  ) j;

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, and award_name since 20260828000100.';

-- ---------------------------------------------------------------------------
-- 10. The rollout backfill — BEFORE the triggers exist, so it announces nothing
-- ---------------------------------------------------------------------------
--
-- Every currently-earned tier for every existing account goes on the ledger
-- quietly. A fresh database (every test run) has no profiles here and backfills
-- nothing; the deployed database gets its history recorded so the first
-- post-deploy action announces only what it genuinely crossed.

insert into award_unlocks (user_id, award_key, tier_key, value_at_unlock, announced)
select pr.id, t.award_key, t.tier_key, m.v, false
  from profiles pr
  cross join award_tiers t
  cross join lateral (select _award_metric(pr.id, t.award_key, t.threshold) as v) m
 where m.v >= t.threshold
on conflict (user_id, award_key, tier_key) do nothing;

-- ---------------------------------------------------------------------------
-- 11. The triggers — every count-increasing write, whoever made it
-- ---------------------------------------------------------------------------

create or replace function _award_touch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.user_id,
    case when new.note is not null and new.note_visibility = 'public'
      then array['movie-muncher','season-snacker','scream-snack','lol-mode',
                 'softie-hours','space-brain','boom-club','toon-bloom',
                 'truth-worm','passport-mode','time-hopper','genre-gremlin',
                 'two-screen-life','comment-gremlin']
      else array['movie-muncher','season-snacker','scream-snack','lol-mode',
                 'softie-hours','space-brain','boom-club','toon-bloom',
                 'truth-worm','passport-mode','time-hopper','genre-gremlin',
                 'two-screen-life']
    end);
  return null;
end;
$$;

create or replace function _award_touch_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.user_id, array['comment-gremlin']);
  return null;
end;
$$;

create or replace function _award_touch_ranking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.user_id, array['rating-rascal']);
  return null;
end;
$$;

create or replace function _award_touch_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.user_id, array['queue-dragon']);
  return null;
end;
$$;

create or replace function _award_touch_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.author_id, array['comment-gremlin']);
  return null;
end;
$$;

create or replace function _award_touch_recommendation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _maybe_award_unlocks(new.sender_id, array['hype-courier']);
  return null;
end;
$$;

create or replace function _award_touch_reaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  -- The beneficiary is the event's actor, and a self-reaction moves nothing —
  -- the client's neq(user_id) rule.
  select fe.actor_id into v_actor from feed_events fe where fe.id = new.feed_event_id;
  if v_actor is not null and v_actor <> new.user_id then
    perform _maybe_award_unlocks(v_actor, array['heart-magnet']);
  end if;
  return null;
end;
$$;

create or replace function _award_touch_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A new approval mints a mutual only when the reverse edge is already
  -- approved — one index probe before either party's count runs. Both parties
  -- cross together, which is why this cannot be a caller-scoped hook.
  if new.state = 'approved'
     and (tg_op = 'INSERT' or old.state is distinct from 'approved')
     and exists (
       select 1 from follows b
        where b.follower_id = new.followee_id
          and b.followee_id = new.follower_id
          and b.state = 'approved'
     )
  then
    perform _maybe_award_unlocks(new.follower_id, array['mutual-mania']);
    perform _maybe_award_unlocks(new.followee_id, array['mutual-mania']);
  end if;
  return null;
end;
$$;

create or replace function _award_touch_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The inviter's achievement, on the invitee's action — the case that makes
  -- server-side detection non-optional. inviter_id is nullable (a deleted
  -- inviter keeps the historical fact); the detector shrugs at null.
  perform _maybe_award_unlocks(new.inviter_id, array['invite-instigator']);
  return null;
end;
$$;

revoke execute on function _award_touch_user_media()     from public, anon, authenticated;
revoke execute on function _award_touch_note()           from public, anon, authenticated;
revoke execute on function _award_touch_ranking()        from public, anon, authenticated;
revoke execute on function _award_touch_watchlist()      from public, anon, authenticated;
revoke execute on function _award_touch_comment()        from public, anon, authenticated;
revoke execute on function _award_touch_recommendation() from public, anon, authenticated;
revoke execute on function _award_touch_reaction()       from public, anon, authenticated;
revoke execute on function _award_touch_follow()         from public, anon, authenticated;
revoke execute on function _award_touch_invite()         from public, anon, authenticated;

create trigger award_on_user_media
  after insert on user_media
  for each row execute function _award_touch_user_media();

create trigger award_on_note
  after update of note, note_visibility on user_media
  for each row
  when (new.note is not null and new.note_visibility = 'public')
  execute function _award_touch_note();

create trigger award_on_ranking
  after insert on rankings
  for each row execute function _award_touch_ranking();

create trigger award_on_watchlist
  after insert on watchlist
  for each row execute function _award_touch_watchlist();

create trigger award_on_comment
  after insert on comments
  for each row execute function _award_touch_comment();

create trigger award_on_recommendation
  after insert on title_recommendations
  for each row execute function _award_touch_recommendation();

create trigger award_on_reaction
  after insert on reactions
  for each row execute function _award_touch_reaction();

create trigger award_on_follow
  after insert or update of state on follows
  for each row execute function _award_touch_follow();

create trigger award_on_invite_activation
  after update of activated_at on invite_attributions
  for each row
  when (new.activated_at is not null and old.activated_at is null)
  execute function _award_touch_invite();
