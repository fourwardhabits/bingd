-- An invitation counted in public.
-- Founder clarification 2026-08-27: Invite Instigator's progress is a normal public
-- achievement metric. The NUMBER of activated invites is visible to anyone allowed
-- to see the profile's Awards; the invite graph behind it — who, when, with which
-- token — stays exactly as private as it is today.
--
-- ---------------------------------------------------------------------------
-- THE SAME MOVE AS THE MUTUALS, ONE DAY LATER
--
-- 20260827000100 released a mutual-follow count that had been withheld out of
-- caution, with the argument "what was withheld was the *aggregation*". This is that
-- argument again with one difference that matters: unlike mutual follows, the rows
-- beneath this count are NOT individually readable by the visitor
-- (`invite_attributions_read` admits only the two parties), so the aggregate is a
-- genuine disclosure rather than a convenience — and the founder has now decided it,
-- explicitly: the count is public achievement data; the identities are not.
--
-- That decision is scoped. Hype Courier's sent-recommendation count stays withheld:
-- one aggregate becoming public is a founder decision about that aggregate, not a
-- precedent that widens every two-party fact.
--
-- ---------------------------------------------------------------------------
-- WHY A SCALAR FUNCTION AND NOT A VIEW OR A POLICY
--
-- A row-returning object over `invite_attributions` — a view like `logged_collection`,
-- or a widened policy — would disclose per-row existence and everything a row embed
-- can reach. The public surface here is one integer, so the object is one integer:
-- a definer scalar in the `people_mutuals` mould. A column that is not returned
-- cannot be selected, which is the strongest privacy statement available.
--
-- `can_i_view` rather than a bare read: the caller must already be entitled to the
-- profile whose Awards this number sits on. An unviewable subject — blocked either
-- way, private and unapproved, suspended — answers null, which tells the caller
-- nothing the profile screen's own refusal had not: the function is not a new
-- oracle, it is the same one.
--
-- The predicate is the canonical one from growth-instrumentation.md §"the award
-- that now counts people": attributed AND activated. Acceptance without activation
-- is not an achievement, exactly as the owner's own award has always counted it —
-- which is what makes the owner's number and a visitor's number equal by
-- construction rather than by synchronisation.
-- ---------------------------------------------------------------------------

create or replace function invited_signup_count(p_user uuid)
returns integer
language sql stable security definer
set search_path = public
as $$
  select case
    when p_user is not null
     and auth.uid() is not null
     and can_i_view(p_user)
    then (
      select count(*)::integer
        from invite_attributions ia
       where ia.inviter_id = p_user
         and ia.activated_at is not null
    )
  end;
$$;

comment on function invited_signup_count(uuid) is
  'How many people one account has brought to bingd. — attributed, activated invites, the same predicate the owner''s own Invite Instigator award has always counted. Public aggregate by founder decision (2026-08-27): one integer, gated on can_i_view, so any viewer entitled to the profile sees the same number the owner does. Returns null for an unviewable subject — the same refusal the profile itself gives — and never returns, joins, or orders by anything that could name an invitee, a token, or a timestamp.';

revoke execute on function invited_signup_count(uuid) from public, anon, authenticated;
grant  execute on function invited_signup_count(uuid) to authenticated;
