-- Reactions get the rate limit PRD §14 asks for, and the notification guard becomes
-- a schema invariant rather than a query.
-- Found by: independent review of 20260816000200, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- 1. A ceiling on inbox rows
--
-- PRD §14: reactions are "rate-limited to prevent notification flooding". They were
-- not. The `where not exists` guard makes the notification once per (reactor, event),
-- which stops one activity ringing repeatedly, and does nothing about one account
-- reacting to a thousand *different* activities belonging to the same person.
--
-- The helper is `_assert_operation_rate`, introduced with watch tagging in the
-- previous migration; the reasoning for counting `processed_operations` rather than
-- the created rows lives there. Two hundred a day is not a product decision -- it is
-- comfortably above a heavy session on a busy feed and far below anything that reads
-- as automated, and it is in `app_config` so raising it is not a migration.
--
-- ---------------------------------------------------------------------------
-- 2. The notification guard, as a constraint
--
-- `insert ... where not exists` expresses "once per reactor per event" and does not
-- establish it: two concurrent calls can both see no row and both insert. Review
-- could not construct that race, because the reaction upsert takes a row lock on the
-- same key first and serialises the pair -- so this is hardening rather than a fix.
--
-- It is worth doing anyway, because the serialisation is a property of the *current*
-- body. A later change that moves the notification before the upsert, or adds a path
-- that notifies without touching `reactions`, loses it silently. A partial unique
-- index cannot be lost silently.
--
-- Partial, and scoped to reaction rows only: the other notification types have their
-- own multiplicity. A watch tag is already once-per-person-per-title by the same
-- `v_added` logic, but a future type may legitimately repeat, and a blanket
-- constraint would be a trap for whoever adds it.
-- ---------------------------------------------------------------------------

create unique index if not exists notifications_one_reaction_per_event
  on notifications (recipient_id, actor_id, subject_id, type)
  where type = 'reaction';

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

  -- Existence and visibility resolved together, and reported together. A caller who
  -- cannot see the actor must not be able to tell an event they may not view from an
  -- event that is not there.
  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from reactions
     where feed_event_id = p_feed_event_id and user_id = auth.uid();
    -- Deliberately not an error when there was nothing to remove. Removal is a
    -- toggle reaching a state, not a transaction against a row: a double tap, or a
    -- retry after a dropped response, means "I have no reaction to this", and that
    -- is now true either way.
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  -- Checked here as well as by the column constraint, so a client gets a field error
  -- it can act on rather than a 23514 it has to guess at. The list is PRD §14's, and
  -- the values are meanings rather than glyph names -- swapping a thumb for a face is
  -- a copy change, never a data migration.
  if v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  insert into reactions (feed_event_id, user_id, kind)
  values (p_feed_event_id, auth.uid(), v_kind)
  on conflict (feed_event_id, user_id) do update
    set kind = excluded.kind;

  -- PRD §15's inbox event. Written, not delivered: push is deliberately dark in v1
  -- (AD-10), and the row is what makes turning it on a server flag rather than a
  -- release. Recipient-scoped by `notifications_own`, and cascades with either party.
  --
  -- Not for your own activity. A notification telling you that you reacted to
  -- yourself is noise the moment anybody uses their own feed.
  --
  -- `on conflict do nothing` against the partial unique index above, rather than the
  -- `where not exists` this replaced: same behaviour on the ordinary path, and it
  -- stays correct if a later change stops the reaction upsert from serialising the
  -- callers first.
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
  'Sets, changes or removes the caller''s one reaction to a feed event (PRD §14). Null kind removes, idempotently. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Rate-limited per day. Writes the PRD §15 inbox row once per (reactor, event), never for one''s own activity.';

grant execute on function set_reaction(uuid, uuid, text) to authenticated;
