-- Who I watched with, made writable.
-- Specification: PRD §14 (watch tagging) · PRD §15 (inbox event) · PRD §22 (blocks)
-- · data-model.md §6 · founder tranche, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- What the table already guarantees, and what it cannot
--
-- 20260813000800 got the structure right, and the comment on it is worth repeating
-- because it is the feature's whole safety argument: a tag is a row on the *tagger's*
-- watch, and nothing in `watch_tags` references `user_media` or `rankings`. So PRD
-- §14's "no effect on the tagged user's collection" is not a rule anybody has to
-- enforce -- there is no column through which it could be violated.
--
-- `unique (tagger_id, tagged_id, media_item_id)` makes duplicate tagging impossible,
-- `no_self_tag` makes tagging yourself impossible, and `removed_by_tagged` lets the
-- tagged person hide a tag without editing somebody else's log. 20260813001900 gave
-- it `watch_tag_visible(tag_id)`, which folds blocks, removal and profile visibility
-- into one answer and takes the row id rather than the parties, so it cannot be used
-- to probe whether two chosen people have blocked each other.
--
-- Two rules cannot live on the table, because both are conditions across several
-- rows, and they are what this migration is for:
--
--   - who may be tagged: someone the tagger follows, or who follows the tagger;
--   - at most ten per watch.
--
-- ---------------------------------------------------------------------------
-- Why one function that sets the whole list
--
-- The obvious API is add_tag and remove_tag. This is `set_watch_tags`, taking the
-- complete set for one watch, because that is what the control actually is: a picker
-- the user opens, ticks people in, and closes. Expressed as add/remove, closing that
-- picker is N writes whose failure modes interleave -- three added, one removed, the
-- fourth add refused for a follow that lapsed, and now the screen and the database
-- disagree with no single operation to retry.
--
-- One call is also one idempotency key, which matters offline: the outbox replays an
-- intent, and "these five people" replays correctly where "add Beth" does not once
-- Beth has been removed by hand in between.
--
-- The cost is that a caller must send the full list, so a stale client can drop a tag
-- it never knew about. That is the ordinary last-write-wins of a set control, and it
-- is confined to one user's own tags on one of their own watches.
-- ---------------------------------------------------------------------------

