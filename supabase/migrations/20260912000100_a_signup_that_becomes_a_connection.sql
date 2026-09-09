-- A signup that becomes a connection.
-- Founder tranche 2026-09-08 (pre-distribution social activation) §§A7-A14.
--
-- ===========================================================================
-- THE PROBLEM THIS FILE IS ABOUT
--
-- Everything social in bingd. is worth more once a real graph exists -- the Feed, the
-- Following score, Taste Match, Sent to You, Group Picks -- and the graph has one
-- reliable seed: somebody hands a friend their personal invite link. Until now that act
-- produced *one* follow edge, invitee -> inviter, and left the inviter to go and find
-- the person they had just invited.
--
-- Three changes, and the third is the one with the privacy argument in it:
--
--   1. **A redeemed personal invite connects both parties.** The inviter now follows the
--      invitee as well, in the same transaction, idempotently.
--   2. **Following somebody is activity.** A new `follow_added` feed event, aggregated
--      per actor over a window, so a session spent following ten suggestions is one row
--      rather than ten.
--   3. **The people a follow event names are resolved per viewer**, through a definer
--      function, because who a follow was *of* is identity that not every reader of the
--      event is entitled to.
--
-- ===========================================================================
-- WHAT IS DELIBERATELY *NOT* HERE, AND WHY IT IS NOT A REGRESSION
--
-- **`people_mutuals` is untouched.** The founder's §A4 asks that Mutuals be allowed to
-- surface a private account the viewer may discover. `20260828000400` already did
-- exactly that -- `can_identify_profile` on the candidate, `can_view_profile` on the
-- intermediary -- so the requirement is already met and the correct change here is none.
-- Restating that function to prove it was read is how `_assert_operation_rate` lost its
-- advisory lock (20260817000200 records it), so it is read and left alone.
--
-- **The invitee's edge into a *private* inviter stays `pending`.** §A7 asks for a
-- fully-connected relationship on both sides "PROVIDED this does not violate an existing
-- privacy/security invariant", and here it would. The asymmetry is not an accident of
-- implementation, it is who is holding the phone:
--
--   inviter -> invitee   The **invitee is the caller.** Granting the inviter read access
--                        to the invitee's own content is the invitee's decision to make
--                        about their own account, and redeeming that specific person's
--                        personal link is them making it. So this edge is `approved`
--                        whatever the invitee's visibility setting says.
--
--   invitee -> inviter   The **inviter is not the caller** and has done nothing in this
--                        transaction. Auto-approving here would hand a brand-new account
--                        read access to a private account's collection, notes, goals and
--                        activity without that account acting -- which is precisely what
--                        `respond_follow_request` exists to require. Approval by anybody
--                        other than the target is the invariant, and it holds.
--
-- So a public inviter gets a mutual pair, and a private inviter gets `approved` outward
-- plus `pending` inward and keeps the `follow_request` row that carries Approve and
-- Decline (20260831000100 explains why that row may not be replaced). Nothing about
-- private semantics is weakened in either direction.
--
-- **A follow *request* posts no activity.** Only an approved edge does. A story saying
-- "Ada followed Bob" about a pending request would announce a relationship Bob has not
-- agreed to, in front of Ada's followers, and would disclose that somebody asked.
--
-- **An approval posts no activity either.** `respond_follow_request` turning pending into
-- approved is the private account's own act, days later, about a request the requester
-- has half forgotten; the two people who care are already told (`follow_approved`,
-- `friendship`). Announcing it in the requester's followers' feeds would be a story about
-- an act nobody just performed, and it would publish the approval decision of an account
-- that is private by choice.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The aggregation window
--
-- §A9 asks for "approximately 60 minutes" and to reuse a strongly established nearby
-- window if one exists. There is none: the Feed has no aggregation at all today, which
-- is why this file has to introduce the mechanism rather than borrow it. So 60 minutes,
-- as configuration rather than as a literal, because it is a tuning value on a surface
-- whose density the founder will want to move after watching real accounts use it.
--
-- Not `public.`-prefixed, so it stays server-side: the client never needs the number.
-- The reader below carries the same 60 as its fallback for a database that has lost the
-- row -- `config-defaults.test.mjs` exists because a `coalesce` over a query returning no
-- rows is never evaluated at all.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('feed.follow_aggregation_minutes', '60'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. An invite token knows what kind of invitation it is
--
-- §A7's forward-compatibility clause: mutual auto-follow is the semantics of *this*
-- relationship -- one person handing another their personal link -- and a future public
-- referral token must be able to redeem without connecting two strangers.
--
-- The gate has to be a property of the token rather than a rule buried in
-- `redeem_invite`, or the future type arrives as an `if` nobody can add without
-- re-reading the whole function. `kind` is that property, defaulted so every existing
-- row is what it has always been.
--
-- **`referral` is declared and has no writer.** `create_invite_link` still mints
-- `personal` and nothing in the schema can produce anything else. That is the doctrine
-- `lib/analytics.ts` uses for a deferred event: name the taxonomy on the day the decision
-- is made, so introducing the type later is a writer plus a product decision about its
-- social semantics, rather than a check constraint somebody has to notice.
-- ---------------------------------------------------------------------------

alter table invite_tokens add column if not exists kind text not null default 'personal';

alter table invite_tokens drop constraint if exists invite_tokens_known_kind;
alter table invite_tokens add constraint invite_tokens_known_kind
  check (kind in ('personal', 'referral'));

comment on column invite_tokens.kind is
  'What kind of invitation this token is. personal -- one person''s reusable link, the only kind create_invite_link mints -- redeems into a mutual connection (20260912000100). referral is declared and has no writer: a future public or campaign token whose redemption must NOT auto-connect two strangers, which is why the rule is a property of the token rather than a branch inside redeem_invite.';


-- ---------------------------------------------------------------------------
-- 3. `follow_added`, the activity type
--
-- Rebuilt from `20260829000200` §7. The list is restated in full because
-- `drop constraint` / `add constraint` replaces it whole, and a `check` rebuilt from the
-- wrong ancestor silently drops every type added since.
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
  'goal_completed',
  -- 20260912000100. One row per actor per window, whatever it holds -- see §5.
  'follow_added'
));


