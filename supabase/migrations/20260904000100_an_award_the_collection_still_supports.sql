-- An award the collection still supports.
-- Founder tranche 2026-08-30: an award tier whose requirement is a fact about the
-- user's CURRENT collection is held only while the current collection still
-- satisfies it. Remove the titles and the tier goes, with its feed post and its
-- congratulations. Put them back and it is earned again, once, freshly.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
--
-- 20260828000100 wrote the rule this migration narrows: "an unlock is a
-- historical fact and is never revoked", the same irreversibility
-- `invite_attributions.activated_at` records. That rule is right for most of the
-- ladder and wrong for part of it, and the difference is not a matter of taste —
-- it is what the tier's own requirement *says*.
--
--   · **Watch 25 dramas** is a claim about a collection. Delete the dramas and
--     the claim is no longer true of anything; the badge is then asserting a
--     state the app itself can see is absent, on a screen that lists the very
--     titles it counted. The founder saw a Softie Hours tier survive the removal
--     of the titles that earned it, which is the report this answers.
--   · **You invited three people who joined** is a claim about events. Nothing
--     later makes it untrue. Neither does deleting a comment un-write it, nor
--     does somebody removing their reaction un-react it.
--
-- So the ladder is classified, in a table, by which of the two kinds of claim
-- each track makes — and the classification is not a list somebody typed here.
-- It is `AwardTrack.needs` from src/features/awards/tracks.ts, which already
-- names the fact each track counts, read across by the parity test the way the
-- thresholds already are. `needs` in ('watched', 'watchlist', 'rankings') is a
-- collection metric; the other five are histories.
--
-- **Mutual Mania is deliberately a history**, and it is the one that has to be
-- argued rather than derived. Its count *can* fall — an unfollow, a block — so
-- by the shape of the metric it looks reversible. It is not being made so. The
-- founder's decision is about the collection, and `needs = 'mutualFollows'`
-- is a claim about other people's standing relationships: revoking on it would
-- mean one person's unfollow silently deletes another person's badge, their feed
-- post and their notification, with no act of their own involved. That is a
-- different product decision and it is on the deferred roadmap, not in this
-- migration. The boundary is the table, and the table is checked.
--
-- ---------------------------------------------------------------------------
-- WHY THE REVOCATION TRIGGERS ARE DEFERRED, AND IT IS NOT A DETAIL
--
-- `rank_rebucket` and `rank_again` share `_rank_unrank_impl`: they DELETE the
-- `rankings` row and INSERT a new one in the same transaction. An immediate
-- AFTER DELETE trigger fires between those two statements, sees a count one below
-- the threshold, and revokes Rating Rascal — deleting the feed post — and the
-- insert that follows then re-earns it and posts again. Moving a title between
-- bands would announce an award the reader already had, every time.
--
-- `create constraint trigger ... deferrable initially deferred` moves the check to
-- COMMIT, where the transaction's FINAL state is the only state there is. A
-- rebucket revokes nothing because nothing was lost; a removal-then-re-add in one
-- transaction likewise. Unlocking stays immediate, which composes correctly with
-- this: an insert that restores the count finds the tier still on the ledger and
-- announces nothing.
--
-- Constraint triggers are FOR EACH ROW by definition, so a bulk delete queues one
-- event per row. Two guards keep that cheap: a deleted profile returns at once
-- (which is the whole of `delete_account`, whose cascade removes the profile
-- before these fire), and a user holding no collection-derived unlock returns
-- after a single index probe on `award_unlocks_user` without computing a metric.
--
-- ---------------------------------------------------------------------------
-- CONCURRENT REVOCATIONS, AND THE ONE WINDOW THAT IS STATED RATHER THAN CLOSED
--
-- Two removals landing together must revoke the tier once and leave nothing
-- behind — no orphan feed post, no orphan congratulations. `_award_lock` gives
-- that: each revocation takes the account's advisory lock before reading a metric,
-- inside VOLATILE plpgsql, which is what makes the lock worth taking at all. Under
-- READ COMMITTED a volatile function's statements each take a FRESH snapshot, so
-- the one that waited sees what it waited for. A `stable` function would have
-- re-read the caller's original snapshot and learned nothing from having waited.
--
-- **The lock is taken by the revocation and by nothing else, and it is taken at
-- COMMIT**, when the transaction's other locks are already held. That ordering is
-- what keeps it safe, and it is also why the unlock detector does NOT take it. An
-- earlier draft added it to `_maybe_award_unlocks`, which runs from AFTER-INSERT
-- triggers on `user_media` — so it was acquired before `_rank_finalize` reached
-- the band lock, and one account's award lock became a coarse write lock over
-- every collection write it makes. Two of this repo's own race suites caught it
-- immediately, blocking on the wrong key: `races/ranking.mjs`'s band-lock ordering
-- and `races/goal-completion.mjs`'s G1. A lock that hides the finer locks under it
-- is worse than the window it was closing.
--
-- **The window it was closing, stated plainly.** Two devices, one account, sitting
-- exactly on a threshold: A removes a title while B adds one. If B's insert trigger
-- runs its detector — finding the tier already on the ledger, and doing nothing —
-- and A then commits its revocation before B commits, A cannot see B's row and
-- revokes. The account ends with a supported count and no tier.
--
-- That is a MISSING unlock, not a stale one: nothing unsupported survives, nothing
-- is duplicated, and no announcement is left without an unlock behind it. It heals
-- on the account's very next collection write, which finds the tier absent and the
-- count sufficient and earns it again — one fresh post, one fresh congratulations,
-- which is exactly the re-earning contract. `races/award-revocation.mjs` pins the
-- invariants that hold in every interleaving and pins the convergence rather than
-- claiming a determinism that is not there.
--
-- ---------------------------------------------------------------------------
-- WHAT REVOKING TAKES WITH IT, AND THE ONE THING IT CANNOT
--
-- The tier's ledger row, its `award_earned` feed event and its `award_earned`
-- notification, keyed on (award, tier) exactly as the partial unique indexes that
-- guarantee one of each are. `push_outbox` keys to the notification with
-- `on delete cascade`, so a queued push that has not been claimed yet goes with
-- it; `feed_event_causes`, `reactions` and `comments` cascade from the feed event.
-- Deleting those two rows is also what makes re-earning possible at all — the
-- partial unique indexes are permanent, so an announcement that outlived its
-- unlock would refuse the next one in silence.
--
-- **A push already delivered to a phone cannot be retracted.** Apple and Google
-- have no such call, and this migration does not pretend otherwise: a reader who
-- was told about Sob Lord ten minutes ago and then deleted the titles keeps that
-- lock-screen line until they clear it. Everything the server owns is removed;
-- the notification centre is the operating system's.
--
-- ---------------------------------------------------------------------------
-- THE RECONCILIATION
--
-- Existing unsupported collection-derived unlocks are removed at the bottom of
-- this file, by the same rule and through the same set — the shape
-- 20260901000100 used for `comment-gremlin`. Only tiers whose metric is now below
-- their own threshold; supported tiers and every history track are untouched.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The classification, as a table with a key the ladder must reference
-- ---------------------------------------------------------------------------

