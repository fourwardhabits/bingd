-- A recommendation remembers being shown, and can come from a friend.
-- Founder tranche 2026-08-28 §§13-17: For You V1.5 -- rotation that survives a relaunch,
-- and one small social candidate source.
--
-- ===========================================================================
-- 1. THE PROBLEM, AS IT ACTUALLY IS AFTER 20260827
--
-- The founder's report is that opening For You repeatedly produces substantially the
-- same slate. Half of that was fixed on 2026-08-27: `session-seed.ts` separated *which
-- titles are good* from *which arrangement this session is showing*, and `rank.ts` now
-- demotes what the session has already presented.
--
-- The half that was left is written in that file's own header: **exposure is module
-- state, so it resets with the process.** Close the app and every title is unseen again,
-- which means the first slate after every launch is drawn from an un-penalised pool and
-- is therefore the same first slate. The founder's rule for this tranche is explicit --
-- "prefer durable cross-session behaviour" -- and that is this migration.
--
-- `recommendation_impressions` (20260813001000) was created for a server-side engine
-- that was never built. It has the exact shape this needs -- `(user_id, media_item_id,
-- shown_at)`, plus an index whose name is literally `recommendation_impressions_cooldown`
-- -- and, like `recommendation_feedback` before 20260827000700, it has never had a
-- writer. This is its first one.
--
-- ===========================================================================
-- 2. WHEN A TITLE COUNTS AS SHOWN
--
-- **Included in a slate the client actually rendered.** Not scored, not fetched, not
-- scrolled past a threshold: a visibility observer would be a second definition of
-- "shown" living in a layout, and the founder asked for whichever rule is reliably
-- testable. A delivered slate is a list the client can name.
--
-- The founder's other instruction -- do not record a server write for every render --
-- is answered **twice**, and the second one is the load-bearing half:
--
--   * the client only calls when the delivered id set *changes* (`use-for-you.ts`), and
--   * `shown_at` is truncated to the hour before the insert, so the primary key itself
--     collapses everything within one hour into one row per title.
--
-- The truncation is what makes this safe against a client bug rather than against a
-- careful client. A render loop firing a hundred times a second writes the same hundred
-- rows a hundred times and inserts none of them after the first, because
-- `on conflict do nothing` on `(user_id, media_item_id, shown_at)` has nothing new to
-- store. The bound is therefore **one row per title per hour**, not one per render.
--
-- It also gives the count its meaning: `shown_count` is *how many distinct hours this
-- title has been on your wall*, which is much closer to "how bored are you of it" than
-- a render tally would be, and it cannot be inflated by leaving the app open.
--
-- ===========================================================================
-- 3. HOW THE PENALTY DECAYS, AND WHY NOTHING IS HIDDEN FOREVER
--
-- The reader returns rows inside a window -- `foryou.impression_window_hours`, seeded at
-- 72. Outside it an impression still exists but no longer counts, so a title shown three
-- times last week competes on score again this week. That is the founder's "very strong
-- candidates can eventually return", implemented as an expiry rather than as a decay
-- curve because an expiry is one number a person can reason about.
--
-- **A dismissal is not an impression and does not expire.** `recommendation_feedback`
-- kind `dismiss` is a veto and stays one; this is a preference over ordering. Two
-- mechanisms because they answer different questions, and collapsing them would make
-- "I have seen this a lot" eventually mean "never show me this", which nobody asked for.
--
-- ===========================================================================
-- 4. THE SOCIAL CANDIDATE SOURCE (§17)
--
-- The founder's concept: "somebody whose taste I trust loved this and I have not seen
-- it" is more bingd.-native than importing a critics' list. Approved as a *small*
-- addition if it costs no new architecture, and deferred if it would need N x M Match
-- queries or new caching.
--
-- So this is the cheap half of the idea and deliberately not the expensive one:
--
--   IN   -- titles bucketed `loved` by accounts the caller follows, weighted by how many
--          of them did, over `rankings` and `follows` which are both already indexed for
--          exactly this join.
--   OUT  -- Match weighting. Ordering candidates by the caller's Match to each endorser
--          is one `taste_match` per followee per call, and `taste_match` reads two whole
--          ranking catalogues. That is the N x M the founder said to defer, and it is
--          deferred with the reason on the roadmap rather than approximated.
--
-- **Why this is not the fabricated-social-proof failure `rank.ts` forbids.** That rule
-- exists because the client must never be given other users' rankings to score, and it
-- is not relaxed: the client receives media item ids and a count, never a person. The
-- aggregation happens here, where `can_view_profile` can be applied to every endorser,
-- and no name and no per-endorser fact leaves this function. The founder's §17 also says
-- to keep the reasoning internal for now, so the client attributes nothing socially --
-- these arrive as candidates and are scored by the same on-device rules as every other
-- candidate.
--
-- **`loved` and not a derived score.** `score_for` needs `band_bounds` per user per
-- category, which is the expensive shape; the bucket is the band, it is stored on the
-- row, and "they put it in their top band" is what the sentence meant anyway.
-- ===========================================================================