-- ---------------------------------------------------------------------------
-- 4. Who a follow event is about, in a table the client cannot read
--
-- The obvious shape is an array of ids in `feed_events.payload`, and it is wrong for a
-- reason that only shows up from the other side of the wire: `payload` is selected
-- straight through `feed_events_read`, so any reader of the event would hold the uuid of
-- every account the actor followed -- including accounts that have blocked them, accounts
-- that are suspended, and private accounts with no relationship to them at all. A uuid is
-- not a name, but it is a *handle*: it is the argument nearly every read in this schema
-- takes, and "an edge exists from somebody I can read into an account I cannot identify"
-- is exactly the disclosure §A10's last clause forbids.
--
-- So the membership lives in its own table with **row level security on and no policy at
-- all**, which is the shape `notifications` has had since `20260819000300`: unreadable to
-- clients, reachable through one definer function that applies the predicate a policy
-- cannot express. `feed_events.payload` stays `{}` for this type and carries no count
-- either -- the number a reader is shown is the number of people *they* may see, which is
-- per viewer and cannot be denormalised onto a shared row.
--
-- `on delete cascade` from `feed_events` so removing an event removes its membership, and
-- from `profiles` so a deleted account leaves no row naming it.
-- ---------------------------------------------------------------------------

create table if not exists feed_follow_targets (
  event_id    uuid not null references feed_events(id) on delete cascade,
  followed_id uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (event_id, followed_id)
);

comment on table feed_follow_targets is
  'Who a follow_added feed event is about. NOT client-readable -- RLS is on and there is deliberately no policy, the shape notifications has had since 20260819000300 -- because a uuid in a payload is a handle nearly every read in this schema accepts, and the existence of an edge into an account the reader may not identify is a disclosure. Read it through follow_activity_people(), which applies can_identify_profile per viewer. The primary key is what makes a follow, unfollow and re-follow inside one window stay one mention of one person.';

alter table feed_follow_targets enable row level security;

-- The grant as well as the policy, which is the shape `notifications` settled on
-- (`20260819000300`): Supabase's default privileges hand `select` on every new table to
-- `anon` and `authenticated`, so row security with no policy is the *second* lock rather
-- than the first. Both, because a policy added later by somebody who did not read this
-- header would otherwise be the only thing between a client and the table.
revoke select on feed_follow_targets from anon, authenticated;

-- The window probe in §5 is `(actor_id, causal_at desc)` narrowed to one type, which is
-- neither of the two indexes `feed_events` already has: `feed_events_actor` is on
-- `created_at`, and the aggregate has to be found by `causal_at` because that is the
-- column the Feed sorts and pages on. Partial, because follow rows are a small minority
-- of this table and an index that answers one question should only cover the rows it
-- answers for.
create index if not exists feed_events_follow_window
  on feed_events (actor_id, causal_at desc)
  where type = 'follow_added';

-- Reciprocal suppression (§A11) asks "is this person already the subject of an open
-- story", which reads the membership by its followed side.
create index if not exists feed_follow_targets_followed
  on feed_follow_targets (followed_id);


