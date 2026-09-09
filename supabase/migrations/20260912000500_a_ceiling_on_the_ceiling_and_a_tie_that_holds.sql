-- A ceiling on the ceiling, and a tie that holds.
-- Third independent review of PR #128, 2026-09-09. Corrects `20260912000200` and
-- `20260912000400`, both of which have run against staging and are therefore immutable.
--
-- ===========================================================================
-- 1. THE FIRST NAME IS SORTED BY SOMETHING ITS OWNER CAN EDIT
--
-- `follow_activity_people` orders by `ft.created_at, p.username`, and every version of it
-- has claimed that this makes the name in the sentence's emphasised slot stable across
-- refetches. For the ordinary case it does: appends happen in separate transactions and
-- `created_at` separates them.
--
-- The tie is the problem. `created_at` defaults to `now()`, which is transaction-scoped, so
-- two members appended in one transaction share a timestamp exactly -- and `redeem_invite`
-- is precisely such a writer. The tie-break is then `username`, which its owner can change
-- from Settings at any time. So two people who joined a story in the same transaction can
-- swap places in somebody else's Feed because one of them renamed themselves, and the row
-- silently starts emphasising a different person.
--
-- `followed_id` breaks the tie instead. It is the membership's own primary-key column, it is
-- immutable for the life of the row, and it is already in the index the scan uses. The
-- ordering stops depending on anything either account can edit.
--
-- ===========================================================================
-- 2. NOTHING BOUNDS THE BOUND
--
-- `20260912000400` was right that the reader must not truncate: it reports the story, and
-- the story is bounded when it is written. That makes `feed.follow_story_max_people` the
-- only thing standing between a Feed page and an arbitrarily large read -- and it is a row
-- in a table, with no constraint on it.
--
-- Set it to 5,000 by mistake and invite redemptions will build 5,000-member stories.
-- Nothing fails at that moment; the cost lands later, on every reader, for ever, because a
-- story already written is a story the reader must now return in full. That is the correct
-- reader behaviour meeting a configuration error, and the configuration error is the half
-- that can be prevented.
--
-- So the writer clamps. `feed.follow_story_max_people` remains the founder's density lever
-- and 50 remains its value; 200 is a ceiling on the ceiling, and it is an engineering bound
-- on the cost of a read rather than a second product opinion about how long a story should
-- be. A setting between 1 and 200 does exactly what it says; one above 200 is treated as
-- 200; one at or below 0 is treated as 1.
--
-- **The zero case is worth naming, because it was already half-true.** The cap is consulted
-- only on the append path -- a story this call just created holds nothing -- so a setting of
-- 0 never stopped the *first* member being named, and a story of one is what it produced.
-- `greatest(..., 1)` makes that the stated rule rather than an accident of where the check
-- sits.
--
-- No reader changes for this. The reader has no bound to keep in step with, which is the
-- whole point of `20260912000400`: there is one number now, it lives in the writer, and this
-- file is what keeps it sane.
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
  v_cap    integer;
  v_held   integer;
begin
  if p_actor is null or p_target is null or p_actor = p_target then
    return;
  end if;

  -- Ordered pair first, then the actor's own key. `for update` cannot lock a story that does
  -- not exist yet, and the actor is not always the caller.
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

  -- The actor's open story, if they have one. `for update` because the actor of a story is
  -- not always the caller: two people redeeming the same inviter's link at the same moment
  -- are two transactions appending to one row.
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
    -- `causal_step` 0: a follow is an act rather than a consequence of one, so it takes the
    -- base step a ranking takes (20260901000100).
    insert into feed_events (actor_id, type, payload, causal_at, causal_step)
    values (p_actor, 'follow_added', '{}'::jsonb, now(), 0)
    returning id into v_event;
  else
    -- §2. A full story takes no more, and the ceiling is itself bounded: this is the only
    -- thing keeping a Feed read small now that the reader truncates nothing, so it may not
    -- be an unconstrained row in a table. 1..200, defaulting to 50.
    --
    -- The count is safe inside the actor lock: nobody else can be adding to this actor's
    -- open story, so it cannot be stale by the time the insert below runs.
    select least(greatest(coalesce(
             (select (value)::integer from app_config where key = 'feed.follow_story_max_people'),
             50), 1), 200)
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

  -- Idempotent by the primary key, which is what keeps a follow, an unfollow and a re-follow
  -- inside one window to one mention of one person.
  insert into feed_follow_targets (event_id, followed_id)
  values (v_event, p_target)
  on conflict (event_id, followed_id) do nothing;
end;
$$;

comment on function _post_follow_activity(uuid, uuid) is
  'Records that one account followed another as Feed activity: one mutable feed_events row per actor per feed.follow_aggregation_minutes, with membership in feed_follow_targets. The membership is bounded at feed.follow_story_max_people, clamped to 1..200 since 20260912000500 -- since 20260912000400 the reader truncates nothing, so this is the only thing keeping a Feed read small and it may not be an unconstrained configuration row. Suppresses a story that would only restate a relationship the reverse story already announced inside the same window (founder §A11) -- presentation, never follow state. causal_at is set once and never bumped, because the Feed is paged by a keyset over it. Takes two advisory locks before it reads anything -- the ordered pair, then follow_story:<actor> -- because for update cannot lock a story that does not exist yet, and because the actor is not always the caller: redeem_invite posts the *inviter''s* story from the invitee''s session, so two invitees accepting one link are two transactions appending to one row. Pair then actor, one of each, which is what makes them deadlock-free. Internal.';

revoke execute on function _post_follow_activity(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The reader's tie-break, and nothing else about it
--
-- Same signature and same return type as `20260912000400`, so this is a plain
-- `create or replace`. The comment and grants are restated, as they are every time.
-- ---------------------------------------------------------------------------

create or replace function follow_activity_people(p_event_ids uuid[])
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
  -- *events* one call resolves, which is nothing to do with how completely each is answered.
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
   -- same one across refetches -- and `followed_id` breaks the tie two appends in one
   -- transaction always produce, because `created_at` defaults to transaction-scoped `now()`.
   -- It is the membership's own primary-key column: immutable, and already in the index this
   -- scan uses. The previous tie-break was `username`, which its owner can change from
   -- Settings, so renaming yourself could reorder somebody else's Feed row.
   order by ev.id, ft.created_at, ft.followed_id;
$$;

comment on function follow_activity_people(uuid[]) is
  'The people one or more follow_added events are about, as far as the caller is allowed to know. The only read path into feed_follow_targets, which has no policy. Definer and takes no viewer, so it can only answer from auth.uid()''s own perspective (20260813001900). Two predicates: can_view_profile on the event''s actor, restated because definer bypasses feed_events_read; can_identify_profile on each named account, so a private account the caller may discover appears as identity only and a blocked or suspended one is absent (20260828000400). The caller is excluded from their own row -- this is a list of people to discover, and Follow on yourself is a control that cannot exist. Since 20260912000400 it takes NO limit and truncates nothing: every member of a named event that this viewer may identify is returned, so the count a Feed row draws is the truth about what they may see rather than a page presented as a total. The bound lives in _post_follow_activity, which stops appending at feed.follow_story_max_people (clamped 1..200) -- a story is bounded by what was true when it was written, and lowering that setting shortens future stories rather than hiding members of stories already told. Ordered by when each follow joined the story and then by followed_id, which is immutable, so the first name is stable across refetches and cannot be changed by somebody renaming themselves.';

revoke execute on function follow_activity_people(uuid[]) from public, anon;
grant  execute on function follow_activity_people(uuid[]) to authenticated;
