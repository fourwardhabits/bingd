-- Removing a title from the collection takes its activity with it, and Bingd's
-- aggregate waits for ten ratings.
-- Specification: founder corrections 2026-08-18 §0A, §0B.
--
-- ===========================================================================
-- 1. WHY unlog HAS TO DELETE FEED EVENTS
--
-- `unlog` deletes the `user_media` row and nothing else. `feed_events` has no foreign
-- key to it -- it references `media_items` and `profiles`, which both survive -- so
-- after a removal the feed still reads "Sai ranked Inception", the profile activity
-- list still carries it, and `title_reviews` still finds the actor through the event.
-- The collection says the title is gone and every social surface says it is ranked.
--
-- That was recorded as a known gap in the device checklist of 2026-08-18 and the
-- founder has ruled it out for V1: an activity item that states something the database
-- no longer believes is not a stale cache, it is a false claim about a person, and it
-- is the one the app makes loudest.
--
-- **Delete rather than suppress**, and the reasoning is worth keeping because the
-- other choice is defensible too. A `retracted_at` column would preserve the history
-- and cost one predicate in the feed view, the profile activity read, the actor
-- activity read, `title_reviews`, the notification join and every reader added later.
-- The defect being closed here is precisely a reader that did not know it had to
-- filter. A rule enforced by deletion cannot be forgotten by a query written next
-- month; a rule enforced by a predicate is forgotten by exactly one.
--
-- **What goes with it.** `reactions` and `comments` both reference `feed_events` with
-- `on delete cascade`, so other people's reactions and comments on that activity are
-- removed. That is deliberate and it is the ordinary shape of the act: the activity
-- they were attached to no longer exists, and leaving a comment thread hanging off a
-- deleted event is the same false claim with an extra step. The notifications *about*
-- those reactions and comments are deleted here explicitly, because
-- `notifications.subject_id` is a bare uuid with no foreign key -- `my_notifications`
-- left-joins it, so a survivor would render as a notice about a title that is null.
--
-- **Three types, not every type.** `title_ranked`, `title_logged` and
-- `season_completed` are the events that assert collection state. `list_added` also
-- names a media item and asserts something else entirely -- that the title is on a
-- list -- which removal from a collection does not make untrue. Only `title_ranked` is
-- written today; the other two are named so that writing them later inherits the rule
-- rather than reopening the gap.
--
-- **All of them, not the latest one.** `_rank_finalize` writes a *new* event every
-- time a ranking completes, and unranking, reranking and rebucketing all complete one
-- (review 16, `20260817001100`). A (user, title) pair can therefore hold many. Every
-- one of them claims the title is in the collection, so every one of them goes.
--
-- **`rank_unrank` is deliberately not touched.** It is called by `rank_rebucket`, so
-- deleting events there would silently destroy the reactions on an activity every time
-- somebody moved a title between bands -- which is the outcome review 16 examined and
-- rejected in favour of reading the latest event. Removing a *ranking* also leaves the
-- title watched, which is a different fact from removing the title.
--
-- 2. WHY THE BINGD THRESHOLD MOVES TO TEN
--
-- `score.community_min_ratings` has been 3 since `20260816000000`. Three strangers is
-- not an app-wide opinion; it is three people, and presenting their mean under the
-- product's own name lends it an authority it has not earned. Ten is the founder's
-- number. The client already draws the grey circle and says "Not enough ratings"
-- below the threshold and never counts down to it, so nothing on the client changes
-- with this value.
--
-- It is an `update`, not an `insert ... on conflict`: the row is created by
-- `20260816000000` and a database missing it has a larger problem than this file.
-- ===========================================================================

create or replace function unlog(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'unlog') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_unranked(p_media_item_id);

  delete from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  get diagnostics v_deleted = row_count;

  -- offline-sync.md §5: an operation targeting something already gone fails and
  -- leaves the queue, rather than retrying against a row that will never return.
  if v_deleted = 0 then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  -- The caller's own activity about this exact title, and nobody else's.
  --
  -- One statement, because the second half needs the ids the first half removed:
  -- `notifications.subject_id` is a bare uuid with no foreign key, so nothing
  -- cascades to it and a survivor renders through `my_notifications`' left join as a
  -- notice about a null title. `reactions` and `comments` do have the key and do
  -- cascade, which is where the reactions and comments on that activity go.
  with removed as (
    delete from feed_events
     where actor_id = auth.uid()
       and media_item_id = p_media_item_id
       and type in ('title_ranked', 'title_logged', 'season_completed')
    returning id
  )
  delete from notifications n
   using removed r
   where n.subject_type = 'feed_event'
     and n.subject_id = r.id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function unlog(uuid, uuid) is
  'Removes a title from the collection: the user_media row, and the caller''s own title_ranked, title_logged and season_completed events for that exact title, whose reactions and comments cascade. Refuses a ranked title with 55000, since queuing it would discard ranking work silently on reconnect. Does not touch the watchlist: removal is not a decision to watch it again.';

update app_config
   set value = '10'::jsonb
 where key = 'score.community_min_ratings';