-- The cap, alongside the other tunables rather than as a literal in a function body.
insert into app_config (key, value)
values ('watch_tags.max_per_watch', '10'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Rate limiting the social writes
--
-- PRD §14 requires reactions to be "rate-limited to prevent notification flooding",
-- and the same sentence is true of tagging for the same reason: both put a row in
-- somebody else's inbox, and both are cheap enough to issue in a loop. Independent
-- review, 2026-08-16, found the reaction path unlimited -- one account reacting to a
-- thousand visible events files a thousand inbox rows, and push being dark today only
-- means the backlog is waiting for the reader that turns it on.
--
-- `report.max_per_day` set the pattern in 20260813001700, counting rows in the table
-- the write itself creates. That does not work here: a reaction can be removed, so
-- counting `reactions` would let a loop of react-and-unreact run forever.
--
-- `processed_operations` is the right counter. Every one of these RPCs already claims
-- an operation id there, tagged with its `kind`, and a claim is never withdrawn -- so
-- it counts *attempts*, which is exactly what flooding is, rather than surviving
-- state. Its retention is already required to exceed the longest a client can hold an
-- unsent operation, which is days, so a one-day window is safely inside it.
--
-- The check runs after the claim, so the operation being tested is itself counted.
-- That is deliberate: it makes the limit "the Nth call of the day is refused" rather
-- than an off-by-one argument about whether it is the Nth or the N+1th.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('reactions.max_per_day', '200'::jsonb),
  ('watch_tags.max_calls_per_day', '100'::jsonb)
on conflict (key) do nothing;

create or replace function _assert_operation_rate(
  p_kind       text,
  p_config_key text,
  p_fallback   integer
)
returns void
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_max  integer;
  v_used integer;
begin
  select coalesce((select (value)::integer from app_config where key = p_config_key), p_fallback)
    into v_max;

  select count(*) into v_used
    from processed_operations
   where user_id = auth.uid()
     and kind = p_kind
     and processed_at > now() - interval '1 day';

  if v_used > v_max then
    raise exception 'you have done that too many times today'
      using errcode = '53400',
            hint = format('%s is limited to %s per day', p_kind, v_max);
  end if;
end;
$$;

comment on function _assert_operation_rate(text, text, integer) is
  'Per-day ceiling on one kind of operation, counted from processed_operations rather than from the rows the operation creates -- so a react-and-unreact loop is bounded, which counting reactions would not be. PRD §14. Internal: exposing it would report another account''s activity level.';

/**
 * Whether the caller may tag this person.
 *
 * Follow in *either* direction, which is PRD §14 exactly: "Bingd users the tagger
 * follows or who follow the tagger". A pending request is not a follow -- only
 * `approved` counts, or a follow request to a private account would become a way to
 * put your name in their notifications before they let you in.
 *
 * Blocks are checked through `blocked_between` rather than by reading `blocks`,
 * because `blocks_read` deliberately hides a block from the person it was made
 * against: an inline subquery would return false for precisely the caller who must be
 * refused. This is the same reasoning `watch_tag_visible` records.
 *
 * Takes the subject only. The perspective is always `auth.uid()`'s, so this cannot be
 * turned into a "do these two people follow each other" oracle.
 */
create or replace function _can_tag(p_tagged uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_tagged is not null
     and p_tagged <> auth.uid()
     and exists (select 1 from profiles p where p.id = p_tagged and p.status = 'active')
     and not blocked_between(p_tagged, auth.uid())
     and exists (
       select 1 from follows f
        where f.state = 'approved'
          and ((f.follower_id = auth.uid() and f.followee_id = p_tagged)
            or (f.follower_id = p_tagged   and f.followee_id = auth.uid()))
     );
$$;

comment on function _can_tag(uuid) is
  'PRD §14: a taggable person is one the caller follows or who follows the caller, approved in at least one direction, not blocked either way, and not suspended. Internal to set_watch_tags -- exposing it would answer questions about other people''s follow graph.';

create or replace function set_watch_tags(
  p_operation_id  uuid,
  p_media_item_id uuid,
  -- The complete set. An empty array clears every tag on this watch; null is
  -- rejected rather than treated as empty, so a client bug cannot silently erase
  -- somebody's companions by omitting the field.
  p_tagged_ids    uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max      integer;
  v_wanted   uuid[];
  v_bad      uuid;
  v_added    uuid[];
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watch_tags') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_watch_tags', 'watch_tags.max_calls_per_day', 100);

  if p_tagged_ids is null then
    raise exception 'the companion list is required; send an empty array to clear it'
      using errcode = '22023';
  end if;

  -- A tag records who you watched something with, so there has to be a watch. This
  -- also makes the media item's existence and kind somebody else's problem already
  -- solved: you cannot have logged a series (PRD §10).
  if not exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'log the watch before saying who you watched it with'
      using errcode = 'P0002';
  end if;

  -- Deduplicated before counting, so sending the same friend twice is a typo rather
  -- than two of the ten.
  --
  -- Every `unnest` below is aliased `w(uid)`, and the alias is not decoration.
  -- Written as `unnest(v_wanted) as id`, the column is called `id` -- and inside a
  -- correlated subquery over `watch_tags`, which has its own `id`, the inner one
  -- wins. `t.tagged_id = id` then silently means `t.tagged_id = t.id`, which is never
  -- true, so the "which of these are new" query below returned *everyone* and the
  -- same list saved three times filed three notifications.
  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(p_tagged_ids) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'watch_tags.max_per_watch'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can tag up to % people on one watch', v_max using errcode = '22023';
  end if;

  -- Refused as a whole rather than partially applied. Silently dropping the one
  -- person the caller is no longer connected to would leave them believing a tag
  -- exists, and the screen would agree until it next reloaded.
  select w.uid into v_bad from unnest(v_wanted) as w(uid) where not _can_tag(w.uid) limit 1;
  if v_bad is not null then
    raise exception 'you can only tag people you follow or who follow you'
      using errcode = '42501';
  end if;

  -- Which of these are new, captured before the write, so the notification below
  -- fires for a genuinely new tag and not for one that was already there.
  select coalesce(array_agg(w.uid), '{}') into v_added
    from unnest(v_wanted) as w(uid)
   where not exists (
     select 1 from watch_tags t
      where t.tagger_id = auth.uid()
        and t.tagged_id = w.uid
        and t.media_item_id = p_media_item_id
   );

  delete from watch_tags
   where tagger_id = auth.uid()
     and media_item_id = p_media_item_id
     and tagged_id <> all (v_wanted);

  -- do nothing, not do update: a row that survives keeps its `removed_by_tagged`.
  -- Overwriting it would let the tagger un-hide a tag the tagged person hid, simply
  -- by reopening the picker and saving -- which is the tagged person's decision being
  -- reversed by the one party PRD §14 says cannot reverse it.
  insert into watch_tags (tagger_id, tagged_id, media_item_id)
  select auth.uid(), w.uid, p_media_item_id from unnest(v_wanted) as w(uid)
  on conflict (tagger_id, tagged_id, media_item_id) do nothing;

  -- PRD §15's inbox event, written and not delivered (push is dark in v1, AD-10).
  -- Only for newly added people, so re-saving the same list does not ring again.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
  select w.uid, 'watch_tag', auth.uid(), 'media_item', p_media_item_id, '{}'::jsonb
    from unnest(v_added) as w(uid);

  return jsonb_build_object('status', 'ok', 'tagged', coalesce(array_length(v_wanted, 1), 0));
end;
$$;

comment on function set_watch_tags(uuid, uuid, uuid[]) is
  'Replaces the caller''s companion list for one of their own watches (PRD §14). Refuses the whole call if any person is not connected, blocked, or suspended, rather than partially applying. Preserves removed_by_tagged on surviving rows, so a tagger cannot un-hide a tag the tagged person hid.';

/**
 * The tagged person's own control.
 *
 * Hides the tag rather than deleting it, which is PRD §14 exactly: "This hides the
 * tag; it does not alter the tagger's log." The tagger's record of who they watched
 * something with is theirs, and the tagged person's presence in other people's feeds
 * is theirs -- deleting the row would settle both questions in one direction.
 *
 * Takes the row id and matches on `tagged_id = auth.uid()`, so it can only ever act
 * on a tag pointed at the caller. A tagger removing their own tag goes through
 * `set_watch_tags` with a shorter list.
 */
create or replace function hide_watch_tag(
  p_operation_id uuid,
  p_tag_id       uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'hide_watch_tag') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  update watch_tags
     set removed_by_tagged = true
   where id = p_tag_id and tagged_id = auth.uid();

  get diagnostics v_updated = row_count;

  -- Already hidden is the state the caller asked for, so it is not an error; a tag
  -- that is not theirs is, and reports as absent rather than as forbidden, because
  -- "that tag exists but is not yours" is a fact about someone else's log.
  if v_updated = 0 then
    raise exception 'no such tag' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function hide_watch_tag(uuid, uuid) is
  'The tagged person hides a tag from their side (PRD §14). Sets removed_by_tagged rather than deleting, so the tagger''s log is unaltered. Matches on tagged_id = auth.uid(), so it cannot touch a tag pointed at anybody else.';

-- Serves "the companions on these watches", which the feed and the title page both
-- ask. `watch_tags_tagged` already covers the other direction.
create index if not exists watch_tags_by_watch
  on watch_tags (tagger_id, media_item_id);

grant execute on function set_watch_tags(uuid, uuid, uuid[]) to authenticated;
grant execute on function hide_watch_tag(uuid, uuid)         to authenticated;
