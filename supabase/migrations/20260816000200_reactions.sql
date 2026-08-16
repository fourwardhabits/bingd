-- Reactions become writable.
-- Specification: PRD §14 (the six-value set, one per user per item, changeable and
-- removable) · PRD §15 (inbox event) · api.md §1 · founder tranche, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- What was already here, and what was missing
--
-- 20260813000600 created `reactions` with the right shape: primary key
-- (feed_event_id, user_id), which is PRD §14's one-reaction-per-user rule expressed
-- as a constraint rather than as a check somebody has to remember to write.
-- 20260813001500 closed `kind` to six values, so the column cannot become a free-text
-- field in a modified client. And there is a select policy.
--
-- What is missing is any way to write one. That is not an oversight in the schema, it
-- is the schema's architecture: no table in this database has an insert policy, and
-- every write goes through a SECURITY DEFINER function that authorises it first.
-- Adding an insert policy here instead would be the wrong shape twice over -- a
-- policy cannot express "and only on an event you are allowed to see", and it would
-- put the first client-side write into a database that has been carefully built
-- without any.
--
-- ---------------------------------------------------------------------------
-- The authorisation that is easy to leave out
--
-- The obvious body for this function is an upsert keyed on (event, auth.uid()). That
-- is wrong, and wrong in a way that would not show up in ordinary use: nothing in it
-- checks that the caller may *see* the event being reacted to.
--
-- `feed_events` is readable through `can_i_view(actor_id)`, so a client cannot list
-- someone else's private activity. But event ids are uuids that travel -- in a share
-- link's analytics, in a crash report, in a screenshot -- and an unchecked writer
-- turns a known id into two capabilities: confirming the event exists (a row appears)
-- and putting a row naming yourself against a private account's activity, which
-- becomes an inbox notification they receive from someone they have not let in.
--
-- So the function resolves the event and applies AD-5 to its actor. A caller who may
-- not view the actor gets the same P0002 as for an event that does not exist, because
-- distinguishing them is itself the disclosure.
-- ---------------------------------------------------------------------------

create or replace function set_reaction(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  -- Null removes. A separate `remove_reaction` would need its own operation id, its
  -- own idempotency entry and its own grant, to express one of two states of a single
  -- toggle.
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
  -- Not on a change of reaction either: `where not exists` means moving from `love`
  -- to `agree` does not ring twice. The event is "somebody reacted", and they had.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select v_actor, 'reaction', auth.uid(), 'feed_event', p_feed_event_id,
           jsonb_build_object('kind', v_kind)
     where not exists (
       select 1 from notifications n
        where n.recipient_id = v_actor
          and n.actor_id = auth.uid()
          and n.subject_id = p_feed_event_id
          and n.type = 'reaction'
     );
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

comment on function set_reaction(uuid, uuid, text) is
  'Sets, changes or removes the caller''s one reaction to a feed event (PRD §14). Null kind removes, idempotently. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Writes the PRD §15 inbox row once per (reactor, event), never for one''s own activity.';

-- ---------------------------------------------------------------------------
-- Reading them back
--
-- No new read path. `reactions_read` already answers this correctly and, importantly,
-- answers it *per viewer*: it requires `can_i_view` on both the reactor and the
-- event's actor, so a blocked user's reaction is absent from the count rather than
-- counted anonymously. A definer aggregate would have had to rebuild that filter and
-- would have got it wrong the first time.
--
-- The index is the missing half. `reactions_event` exists for the by-event lookup;
-- this one serves "did I react", which every rendered row asks.
-- ---------------------------------------------------------------------------

create index if not exists reactions_user on reactions (user_id);

-- 20260813001800 made execute default-deny and 20260813002100 issued the global form.
grant execute on function set_reaction(uuid, uuid, text) to authenticated;
