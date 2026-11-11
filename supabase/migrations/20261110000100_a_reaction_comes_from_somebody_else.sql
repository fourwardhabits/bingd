-- A reaction comes from somebody else.
-- Specification: founder report of 2026-11-10 (Notion "Reaction UI: self-post controls,
-- consistent icons, and affinity-ranked names"). FOUNDER DECISION REQUIRED before this is
-- applied anywhere: it changes what an older client can do, see "Older clients" below.
--
-- ---------------------------------------------------------------------------
-- What the founder saw
--
-- Their own ranking of Logan (2017), opened from a notification, offered them an outline
-- heart beside the one reaction a friend had left. Nothing anywhere stopped an author
-- reacting to themselves: the client drew the control on every post, and `set_reaction`
-- only declined to *notify* the author of their own reaction (20260816000200).
--
-- The client now draws no reaction control on the reader's own post or comment. This is
-- the same rule in the two writers, so a client that still draws one — or a request made
-- without a client — gets a refusal rather than a row.
--
-- ---------------------------------------------------------------------------
-- What does not change
--
--   **No row is deleted.** Self-reactions written before this migration stay in
--   `reactions` and `comment_reactions` exactly as they are. The Feed's read leaves them
--   out of what it counts and names (`features/feed/use-reactions.ts`); that is a display
--   decision and is reversible by one line, which a delete would not be.
--
--   **Removal still works on your own post.** A null kind is not a reaction, so taking a
--   historical self-reaction back is allowed, idempotently, as it always was.
--
--   **The visibility answer is unchanged and comes first.** A caller who may not view
--   the event or comment gets the same P0002 a missing one does, before any of this is
--   asked; only the author can reach the new refusal, and the author already knows the
--   post exists.
--
--   **Everything else in both bodies is the previous definition verbatim**:
--   `set_reaction` is 20260819000400's (claim, rate, check, pair lock, re-check, write,
--   inbox row) and `_set_comment_reaction` is 20260827000500's.
--
-- ---------------------------------------------------------------------------
-- Older clients
--
-- A phone that has not taken the OTA still draws the heart on its own posts. Tapping it
-- now raises 42501 "cannot react to your own activity", and `feed.tsx` shows that in its
-- existing "Could not save your reaction" alert. Nothing else on that client changes.
-- ---------------------------------------------------------------------------

create or replace function set_reaction(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_kind          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_kind  text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_reaction') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_reaction', 'reactions.max_per_day', 200);

  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if v_actor <> auth.uid() then
    perform _lock_pair(auth.uid(), v_actor);
  end if;

  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from reactions
     where feed_event_id = p_feed_event_id and user_id = auth.uid();
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  -- 20261110000100: after the removal branch, so a historical self-reaction can still be
  -- taken back.
  if v_actor = auth.uid() then
    raise exception 'cannot react to your own activity' using errcode = '42501';
  end if;

  if v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  insert into reactions (feed_event_id, user_id, kind)
  values (p_feed_event_id, auth.uid(), v_kind)
  on conflict (feed_event_id, user_id) do update
    set kind = excluded.kind;

  -- The actor is never the caller here any more, but the guard stays: it is the
  -- notification's own rule, and it should not depend on the refusal above.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'reaction', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('kind', v_kind))
    on conflict (recipient_id, actor_id, subject_id, type) where type = 'reaction'
      do nothing;
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

comment on function set_reaction(uuid, uuid, text) is
  'Sets, changes or removes the caller''s one reaction to a feed event (PRD §14). Null kind removes, idempotently. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Since 20260819000400 the visibility check is made, then the pair lock taken, then the check remade under it. Since 20261110000100 refuses a reaction to the caller''s own activity with 42501; removing one is still allowed, and existing rows are untouched. Rate-limited per day. Writes the PRD §15 inbox row once per (reactor, event).';

create or replace function _set_comment_reaction(p_comment_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok     boolean;
  v_author uuid;
  v_kind   text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  if v_kind is not null
     and v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  select true, c.author_id into v_ok, v_author
    from comments c
    join feed_events e on e.id = c.feed_event_id
   where c.id = p_comment_id
     and c.deleted_at is null
     and can_view_profile(auth.uid(), c.author_id)
     and can_view_profile(auth.uid(), e.actor_id);

  if v_ok is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from comment_reactions
     where comment_id = p_comment_id and user_id = auth.uid();
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  -- 20261110000100: the same rule as `set_reaction`, after the removal branch.
  if v_author = auth.uid() then
    raise exception 'cannot react to your own comment' using errcode = '42501';
  end if;

  insert into comment_reactions (comment_id, user_id, kind)
  values (p_comment_id, auth.uid(), v_kind)
  on conflict (comment_id, user_id) do update
    set kind = excluded.kind;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

-- `create or replace` keeps the grants 20260827000500 revoked, but they are restated so
-- this file alone says who may call it.
revoke all on function _set_comment_reaction(uuid, text) from public;
revoke all on function _set_comment_reaction(uuid, text) from anon;
revoke all on function _set_comment_reaction(uuid, text) from authenticated;

comment on function _set_comment_reaction(uuid, text) is
  'The visibility check and the write behind both set_comment_reaction signatures. Since 20261110000100 refuses a reaction to the caller''s own comment with 42501; removing one is still allowed, and existing rows are untouched. Internal: not granted to any client role, because it neither claims an operation nor spends a rate slot.';
