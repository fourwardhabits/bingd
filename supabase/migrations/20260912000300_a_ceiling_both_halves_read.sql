-- A ceiling both halves read.
-- Independent review of PR #128, 2026-09-09. Corrects `20260912000200`.
--
-- ===========================================================================
-- THE DEFECT, WHICH IS A DISAGREEMENT RATHER THAN A BUG IN EITHER HALF
--
-- `20260912000200` §1 bounded a follow story's membership at
-- `feed.follow_story_max_people`, and the whole argument for that bound is a property of
-- two functions at once: **the reader's single page IS the whole story**, so the count a
-- Feed row prints is the truth about what that viewer may see rather than a page presented
-- as a total.
--
-- The writer read the configuration. The reader did not. `follow_activity_people` clamped
-- every request to a literal 50, so the two halves agreed only while the configuration
-- happened to say 50 -- and the configuration exists precisely so the founder can move it
-- after watching real accounts.
--
-- Raise it to 75 and the property silently stops holding: a story stores 75 members, the
-- reader returns the first 50, and "and 49 others" is once again a page presented as a
-- total, with 25 people named in `feed_follow_targets` that no client can reach. The
-- failure needs no code change to happen -- one row in `app_config` does it -- and nothing
-- fails loudly when it does. Lowering the value was safe, which is why the tests that
-- lowered it passed.
--
-- **So the reader reads the same row.** `p_limit` is clamped to the story's own ceiling
-- rather than to a literal, and the ceiling is the only number either function knows. They
-- cannot disagree, because there is nothing left for them to disagree about.
--
-- The literal 50 it replaces was described as "a floor under a pathological argument rather
-- than a real limit", and the story cap is a strictly better one for that job: a caller
-- asking for a million is clamped to the largest number of rows a story can hold, which is
-- the most any honest answer could contain. The `coalesce(..., 50)` fallback and the
-- `greatest(..., 1)` floor are the writer's, restated here for the same reason the writer
-- has them -- `config-defaults.test.mjs` exists because a `coalesce` over a query returning
-- no rows is never evaluated at all.
--
-- **`p_limit` now defaults to null rather than to 50, and null means the whole story.** A
-- parameter default cannot contain a subquery, so a literal default has the same disagreement
-- built into it as the clamp did: omit the argument at a setting of 75 and you would get 50.
-- Null resolves to the ceiling inside the body, where the row can be read, so "omit it" means
-- "everything this viewer may see" at any setting. `use-feed.ts` omits it for that reason --
-- it depends on the *semantics* of the default rather than on its number, which is the
-- dependency review asked for when it objected to the client taking whatever page came back.
--
-- **`20260912000200` is not edited.** It has been executed against staging, and a migration
-- that has run somewhere is history. This is the same discipline that produced it in the
-- first place, applied to it.
--
-- The return type is unchanged, so this is a plain `create or replace` -- no drop, and the
-- grants and comment survive. They are restated anyway, because a replace that silently
-- relied on them surviving is the kind of assumption `20260827000200` had to correct.
-- ===========================================================================

create or replace function follow_activity_people(
  p_event_ids uuid[],
  p_limit     integer default null
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
  -- The story's own ceiling, read once. `_post_follow_activity` reads this same row before
  -- it appends, so the largest membership that can exist and the largest this can return
  -- are the same number by construction.
  cap as (
    select greatest(coalesce(
             (select (value)::integer from app_config where key = 'feed.follow_story_max_people'),
             50), 1) as n
  ),
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
       limit least(greatest(coalesce(p_limit, (select n from cap)), 1), (select n from cap))
    ) x;
$$;

comment on function follow_activity_people(uuid[], integer) is
  'The people one or more follow_added events are about, as far as the caller is allowed to know. The only read path into feed_follow_targets, which has no policy. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Two predicates: can_view_profile on the event''s actor, restated because definer bypasses feed_events_read; can_identify_profile on each named account, so a private account the caller may discover appears as identity only and a blocked or suspended one is absent (20260828000400). The caller is excluded from their own row -- this is a list of people to discover, and Follow on yourself is a control that cannot exist. Returns no total: a story''s membership is bounded at feed.follow_story_max_people, and since 20260912000300 this function clamps p_limit to that same configured number rather than to a literal, so asking for the default IS the whole story at any setting and the count the client draws is the truth about what this viewer may see. Ordered by when each follow joined the story, so the first name is stable.';

revoke execute on function follow_activity_people(uuid[], integer) from public, anon;
grant  execute on function follow_activity_people(uuid[], integer) to authenticated;


-- ---------------------------------------------------------------------------
-- `redeem_invite`'s comment says "exactly once", and it is "at most once"
--
-- The behaviour is right and is not touched here. The description of it was not: review
-- read "each party is told exactly once" and found the case it does not cover, which is
-- neither a defect nor an accident.
--
-- When the invitee **already followed** their inviter and no request of the inviter's was
-- answered, the inviter is told nothing. That is correct: the follow they were told about
-- at the time still stands, there is no join to announce that they have not already heard,
-- and the only edge this call created is the inviter's own outgoing one -- which nobody is
-- notified about anywhere in this schema, because being told about your own action is what
-- `20260827000200` removed from the accepter's side of an approval.
--
-- A function comment is the first thing the next reader trusts, and one that promises a row
-- in a case that produces none is how a later writer "fixes" the silence by adding a
-- duplicate. So the sentence changes and the code does not.
-- ---------------------------------------------------------------------------

comment on function redeem_invite(uuid, text) is
  'Redeems an invite token for the caller: attribution (once per account, for ever), invited_by, the invitee''s invite_welcome row, and PRD §17''s follow. Since 20260912000200 a valid *personal* token ends with BOTH directed edges approved, in all four combinations of the two accounts'' visibility: minting a personal link and handing it to somebody is the inviter acting, which is the same decision an Approve is, and redeeming that person''s link is the invitee making theirs. An edge that was already pending in either direction is upgraded rather than left, the follow_request it answered is cleared in both directions, and held recommendations are released both ways -- the approval semantics respond_follow_request applies, applied here because this is an approval. An already-approved edge keeps the approved_at it was granted at. The invitee is told once, by invite_welcome. The inviter is told AT MOST once: invite_joined when their invitee''s own edge was created or upgraded; follow_approved in the one case that cannot reach, an invitee who already followed them whose redemption approved the inviter''s own pending request; and nothing at all when the invitee already followed them and no request of theirs was answered, because the only edge that moved is the inviter''s own outgoing one and no writer in this schema announces that. Never two rows. One Feed story is posted with the inviter as actor -- two edges, one relationship (§A14). Answers with connected: whether both edges came out approved, read back rather than assumed. A *referral* token keeps 20260912000100''s semantics exactly -- the invitee''s own edge is approved for a public inviter and a request for a private one, and there is no reverse edge, no cleared request, no release and no story -- so a future campaign link cannot inherit a rule written for a link one friend hands another. Unknown, revoked and foreign-environment tokens are one refusal, as are self, a block in either direction, and a suspended or missing inviter. Idempotent through the operation ledger; a replay reports whether an attribution exists without naming the inviter.';