-- ---------------------------------------------------------------------------
-- 5. Posting follow activity: aggregation, and the suppression
--
-- §§A9, A11, A12, A13 and A14 are all one function, because they are all the same
-- decision: what does one *relationship* look like in a list read newest-first.
--
-- **Aggregation is one mutable row per actor per window** rather than N rows collapsed at
-- read time. The alternative -- a row per follow, grouped in the reader -- was rejected
-- because the reader is a keyset over `(causal_at, causal_step, id)` shared with the
-- profile activity page (`use-feed.ts`), and a group-by cannot be paged by a keyset over
-- its members. One row also *is* the frequency cap §A13 asks for: a session spent
-- following twenty suggestions cannot produce more than one row an hour, so no relevance
-- model is needed to stop follows crowding out watch activity.
--
-- **`causal_at` is set once and never bumped.** An appended follow does not move the row
-- back to the top of the Feed. That is deliberate, and it is the keyset: a row that
-- changed its sort position while somebody was paging past it is exactly the
-- duplicate-and-skip `useFeed` gave up `OFFSET` to avoid. Inside an hour the row is near
-- the top regardless.
--
-- **Reciprocal suppression (§A11) is per pair and window-bounded.** If B follows A back
-- while A's story about following B is still open, B's follow writes nothing. The edge is
-- created either way -- this is presentation and never follow state -- and the test is
-- the smallest reliable one: it asks the stored membership rather than inferring anything
-- from timestamps.
--
-- **The actor is a parameter and is not `auth.uid()`**, because §A14's one case has the
-- caller and the actor differ: an invitee redeems a link, and the story that propagates
-- them is the *inviter's*. Internal and revoked, so no client can post activity as
-- somebody else.
--
-- ===========================================================================
-- THE TWO LOCKS, AND THE PHANTOM THAT `FOR UPDATE` CANNOT STOP
--
-- The first draft of this function opened the aggregate with
--
--     select e.id into v_event from feed_events e where ... limit 1 for update;
--
-- and the concurrency suite failed it immediately, which is the whole reason that suite
-- exists. **`for update` locks the rows a query returned. It cannot lock a row that is not
-- there yet.** Two transactions that both find no open story both find nothing to lock,
-- and both insert one -- so §A13's frequency cap, which is "one row per actor per hour",
-- silently became a row per caller.
--
-- That is not a hypothetical, and it is not reachable from `follow` alone: `follow` takes
-- the caller's per-account rate-limit lock, so one account is already serialised against
-- itself. The case is `redeem_invite`, where the **actor is not the caller** -- two people
-- accepting the same personal link at the same moment are two transactions appending to
-- one inviter's story, with no lock between them anywhere.
--
-- So there are two, and both are taken before anything is read:
--
--   `_lock_pair(p_actor, p_target)`   The pair, ordered by uuid. Both current callers
--                                     already hold exactly this key, so it is a no-op for
--                                     them -- advisory locks are re-entrant within a
--                                     session. It is taken here anyway, because the
--                                     reciprocal check below reads the *other* account's
--                                     stories, and a suppression rule that depended on its
--                                     caller having locked the right thing would be a rule
--                                     the next caller breaks silently.
--
--   `follow_story:<actor>`            The actor's own key, which is what makes
--                                     select-then-insert atomic per actor. Same shape as
--                                     `_assert_operation_rate`'s per-account key and
--                                     `_lock_media`'s.
--
-- **Ordered pair, then actor, and never more than one of each** -- which is what makes the
-- pair deadlock-free. A transaction holding an actor key has already taken its pair key and
-- never asks for another, so there is no cycle for two transactions to complete.
--
-- `for update` is kept on the select as well. It is not what makes this correct, but it is
-- what stops a *future* second writer -- one that updates an existing story without taking
-- the actor key -- from interleaving with the append below.
-- ===========================================================================

