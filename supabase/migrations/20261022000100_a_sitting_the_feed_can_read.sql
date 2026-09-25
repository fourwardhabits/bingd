-- ===========================================================================
-- A SITTING THE FEED CAN READ (#209 founder QA, 2026-09-25)
--
-- Two defects in `20261020000100`, both found on staging the moment a real sitting
-- existed, and neither visible to a mocked client or to PGlite.
--
-- ---------------------------------------------------------------------------
-- 1. EVERY ACTIVITY READ ANSWERED 300
--
-- Feed and Profile → Recent activity both said "Could not load activity". PostgREST
-- answered every `feed_events?select=…,media_items(…)` with
--
--   PGRST201  Could not embed because more than one relationship was found for
--             'feed_events' and 'media_items'
--     many-to-one   feed_events_media_item_id_fkey
--     many-to-many  feed_ranking_titles
--
-- PostgREST treats any table whose primary key is made of foreign keys to two tables as a
-- many-to-many junction between them, and it builds that from the catalogue whatever the
-- grants say — `feed_ranking_titles` is revoked from every client role and still counted.
-- `primary key (event_id, media_item_id)` therefore gave `feed_events` a second path to
-- `media_items`, and every bare `media_items(…)` embed from it became ambiguous: the Feed,
-- Recent activity, the comment page and the Awards reads that go through `feed_events`.
-- Not the QA row: the failure is at schema resolution, before a single row is read.
--
-- **The fix is here rather than in the client**, because every bundle already installed —
-- production's included, the day this is promoted — makes the bare embed. A surrogate key
-- stops the table being a junction; the membership rule it expressed moves to a unique
-- constraint, which `on conflict (event_id, media_item_id)` infers exactly as it inferred
-- the primary key. (The client also names the column now, as `profiles:actor_id` always
-- has, so the next junction cannot do this again.)
--
-- ---------------------------------------------------------------------------
-- 2. A SITTING COULD STILL POST ITS TITLES ONE BY ONE
--
-- `rank_backlog_start` resumes a title's open native session *as itself* (`20261019000100`:
-- "a native one still posts when it finishes"). A title logged and then left at "How was
-- it?" has such a session, so when the sitting finished it `_rank_finalize` posted an
-- ordinary `title_ranked` — and `rank_batch_note` then added the same title to the
-- sitting's post. The founder's QA sitting of three is on staging as the post *and* two
-- singles.
--
-- The kind is not changed to make it silent: `first` is also what fulfils a pending
-- recommendation (`recommendation_ranked`), and that must keep happening. Instead the
-- sitting **absorbs** the single post that this same placement wrote. It is found exactly,
-- not by a time window: `_rank_finalize` writes the placement's ledger row and its feed row
-- in one transaction, so they share one `now()`. Only the title's latest placement, only a
-- `first` one, and never a rewatch.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Not a junction
-- ---------------------------------------------------------------------------

alter table feed_ranking_titles drop constraint feed_ranking_titles_pkey;
alter table feed_ranking_titles add column id bigint generated always as identity primary key;
alter table feed_ranking_titles
  add constraint feed_ranking_titles_member unique (event_id, media_item_id);

comment on table feed_ranking_titles is
  'The titles in one ranking_batch feed post. The surrogate key is load-bearing '
  '(20261022000100): a primary key made of the two foreign keys makes PostgREST read this '
  'as a feed_events<->media_items junction and every bare media_items embed from '
  'feed_events fails with PGRST201.';


-- ---------------------------------------------------------------------------
-- 2. The sitting absorbs the single post its own placement wrote
-- ---------------------------------------------------------------------------

/**
 * The single `title_ranked` that the caller's latest placement of this title posted, if
 * that placement was a first ranking made between `p_since` and `p_until`. Shared by
 * `rank_batch_note` and the one-time repair below, so the two cannot disagree about which
 * row is "the same act".
 *
 * The bounds are a guard, not the matching rule — the match is the shared transaction
 * time. They exist because `rank_batch_note` accepts any title the caller has ranked, and
 * without them a call naming a film ranked last spring would delete last spring's post.
 */
create or replace function _ranking_batch_absorb(
  p_actor         uuid,
  p_media_item_id uuid,
  p_since         timestamptz,
  p_until         timestamptz
)
returns integer
language sql
set search_path = public
as $$
  with latest as (
    select rp.created_at, rp.kind
      from ranking_placements rp
     where rp.user_id = p_actor and rp.media_item_id = p_media_item_id
     order by rp.created_at desc
     limit 1
  ),
  gone as (
    delete from feed_events fe
     using latest l
     where fe.actor_id = p_actor
       and fe.media_item_id = p_media_item_id
       and fe.type = 'title_ranked'
       and l.kind = 'first'
       and l.created_at between p_since and p_until
       and fe.created_at = l.created_at
       and coalesce(fe.payload ->> 'again', 'false') <> 'true'
    returning 1
  )
  select count(*)::integer from gone;
$$;

comment on function _ranking_batch_absorb(uuid, uuid, timestamptz, timestamptz) is
  'Removes the single title_ranked post written by the actor''s latest placement of a title '
  'when that placement was a first ranking inside the given bounds, identified by the shared '
  'transaction time. Called when the title joins a ranking_batch, so a sitting is one post.';

revoke execute on function _ranking_batch_absorb(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;


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

  -- A suspended account may not post activity, which is the whole point of the guard.
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

  insert into feed_events (actor_id, type, media_item_id, payload, causal_at, causal_step)
  values (
    auth.uid(), 'ranking_batch', p_media_item_id,
    jsonb_build_object('sitting', p_sitting::text), now(), 0
  )
  on conflict (actor_id, (payload ->> 'sitting')) where type = 'ranking_batch'
    do update set payload = feed_events.payload
  returning id into v_event;

  insert into feed_ranking_titles (event_id, media_item_id)
  values (v_event, p_media_item_id)
  on conflict (event_id, media_item_id) do nothing;

  -- The sitting is the post: a resumed native session's own single post goes
  -- (20261022000100). Only when this call added the title, and only a placement from the
  -- last hour — the client calls this the moment a placement finishes.
  if found then
    perform _ranking_batch_absorb(auth.uid(), p_media_item_id, now() - interval '1 hour', now());
  end if;

  select count(*) into v_count from feed_ranking_titles where event_id = v_event;

  -- `causal_at` deliberately not bumped (20261020000100): the Feed pages by a keyset over it.
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
  'Adds one finished Unranked placement to that sitting''s grouped feed post, creating the '
  'post on the first title, and removes the single title_ranked post that same placement '
  'wrote if it was a resumed first ranking (20261022000100), so a sitting is one post. '
  'Ranking activity only: writes no watch_events row and moves no watch date. Idempotent by '
  'operation id and by membership key. Refuses a title this caller has not ranked.';

revoke execute on function rank_batch_note(uuid, uuid, uuid) from public, anon;
grant execute on function rank_batch_note(uuid, uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. The sittings that already exist
--
-- Staging only in practice: production has no ranking_batch rows until this ships, so
-- there this is a no-op. It removes nothing but the duplicates rule 2 would have prevented,
-- and it adds nothing — no historical post is created.
-- ---------------------------------------------------------------------------

select _ranking_batch_absorb(
         fe.actor_id, frt.media_item_id, frt.placed_at - interval '1 hour', frt.placed_at
       )
  from feed_events fe
  join feed_ranking_titles frt on frt.event_id = fe.id
 where fe.type = 'ranking_batch';

notify pgrst, 'reload schema';