insert into app_config (key, value) values
  ('foryou.impression_window_hours', '72'::jsonb),
  ('foryou.impression_batch_max',    '60'::jsonb),
  ('foryou.impression_rows_per_day', '2000'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The writer
--
-- No operation ledger, and that is a departure worth defending. Every other writer in
-- this schema claims an operation id so a retry is a replay -- because every other
-- writer stores something a duplicate of which would be *wrong*. A duplicate impression
-- is not wrong, it is impossible: the primary key with an hour-truncated timestamp makes
-- the insert idempotent by shape, which is strictly stronger than a ledger entry and
-- costs no row. Adding a ledger claim here would mean one `processed_operations` row per
-- slate per user per app open, to protect against a duplicate the key already refuses.
--
-- The rate limit is therefore counted on the impressions themselves rather than through
-- `_assert_operation_rate`, which reads the ledger this function does not write.
-- ---------------------------------------------------------------------------

create or replace function note_recommendations_shown(p_media_item_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_max integer;
  v_day_max   integer;
  v_used      integer;
  v_hour      timestamptz := date_trunc('hour', now());
  v_written   integer;
begin
  perform assert_can_write();

  if p_media_item_ids is null or array_length(p_media_item_ids, 1) is null then
    return jsonb_build_object('status', 'ok', 'recorded', 0);
  end if;

  select coalesce((select (value)::integer from app_config where key = 'foryou.impression_batch_max'), 60)
    into v_batch_max;
  select coalesce((select (value)::integer from app_config where key = 'foryou.impression_rows_per_day'), 2000)
    into v_day_max;

  if array_length(p_media_item_ids, 1) > v_batch_max then
    raise exception 'too many titles in one impression batch'
      using errcode = '22023',
            hint = format('at most %s per call', v_batch_max);
  end if;

  -- ---------------------------------------------------------------------------
  -- A defensive ceiling rather than the primary bound; the hour truncation below is what
  -- actually keeps this small. Refuses loudly, because a client that has hit it is doing
  -- something the design did not anticipate and silence would hide it.
  --
  -- The ceiling, counted and enforced under one lock
  --
  -- **Serialised per caller**, the same way `_rank_finalize` serialises a user's
  -- category (20260813000700). Without it the count and the insert are two statements
  -- with a gap between them: two devices belonging to one account could each read 1,940,
  -- each admit sixty ids, and commit 2,060 rows between them. A ceiling two callers can
  -- walk through together is not a ceiling, and independent review was right to say the
  -- arithmetic fix alone did not make it one.
  --
  -- The lock is per user and held to the end of this transaction, which is one small
  -- insert. Contention is two devices belonging to the same person rendering a wall in
  -- the same instant; everybody else's calls are on different keys and never wait.
  perform pg_advisory_xact_lock(hashtextextended('foryou.impressions:' || auth.uid()::text, 0));

  select count(*) into v_used
    from recommendation_impressions
   where user_id = auth.uid()
     and shown_at > now() - interval '1 day';

  -- The whole batch, not just the current total. Checking `v_used >= v_day_max` alone
  -- refuses only once the ceiling is already reached, so a call arriving at 1,999 with
  -- sixty ids would be admitted and land on 2,059. Assuming every id is new is
  -- conservative — most will be duplicates the key drops — and over-refusing at two
  -- thousand distinct titles in a rolling day costs nothing real: that is not a number a
  -- person's wall produces.
  if v_used + array_length(p_media_item_ids, 1) > v_day_max then
    raise exception 'you have done that too many times today'
      using errcode = '53400',
            hint = format('recommendation impressions are limited to %s per day', v_day_max);
  end if;

  -- `distinct` because a slate should never contain a title twice and this must not be
  -- the place that discovers otherwise. The join to `media_items` drops an id that names
  -- nothing, rather than raising: this is a background fact, not an act, and failing a
  -- whole batch over one stale id would cost the rotation for every other title in it.
  with fresh as (
    select distinct m.id
      from unnest(p_media_item_ids) as ids(id)
      join media_items m on m.id = ids.id
  )
  insert into recommendation_impressions (user_id, media_item_id, shown_at)
  select auth.uid(), fresh.id, v_hour from fresh
  on conflict (user_id, media_item_id, shown_at) do nothing;

  get diagnostics v_written = row_count;
  return jsonb_build_object('status', 'ok', 'recorded', v_written);
end;
$$;

comment on function note_recommendations_shown(uuid[]) is
  'Records that these titles were on the caller''s For You wall, so the next slate can prefer what they have not seen (founder §15). shown_at is truncated to the hour, so the primary key collapses a render loop into one row per title per hour and the write is idempotent by shape rather than by an operation ledger. Never raises over an unknown id -- a background fact should not fail a batch -- but does raise over an oversized batch or a day''s worth of them. Not a dismissal: this changes ordering, dismissal is a veto (dismiss_for_you).';

-- ---------------------------------------------------------------------------
-- The reader
--
-- `recommendation_impressions` has RLS enabled and, deliberately, no read policy: its
-- own migration calls it "a server-side signal, not user content". That stays true -- the
-- client cannot select the table -- and this definer function is the one shape of it the
-- client is given: **the caller's own rows, aggregated, inside the window**. No
-- timestamps beyond the last one, and nothing about anybody else.
-- ---------------------------------------------------------------------------

create or replace function recommendation_exposure()
returns table (media_item_id uuid, shown_count integer, last_shown_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select i.media_item_id,
         count(*)::integer,
         max(i.shown_at)
    from recommendation_impressions i
   where auth.uid() is not null
     and i.user_id = auth.uid()
     and i.shown_at > now() - make_interval(
           hours => coalesce(
             (select (value)::integer from app_config where key = 'foryou.impression_window_hours'),
             72
           )
         )
   group by i.media_item_id;
$$;

comment on function recommendation_exposure() is
  'How often each title has been on the caller''s own For You wall inside foryou.impression_window_hours, for the client''s rotation penalty. Definer because recommendation_impressions is deliberately unreadable by clients; takes no arguments, so auth.uid() is the only perspective available. Rows outside the window are excluded rather than deleted, which is what makes a strong candidate return by itself instead of being suppressed forever.';

-- ---------------------------------------------------------------------------
-- The social candidate source
-- ---------------------------------------------------------------------------

create or replace function social_candidates(p_limit integer default 40)
returns table (media_item_id uuid, endorsements integer)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- The accounts whose top band the caller is entitled to read. `can_view_profile`
  -- rather than the follow alone, so a suspension or a block that raced the edge takes
  -- the endorsement with it.
  trusted as (
    select f.followee_id as who
      from follows f, me
     where me.id is not null
       and f.follower_id = me.id
       and f.state = 'approved'
       and can_view_profile(me.id, f.followee_id)
  )
  select r.media_item_id, count(*)::integer
    from rankings r
    join trusted on trusted.who = r.user_id
    cross join me
   where r.bucket = 'loved'
     -- Nothing the caller has already met, in any of the four senses. `user_media`
     -- covers watched and noted, `rankings` covers ranked, `watchlist` covers wanted,
     -- and a dismissal is a veto that outranks any number of endorsements.
     and not exists (select 1 from user_media um
                      where um.user_id = me.id and um.media_item_id = r.media_item_id)
     and not exists (select 1 from rankings mine
                      where mine.user_id = me.id and mine.media_item_id = r.media_item_id)
     and not exists (select 1 from watchlist w
                      where w.user_id = me.id and w.media_item_id = r.media_item_id)
     and not exists (select 1 from recommendation_feedback fb
                      where fb.user_id = me.id
                        and fb.media_item_id = r.media_item_id
                        and fb.kind = 'dismiss')
   group by r.media_item_id
   -- Most-endorsed first, then by id so two calls over the same graph agree. The client
   -- re-scores everything anyway; this ordering only decides what survives the limit.
   order by count(*) desc, r.media_item_id
   limit least(greatest(coalesce(p_limit, 40), 0), 100);
$$;

comment on function social_candidates(integer) is
  'Titles the caller''s approved followees put in their top band and the caller has not met -- not watched, not ranked, not on their watchlist, not dismissed. Founder §17, the cheap half: no Match weighting, because ordering by the caller''s Match to each endorser is one taste_match per followee and that is the N x M the founder deferred. Definer and argument-free as to viewer, so there is no third-party question to pose. Returns ids and a count and never a person: the client is given no name and composes no social sentence, which is what keeps rank.ts'' no-fabricated-social-proof rule intact while widening the pool.';

revoke execute on function note_recommendations_shown(uuid[]) from public, anon, authenticated;
revoke execute on function recommendation_exposure()          from public, anon, authenticated;
revoke execute on function social_candidates(integer)         from public, anon, authenticated;
grant  execute on function note_recommendations_shown(uuid[]) to authenticated;
grant  execute on function recommendation_exposure()          to authenticated;
grant  execute on function social_candidates(integer)         to authenticated;