create table award_tracks (
  award_key   text primary key,
  -- 'collection' — the metric counts what is in the user's collection right now
  --   (`user_media`, `watchlist`, `rankings`). Reversible: see the header.
  -- 'history'    — the metric counts acts that happened. Permanent.
  metric_kind text not null check (metric_kind in ('collection', 'history'))
);

alter table award_tracks enable row level security;
revoke all on award_tracks from public, anon, authenticated;

comment on table award_tracks is
  'Which kind of claim each award track makes: a collection metric, which is held only while the current collection satisfies it, or a history, which is permanent. Seeded from AwardTrack.needs in src/features/awards/tracks.ts and held to it by awards-server-parity.test.ts -- needs in (watched, watchlist, rankings) is collection, the other five are history. Not client-readable: the client has the source. Internal.';

insert into award_tracks (award_key, metric_kind) values
  -- needs: 'watched' — user_media
  ('movie-muncher',     'collection'),
  ('season-snacker',    'collection'),
  ('scream-snack',      'collection'),
  ('lol-mode',          'collection'),
  ('softie-hours',      'collection'),
  ('space-brain',       'collection'),
  ('boom-club',         'collection'),
  ('toon-bloom',        'collection'),
  ('truth-worm',        'collection'),
  ('passport-mode',     'collection'),
  ('time-hopper',       'collection'),
  ('genre-gremlin',     'collection'),
  ('two-screen-life',   'collection'),
  -- needs: 'watchlist'
  ('queue-dragon',      'collection'),
  -- needs: 'rankings'
  ('rating-rascal',     'collection'),
  -- needs: 'invitedSignups' — an activation is a historical fact (20260819000500)
  ('invite-instigator', 'history'),
  -- needs: 'written' — a retraction does not un-say that the person wrote
  ('comment-gremlin',   'history'),
  -- needs: 'recommendationsSent' — sending happened
  ('hype-courier',      'history'),
  -- needs: 'reactionsReceived' — other people's acts, and never the earner's
  ('heart-magnet',      'history'),
  -- needs: 'mutualFollows' — see the header for why this one is argued, not derived
  ('mutual-mania',      'history');

