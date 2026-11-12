-- A reaction from anyone, the author included.
-- Specification: founder decision of 2026-11-11 (9:23 PM CST): users can react to their
-- own posts and comments, and that is intentional. This reverses 20261110000100's refusal.
--
-- ---------------------------------------------------------------------------
-- What changes
--
-- `set_reaction` and `_set_comment_reaction` no longer raise 42501 "cannot react to your
-- own activity" / "...comment". Those two refusals are the only thing removed. No later
-- migration (20261112000100 to 20261114000400) redefines either function or adds another
-- self-reaction check to a writer, so 20261110000100's bodies are each function's current
-- definition, and everything else in them is kept verbatim:
--
--   `set_reaction`: write check, operation claim, daily rate limit, P0002 visibility
--   answer first, pair lock, visibility re-check under the lock, removal branch, kind
--   check, the write, and the inbox row.
--
--   `_set_comment_reaction`: kind check, P0002 visibility answer first, removal branch,
--   the write.
--
-- ---------------------------------------------------------------------------
-- What does not change
--
--   **An author is still never notified of their own reaction** (20260816000200). The
--   inbox row is written only when the activity's actor is not the caller. Comment
--   reactions write no inbox row at all, as before.
--
--   **No row is touched.** Self-reactions written before 20261110000100 were never
--   deleted; they count again the normal way, because the client stops leaving them out.
--
--   **Grants.** `create or replace` keeps every grant. They are restated anyway, exactly
--   as they stand: `set_reaction` executable by `authenticated` (20260816000400), and
--   `_set_comment_reaction` granted to no client role (20260827000500, 20261110000100).
--   The public `set_comment_reaction` signatures are not redefined here.
--
--   **The award does not change.** `_award_metric`'s heart-magnet still counts only other
--   people's reactions to your activity (20261114000200). That rule predates
--   20261110000100 and is about which reactions earn an award, not about which may exist.
--
-- ---------------------------------------------------------------------------
-- Clients
--
-- A client from before the reversal OTA hides its own heart and leaves self-reactions out
-- of what it counts; it simply keeps doing so, and every write it can make still works.
-- The current client draws the heart everywhere. Against a server that still has
-- 20261110000100 alone, its tap is refused and it says "You can't react to your own
-- post." calmly; after this migration that refusal never happens.
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

  if v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  insert into reactions (feed_event_id, user_id, kind)
  values (p_feed_event_id, auth.uid(), v_kind)
  on conflict (feed_event_id, user_id) do update
    set kind = excluded.kind;

  -- 20260816000200's rule, and now the only thing standing between an author's own
  -- reaction and their inbox: an author is never notified of their own reaction.
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

grant execute on function set_reaction(uuid, uuid, text) to authenticated;

comment on function set_reaction(uuid, uuid, text) is
  'Sets, changes or removes the caller''s one reaction to a feed event (PRD §14), their own activity included (founder, 2026-11-11; 20261115000100 reverses 20261110000100''s refusal). Null kind removes, idempotently. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Since 20260819000400 the visibility check is made, then the pair lock taken, then the check remade under it. Rate-limited per day. Writes the PRD §15 inbox row once per (reactor, event), and never for a reaction to the caller''s own activity.';

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

  insert into comment_reactions (comment_id, user_id, kind)
  values (p_comment_id, auth.uid(), v_kind)
  on conflict (comment_id, user_id) do update
    set kind = excluded.kind;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

revoke all on function _set_comment_reaction(uuid, text) from public;
revoke all on function _set_comment_reaction(uuid, text) from anon;
revoke all on function _set_comment_reaction(uuid, text) from authenticated;

comment on function _set_comment_reaction(uuid, text) is
  'The visibility check and the write behind both set_comment_reaction signatures. Since 20261115000100 a reaction to the caller''s own comment is accepted like any other (founder, 2026-11-11), reversing 20261110000100. Writes no inbox row. Internal: not granted to any client role, because it neither claims an operation nor spends a rate slot.';
