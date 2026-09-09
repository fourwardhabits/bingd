-- An invitation is a connection on both sides.
-- Founder tranche 2026-09-08, corrective. Sits on top of `20260912000100`.
--
-- ===========================================================================
-- WHY THIS FILE EXISTS AND `20260912000100` WAS NOT EDITED
--
-- `20260912000100` has already been executed against staging -- 29 statements, recorded
-- in `supabase_migrations.schema_migrations` on 2026-09-08 -- and a migration that has run
-- somewhere is history. Editing it would leave a file in the repository that no database
-- ever ran, a history row describing statements that no longer exist, and a production
-- apply taking a path staging never rehearsed. The rehearsal is the only thing that makes
-- a production migration safe, so the rehearsed file is immutable and every correction
-- arrives as a new one.
--
-- So `20260912000100` is the tranche as it was first written and first run, and this file
-- is everything learned afterwards. Two sources, and the second is the larger:
--
--   1. **Independent review of the tranche**, which found three defects: an unbounded
--      story membership; a reader that presented one page as a whole set while sorting
--      that unbounded membership to produce it; and a redemption that left a pending
--      reverse edge exactly where it was.
--
--   2. **A founder decision that supersedes §A7's asymmetry**, taken after reading the
--      first implementation. It is a product decision about what a personal invitation
--      *means*, so it is stated in full below rather than folded in among the fixes.
--
-- ===========================================================================
-- THE FOUNDER DECISION: A PERSONAL INVITATION IS BILATERAL CONSENT
--
-- `20260912000100` connected the two parties asymmetrically. The inviter -> invitee edge
-- was approved whatever the invitee's visibility said, because the invitee is the caller
-- and it is their own account's access they are granting. The invitee -> inviter edge was
-- approved for a public inviter and left a **request** for a private one, on the argument
-- that the inviter is not the caller and that approval by anybody other than the target is
-- the invariant `respond_follow_request` exists to enforce.
--
-- The founder's reading, which supersedes it: **the inviter did act.** They minted a
-- personal link and handed it to somebody. That is the same decision an Approve is, taken
-- earlier and about the same person; asking for it again when the invitee walks through
-- the door is the product asking twice for something it has already been given. Both
-- directions therefore end `approved` for a valid personal token, in all four combinations
-- of the two accounts' visibility:
--
--   public  inviter + public  invitee    approved / approved
--   private inviter + public  invitee    approved / approved
--   public  inviter + private invitee    approved / approved
--   private inviter + private invitee    approved / approved
--
-- **What this widens, said plainly rather than left for somebody to find.** A personal
-- token is reusable and `invite_attributions` is keyed on the invitee, so one link can be
-- redeemed by many people. Before this file, a link that leaked out of the conversation it
-- was sent in produced a *request* into a private inviter and the inviter decided. After
-- it, whoever holds the link becomes an approved follower of that private account on
-- redemption. The controls that remain are the ones that already exist and are the right
-- ones: `revoke_invite_link` ends a link that has travelled further than it was meant to,
-- `unfollow` and `block` end a relationship, and `invite_joined` names every person who
-- used it as they use it. This is a deliberate trade of a leaked-link edge case against the
-- activation of every invitation that goes where it was sent.
--
-- **Nothing else about privacy moves.** A block in either direction still refuses the whole
-- redemption, a suspended inviter still refuses it, the caller's own suspension still
-- refuses it at `assert_can_write`, the token must still be live and minted in this
-- environment, and `follow_activity_people` still resolves every named account through
-- `can_identify_profile`. What changed is one state, for one token kind, on a path both
-- parties deliberately walked.
--
-- **A referral token keeps the old semantics exactly.** `referral` is declared in
-- `20260912000100` §2 and has no writer; the branch below preserves `20260817000200`'s
-- public-or-private decision for the invitee's own edge and creates no reverse edge and no
-- story, so a future campaign link cannot inherit a rule written for a link one friend
-- hands another. That separation is the point of the `kind` column, and it is asserted in
-- `follow-activity.test.mjs` rather than assumed.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. How many people one story will ever name
--
-- **A bound on the membership, and it is what makes the read cheap and the sentence honest
-- at the same time.** Review found the two halves separately: the reader presents one page
-- of members as the whole story, and the reader sorts an unbounded membership to return a
-- handful of rows.
--
-- Both are the same missing number. `follow.max_per_hour` bounds one account's own follows
-- at 60, but `redeem_invite` posts the *inviter's* story from the invitee's session -- so a
-- link shared into a large group chat appends one member per redemption with no per-actor
-- ceiling anywhere. A story naming five thousand people is not a story anybody reads; it is
-- a scan on every feed page that happens to include it.
--
-- So the membership stops at fifty. Past that the story exists, says fifty names' worth,
-- and takes no more -- which is §A13's "a social onboarding session cannot flood the Feed"
-- applied to the row rather than to the list. The consequences are stated rather than
-- discovered:
--
--   * the reader's page is never truncated, because the whole membership fits in one -- so
--     "and 49 others" is the truth about what this viewer may see, and the sheet needs no
--     "showing the first N" line;
--   * the sort inside `follow_activity_people` is over at most fifty rows per event, which
--     is why it needs no index beyond the membership's own primary key;
--   * a fifty-first follow inside the same window is simply not in the story. It is still a
--     follow, it is still in the graph, and the next window opens a new story.
--
-- Configuration rather than a literal, for `feed.follow_aggregation_minutes`' reason: it is
-- a density decision the founder will want to move after watching real accounts.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('feed.follow_story_max_people', '50'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. The story stops at the ceiling
--
-- `create or replace`, so `20260912000100` §5's whole body is restated with the count
-- added. The locking is unchanged and is the part that must not drift: the ordered pair,
-- then `follow_story:<actor>`, both taken before anything is read, because `for update`
-- cannot lock a story that does not exist yet and the actor is not always the caller.
-- ---------------------------------------------------------------------------

create or replace function _post_follow_activity(p_actor uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval;
  v_event  uuid;
  v_cap    integer;
  v_held   integer;
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
  else
    -- §1. A full story takes no more. Counted rather than assumed, and only on the append
    -- path -- a story this call just created holds nothing.
    --
    -- The count is safe inside the actor lock: nobody else can be adding to this actor's
    -- open story, so it cannot be stale by the time the insert below runs.
    select coalesce(
             (select (value)::integer from app_config where key = 'feed.follow_story_max_people'),
             50)
      into v_cap;

    select count(*) into v_held from feed_follow_targets ft where ft.event_id = v_event;

    -- The membership test comes first, on a re-follow's behalf: a person already in the
    -- story is already counted, so the insert below is a no-op and the ceiling does not
    -- apply to them. Without it a full story would silently drop a name it already holds.
    if v_held >= v_cap and not exists (
      select 1 from feed_follow_targets ft
       where ft.event_id = v_event and ft.followed_id = p_target
    ) then
      return;
    end if;
  end if;

  -- Idempotent by the primary key, which is what keeps a follow, an unfollow and a
  -- re-follow inside one window to one mention of one person.
  insert into feed_follow_targets (event_id, followed_id)
  values (v_event, p_target)
  on conflict (event_id, followed_id) do nothing;
end;
$$;

comment on function _post_follow_activity(uuid, uuid) is
  'Records that one account followed another as Feed activity: one mutable feed_events row per actor per feed.follow_aggregation_minutes, with membership in feed_follow_targets, bounded at feed.follow_story_max_people so the reader never has to page one story and the sort inside follow_activity_people is over a handful of rows. Suppresses a story that would only restate a relationship the reverse story already announced inside the same window (founder §A11) -- presentation, never follow state. causal_at is set once and never bumped, because the Feed is paged by a keyset over it. Takes two advisory locks before it reads anything -- the ordered pair, then follow_story:<actor> -- because for update cannot lock a story that does not exist yet, and because the actor is not always the caller: redeem_invite posts the *inviter''s* story from the invitee''s session, so two invitees accepting one link are two transactions appending to one row. Pair then actor, one of each, which is what makes them deadlock-free. Internal.';

revoke execute on function _post_follow_activity(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The reader answers with the whole story, and stops numbering it
--
-- Two corrections, and they are one correction.
--
-- **No `ordinal`.** The first version numbered the filtered rows with `row_number()` before
-- applying the limit, which the client never read and which made the function sort the
-- entire membership of every event on every feed page. §1's bound is what makes the plain
-- `order by ... limit` cheap: the lateral is an index scan over one event's rows and there
-- are at most fifty of them, so it needs no index beyond `feed_follow_targets`' own primary
-- key.
--
-- **`p_limit` defaults to fifty, which is the ceiling.** There is no second page, and that
-- is a property of §1 rather than an omission: a caller asking for that many receives the
-- whole story, so the count the client draws is the truth about what this viewer may see.
-- The default is deliberately the same number, so a caller that omits the argument gets the
-- whole story too rather than a page it would present as one. `use-feed.ts` passes it
-- explicitly anyway, because a client that depends on a server default is a client that
-- breaks silently when the default moves.
--
-- **Dropped and recreated, because the return type changed.** `create or replace` cannot
-- remove a column from a `returns table`, so the function goes and comes back -- and a
-- dropped function keeps neither its comment nor its grants, which is why both are
-- restated below (`20260827000200` and `20260830000100` do the same for `my_notifications`).
--
-- The drop is safe with respect to every deployed client, and that is checked rather than
-- assumed: `follow_activity_people` was created by `20260912000100`, which is on staging
-- only. Production is at `20260907000100`, so the function does not exist there at all, and
-- no released build -- iOS 7, Android build 8 -- can call something no database it talks to
-- has ever had. The only caller in the repository is `src/features/feed/use-feed.ts`, which
-- ships in the same unreleased tranche and stopped reading `ordinal` in the same review.
-- ---------------------------------------------------------------------------

drop function if exists follow_activity_people(uuid[], integer);

create function follow_activity_people(
  p_event_ids uuid[],
  p_limit     integer default 50
)
returns table (
  event_id     uuid,
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
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
  select ev.id, x.user_id, x.username, x.display_name, x.avatar_path, x.visibility
    from events ev
    cross join lateral (
      select p.id             as user_id,
             p.username::text as username,
             p.display_name,
             p.avatar_path,
             p.visibility
        from feed_follow_targets ft
        join profiles p on p.id = ft.followed_id
        cross join me
       where ft.event_id = ev.id
         and p.id <> me.id
         and p.status = 'active'
         and can_identify_profile(me.id, p.id)
       -- When each follow joined the story, so the name in the sentence's emphasised slot
       -- is the same one across refetches. The handle breaks a tie two appends in the same
       -- microsecond could produce.
       order by ft.created_at, p.username
       limit least(greatest(coalesce(p_limit, 50), 1), 50)
    ) x;
$$;

comment on function follow_activity_people(uuid[], integer) is
  'The people one or more follow_added events are about, as far as the caller is allowed to know. The only read path into feed_follow_targets, which has no policy. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Two predicates: can_view_profile on the event''s actor, restated because definer bypasses feed_events_read; can_identify_profile on each named account, so a private account the caller may discover appears as identity only and a blocked or suspended one is absent (20260828000400). The caller is excluded from their own row -- this is a list of people to discover, and Follow on yourself is a control that cannot exist. Returns no total: a story''s membership is bounded at feed.follow_story_max_people, so asking for that many IS the whole story, and the count the client draws is the truth about what this viewer may see rather than a page presented as one. Ordered by when each follow joined the story, so the first name is stable.';

revoke execute on function follow_activity_people(uuid[], integer) from public, anon;
grant  execute on function follow_activity_people(uuid[], integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. A redemption that finishes the relationship
--
-- `create or replace`, so `20260912000100` §8's whole body is restated. Everything before
-- the two edges is unchanged and is repeated because a replace replaces all of it: the
-- operation ledger, the daily rate limit, the environment-scoped token read under
-- `for share`, self, the pair lock, the block check, the suspended-inviter check, the
-- attribution, `invited_by`, and the invitee's `invite_welcome`.
--
-- What changed, and each of the four is a separate decision:
--
--   **(a) Both edges end approved for a personal token.** The founder decision in the
--   header. `v_state` is no longer read from the inviter's visibility on this path, so a
--   private inviter and a public one produce the same pair.
--
--   **(b) A pending edge is upgraded rather than left alone**, in *either* direction. This
--   is the review correction, and `on conflict do nothing` looked conservative and was not:
--   a private invitee whose inviter had already asked to follow them came out of a
--   redemption still holding a request, with `connected` false, an Approve button in their
--   inbox for a decision they had just made by another door, and a Feed story announcing a
--   relationship one edge of which was pending. `where follows.state = 'pending'` on the
--   update, so an already-approved edge is untouched and keeps the `approved_at` it was
--   actually granted at -- the never-downgrade rule `follow` states, in the one direction
--   it could be broken here.
--
--   **(c) The requests this answers are cleared, and nothing new is filed beside them.**
--   `respond_follow_request` deletes exactly these rows when it approves. Leaving one
--   behind would put an Approve control in somebody's inbox for a decision already made,
--   which raises P0002 when pressed -- a dead button on the row that introduces the two
--   accounts. Deleted in both directions and unconditionally: `delete` over a pair with no
--   such row is a no-op, and guarding it on the upgrade would be a second place for the two
--   to disagree.
--
--   The **invitee** is told once and only by `invite_welcome`. `respond_follow_request`
--   would file them a `follow_approved` for the edge upgraded above; the person it would
--   tell is already reading "Suraj invited you" in this same transaction about this same
--   pair, and two rows for one relationship is the redundancy PRD §15 exists to prevent.
--   The `friendship` record that function also writes belongs to somebody who pressed
--   Approve in their inbox, and nobody did.
--
--   The **inviter** is told once as well, and which row it is depends on which edge moved:
--   `invite_joined` whenever their invitee's own edge was created or upgraded, which is the
--   condition `20260831000100` has always used and covers every ordinary redemption;
--   `follow_approved` in the one case that condition cannot reach -- the invitee already
--   followed them, so there is no join to announce, and it is the *inviter's* request into
--   a private invitee that this redemption approved. Never both, and never neither.
--
--   **(d) Held recommendations are released in both directions** (20260826000400). An
--   approval delivers what the *other* party was holding for the person now allowed to see
--   it, and this redemption is two approvals. For the ordinary brand-new invitee both calls
--   are no-ops; the case they exist for is two accounts that already knew each other and had
--   a request open. Silent, like every other caller of it.
--
-- `invite_joined` is filed at a position reachable once per account -- the `invite_attributions`
-- row above was genuinely new, and `invitee_id` is that table's primary key -- with
-- `notifications_one_join_per_pair` as the backstop (20260831000100).
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
  v_notify     text;
  v_before_out follow_state;
  v_before_in  follow_state;
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
  -- `kind` comes along because it is what decides the reverse edge (20260912000100 §2).
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

  if v_kind = 'personal' then
    -- ---------------------------------------------------------------------------
    -- (a) and (b). Two edges, both approved, neither downgraded
    -- ---------------------------------------------------------------------------
    v_state := 'approved';

    -- What the pair looked like before this call, read under the pair lock taken above so
    -- nothing can move between here and the inserts. Read rather than inferred from
    -- `found`, which cannot tell an edge that was created from one that was upgraded --
    -- and the difference decides which row the inviter is sent.
    select f.state into v_before_out
      from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
    select f.state into v_before_in
      from follows f where f.follower_id = v_inviter and f.followee_id = v_self;

    -- The invitee's own edge into the inviter. Approved whatever the *inviter's*
    -- visibility says: minting a personal link and handing it to this person is the
    -- inviter acting, which is the founder decision this file carries.
    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_self, v_inviter, 'approved', now())
    on conflict (follower_id, followee_id) do update
       set state       = 'approved',
           approved_at = coalesce(follows.approved_at, now())
     where follows.state = 'pending';

    -- The inviter's edge into the invitee. Approved whatever the *invitee's* visibility
    -- says, which was already true in 20260912000100: the invitee is the caller, and
    -- this is their own account's access they are granting.
    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_inviter, v_self, 'approved', now())
    on conflict (follower_id, followee_id) do update
       set state       = 'approved',
           approved_at = coalesce(follows.approved_at, now())
     where follows.state = 'pending';

    -- (c). Whichever of the two requests existed has just been answered, so it must stop
    -- asking. Both directions, because either could have been open before the redemption.
    delete from notifications
     where type = 'follow_request'
       and ( (recipient_id = v_inviter and actor_id = v_self)
          or (recipient_id = v_self    and actor_id = v_inviter) );

    -- (d). What each approval releases, in the direction that approval runs.
    -- `_release_recommendations(sender, recipient)`: the followee is the sender, because
    -- approving a follower is deciding to let them see what was being held for them.
    perform _release_recommendations(v_inviter, v_self);
    perform _release_recommendations(v_self, v_inviter);

    if v_before_out is null or v_before_out = 'pending' then
      -- The join row, on the same condition `20260831000100` has always used: the
      -- invitee's own edge was created or upgraded by this call. An invitee who already
      -- followed their inviter told them so at the time, with `follow`, and a join row
      -- beside it would be the second notice about one relationship that PRD §15 forbids.
      v_notify := 'invite_joined';
    elsif v_before_in = 'pending' then
      -- The narrow case the line above cannot reach, and it must not be silent: the
      -- invitee already followed the inviter, and the *inviter* had an open request into
      -- a private invitee which this redemption just approved. `respond_follow_request`
      -- tells a requester their request landed, and with no `invite_joined` to carry the
      -- news there is nothing redundant about saying it here. Same shape as that
      -- function's own row: the approver is the actor, and their profile is the subject.
      v_notify := 'follow_approved';
    end if;
  else
    -- ---------------------------------------------------------------------------
    -- A referral token, and 20260912000100's semantics are carried across unchanged
    -- ---------------------------------------------------------------------------
    --
    -- PRD §17 clauses 2 and 3. The state decision is `follow`'s own and is copied from
    -- it deliberately: 20260817000200 is the one place in the schema that decides
    -- public-or-private, and it decides from the target's own setting. There is no
    -- reverse edge, no request is cleared, nothing is released and no story is posted --
    -- a public campaign link must be able to redeem without connecting two strangers.
    select p.visibility into v_visibility from profiles p where p.id = v_inviter;
    v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

    insert into follows (follower_id, followee_id, state, approved_at)
    values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
    on conflict (follower_id, followee_id) do nothing;

    if found then
      v_notify := case when v_state = 'approved' then 'invite_joined' else 'follow_request' end;
    else
      -- Already following, in whichever state. Report that state rather than the one
      -- this call would have created, so the client cannot tell somebody their request
      -- is pending when they were approved months ago.
      select f.state into v_state
        from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- The inviter's row (20260831000100)
  -- ---------------------------------------------------------------------------
  --
  -- **`invite_joined`, in place of the `follow` this used to file.** "Ada Lovelace joined
  -- bingd. from your invite" is the true and useful statement about what just happened,
  -- and "started following you" was the incidental half of it. Filing both would be two
  -- rows for one act, and so would filing `follow_approved` beside it.
  --
  -- **`follow_request` survives on the referral path only**, where an edge into a private
  -- inviter is still a request. That row carries Approve and Decline and is the only place
  -- in the app they exist.
  --
  -- **It is not deleted when the invitee later unfollows.** `unfollow` clears `follow` and
  -- `follow_request` because those rows announce an edge that has stopped existing.
  -- `invite_joined` announces that somebody joined, which stays true. A block still removes
  -- it, in both directions and whatever its type.
  if v_notify is not null then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter, v_notify, v_self, 'profile', v_self);
  end if;

  if v_kind = 'personal' then
    -- One story for one relationship (§A14), authored by the inviter because that is the
    -- direction with an audience. Posted unconditionally rather than only when the insert
    -- was new: an inviter who already followed this person has still just had them join,
    -- and `_post_follow_activity` is idempotent per (event, person) by primary key.
    perform _post_follow_activity(v_inviter, v_self);

    -- Whether the pair came out of this mutually connected. Read back rather than assumed
    -- true: it is the one assertion in this function that would notice if either insert
    -- above stopped doing what it says.
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
  'Redeems an invite token for the caller: attribution (once per account, for ever), invited_by, the invitee''s invite_welcome row, and PRD §17''s follow. Since 20260912000200 a valid *personal* token ends with BOTH directed edges approved, in all four combinations of the two accounts'' visibility: minting a personal link and handing it to somebody is the inviter acting, which is the same decision an Approve is, and redeeming that person''s link is the invitee making theirs. An edge that was already pending in either direction is upgraded rather than left, the follow_request it answered is cleared in both directions, and held recommendations are released both ways -- the approval semantics respond_follow_request applies, applied here because this is an approval. An already-approved edge keeps the approved_at it was granted at. Each party is told exactly once: the invitee by invite_welcome, and the inviter by invite_joined when their invitee''s own edge moved, or by follow_approved in the one case that cannot reach -- an invitee who already followed them, whose redemption approved the inviter''s own pending request. One Feed story is posted with the inviter as actor -- two edges, one relationship (§A14). Answers with connected: whether both edges came out approved, read back rather than assumed. A *referral* token keeps 20260912000100''s semantics exactly -- the invitee''s own edge is approved for a public inviter and a request for a private one, and there is no reverse edge, no cleared request, no release and no story -- so a future campaign link cannot inherit a rule written for a link one friend hands another. Unknown, revoked and foreign-environment tokens are one refusal, as are self, a block in either direction, and a suspended or missing inviter. Idempotent through the operation ledger; a replay reports whether an attribution exists without naming the inviter.';
