-- An invitation that resolves.
--
-- ---------------------------------------------------------------------------
-- What was missing
-- ---------------------------------------------------------------------------
--
-- `invite_attributions` has carried `accepted_at` and `activated_at` since
-- `20260813001300` with **nothing writing either**. `create_invite_link`
-- (`20260817001300`) mints the one reusable personal link and records one
-- `invite_link_creations` row per share, and that is where the funnel stopped: a
-- link somebody can send and nobody can count. Bingd Awards' Invite Instigator
-- track reads `activated_at is not null` and therefore reads zero for every
-- account; the `invite_activated` notification type, its preference category and
-- its client route all exist ahead of a writer that does not.
--
-- This migration writes the missing three:
--
--   record_invite_open      the only measure of the *uninstalled* half of the funnel
--   redeem_invite           attribution, once per invitee, for good
--   _maybe_activate_invite  activation, from the one place a ranking is created
--
-- Nothing here invents a stage. Each follows an event the database can actually
-- observe, which is the rule `docs/product/growth-instrumentation.md` exists to
-- enforce.
--
-- ---------------------------------------------------------------------------
-- The three refusals that are one answer
-- ---------------------------------------------------------------------------
--
-- `redeem_invite` answers `invalid` for a token that does not exist, one that was
-- revoked, and one minted in another environment. Telling them apart would make
-- the function a **token oracle**: "revoked" confirms a token was once real, which
-- is precisely the fact 128 bits of entropy exists to withhold. Same reasoning
-- `recommend_title` records for its four-way `not_mutual`, and `create_profile`
-- for its two 23505s.
--
-- `self`, `blocked` and `already_attributed` are distinguishable because in each
-- case the caller already knows: they are their own inviter, they are one of the
-- two parties to a block, or they have an attribution of their own. None of the
-- three discloses anything the caller could not already state.
--
-- ---------------------------------------------------------------------------
-- Why an open is recorded and a validity is never returned
-- ---------------------------------------------------------------------------
--
-- The web page at `https://bingd.app/i/<token>` is static and anonymous. It has no
-- session, so the only thing it can do is report that a link was opened.
-- `record_invite_open` therefore takes `anon` -- and returns **void**, so there is
-- no value in which a validity could be read back. The row is written only for a
-- live token, which is not observable from outside.
--
-- Enumeration is not the threat this guards against: a token is 122 bits from
-- `gen_random_uuid()`, and a caller who could guess one would have no use for this
-- function. The threat is a **table filled by anybody holding the URL**, and an
-- anonymous caller has no identity to rate-limit. So the ceiling is per token and
-- per hour, read from `app_config` like every other limit here. Past it the call
-- still succeeds and still returns nothing; it simply stops writing. An invitation
-- opened two hundred times in an hour is not two hundred facts.
--
-- **The honest limit of "returns void", named by independent review 26.** No value
-- distinguishes a live token from an invented one, and no error does either -- but a
-- live token causes strictly more work: a count, and usually an insert. Repeated
-- measurement can separate the two *statistically*. Both `app_config` reads were
-- moved ahead of the lookup so they are common to both paths, which removes the
-- largest part of the difference; the count and the insert cannot be, short of doing
-- fake work, which is a worse thing to have in a schema than an accurate comment.
--
-- That residue is not an enumeration path and the arithmetic says why: distinguishing
-- one candidate from another is worth nothing when there are 2^122 of them, and the
-- oracle answers one token at a time at network latency. It matters only to somebody
-- who *already holds* a specific token and wants to know whether it is live -- which
-- they can establish for certain by redeeming it, from an account they can create.
-- So the claim this function makes is "no value and no error reveals validity", and
-- not "validity is unobservable by any means".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Opens
--
-- A separate table rather than a column on `invite_tokens`, for the reason roadmap
-- §7 states: one link opened by five people is five rows, and a column would be
-- one. `token_id` rather than the token text, so the token itself is stored in
-- exactly one place and a second copy cannot outlive a revocation.
--
-- No address, no user agent, no fingerprint of any kind. PRD §17 forbids
-- approximate attribution and this table is where the temptation to build it would
-- land. `platform` is the one thing the page states about *itself*, and is the only
-- column here that is not a timestamp or a key.
-- ---------------------------------------------------------------------------