create or replace function _post_follow_activity(p_actor uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval;
  v_event  uuid;
begin
  if p_actor is null or p_target is null or p_actor = p_target then
    return;
  end if;

  -- Ordered pair first, then the actor's own key. See the header: `for update` cannot lock
  -- a story that does not exist yet, and the actor is not always the caller.
  perform _lock_pair(p_actor, p_target);
  perform pg_advisory_xact_lock(hashtextextended('follow_story:' || p_actor::text, 0));

  select make_interval(mins => coalesce(
           (select (value)::integer from app_config
             where key = 'feed.follow_aggregation_minutes'),
           60))
    into v_window;

  -- §A11. The reverse story is still open and already says this relationship exists.
  if exists (
    select 1
      from feed_events e
      join feed_follow_targets ft on ft.event_id = e.id
     where e.type = 'follow_added'
       and e.actor_id = p_target
       and ft.followed_id = p_actor
       and e.causal_at > now() - v_window
  ) then
    return;
  end if;

  -- The actor's open story, if they have one. `for update` because the actor of a story
  -- is not always the caller: two people redeeming the same inviter's link at the same
  -- moment are two transactions appending to one row, and they must not each insert a
  -- second story for the same actor and window.
  select e.id
    into v_event
    from feed_events e
   where e.type = 'follow_added'
     and e.actor_id = p_actor
     and e.causal_at > now() - v_window
   order by e.causal_at desc
   limit 1
     for update;

  if v_event is null then
    -- `causal_step` 0: a follow is an act rather than a consequence of one, so it takes
    -- the base step a ranking takes (20260901000100).
    insert into feed_events (actor_id, type, payload, causal_at, causal_step)
    values (p_actor, 'follow_added', '{}'::jsonb, now(), 0)
    returning id into v_event;
  end if;

  -- Idempotent by the primary key, which is what keeps a follow, an unfollow and a
  -- re-follow inside one window to one mention of one person.
  insert into feed_follow_targets (event_id, followed_id)
  values (v_event, p_target)
  on conflict (event_id, followed_id) do nothing;
end;
$$;

comment on function _post_follow_activity(uuid, uuid) is
  'Records that one account followed another as Feed activity: one mutable feed_events row per actor per feed.follow_aggregation_minutes, with membership in feed_follow_targets. Suppresses a story that would only restate a relationship the reverse story already announced inside the same window (founder §A11) -- presentation, never follow state. causal_at is set once and never bumped, because the Feed is paged by a keyset over it. Takes two advisory locks before it reads anything -- the ordered pair, then follow_story:<actor> -- because for update cannot lock a story that does not exist yet, and because the actor is not always the caller: redeem_invite posts the *inviter''s* story from the invitee''s session, so two invitees accepting one link are two transactions appending to one row. Pair then actor, one of each, which is what makes them deadlock-free. Internal.';

revoke execute on function _post_follow_activity(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Reading a follow story, one viewer at a time
--
-- The counterpart to §4: the membership table has no policy, so this is the only way to
-- learn who a follow event is about, and it applies the predicate a policy could not.
--
-- **`can_identify_profile`, which is identity and not content** -- the same predicate
-- `followers_of`, `following_of` and `people_mutuals` name people with since
-- `20260828000400`. A private account the viewer may discover appears as itself and
-- nothing more, and the client draws the locked shell when the row is tapped. Blocks in
-- either direction and suspension remove the row, which is §A12's "never expose a
-- blocked or private-ineligible member merely because they were part of the raw
-- aggregate", enforced here rather than in the client that draws the sheet.
--
-- **The caller is excluded from their own follow story.** `can_identify_profile` admits
-- the caller by design -- you belong on your own friend's follower list -- and that is
-- the wrong answer here: this list is a list of people to discover and follow, and a row
-- for yourself in it is a control that cannot exist. Somebody who was followed already
-- has the `follow` notification that says so.
--
-- **The event's own gate is restated.** `security definer` bypasses `feed_events_read`,
-- so `can_view_profile(caller, actor)` is applied here in as many words -- otherwise
-- holding an event id would be enough to read the membership of a story belonging to a
-- private account the caller cannot see.
--
-- **A count is not returned, and that is the honest shape.** What the row says and what
-- the sheet lists are both derived from these rows, so "and 4 others" cannot promise
-- four people a viewer is not allowed to open.
-- ---------------------------------------------------------------------------

create or replace function follow_activity_people(
  p_event_ids uuid[],
  p_limit     integer default 25
)
returns table (
  event_id     uuid,
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  ordinal      integer
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- One page of the Feed holds twenty events and only a few of them can be follow rows,
  -- so the cap is a floor under a pathological argument rather than a real limit.
  events as (
    select e.id
      from feed_events e, me
     where me.id is not null
       and e.id = any (coalesce(p_event_ids, '{}'::uuid[]))
       and e.type = 'follow_added'
       and can_view_profile(me.id, e.actor_id)
     limit 50
  )
  select ev.id, x.user_id, x.username, x.display_name, x.avatar_path, x.visibility, x.ordinal
    from events ev
    cross join lateral (
      select p.id                                                     as user_id,
             p.username::text                                         as username,
             p.display_name,
             p.avatar_path,
             p.visibility,
             (row_number() over (order by ft.created_at, p.username))::integer as ordinal
        from feed_follow_targets ft
        join profiles p on p.id = ft.followed_id
        cross join me
       where ft.event_id = ev.id
         and p.id <> me.id
         and p.status = 'active'
         and can_identify_profile(me.id, p.id)
       order by ft.created_at, p.username
       limit least(greatest(coalesce(p_limit, 25), 1), 50)
    ) x;
$$;

comment on function follow_activity_people(uuid[], integer) is
  'The people one or more follow_added events are about, as far as the caller is allowed to know. The only read path into feed_follow_targets, which has no policy. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Two predicates: can_view_profile on the event''s actor, restated because definer bypasses feed_events_read; can_identify_profile on each named account, so a private account the caller may discover appears as identity only and a blocked or suspended one is absent (20260828000400). The caller is excluded from their own row -- this is a list of people to discover, and Follow on yourself is a control that cannot exist. Returns no total, so a Feed row cannot promise people the reader may not open. Ordered by when each follow joined the story, so the first name is stable.';

revoke execute on function follow_activity_people(uuid[], integer) from public, anon;
grant  execute on function follow_activity_people(uuid[], integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. `follow`, carried across verbatim with one line added
--
-- The only difference from `20260826000400` §7 is the `_post_follow_activity` call, and
-- it sits inside the `v_state = 'approved'` branch beside `_release_recommendations` --
-- deliberately, because those two are the same condition for the same reason: a pending
-- request has decided nothing, and neither the release nor the announcement may act on a
-- relationship the target has not agreed to.
--
-- Everything else -- the operation ledger, the per-hour rate limit, the pair lock, the
-- share lock on the followee's profile row, the never-downgrade rule, the inbox row and
-- what the function returns -- is unchanged and is repeated in full because
-- `create or replace` replaces the whole body.
--
-- **It is not called on the already-following path.** A tap that changed nothing is not
-- an event, and posting there would let a retry of a settled follow reopen a story that
-- had aged out of its window.
-- ---------------------------------------------------------------------------

create or replace function follow(p_operation_id uuid, p_followee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visibility profile_visibility;
  v_state      follow_state;
  v_existing   follow_state;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'follow') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Per hour, not per day (api.md §11). A mass-follow script is a burst.
  perform _assert_operation_rate('follow', 'follow.max_per_hour', 60, interval '1 hour');

  -- Before the reachability check, not after: the check is what reads `blocks`, and a
  -- block committing between the check and the insert is precisely the race.
  perform _lock_pair(auth.uid(), p_followee_id);

  -- The followee's own row, shared, so that a concurrent `set_profile_visibility` on
  -- that account either commits before this reads it or waits until after this has
  -- inserted (20260817000600).
  perform 1 from profiles where id = p_followee_id for share;

  v_visibility := _assert_reachable(p_followee_id);

  -- A public account is followed outright; a private one receives a request. This is
  -- the only place in the schema that decides which, and it decides it from the
  -- target's own setting rather than from anything the caller sends.
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  select f.state into v_existing
    from follows f
   where f.follower_id = auth.uid() and f.followee_id = p_followee_id;

  -- Already there. Return the state rather than raising, and never downgrade: if an
  -- approved follow exists and the account has since become private, re-following must
  -- not demote it to pending.
  if v_existing is not null then
    -- A follow that was already approved has already released whatever it was going to
    -- release and has already been announced, and this call changed nothing -- so there
    -- is nothing to do here. Stated rather than left implicit, because "the effects live
    -- on the insert path" is the sort of thing a later reader has to check.
    return jsonb_build_object('status', 'ok', 'state', v_existing);
  end if;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (auth.uid(), p_followee_id, v_state,
          case when v_state = 'approved' then now() end);

  -- PRD §15's inbox row. Two types, because they are two different things to be
  -- told: somebody followed you, or somebody is waiting on you.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (p_followee_id,
          case when v_state = 'approved' then 'follow' else 'follow_request' end,
          auth.uid(), 'profile', auth.uid());

  if v_state = 'approved' then
    -- 20260826000400. Following somebody is how a recipient says "their suggestions can
    -- come straight through", so everything they are already holding from that person is
    -- released now. Silent -- see `_release_recommendations`.
    perform _release_recommendations(p_followee_id, auth.uid());
    -- 20260912000100. And the Feed story, aggregated into whatever this account already
    -- has open. Approved only, for the reason stated at the top of the branch.
    perform _post_follow_activity(auth.uid(), p_followee_id);
  end if;

  return jsonb_build_object('status', 'ok', 'state', v_state);
end;
$$;

comment on function follow(uuid, uuid) is
  'Follows a public account outright and files a request against a private one. Refuses a missing, suspended or blocked target with the same P0002. Never downgrades an existing approved follow to pending. Takes a share lock on the followee''s profile row so a concurrent visibility change cannot leave a public account holding a pending request. On an approved follow it releases every recommendation that account was holding for the caller (20260826000400) and posts the aggregated Feed story (20260912000100), both inside the pair lock; a pending request does neither, because it has decided nothing. Rate-limited per hour.';


-- ---------------------------------------------------------------------------
-- 8. `redeem_invite`: the invitation becomes a connection
--
-- Carried across verbatim from `20260831000100` with three additions and no removals.
-- The operation ledger, the rate limit, the `for share` on the token, the pair lock,
-- every refusal branch, the attribution, `invited_by`, the invitee's `invite_welcome`,
-- the invitee's own follow and the inviter's `invite_joined` / `follow_request` are all
-- unchanged.
--
-- WHAT IS ADDED
--
--   1. **The reverse edge, inviter -> invitee, `approved`.** Gated on the token being
--      `personal` (§2). `on conflict do nothing`, so an inviter who already followed this
--      person keeps the one edge they had and nothing is downgraded -- the same rule
--      `follow` states for its own direction.
--   2. **One Feed story, with the inviter as its actor** (§A14). A redeemed invite creates
--      two directed edges and is *one* relationship event, so it gets one story -- and the
--      actor is the inviter because that is the direction that propagates the new account:
--      the Feed reads activity by actor, so a story authored by the inviter reaches the
--      people around the inviter, which is the exact case §A10 names. The invitee's own
--      edge posts nothing; a second story would be the duplication §A14 forbids, and it
--      would reach nobody anyway, a brand-new account having no followers.
--   3. **`connected` in the answer**, so the client can say whether the two accounts came
--      out of this mutually connected without inferring it from `follow_state`.
--
-- WHY IDEMPOTENCE IS NOT A NEW PROBLEM
--
-- Every addition sits inside the `invite_attributions` insert's `if not found` guard or is
-- an `on conflict do nothing` upsert, and the whole function is behind `_claim_operation`.
-- So a lost reply and a retry re-enter at `already_applied` and write nothing; a retry with
-- a fresh operation id reaches the attribution insert, finds the row, and returns
-- `already_attributed` before any of this. There is no timestamp heuristic anywhere.
--
-- WHY THE INVITER GETS NO SECOND NOTIFICATION
--
-- §A8. Two edges, one relationship, one row in each inbox: the invitee's `invite_welcome`
-- and the inviter's `invite_joined`. The reverse edge is written *without* the `follow`
-- notification `follow` would have filed, because the person it would tell is the invitee,
-- who is already reading "Suraj invited you" about the same fact. And the `Follow back`
-- affordance on `invite_joined` resolves from `follow_state_with` on the client, so it now
-- draws `Following` on its own -- there was never a stored CTA to remove.
-- ---------------------------------------------------------------------------

create or replace function redeem_invite(p_operation_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_self       uuid := auth.uid();
  v_token_id   uuid;
  v_inviter    uuid;
  v_kind       text;
  v_env        text;
  v_prior      uuid;
  v_visibility profile_visibility;
  v_state      follow_state;
  v_mutual     boolean := false;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'redeem_invite') then
    -- A replay answers with what the original produced, so a client whose reply was
    -- lost can retry and be told what actually happened rather than a status it has
    -- nothing to do with. The inviter is not named: on the refusal branches the
    -- original never established one.
    select ia.inviter_id into v_prior
      from invite_attributions ia where ia.invitee_id = v_self;

    return jsonb_build_object('status', 'already_applied', 'attributed', v_prior is not null);
  end if;

  perform _assert_operation_rate('redeem_invite', 'invite.max_redeem_attempts_per_day', 10);

  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  -- Unknown, revoked, and minted elsewhere are one answer. See 20260819000500.
  --
  -- `for share`, so a revocation cannot commit between this read and the insert below.
  -- `kind` comes along because it is what decides the reverse edge (§2).
  select t.id, t.owner_id, t.kind into v_token_id, v_inviter, v_kind
    from invite_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and t.env = v_env
     for share;

  if v_token_id is null then
    return jsonb_build_object('status', 'refused', 'reason', 'invalid');
  end if;

  if v_inviter = v_self then
    -- `no_self_invite` would catch this as a 23514, which is a constraint failure
    -- rather than an answer. Opening your own link is the ordinary way somebody
    -- checks what they just shared.
    return jsonb_build_object('status', 'refused', 'reason', 'self');
  end if;

  perform _lock_pair(v_self, v_inviter);

  -- `blocked_between` rather than a subquery on `blocks`: `blocks_read` hides a block
  -- from the person it was made against, so a direct read would return false for
  -- exactly the caller who must be refused.
  if blocked_between(v_self, v_inviter) then
    return jsonb_build_object('status', 'refused', 'reason', 'blocked');
  end if;

  -- A suspended inviter gains no attribution while suspended, and the invitee is not
  -- told which of the two it was: `unavailable` covers a deleted profile as well, in
  -- the window before the cascade lands.
  if not exists (select 1 from profiles p where p.id = v_inviter and p.status = 'active') then
    return jsonb_build_object('status', 'refused', 'reason', 'unavailable');
  end if;

  insert into invite_attributions (invitee_id, inviter_id, token_id, accepted_at)
  values (v_self, v_inviter, v_token_id, now())
  on conflict (invitee_id) do nothing;

  if not found then
    -- Already invited by somebody -- possibly by this same inviter, on another device
    -- or in a lost reply. Either way the row does not move. The existing inviter is
    -- deliberately not named: it may be an account this caller cannot see.
    return jsonb_build_object('status', 'refused', 'reason', 'already_attributed');
  end if;

  -- Growth provenance, which PRD §17 requires on every account from day one and which
  -- is impossible to reconstruct later. Guarded on null so it records the first
  -- attribution and is never rewritten.
  update profiles
     set invited_by = v_inviter
   where id = v_self and invited_by is null;

  -- The invitee's own welcome (20260823000100). Exactly once by position: every path
  -- that reaches this line has just created the `invite_attributions` row.
  --
  -- The actor is the inviter, so the row draws their avatar and name and routes to
  -- their profile. Blocks and suspension are handled downstream: `my_notifications`
  -- filters every actor through `can_discover_profile`, and `block` deletes the rows
  -- in both directions whatever their type.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_self, 'invite_welcome', v_inviter, 'profile', v_inviter);

  -- PRD §17 clauses 2 and 3. The state decision is `follow`'s own and is copied from
  -- it deliberately: 20260817000200 is the one place in the schema that decides
  -- public-or-private, and it decides from the target's own setting. A private inviter
  -- therefore still receives a *request* -- see this file's header for why that one
  -- cannot be auto-approved even though its counterpart can.
  select p.visibility into v_visibility from profiles p where p.id = v_inviter;
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
  on conflict (follower_id, followee_id) do nothing;

  if found then
    -- ---------------------------------------------------------------------------
    -- The inviter's row (20260831000100)
    -- ---------------------------------------------------------------------------
    --
    -- **Public inviter: `invite_joined`, in place of the `follow` this used to file.**
    -- "Ada Lovelace joined bingd. from your invite" is the true and useful statement
    -- about what just happened, and "started following you" was the incidental half of
    -- it. Filing both would be two rows for one act.
    --
    -- **Private inviter: `follow_request`, exactly as before.** That row carries Approve
    -- and Decline and is the only place in the app they exist.
    --
    -- Exactly once by position, like the welcome above, with
    -- `notifications_one_join_per_pair` as the backstop.
    --
    -- **It is not deleted when the invitee later unfollows.** `unfollow` clears `follow`
    -- and `follow_request` because those rows announce an edge that has stopped existing.
    -- `invite_joined` announces that somebody joined, which stays true. A block still
    -- removes it, in both directions and whatever its type.
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter,
            case when v_state = 'approved' then 'invite_joined' else 'follow_request' end,
            v_self, 'profile', v_self);
  else
    -- Already following, in whichever state. Report that state rather than the one
    -- this call would have created, so the client cannot tell somebody their request
    -- is pending when they were approved months ago.
    select f.state into v_state
      from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
  end if;

  -- ---------------------------------------------------------------------------
  -- 20260912000100. The reverse edge, and the one story
  -- ---------------------------------------------------------------------------
  --
  -- `approved` regardless of the *invitee's* visibility, and the header says why: the
  -- invitee is the caller, and this is their own account's access being granted to the
  -- person whose link they chose to use. `on conflict do nothing`, so an inviter who
  -- already followed them keeps their existing edge in whatever state it is in.
  --
  -- Only for a `personal` token. A future `referral` token redeems without connecting
  -- anybody, and the invitee's own edge above is unaffected by that distinction because
  -- following the account whose link you used is an act you performed.
  if v_kind = 'personal' then
    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_inviter, v_self, 'approved', now())
    on conflict (follower_id, followee_id) do nothing;

    -- One story for one relationship (§A14), authored by the inviter because that is the
    -- direction with an audience. Posted unconditionally rather than only when the insert
    -- was new: an inviter who already followed this person has still just had them join,
    -- and `_post_follow_activity` is idempotent per (event, person) by primary key.
    perform _post_follow_activity(v_inviter, v_self);

    -- Whether the pair came out of this mutually connected. False for a private inviter,
    -- whose side is a request until they answer it.
    v_mutual := exists (
      select 1 from follows f
       where f.follower_id = v_self and f.followee_id = v_inviter and f.state = 'approved'
    ) and exists (
      select 1 from follows f
       where f.follower_id = v_inviter and f.followee_id = v_self and f.state = 'approved'
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'inviter_id', v_inviter,
    'inviter_username', (select p.username::text from profiles p where p.id = v_inviter),
    'follow_state', v_state,
    -- New in 20260912000100. An older bundle ignores an unknown key, which is what makes
    -- this additive for the public build.
    'connected', v_mutual
  );
end;
$$;

comment on function redeem_invite(uuid, text) is
  'Redeems an invite token for the caller: attribution (once per account, for ever), invited_by, the invitee''s invite_welcome row, and PRD §17''s follow -- approved for a public inviter, a request for a private one. Since 20260912000100 a *personal* token also creates the reverse edge, inviter -> invitee, approved: the invitee is the caller, so granting the inviter access to the invitee''s own account is the invitee''s decision and redeeming that person''s link is them making it. The inviter''s edge into a private inviter is NOT auto-approved, because that approval belongs to the inviter alone. One Feed story is posted with the inviter as actor -- two edges, one relationship (§A14) -- and no extra notification. Answers with connected: whether both edges came out approved. The inviter is told once: invite_joined when the follow was approved (20260831000100), follow_request when it is pending, because that row is the only Approve and Decline in the app. Unknown, revoked and foreign-environment tokens are one refusal. Idempotent through the operation ledger; a replay reports whether an attribution exists without naming the inviter.';


-- ---------------------------------------------------------------------------
-- 9. Match is public-only, said out loud -- and it carries its evidence
--
-- §A5 is a privacy decision: a private account may be searched for intentionally and may
-- be discovered through Mutuals, but it must never be *algorithmically recommended to
-- strangers* because its taste happens to correlate.
--
-- **The rule already held, and that is exactly why it is being written down.** It held
-- emergently: `can_view_profile` on the candidate excludes a private account the caller
-- has not been approved by, and a private account that *has* approved them is excluded by
-- the `not exists` clause on the caller's own outgoing edge -- so the population was
-- already public-only, by the intersection of two conditions neither of which is about
-- visibility. An invariant that holds because two unrelated predicates happen to meet is
-- one line of tuning away from not holding, and the tuning is plausible: relaxing the
-- candidate gate to `can_identify_profile` is precisely what §A4 asked for on the other
-- list, in this same tranche.
--
-- So the predicate is stated. `p.visibility = 'public'` in `candidates`, where it also
-- keeps the expensive `taste_match` call from being made for a row that cannot be
-- returned. Everything else -- the `taste.min_common` overlap narrowing, the single
-- `taste_match` call per candidate, the no-score-no-row gate, the ordering, the caps -- is
-- `20260828000400`'s body unchanged, restated in full because `create or replace`
-- replaces the whole of it.
--
-- Note what is NOT added: no second similarity calculation, and no second minimum-data
-- number. `taste_match` refusing to score below `taste.min_common` remains the only gate
-- on precision, which is what keeps a suggestion and a profile from ever disagreeing.
--
-- ---------------------------------------------------------------------------
-- AND THE SHARED COUNT, WHICH IS THE OTHER HALF OF THE LEADERBOARD'S LINE
--
-- §A6 asks a People row to read `87% match · 14 shared`. The Leaderboard already draws
-- exactly that line, from `taste_match`'s own `common_count` (`20260827001000`, "a Match
-- that knows its evidence"), and People drew only the percentage because this function
-- never returned the count -- not because it did not have it. `taste_match` is already
-- being called per candidate, so the number is one column in a projection that is already
-- computed, and taking it from there rather than recounting is what keeps the two surfaces
-- from ever disagreeing about what "shared" means.
--
-- `drop function` first, because the return table changes and `create or replace` cannot
-- widen one. **A drop takes the function's grants with it** -- the trap `20260826000500`
-- §8 records -- so both are restated below. The change is additive over the wire: an
-- older bundle reading this RPC gets one key it does not look at, which is what keeps the
-- public App Store build working against a migrated database.
-- ---------------------------------------------------------------------------

drop function if exists people_taste_matches(integer);

create or replace function people_taste_matches(p_limit integer default 10)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility,
  match_score  integer,
  -- New in 20260912000100. `taste_match`'s own `common_count`, so `14 shared` on a People
  -- row and `14 shared` on the Leaderboard are the same number from the same call.
  shared_count integer
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
      from overlap o
      join profiles cp on cp.id = o.subject
      cross join me
      cross join threshold t
     where o.shared >= t.k
       -- 20260912000100, founder §A5. Match is algorithmic discovery by strangers, and a
       -- private account must not be recommended to one however well its taste
       -- correlates. Stated rather than left to emerge from the two predicates below.
       and cp.visibility = 'public'
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
  select c.subject, p.username::text, p.display_name, p.avatar_path, p.visibility,
         tm.score, tm.common_count
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
  'People whose rankings agree most with the caller''s, scored by taste_match itself rather than by a second algorithm -- so a suggestion and a profile can never show different numbers. Definer and takes no viewer (20260813001900). PUBLIC ACCOUNTS ONLY since 20260912000100 (founder §A5): Match is algorithmic discovery by strangers, and a private account is discoverable by name and through Mutuals but must never be recommended to somebody with no relationship to it. Returns taste_match''s own common_count since 20260912000100, so a People row and the Leaderboard quote the same shared total from the same call. Candidates are narrowed to accounts sharing at least taste.min_common exact titles, must pass can_view_profile and can_discover_profile, and exclude anyone the caller already follows or has asked to follow. A candidate with no score is not returned, so the screen never claims a precision the profile would refuse.';

revoke execute on function people_taste_matches(integer) from public, anon;
grant  execute on function people_taste_matches(integer) to authenticated;
