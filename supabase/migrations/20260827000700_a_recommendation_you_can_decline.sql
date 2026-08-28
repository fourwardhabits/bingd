-- A For You recommendation you can decline.
-- Founder tranche 2026-08-27 §12: a restrained X on the engine's poster wall, whose
-- dismissal persists across refetch and relaunch.
--
-- ---------------------------------------------------------------------------
-- THE TABLE ALREADY EXISTED, AND HAD NO WRITER
--
-- `recommendation_feedback` (20260813001000) was created for a server-side
-- recommendation engine that was never built: SELECT-own policy, a `kind` check
-- naming `dismiss` among others, and not one INSERT path anywhere — schema, client,
-- or grant. It has held zero rows since the day it was created. This migration gives
-- it its first writer rather than a second table, because the shape is exactly what
-- the feature needs: one row per (user, title, kind), owner-scoped.
--
-- What this deliberately is NOT: a training pipeline. The dismissal is stored as the
-- feedback signal it may one day become (docs/architecture/recommendations.md always
-- intended `dismiss` to feed the engine), but nothing here builds toward that — the
-- client reads the set back and subtracts it from the slate, and that is the entire
-- consumer.
--
-- ---------------------------------------------------------------------------
-- WHY A DEFINER RPC AND NOT AN INSERT POLICY
--
-- The same reasons every other writer here is a function (20260813002300): an
-- operation id so a retried tap is a replay rather than a second row; a rate limit,
-- because an unbounded personal write path is the kind of thing review 28 hunts for;
-- and one place to name what a valid dismissal is. An INSERT policy would allow four
-- `kind`s this feature does not ship and would leave the ledger out of the loop.
--
-- Scope: `dismiss` only. `already_seen`, `saved` and `opened` remain unwritten —
-- they belong to the engine that does not exist, and granting them now would be
-- speculative surface.
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('recommendation_feedback.max_per_day', '200'::jsonb)
on conflict (key) do nothing;

create or replace function dismiss_for_you(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'dismiss_for_you') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate(
    'dismiss_for_you', 'recommendation_feedback.max_per_day', 200
  );

  -- Named refusal rather than a bare 23503 from the foreign key: the client maps
  -- SQLSTATEs, and P0002 is its "no such title" everywhere else.
  if not exists (select 1 from media_items m where m.id = p_media_item_id) then
    raise exception 'no such title' using errcode = 'P0002';
  end if;

  -- Idempotent by shape as well as by ledger: dismissing an already-dismissed title
  -- is the state the caller asked for, not an error. `on conflict` answers the race
  -- of two devices dismissing the same tile.
  insert into recommendation_feedback (user_id, media_item_id, kind)
  values (auth.uid(), p_media_item_id, 'dismiss')
  on conflict (user_id, media_item_id, kind) do nothing;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function dismiss_for_you(uuid, uuid) is
  'Records that the caller does not want a title on their For You wall. Writes recommendation_feedback kind=dismiss, owner-scoped, idempotent under replay (operation ledger) and under repetition (conflict target). Touches nothing else: the title stays rankable, watchlistable, and searchable — this is about the wall, not the catalogue. The client subtracts the set from the slate; no engine consumes it yet, deliberately.';

revoke execute on function dismiss_for_you(uuid, uuid) from public, anon, authenticated;
grant  execute on function dismiss_for_you(uuid, uuid) to authenticated;