create table invite_link_opens (
  id        uuid primary key default gen_random_uuid(),
  token_id  uuid not null references invite_tokens(id) on delete cascade,
  platform  text,
  opened_at timestamptz not null default now(),
  constraint invite_link_opens_known_platform
    check (platform is null or platform in ('ios', 'android', 'other'))
);

create index invite_link_opens_token on invite_link_opens (token_id, opened_at desc);

comment on table invite_link_opens is
  'One row each time the bingd.app invitation page loaded for a live token. Written by record_invite_open, which is anonymous, returns void, and is capped per token per hour. Carries no address, no user agent and no identifier: platform is the one thing the page states about itself.';

alter table invite_link_opens enable row level security;

-- No policy at all, deliberately. Nobody reads this from a client. An inviter
-- learning their link was opened four times is a product decision nobody has taken,
-- and an open is not an arrival; this is a founder-side query.

revoke all on invite_link_opens from anon, authenticated;

insert into app_config (key, value) values
  ('invite.max_opens_per_token_per_hour', '60'::jsonb),
  ('invite.max_redeem_attempts_per_day',  '10'::jsonb),
  ('invite.activation_rankings',          '10'::jsonb)
on conflict (key) do nothing;

create or replace function record_invite_open(p_token text, p_platform text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_id uuid;
  v_env      text;
  v_cap      integer;
begin
  -- The suspension guard, applied to the one branch it can apply to.
  --
  -- `assert_can_write` raises 28000 on a null `auth.uid()`, and the page that calls
  -- this has no session at all -- so it cannot be the unconditional first line the
  -- other writers give it. It is not therefore skipped: a *signed-in* caller is
  -- checked exactly as everywhere else, and an anonymous one has no account to
  -- suspend, which is the whole reason this function exists in this shape.
  --
  -- `moderation.test.mjs` asserts that every client-callable function either calls
  -- the guard or is declared read-only. This one is a writer, so it calls it.
  if auth.uid() is not null then
    perform assert_can_write();
  end if;

  -- A shape check before touching the table. A token is 32 lowercase hex characters
  -- -- `create_invite_link` strips the dashes from a uuid -- so anything else cannot
  -- match a row and is not worth a lookup.
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return;
  end if;

  -- Both configuration reads happen here, before the lookup, so they are common to
  -- the live and the unknown path rather than being work only a real token causes.
  -- See the note on timing in the header.
  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  select coalesce(
           (select (value)::integer from app_config
             where key = 'invite.max_opens_per_token_per_hour'),
           60)
    into v_cap;

  select t.id into v_token_id
    from invite_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and t.env = v_env;

  if v_token_id is null then
    return;
  end if;

  -- Bounded rather than raised. A page that reported "too many opens" would be
  -- telling a real invitee their link is broken, and the caller can do nothing with
  -- the answer either way.
  --
  -- **A bound, not a strict ceiling**, and the difference is worth stating rather
  -- than discovering. This is a check and then an insert with no lock on the token,
  -- so N simultaneous loads all read the same count and all write: the cap can be
  -- overshot by roughly the concurrency. Locking the token row would make it exact
  -- and would hand an anonymous caller a lock to hold, which is a worse trade for a
  -- metric. What it buys is the thing it exists for -- a link posted publicly cannot
  -- fill this table without bound -- and it buys that whether or not it is exact.
  if (select count(*) from invite_link_opens o
       where o.token_id = v_token_id
         and o.opened_at > now() - interval '1 hour') >= v_cap then
    return;
  end if;

  insert into invite_link_opens (token_id, platform)
  values (v_token_id,
          case when p_platform in ('ios', 'android') then p_platform else 'other' end);
end;
$$;

comment on function record_invite_open(text, text) is
  'Records that the bingd.app invitation page opened for a live token. Returns void in every case -- an unknown, revoked or cross-environment token is indistinguishable from a live one, which is what stops an anonymous caller using this to test tokens. Capped per token per hour, because an anonymous caller has no identity to rate-limit. Granted to anon: the page that calls it has no session.';

revoke execute on function record_invite_open(text, text) from public;
grant execute on function record_invite_open(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Redemption
--
-- ---------------------------------------------------------------------------
-- Exactly one inviter, for good
-- ---------------------------------------------------------------------------
--
-- `invite_attributions` is keyed on `invitee_id`, so "a person is invited once" is
-- the primary key rather than a check this function makes. The insert is
-- `on conflict (invitee_id) do nothing`, and the branch after it is the whole
-- idempotency story:
--
--   the same person replaying the same token       -> already_attributed, row unmoved
--   the same person redeeming a *different* token  -> already_attributed, row unmoved
--   two tokens arriving simultaneously             -> one inserts, one conflicts
--
-- In every case the row standing when the dust settles is the first one committed,
-- and no later call can move it. That is the property this function exists to have:
-- **a replay must never move attribution to another inviter.**
--
-- The operation ledger sits in front of that and is not a substitute for it.
-- `_claim_operation` recognises a replay carrying the same id; two different ids
-- from two devices are two genuine calls, and the primary key is what makes the
-- second one harmless.
--
-- ---------------------------------------------------------------------------
-- Refusals are returned, not raised
-- ---------------------------------------------------------------------------
--
-- Same decision as `recommend_title`, and here it is load-bearing for a sharper
-- reason. A raise rolls back the operation claim, so refused attempts would cost
-- nothing against the ceiling -- and this is the one function in the schema where a
-- refused attempt is exactly what an attack looks like. Returning keeps the claim,
-- so a wrong token is spent from the same budget as a right one.
--
-- ---------------------------------------------------------------------------
-- The pair lock, and where the block check goes
-- ---------------------------------------------------------------------------
--
-- `20260819000400` states the shape: resolve the other party, check the
-- relationship, insert. Every writer of that shape takes `_lock_pair` **before** the
-- check that reads `blocks`, or a block committing in between leaves a row the block
-- was meant to prevent.
--
-- The inviter is not known until the token has been resolved, so the lock cannot
-- come first. It comes immediately after, and before the block check -- not the
-- check-lock-check of `add_comment`, because there is no earlier check here whose
-- wait could leak. Resolving a token is a lookup on a value the caller already
-- holds; ordering the lock after it discloses nothing, since the caller learns
-- whether their own token is live, which is the answer being returned anyway.
--
-- Lock ordering is unchanged and uniform: `_assert_operation_rate`'s account lock is
-- taken first, the token row lock second, the pair lock third. No transaction here
-- takes a pair lock before an account lock, which is what keeps the two families
-- acyclic, and nothing anywhere takes a token row lock while holding a pair lock.
--
-- ---------------------------------------------------------------------------
-- The token is locked, not merely read -- independent review 26
-- ---------------------------------------------------------------------------
--
-- The first version of this function read the token with a plain SELECT and inserted
-- the attribution some lines later. A `revoke_invite_link` committing in that window
-- left a redemption against a **revoked** token: the owner still received the credit
-- for a link they had just withdrawn, which is exactly the case revocation exists for
-- and the only route review 26 found to the wrong inviter being credited.
--
-- A row lock closes it, and closes it in both orderings without either party needing
-- to know about the other:
--
--   * revocation first  -- the SELECT waits for its commit, then **re-evaluates its
--     own qualification** against the new row version (READ COMMITTED's EPQ recheck),
--     finds `revoked_at` set, matches nothing, and answers `invalid`;
--   * redemption first  -- the revoking UPDATE waits for this commit. The attribution
--     was written while the token was live, which is not a defect: it is the
--     invitation being claimed a moment before it was withdrawn.
--
-- The same mechanism as the activation guard in §3, applied to a different row.
--
-- **`for share` and not `for update`, and the first attempt got this wrong.** A
-- personal link is *meant* to be claimed by many people — that is the whole token
-- model in PRD §17 — so an exclusive lock on the token row would serialise every
-- invitee of one popular link against every other, for the duration of a redemption
-- each. The race suite caught it immediately: R4's "two invitees redeeming at once do
-- not serialise" went from passing to a sixty-second timeout.
--
-- `for share` is exactly the strength required. Readers do not conflict with readers,
-- so N simultaneous redemptions proceed together; a writer waits for all of them. The
-- EPQ recheck applies to `for share` just as it does to `for update`, so the
-- revocation-first ordering is closed identically.
--
-- **There are two writers of this row, not one, and the first draft of this comment
-- said one.** Independent review 26b: `revoke_invite_link` updates it, and **deleting
-- the owner's profile cascades into it**. So a cycle is constructible --
--
--     redemption      holds the token FOR SHARE, then waits on the inviter's profile
--                     row for the `profiles.invited_by` update or an FK check
--     delete_account  holds the inviter's profile row, then waits to cascade-delete
--                     the token
--
-- -- and it is left standing deliberately.
--
-- PostgreSQL detects it and aborts one side rather than hanging. **Which side is not
-- ours to predict** -- there is no victim-selection guarantee, and an earlier draft of
-- this comment claimed the redemption always loses, which independent review 26c
-- corrected. Both outcomes are safe, and that is the actual argument:
--
--   * the redemption aborts   -- the client reads an unsettled failure, keeps its token,
--     and retries on the next launch against an inviter who by then does not exist, so
--     it is answered `invalid` and let go;
--   * the deletion aborts     -- the redemption completes against an inviter who still
--     exists, and the account owner's next attempt to delete succeeds.
--
-- Neither can corrupt an attribution, because both sides are transactional and whichever
-- survives leaves a consistent state. The alternative is an ordering rule between a
-- token row and a profile row that every future writer would have to know about, bought
-- to make a one-in-a-million interleaving abort slightly more tidily.
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
  v_env        text;
  v_prior      uuid;
  v_visibility profile_visibility;
  v_state      follow_state;
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

  -- Unknown, revoked, and minted elsewhere are one answer. See the header.
  --
  -- `for share`, so a revocation cannot commit between this read and the insert below.
  -- See "The token is locked, not merely read" above.
  select t.id, t.owner_id into v_token_id, v_inviter
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
  -- exactly the caller who must be refused. Same reasoning as `_assert_reachable`.
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
  -- attribution and is never rewritten -- the same "for good" rule the primary key
  -- gives the row above.
  update profiles
     set invited_by = v_inviter
   where id = v_self and invited_by is null;

  -- ---------------------------------------------------------------------------
  -- PRD §17's acceptance semantics, clauses 2, 3 and 4
  -- ---------------------------------------------------------------------------
  --
  -- **The first version of this function wrote the attribution and stopped there**,
  -- and recorded the omission in the PRD as a deliberate narrowing. Independent
  -- review 26 rejected that, correctly: a specification is not amended by a note
  -- saying it was not implemented, and the reasons offered -- a smaller concurrency
  -- surface, a stricter reading of the privacy clauses -- were arguments for an
  -- implementation convenience, not authorisation to change what acceptance means.
  --
  -- So acceptance does what §17 says it does:
  --
  --   2. it creates a one-way follow from recipient to inviter;
  --   3. a **private** inviter receives a follow *request* instead, subject to normal
  --      approval -- so the private setting is honoured rather than bypassed;
  --   4. the inviter is notified, and the inbox row is what prompts them to follow
  --      back. They are never auto-followed, which clause 4 also requires and which
  --      no line here does.
  --
  -- Clauses 1, 5, 6 and 7 were already met: acceptance is an explicit tap on
  -- `app/i/[token].tsx`, the recipient is unnamed to the inviter until this commits,
  -- a block voids the invitation above, and the attribution is written independently
  -- of the follow.
  --
  -- **The state decision is `follow`'s own and is copied from it deliberately.**
  -- `20260817000200` is the one place in the schema that decides public-or-private,
  -- and it decides from the target's own setting rather than from anything the caller
  -- sends. This reproduces that rule rather than inventing a second one.
  --
  -- **Calling `follow()` instead was considered and is wrong.** It claims its own
  -- operation id and spends its own hourly slot, so a redemption would consume a
  -- follow the person had not made, and a replay of *this* operation would be a
  -- second genuine follow attempt. The rows are written here, under the pair lock
  -- this transaction already holds, which is also the lock `follow` and `block` take.
  --
  -- `on conflict do nothing`, because an invitee who already follows their inviter is
  -- ordinary -- they were sent the link by somebody they know -- and re-adding must
  -- never downgrade an approved follow to pending. Same rule, same reason, as
  -- `follow`'s "never downgraded" branch. The notification is filed only when a row
  -- was actually created, so an existing follow does not produce a second notice.
  select p.visibility into v_visibility from profiles p where p.id = v_inviter;
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (v_self, v_inviter, v_state, case when v_state = 'approved' then now() end)
  on conflict (follower_id, followee_id) do nothing;

  if found then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
    values (v_inviter,
            case when v_state = 'approved' then 'follow' else 'follow_request' end,
            v_self, 'profile', v_self);
  else
    -- Already following, in whichever state. Report that state rather than the one
    -- this call would have created, so the client cannot tell somebody their request
    -- is pending when they were approved months ago.
    select f.state into v_state
      from follows f where f.follower_id = v_self and f.followee_id = v_inviter;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'inviter_id', v_inviter,
    'inviter_username', (select p.username::text from profiles p where p.id = v_inviter),
    'follow_state', v_state
  );
end;
$$;

comment on function redeem_invite(uuid, text) is
  'Claims an invitation for the calling account: writes invite_attributions.accepted_at and profiles.invited_by, creates the one-way follow PRD §17 specifies -- a request rather than a follow when the inviter is private -- and files the inviter''s notification. Unknown, revoked and cross-environment tokens are one refusal, because telling them apart would confirm a token was once real. The token row is locked, so a revocation cannot commit inside the call. Refusals are returned rather than raised so a wrong token spends a slot against the ceiling -- this is the one writer where a refused attempt is what an attack looks like. The primary key on invitee_id is what makes it idempotent: no replay, no second token and no second device can move an attribution once written.';

revoke execute on function redeem_invite(uuid, text) from public, anon, authenticated;
grant execute on function redeem_invite(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2b. Revocation
--
-- ---------------------------------------------------------------------------
-- Why this belongs in *this* migration and not a later one
-- ---------------------------------------------------------------------------
--
-- PRD §17's token model has said "the user may revoke and regenerate from Settings"
-- since v0.6, and `invite_tokens.revoked_at` plus the `invite_tokens_one_live` partial
-- index have supported it since `20260813001300` -- with **no writer**. Independent
-- review 26 named the omission, and the reason it becomes urgent here rather than
-- earlier is specific: until this migration a leaked invitation link resolved to
-- nothing at all. This run makes it a live attribution vector, so the same migration
-- owes the control that takes it back.
--
-- A personal link is reusable, has no expiry and is pasted into group chats. There is
-- exactly one way to undo that, and this is it.
--
-- ---------------------------------------------------------------------------
-- Revoke and mint are one call
-- ---------------------------------------------------------------------------
--
-- `invite_tokens_one_live` permits any number of revoked rows and exactly one live
-- one, so revoking and minting in one transaction is the only sequence that cannot
-- leave an account with no link -- which is a state the Share control has no answer
-- for. The caller gets their new link back from the same call.
--
-- The advisory key is `create_invite_link`'s own mint key, so the two serialise
-- against each other: a Share tapped at the moment Revoke is pressed either sees the
-- old token or the new one, and never a 23505 from two live rows racing.
-- ---------------------------------------------------------------------------

create or replace function revoke_invite_link(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_short text;
  v_env   text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'revoke_invite_link') then
    -- The replay answers with the link that is live *now*, which is the new one. A
    -- retry after a lost reply must not revoke a second time: that would rotate the
    -- link twice and detach everybody who was given the one in between.
    select t.token, t.short_code into v_token, v_short
      from invite_tokens t
     where t.owner_id = auth.uid() and t.revoked_at is null;

    return jsonb_build_object('status', 'already_applied', 'token', v_token, 'short_code', v_short);
  end if;

  -- Deliberately tight. Rotating a personal link detaches everybody holding the old
  -- one, so this is a safety action taken once or twice, not a thing to do in a loop
  -- -- and an unbounded rotation is a cheap way to fill the table.
  perform _assert_operation_rate('revoke_invite_link', 'invite.max_revocations_per_day', 5);

  -- The mint lock, shared with `create_invite_link` (20260817001300). See the header.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(auth.uid()::text, '') || 'invite_link', 0));

  update invite_tokens
     set revoked_at = now()
   where owner_id = auth.uid() and revoked_at is null;

  select coalesce((select value #>> '{}' from app_config where key = 'env.name'), 'nonprod')
    into v_env;

  v_token := replace(gen_random_uuid()::text, '-', '');
  -- Drawn separately rather than sliced off the token, so holding a short code is
  -- never a head start on guessing the token it belongs to. `create_invite_link`'s
  -- rule, restated because this is the second minting site.
  v_short := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into invite_tokens (owner_id, token, short_code, env)
  values (auth.uid(), v_token, v_short, v_env);

  -- The attributions already written against the old token are untouched, and that is
  -- the point of `token_id on delete set null` rather than a cascade: revoking a link
  -- withdraws the *invitation*, it does not un-invite the people who accepted it.
  return jsonb_build_object('status', 'ok', 'token', v_token, 'short_code', v_short);
end;
$$;

comment on function revoke_invite_link(uuid) is
  'Revokes the caller''s live invite link and mints its replacement in one transaction, which is the only sequence invite_tokens_one_live allows that never leaves an account without a link. Takes create_invite_link''s mint lock, so a simultaneous Share cannot see two live tokens. Attributions already accepted against the old token are untouched -- revoking withdraws the invitation, it does not un-invite anybody. Rate-limited tightly: rotating detaches everybody holding the old link.';

insert into app_config (key, value)
values ('invite.max_revocations_per_day', '5'::jsonb)
on conflict (key) do nothing;

revoke execute on function revoke_invite_link(uuid) from public, anon, authenticated;
grant execute on function revoke_invite_link(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Activation
--
-- ---------------------------------------------------------------------------
-- The criterion is PRD §28's, and it was already chosen
-- ---------------------------------------------------------------------------
--
-- **Ten ranked titles.** PRD §17 once said "at least one" and was corrected on
-- 2026-08-19 to agree with §28, precisely so this function would not be handed two
-- contracts. One ranked title is a tap; ten is somebody who has used the app, which
-- is what makes an activation-gated reward unfarmable.
--
-- Counted over `rankings` across both categories, because "ten titles" is a
-- statement about what a person ranked and not about which tab they were on.
--
-- ---------------------------------------------------------------------------
-- Exactly once, from a row lock rather than from an ordering argument
-- ---------------------------------------------------------------------------
--
-- The guard is `where activated_at is null`, and it is what makes two clients
-- ranking the tenth title at the same moment produce one activation. Under READ
-- COMMITTED the second UPDATE blocks on the row lock the first holds, and on release
-- **re-evaluates its predicate against the committed version** -- which by then has
-- `activated_at` set, so it matches nothing and reports no rows. The notification and
-- the analytics flag both hang off that result, so neither can fire twice. Nothing
-- here depends on the two transactions arriving in a particular order.
--
-- `_rank_finalize` already holds an advisory lock keyed on (user, category), and that
-- lock does *not* serialise a movie and a season ranked simultaneously -- so the row
-- lock is not redundant with it. It is the only thing standing there.
--
-- ---------------------------------------------------------------------------
-- Why the count is `>=` rather than `=`
-- ---------------------------------------------------------------------------
--
-- An account can pass ten while unattributed -- redeeming afterwards is allowed and
-- ordinary -- and would then never rank a tenth title again. `>=` activates it at its
-- next ranking instead of never. The transition is still once, because the guard is
-- on the column and not on the count.
--
-- ---------------------------------------------------------------------------
-- The notification is not the activation
-- ---------------------------------------------------------------------------
--
-- `activated_at` is set even when the inviter has deleted their account, been
-- suspended, or blocked the invitee. It is a historical fact about the invitee, and
-- `block` already draws that line itself: `20260817000200` voids only *unaccepted*
-- attributions, deliberately leaving accepted ones alone.
--
-- The **notification** is a message between two people, so it is not written when
-- there is nobody to receive it or a block between them -- and it is written under
-- the pair lock, for the reason `20260819000400` gives: a block committing between
-- the check and the insert would otherwise leave an inbox row between a severed pair.
-- ---------------------------------------------------------------------------

create or replace function _maybe_activate_invite(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_needed  integer;
  v_inviter uuid;
begin
  -- Unattributed, or already activated: nothing to do, and no count to run. The read
  -- is on the primary key, so this is one index probe for the ranking of somebody who
  -- was never invited -- which is most rankings.
  select ia.inviter_id into v_inviter
    from invite_attributions ia
   where ia.invitee_id = p_user
     and ia.accepted_at is not null
     and ia.activated_at is null;

  if not found then
    return false;
  end if;

  select coalesce(
           (select (value)::integer from app_config where key = 'invite.activation_rankings'),
           10)
    into v_needed;

  if (select count(*) from rankings r where r.user_id = p_user) < v_needed then
    return false;
  end if;

  -- The transition, and the only place it can happen. See the header: the predicate
  -- is re-evaluated under the row lock, so a second caller finds nothing to update
  -- rather than a second activation to announce.
  update invite_attributions
     set activated_at = now()
   where invitee_id = p_user
     and activated_at is null;

  if not found then
    return false;
  end if;

  -- Deleted inviter: `inviter_id` is set null by the foreign key (20260813001500) and
  -- the activation is still recorded. There is simply nobody to tell.
  if v_inviter is null then
    return true;
  end if;

  perform _lock_pair(p_user, v_inviter);

  -- Re-read under the lock. A block or a suspension committing between the
  -- attribution read above and this insert is what the lock is here to catch.
  if blocked_between(p_user, v_inviter)
     or not exists (select 1 from profiles p where p.id = v_inviter and p.status = 'active')
  then
    return true;
  end if;

  -- `invite_activated` maps to the `invites` category in
  -- `_apply_notification_preference`, mapped by 20260819000300 ahead of this writer so
  -- the switch is honoured on the day it lands. The before-insert trigger drops the
  -- row if the inviter has turned that category off.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (v_inviter, 'invite_activated', p_user, 'profile', p_user);

  return true;
end;
$$;

comment on function _maybe_activate_invite(uuid) is
  'Sets invite_attributions.activated_at the first time an attributed invitee has ranked invite.activation_rankings titles (PRD §28: ten), and files the inviter''s one invite_activated notification. Exactly once, from the row lock on a guarded UPDATE rather than from any ordering assumption. The activation is recorded even when the inviter is gone, suspended or has blocked the invitee; the notification is not. Internal: it answers a question about a third party''s attribution.';

revoke execute on function _maybe_activate_invite(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. `_rank_finalize` calls it
--
-- Rebuilt in full from its current definition in `20260815010000`, not patched.
-- `20260817001300` records why: a `create or replace` assembled from the wrong
-- ancestor is how `_assert_operation_rate` silently lost its advisory lock, and it is
-- invisible in a diff. Every other line, comment and error below is carried across
-- unchanged; the only additions are the activation call and the `activated` key.
--
-- **Here rather than in `rank_start`/`rank_answer`/`rank_skip`.** This is the one
-- function in the schema that inserts into `rankings` -- all four entry points return
-- through it -- so putting the count here is what makes "ten ranked titles" mean the
-- table rather than a particular code path. `rank_reorder`, `rank_rebucket` and
-- `rank_unrank` do not pass through it and must not: none of them changes how many
-- titles somebody has ranked.
--
-- **After the insert.** The count has to include the ranking being made, or activation
-- would land one title late.
--
-- The returned `activated` flag is what lets the client emit `invite_activated`
-- honestly. `analytics.md` §6 requires an event to follow a server outcome, and this
-- is that outcome: it is true exactly for the transaction whose UPDATE flipped the
-- column, so a retry, a second device and a lost reply all report false.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false
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
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw.
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

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

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

  -- PRD §28's activation, from the one place a ranking is created. See §3 above.
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

revoke all on function
  _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean)
  from public, anon, authenticated;