-- Every tier must belong to a classified track. This is the guard that matters:
-- a twenty-first track seeded into `award_tiers` without a row here fails the
-- migration rather than defaulting quietly to permanent.
alter table award_tiers
  add constraint award_tiers_track_fk
  foreign key (award_key) references award_tracks (award_key);


-- ---------------------------------------------------------------------------
-- 2. The lock both paths take before they count anything
-- ---------------------------------------------------------------------------

create or replace function _award_lock(p_user uuid)
returns void
language sql
set search_path = public
as $$
  -- Namespaced, so it cannot collide with `_rank_unrank_impl`'s lock on
  -- (user || category) or with `_lock_media`'s.
  select pg_advisory_xact_lock(hashtextextended('award:' || p_user::text, 0));
$$;

revoke execute on function _award_lock(uuid) from public, anon, authenticated;
comment on function _award_lock(uuid) is
  'Serialises one account''s award REVOCATIONS for the rest of the transaction, so two removals landing together cannot interleave their ledger, feed and notification deletes. Taken by _award_revoke_unsupported and by nothing else: the unlock detector deliberately does not take it, because it runs from AFTER-INSERT triggers and would then be acquired ahead of the ranking band lock -- see the migration header for the two race suites that caught exactly that. Internal.';


-- ---------------------------------------------------------------------------
-- 3. The revocation
-- ---------------------------------------------------------------------------

