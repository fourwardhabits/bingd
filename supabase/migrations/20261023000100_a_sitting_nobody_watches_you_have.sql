-- ===========================================================================
-- A SITTING NOBODY WATCHES YOU HAVE (founder, device QA, 2026-09-25)
--
-- The grouped post became visible on the first placement and then changed under its
-- readers: its poster, its title and its count all moved as the sitting went on. Somebody
-- scrolling their feed watched a stranger rank their library in real time.
--
-- Two corrections, and they are the same correction:
--
--   1. **A sitting is published when it ENDS**, not while it runs. Done, the queue
--      emptying, and leaving the flow are the ends; a force-kill is not detected and is
--      not meant to be (founder: "do not over-engineer OS force-kill detection").
--   2. **The representative is the LAST title placed**, not the first. At the moment the
--      post appears, the thing the reader most recently finished is the thing it should
--      show them.
--
-- ---------------------------------------------------------------------------
-- HOW IT IS HIDDEN, AND WHY THAT WAY
--
-- A draft carries a type **no read asks for**. `ACTIVITY_TYPES` in the client is the `IN`
-- clause of every activity read — the feed's and the profile's — so a type absent from it
-- is not fetched rather than fetched and filtered. That is the whole mechanism:
--
--   · no RLS change, so nothing about who may see `feed_events` moves;
--   · no client-side predicate, which is the kind of rule the next client forgets;
--   · the draft is invisible to its own author too, which is what "not publicly visible"
--     has to mean on a surface where the author reads their own activity.
--
-- `causal_at` is set at **finalisation** rather than at creation, so the post sorts into
-- the Feed at the moment the sitting ended — the event's actual activity time — and the
-- keyset the Feed pages by never sees a row before it has its final position.
--
-- A sitting that finishes nothing leaves no draft behind: finalising an empty one deletes
-- it, and `20261020000100`'s rule that zero completions produce no social event is now
-- enforced at the end rather than at the start.
--
-- Forward-only. Any draft already sitting in production or staging from the previous
-- behaviour is published by the backfill at the foot, because it belongs to a sitting that
-- can no longer be running.
-- ===========================================================================

alter table feed_events drop constraint feed_events_known_type;
alter table feed_events add constraint feed_events_known_type check (type in (
  'title_ranked',
  'title_logged',
  'season_completed',
  'list_created',
  'list_added',
  'milestone_reached',
  'joined_from_invitation',
  'watchlist_added',
  'award_earned',
  'goal_completed',
  'follow_added',
  'ranking_batch',
  -- 20261023000100. A sitting still being worked through: real rows, real membership,
  -- and a type no activity read asks for, so nobody sees it until it is finalised.
  'ranking_batch_draft'
));

/**
 * The sitting index has to cover the draft as well, because that is the state the upsert
 * actually contends on — two placements finishing at once both reach for the same draft.
 */
drop index if exists feed_events_ranking_sitting;
create unique index feed_events_ranking_sitting
  on feed_events (actor_id, (payload ->> 'sitting'))
  where type in ('ranking_batch', 'ranking_batch_draft');


-- ---------------------------------------------------------------------------
-- Adding a finished title to this sitting's draft
-- ---------------------------------------------------------------------------

