-- A story the reader cannot truncate.
-- Second independent review of PR #128, 2026-09-09. Corrects `20260912000300`.
--
-- ===========================================================================
-- WHY CONSULTING THE CONFIGURATION WAS NOT ENOUGH
--
-- `20260912000300` made `follow_activity_people` read `feed.follow_story_max_people`
-- instead of clamping to a literal 50, on the argument that the writer and the reader would
-- then be bounded by one number and could not disagree. Review found two ways they still
-- can, and both are the same mistake: **the reader was made to agree with the ceiling, when
-- what it has to agree with is the story.**
--
--   1. **A ceiling that moves after a story exists.** Build a fifty-member story while the
--      setting says 50, then lower it to 10. The membership is still fifty rows -- nothing
--      deletes them -- and the reader now returns ten of them. The Feed row says "and 9
--      others", the sheet cannot reach the other forty, and the count is a lie again. The
--      previous file's claim that the two limits are equal "by construction" held only for a
--      story built and read under the same value, which is not a property anything enforces.
--
--   2. **A caller that passes `p_limit`.** Changing the default to null did nothing for a
--      call that supplies the argument. Any value below the membership reproduces the
--      original defect exactly, and the contract the whole bound exists to support -- one
--      page IS the whole story -- cannot survive a knob that truncates it.
--
-- **So the reader stops having a limit.** It returns every member of each named event that
-- this viewer is allowed to identify, and there is no argument, no configuration read and no
-- literal that can make it return fewer. The invariant stops being a coincidence between two
-- numbers and becomes a property of the function: *what it returns is what is there.*
--
-- The bound has not gone anywhere. It lives where it always belonged -- in
-- `_post_follow_activity`, which stops appending at `feed.follow_story_max_people` -- and it
-- is what keeps this read small. The difference is that a story is now bounded by what was
-- true when it was written, and the reader reports it rather than re-deciding it. Lowering
-- the setting makes *future* stories shorter, which is what a density lever should do, and
-- leaves every story already told intact.
--
-- **This is a drop and recreate, and the argument for its safety is `20260912000200`'s.**
-- `follow_activity_people` was created by `20260912000100`, which is on staging only.
-- Production is at `20260907000100` and has never had this function, so no released binary
-- -- iOS 7, Android build 8 -- can call it with or without `p_limit`. The only caller in the
-- repository is `src/features/feed/use-feed.ts`, which passes the event ids and nothing else.
-- The two-argument form is dropped rather than kept and ignored: a parameter that is
-- accepted and silently disregarded is how the next reader concludes it works.
--
-- `20260912000300` is not edited. It has been executed against staging, like the two before
-- it, and every correction gets its own file.
-- ===========================================================================

drop function if exists follow_activity_people(uuid[], integer);

create function follow_activity_people(p_event_ids uuid[])
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
  -- One page of the Feed holds twenty events and only a few of them can be follow rows, so
  -- this is a floor under a pathological caller rather than a real limit. It bounds how many
  -- *events* one call resolves, which is the caller's own argument and is nothing to do with
  -- how completely each of them is answered.
  events as (
    select e.id
      from feed_events e, me
     where me.id is not null
       and e.id = any (coalesce(p_event_ids, '{}'::uuid[]))
       and e.type = 'follow_added'
       and can_view_profile(me.id, e.actor_id)
     limit 50
  )
  select ev.id, p.id as user_id, p.username::text as username,
         p.display_name, p.avatar_path, p.visibility
    from events ev
    join feed_follow_targets ft on ft.event_id = ev.id
    join profiles p on p.id = ft.followed_id
    cross join me
   where p.id <> me.id
     and p.status = 'active'
     and can_identify_profile(me.id, p.id)
   -- When each follow joined the story, so the name in the sentence's emphasised slot is the
   -- same one across refetches. The handle breaks a tie two appends in the same microsecond
   -- could produce. Ordering the whole result rather than each event's rows separately is
   -- what the lateral was for, and it is no longer needed: with no per-event limit there is
   -- nothing to take the first N *of*, and the client groups by event id anyway.
   order by ev.id, ft.created_at, p.username;
$$;

comment on function follow_activity_people(uuid[]) is
  'The people one or more follow_added events are about, as far as the caller is allowed to know. The only read path into feed_follow_targets, which has no policy. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Two predicates: can_view_profile on the event''s actor, restated because definer bypasses feed_events_read; can_identify_profile on each named account, so a private account the caller may discover appears as identity only and a blocked or suspended one is absent (20260828000400). The caller is excluded from their own row -- this is a list of people to discover, and Follow on yourself is a control that cannot exist. Since 20260912000400 it takes NO limit and truncates nothing: every member of a named event that this viewer may identify is returned, so the count a Feed row draws is the truth about what they may see rather than a page presented as a total. The bound lives in _post_follow_activity, which stops appending at feed.follow_story_max_people -- a story is bounded by what was true when it was written, and lowering that setting shortens future stories rather than hiding members of stories already told. Ordered by when each follow joined the story, so the first name is stable.';

revoke execute on function follow_activity_people(uuid[]) from public, anon;
grant  execute on function follow_activity_people(uuid[]) to authenticated;