create or replace function _award_revoke_unsupported(p_user uuid, p_awards text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier record;
begin
  -- A cascade from a deleted account: the profile is already gone by the time a
  -- deferred trigger runs, and there is nobody to take a badge from.
  if p_user is null or not exists (select 1 from profiles where id = p_user) then
    return;
  end if;

  -- The cheap exit, and it is the common one. A reader who has never earned a
  -- collection-derived tier answers this with one index probe on
  -- `award_unlocks_user` and computes no metric at all -- which is what makes a
  -- per-row deferred trigger affordable on a bulk delete.
  if not exists (
    select 1
      from award_unlocks u
      join award_tracks t on t.award_key = u.award_key
     where u.user_id = p_user
       and u.award_key = any (p_awards)
       and t.metric_kind = 'collection'
  ) then
    return;
  end if;

  perform _award_lock(p_user);

  -- Highest tier first, so the log of what happened reads downward and so a
  -- reader watching the feed sees the top tier go before the one under it. Each
  -- tier is measured against ITS OWN threshold rather than against the lowest,
  -- because Two-Screen Life's metric is capped per tier -- a single count would
  -- be the wrong number for two of its three rows.
  for v_tier in
    select u.award_key, u.tier_key, t.threshold
      from award_unlocks u
      join award_tiers t on t.award_key = u.award_key and t.tier_key = u.tier_key
      join award_tracks k on k.award_key = u.award_key
     where u.user_id = p_user
       and u.award_key = any (p_awards)
       and k.metric_kind = 'collection'
     order by u.award_key, t.tier_index desc
  loop
    -- Read after the lock, inside a volatile function: a fresh snapshot per
    -- statement, so a transaction this one waited for is visible. See the header.
    continue when _award_metric(p_user, v_tier.award_key, v_tier.threshold) >= v_tier.threshold;

    -- The social post, where one was ever made. A tier that was backfilled by
    -- 20260828000100's rollout, or skipped past inside one crossing, carries
    -- `announced = false` and has no post; this deletes nothing for it.
    -- `feed_event_causes`, `reactions` and `comments` cascade from the event.
    delete from feed_events fe
     where fe.type = 'award_earned'
       and fe.actor_id = p_user
       and fe.payload ->> 'award' = v_tier.award_key
       and fe.payload ->> 'tier' = v_tier.tier_key;

    -- The congratulations, and with it -- through `push_outbox`'s cascade -- any
    -- queued push that has not been claimed. One already delivered to a phone is
    -- the operating system's and cannot be recalled.
    delete from notifications n
     where n.type = 'award_earned'
       and n.recipient_id = p_user
       and n.payload ->> 'award' = v_tier.award_key
       and n.payload ->> 'tier' = v_tier.tier_key;

    delete from award_unlocks u
     where u.user_id = p_user
       and u.award_key = v_tier.award_key
       and u.tier_key = v_tier.tier_key;
  end loop;
end;
$$;

revoke execute on function _award_revoke_unsupported(uuid, text[]) from public, anon, authenticated;
comment on function _award_revoke_unsupported(uuid, text[]) is
  'Removes every unlocked tier of the named COLLECTION-classified tracks whose metric is now below its own threshold, together with that tier''s feed post and congratulations -- and, by the push_outbox cascade, any push still queued for it. Lower tiers that remain satisfied are untouched, and history tracks are never considered whatever is passed. Called from deferred constraint triggers so it measures the transaction''s final state: a rebucket, or a removal and re-add in one transaction, revokes nothing. Directly callable by nobody. Internal.';


-- ---------------------------------------------------------------------------
-- 4. The revocation triggers — every write that can take a collection row away
--
-- Table-level, for the reason 20260828000100 gives for the insert triggers: the
-- writers are many and the tables are three. `unlog`, `remove_from_collection`,
-- `set_watchlist(false)`, the watchlist invariant of 20260815040000, `rank_unrank`
-- and the delete half of `rank_rebucket` and `rank_again` all reach these by
-- construction, and so does the next one somebody writes.
-- ---------------------------------------------------------------------------

create or replace function _award_untouch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The same thirteen tracks `_award_touch_user_media` counts up.
  perform _award_revoke_unsupported(old.user_id,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);
  return null;
end;
$$;

create or replace function _award_untouch_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _award_revoke_unsupported(old.user_id, array['queue-dragon']);
  return null;
end;
$$;

create or replace function _award_untouch_ranking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _award_revoke_unsupported(old.user_id, array['rating-rascal']);
  return null;
end;
$$;

revoke execute on function _award_untouch_user_media() from public, anon, authenticated;
revoke execute on function _award_untouch_watchlist()  from public, anon, authenticated;
revoke execute on function _award_untouch_ranking()    from public, anon, authenticated;

-- `deferrable initially deferred`, which is the whole point: see the header for
-- what an immediate trigger does to `rank_rebucket`.
create constraint trigger award_off_user_media
  after delete on user_media
  deferrable initially deferred
  for each row execute function _award_untouch_user_media();

create constraint trigger award_off_watchlist
  after delete on watchlist
  deferrable initially deferred
  for each row execute function _award_untouch_watchlist();

create constraint trigger award_off_ranking
  after delete on rankings
  deferrable initially deferred
  for each row execute function _award_untouch_ranking();


-- ---------------------------------------------------------------------------
-- 5. The reconciliation — 20260901000100's shape, over the collection tracks
--
-- Narrow, deterministic, and frozen into a temporary table first so the three
-- deletes cannot disagree about which tiers they are about. Only tiers whose
-- metric is below their own threshold; a supported tier and every history track
-- are untouched. A fresh database has no rows here and reconciles nothing.
-- ---------------------------------------------------------------------------

create temporary table _award_unsupported as
select u.user_id, u.award_key, u.tier_key
  from award_unlocks u
  join award_tiers t  on t.award_key = u.award_key and t.tier_key = u.tier_key
  join award_tracks k on k.award_key = u.award_key
 where k.metric_kind = 'collection'
   and _award_metric(u.user_id, u.award_key, t.threshold) < t.threshold;

delete from feed_events fe
 using _award_unsupported r
 where fe.type = 'award_earned'
   and fe.actor_id = r.user_id
   and fe.payload ->> 'award' = r.award_key
   and fe.payload ->> 'tier' = r.tier_key;

delete from notifications n
 using _award_unsupported r
 where n.type = 'award_earned'
   and n.recipient_id = r.user_id
   and n.payload ->> 'award' = r.award_key
   and n.payload ->> 'tier' = r.tier_key;

delete from award_unlocks u
 using _award_unsupported r
 where u.user_id = r.user_id
   and u.award_key = r.award_key
   and u.tier_key = r.tier_key;

drop table _award_unsupported;


-- ---------------------------------------------------------------------------
-- 6. The claim-to-send window (independent review 78, MAJOR)
-- ---------------------------------------------------------------------------
--
-- The revocation deletes the congratulations, and `push_outbox` cascades from it,
-- so a push still queued never leaves the server. Review 78 pointed out that
-- "still queued" is not the same as "not yet sent": `claim_push_batch` hands the
-- sender a payload and leases the row for five minutes, and the sender holds that
-- payload in memory while it builds messages and talks to Expo. A revocation
-- committing inside that window deletes a row the sender is no longer reading, and
-- the push goes out for a tier that no longer exists.
--
-- The header claimed an already-DELIVERED push was the only thing that could not
-- be stopped. That was wrong by one step: the sender re-asks, at the last moment
-- before it dispatches, which of its claimed jobs still have a queue row, and drops
-- the rest.
--
-- **The remaining window is stated exactly, because review 78b was right that the
-- first version of this note overstated the fix.** It is not "already in flight" —
-- it is everything after this answer comes back, which is the dispatch itself. A
-- database read and a network send cannot be made one atomic act, and no platform
-- offers a recall afterwards. What the check buys is that the window is the
-- milliseconds of dispatch rather than the whole of the sender's message building,
-- which is the difference between a race somebody could hit and one that needs the
-- send itself to be interrupted.
--
-- The sender **fails closed** on this call: if the database cannot answer, nothing
-- is sent and nothing is settled, the five-minute lease expires, and the batch is
-- claimed again. Sending is the direction that cannot be taken back.
--
-- Existence of the `push_outbox` row rather than of the notification, because the
-- outbox row is exactly what the revocation removes and exactly what "still
-- queued" means. A row reaped for repeated failure is also gone, and dropping that
-- job is right for the same reason.

create or replace function live_push_jobs(p_notification_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.notification_id
    from push_outbox o
   where o.notification_id = any (coalesce(p_notification_ids, '{}'::uuid[]));
$$;

revoke execute on function live_push_jobs(uuid[]) from public, anon, authenticated;
grant execute on function live_push_jobs(uuid[]) to service_role;

comment on function live_push_jobs(uuid[]) is
  'Which of the given claimed jobs still have a push_outbox row -- asked by push-sender immediately before dispatch, so a notification deleted between the claim and the send is not pushed. Added by 20260904000100 for award revocation (independent review 78), but it is not award-specific: any notification deleted inside the five-minute lease is caught by it. Takes ids the caller already holds and returns nothing it did not ask about, so it discloses nothing. service_role only.';


-- ---------------------------------------------------------------------------
-- 7. An award push that was never sent, found while testing section 6
-- ---------------------------------------------------------------------------
--
-- Writing the claim-to-send test above turned up something older and worse:
-- `claim_push_batch` has not sent an award congratulations since 20260830000100.
--
-- 20260828000100 added the escape that made actorless pushes possible at all --
-- `and (p.id is not null or n.actor_id is null)` -- and recorded why: the bare
-- `p.id is not null` had been doubling as an actorless filter by accident, and the
-- award congratulations is the first notification with no actor. The
-- 20260830000100 rebuild added a `mention` branch to the `feed_events` join two
-- lines above it and was assembled from an ancestor that predated the escape, so
-- it silently reverted that one predicate.
--
-- **The failure is invisible from the outside.** The notification is filed, the
-- outbox row is enqueued, `claim_push_batch` claims it, the filter drops it from
-- the returned batch, and the reap at the bottom of the function then deletes the
-- unreturned row. So it never retried, never sent, and left nothing behind to
-- notice: no failure count, no `last_error`, no queue backlog.
--
-- This is exactly the trap 20260828000100's own header names -- a
-- `create or replace` assembled from the wrong ancestor, invisible in a diff --
-- and the same one that cost `add_comment` its pair lock on PR #48.
--
-- Rebuilt from 20260830000100 verbatim, with that one predicate restored and
-- nothing else touched. `supabase/tests/push.test.mjs` now pins it, so a future
-- rebuild that drops it again fails rather than shipping.
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
        'feed_event_id',   j.feed_event_id,
        'comment_excerpt', j.comment_excerpt,
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
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
           ) end                                   as comment_excerpt,
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
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            -- The same three rules `my_notifications` states, in the same words, from
            -- the recipient's side -- including the read-time `can_view_profile` on a
            -- mention's activity owner, so a title whose owner has since blocked the
            -- recipient or gone private is not pushed to their lock screen.
            and case
                  when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                  when n.type = 'mention' then can_view_profile(n.recipient_id, fe.actor_id)
                  else fe.actor_id = n.recipient_id
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
       -- **Restored 2026-08-30 (20260904000100).** An actorless notification has nobody
       -- to have gone, and this predicate was the actorless filter by accident until
       -- 20260828000100 wrote the escape. The 20260830000100 rebuild -- which added the
       -- mention join two lines up -- was assembled from an ancestor that predated that
       -- escape and dropped it again, silently: an award congratulations was claimed,
       -- filtered out here, and its outbox row deleted by the reap below, so it never
       -- retried and never sent. Exactly the failure 20260828000100 warns a
       -- create-or-replace can make invisible in a diff.
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
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives -- a predicate 20260830000100 dropped by accident and 20260904000100 restored, with a test behind it. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, award_name since 20260828000100, and the mention branch since 20260830000100. A job it returns may still be dropped before dispatch by live_push_jobs (20260904000100).';