create or replace function rank_batch_note(
  p_operation_id  uuid,
  p_sitting       uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim  record;
  v_event  uuid;
  v_count  integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_batch_note');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  -- Only a title this caller has actually ranked (20261020000100).
  if not exists (
    select 1 from rankings
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    return _record_operation_result(
      p_operation_id, jsonb_build_object('status', 'not_ranked')
    );
  end if;

  /**
   * A **draft**, and it stays one until the sitting ends. `media_item_id` is set to the
   * newest placement each time rather than kept at the first: the representative is the
   * last title finished, and maintaining it here means finalisation has nothing to work
   * out — the row already names the right title whenever the reader stops.
   */
  insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
  values (
    auth.uid(), 'ranking_batch_draft', p_media_item_id,
    jsonb_build_object('sitting', p_sitting::text), now(), 0
  )
  on conflict (actor_id, (payload ->> 'sitting'))
    where type in ('ranking_batch', 'ranking_batch_draft')
    do update set media_item_id = excluded.media_item_id
  returning id into v_event;

  insert into feed_ranking_titles (event_id, media_item_id)
  values (v_event, p_media_item_id)
  on conflict (event_id, media_item_id) do nothing;

  -- The sitting is the post: a resumed native session's own single post goes
  -- (20261022000100). Only when this call added the title.
  if found then
    perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
  end if;

  select count(*) into v_count from feed_ranking_titles where event_id = v_event;

  update feed_events
     set payload = payload || jsonb_build_object('count', v_count)
   where id = v_event;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_note(uuid, uuid, uuid) is
  'Adds one finished Unranked placement to that sitting''s DRAFT post, which no activity '
  'read asks for -- since 20261023000100 the post is invisible until rank_batch_finalize '
  'publishes it, so nobody watches the poster and count change while somebody ranks. Keeps '
  'media_item_id on the newest placement, because the representative is the last title '
  'finished. Still removes the single title_ranked a resumed first ranking wrote, so a '
  'sitting is one post. Ranking activity only: no watch_events row, no watch date moved. '
  'Idempotent by operation id and by membership key.';

revoke execute on function rank_batch_note(uuid, uuid, uuid) from public, anon;
grant execute on function rank_batch_note(uuid, uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Ending the sitting
-- ---------------------------------------------------------------------------

create or replace function rank_batch_finalize(p_operation_id uuid, p_sitting uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim record;
  v_event uuid;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_batch_finalize');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  select id into v_event
    from feed_events
   where actor_id = auth.uid()
     and type = 'ranking_batch_draft'
     and payload ->> 'sitting' = p_sitting::text;

  -- Nothing to publish: a sitting that placed nothing, or one already finalised. Both are
  -- the state the caller asked for, so both answer ok.
  if v_event is null then
    return _record_operation_result(p_operation_id, jsonb_build_object('status', 'empty'));
  end if;

  select count(*) into v_count from feed_ranking_titles where event_id = v_event;

  /**
   * A draft with no members cannot happen through `rank_batch_note`, which always adds
   * one — but a title unranked between placement and finalisation could leave one, and a
   * post about nothing is worse than no post.
   */
  if v_count = 0 then
    delete from feed_events where id = v_event;
    return _record_operation_result(p_operation_id, jsonb_build_object('status', 'empty'));
  end if;

  /**
   * Published here, and dated here. `causal_at` is the Feed's keyset, so a post that
   * existed invisibly for ten minutes must enter the ordering at the moment it became
   * real rather than at the moment its first title landed.
   */
  update feed_events
     set type = 'ranking_batch',
         causal_at = now(),
         created_at = now(),
         payload = payload || jsonb_build_object('count', v_count)
   where id = v_event;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', 'ok', 'event_id', v_event, 'count', v_count)
  );
end;
$$;

comment on function rank_batch_finalize(uuid, uuid) is
  'Ends an Unranked sitting and publishes its grouped post: flips the draft to '
  'ranking_batch and dates it now, so it enters the Feed at the moment the sitting ended '
  'rather than when its first title landed. A sitting that completed nothing, or one '
  'already finalised, answers empty and leaves no row. The representative title is '
  'whatever rank_batch_note last set, which is the last title finished. Idempotent.';

revoke execute on function rank_batch_finalize(uuid, uuid) from public, anon;
grant execute on function rank_batch_finalize(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The drafts that predate this
-- ---------------------------------------------------------------------------

/**
 * Every existing `ranking_batch` row was published by the old behaviour and belongs to a
 * sitting that has long since stopped, so there is nothing to hide retroactively and
 * nothing to hide it from. Their representative stays the first title rather than the
 * last: rewriting somebody's published post to name a different film is a change to
 * history, and the rule is forward-only.
 *
 * Stated rather than performed, so the absence of a backfill here is visibly deliberate.
 */
