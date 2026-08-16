-- A tagged person's refusal outlives the tag, and the social writes stop racing
-- themselves.
-- Found by: independent review of 20260816000300 and 20260816000400, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- 1. The refusal has to survive the row
--
-- PRD §14 gives the tagged person one control: remove the tag from their side. The
-- previous migration implemented it as a flag on the tag, and protected it with
-- `on conflict do nothing` so that a tagger re-saving the same list could not clear
-- it. That protects a row that survives, and review found the path where none does:
--
--   1. Alice tags Bob.  2. Bob hides it.  3. Alice saves [] -- the row is deleted.
--   4. Alice saves [bob] -- a new row, default flag, visible again, fresh notification.
--
-- Two taps to undo somebody else's decision about their own name. That is not a
-- concurrency corner, it is the ordinary use of the picker, and it turns the one
-- control the tagged person has into a suggestion.
--
-- The fix is to stop deleting. `removed_by_tagger` joins `removed_by_tagged`, and the
-- row itself becomes the memory: untagging sets the tagger's flag, re-tagging clears
-- it, and neither touches the other party's. A tag is visible only when *neither*
-- side has withdrawn it, so both people keep a veto and neither can spend the other's.
--
-- The cost is a row per (tagger, tagged, title) that is never reclaimed. That is
-- bounded by the follow graph and the ten-per-watch cap, and a soft delete is the
-- ordinary price of remembering a decision -- which is exactly what this is.
-- ---------------------------------------------------------------------------

alter table watch_tags
  add column removed_by_tagger boolean not null default false;

comment on column watch_tags.removed_by_tagger is
  'The tagger took this person off the list. A soft delete, so that removed_by_tagged survives an untag-and-retag -- otherwise a tagger could reverse the tagged person''s only control in two taps. Visible tags are those neither side has withdrawn.';

comment on column watch_tags.removed_by_tagged is
  'The tagged person hid this tag (PRD §14). Never cleared by anything the tagger does: not by re-saving the list, and not by removing and re-adding them.';

-- The old partial index assumed removal meant deletion. Both flags now matter, and
-- the index that serves "tags pointed at me" should skip the withdrawn ones.
drop index if exists watch_tags_tagged;
create index watch_tags_tagged on watch_tags (tagged_id)
  where not removed_by_tagged and not removed_by_tagger;

drop index if exists watch_tags_by_watch;
create index watch_tags_by_watch on watch_tags (tagger_id, media_item_id)
  where not removed_by_tagger;

/**
 * Visibility, with the tagger's own withdrawal folded in.
 *
 * Same contract as before -- takes the row id rather than the parties, so it cannot
 * be used to test whether two chosen people have blocked each other -- with one
 * clause added. A tag the tagger has taken down is visible to nobody, including the
 * tagged person: it is the tagger's statement about their own evening, and they have
 * retracted it.
 *
 * A tag the *tagged* person has hidden stays visible to both parties and to no one
 * else, which is unchanged: the tagger's log is theirs, and the tagged person has to
 * be able to find what they hid.
 */
create or replace function watch_tag_visible(tag_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((
    select not blocked_between(t.tagger_id, t.tagged_id)
       and not t.removed_by_tagger
       and (
         t.tagger_id = auth.uid()
         or t.tagged_id = auth.uid()
         or (not t.removed_by_tagged and can_view_profile(auth.uid(), t.tagger_id))
       )
      from watch_tags t
     where t.id = tag_id
  ), false);
$$;

comment on function watch_tag_visible is
  'Whether the caller may see one watch tag. Takes the row id, not the parties, so it cannot be used to test a block between two chosen users. A tag withdrawn by its tagger is visible to nobody; one hidden by the tagged person stays visible to both parties only.';

-- ---------------------------------------------------------------------------
-- 2. The counts and the guards were reading uncommitted air
--
-- Two findings with one cause. `_assert_operation_rate` counts committed claims, so
-- N concurrent transactions each see zero and each pass -- a modified client issuing
-- two hundred parallel reactions with fresh operation ids defeats a two-hundred-a-day
-- ceiling entirely. And `set_watch_tags` computes "which of these are new" before
-- inserting, so two identical concurrent saves both decide the same person is new and
-- both file an inbox row, where the unique constraint stops the second *tag* but
-- nothing stops the second notification.
--
-- A per-account advisory lock closes both. It is transaction-scoped, so it releases
-- on commit or rollback with no cleanup path to get wrong, and it is keyed on the
-- caller so it serialises one account against itself and nobody against anyone else.
-- `_rank_finalize` already uses exactly this to make band bounds trustworthy.
--
-- Serialising an account's own social writes costs nothing real: a person taps one
-- reaction at a time, and the picker sends one list at a time. What it removes is the
-- ability to fan out from a script, which is the case the limit exists for.
-- ---------------------------------------------------------------------------

create or replace function _assert_operation_rate(
  p_kind       text,
  p_config_key text,
  p_fallback   integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max  integer;
  v_used integer;
begin
  -- Taken before the count, and keyed per account and kind. Without it the count is
  -- a read of committed history that every concurrent sibling passes.
  --
  -- No longer `stable`: an advisory lock is a side effect, and a stable function may
  -- be folded, cached or skipped by the planner. Marking it volatile is what makes
  -- the lock actually happen once per call.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(auth.uid()::text, '') || p_kind, 0));

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
  'Per-day ceiling on one kind of operation, counted from processed_operations rather than from the rows the operation creates -- so a react-and-unreact loop is bounded, which counting reactions would not be. Takes a per-account advisory lock first, or concurrent callers each read a count that does not include the others. PRD §14.';

-- The same treatment the reaction inbox row got, for the tag one. Belt as well as
-- braces: the advisory lock above already serialises one account's calls, and a
-- constraint cannot be lost by a later edit that reorders a function body.
delete from notifications a
 using notifications b
 where a.type = 'watch_tag'
   and b.type = 'watch_tag'
   and a.recipient_id = b.recipient_id
   and a.actor_id = b.actor_id
   and a.subject_id = b.subject_id
   and a.ctid > b.ctid;

create unique index if not exists notifications_one_tag_per_title
  on notifications (recipient_id, actor_id, subject_id, type)
  where type = 'watch_tag';

-- ---------------------------------------------------------------------------
-- 3. set_watch_tags, over the soft delete
-- ---------------------------------------------------------------------------

create or replace function set_watch_tags(
  p_operation_id  uuid,
  p_media_item_id uuid,
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

  if not exists (
    select 1 from user_media
     where user_id = auth.uid() and media_item_id = p_media_item_id
  ) then
    raise exception 'log the watch before saying who you watched it with'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(p_tagged_ids) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'watch_tags.max_per_watch'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can tag up to % people on one watch', v_max using errcode = '22023';
  end if;

  select w.uid into v_bad from unnest(v_wanted) as w(uid) where not _can_tag(w.uid) limit 1;
  if v_bad is not null then
    raise exception 'you can only tag people you follow or who follow you'
      using errcode = '42501';
  end if;

  -- New means "not currently a live tag", so re-adding somebody the tagger had
  -- taken off does notify them again -- it is a new statement about them. Somebody
  -- who *hid* the tag is not notified again, because their row is still there and
  -- their answer has not changed.
  select coalesce(array_agg(w.uid), '{}') into v_added
    from unnest(v_wanted) as w(uid)
   where not exists (
     select 1 from watch_tags t
      where t.tagger_id = auth.uid()
        and t.tagged_id = w.uid
        and t.media_item_id = p_media_item_id
        and not t.removed_by_tagger
   );

  -- Withdrawn, not deleted. This is the whole point of the migration: the row is
  -- what remembers that the tagged person said no, and deleting it would let the
  -- next save hand back a decision that was not the tagger's to make.
  update watch_tags
     set removed_by_tagger = true
   where tagger_id = auth.uid()
     and media_item_id = p_media_item_id
     and tagged_id <> all (v_wanted);

  insert into watch_tags (tagger_id, tagged_id, media_item_id)
  select auth.uid(), w.uid, p_media_item_id from unnest(v_wanted) as w(uid)
  on conflict (tagger_id, tagged_id, media_item_id) do update
    -- Only the tagger's own flag. `removed_by_tagged` is deliberately absent from
    -- this SET list, and its absence is load-bearing.
    set removed_by_tagger = false;

  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
  select w.uid, 'watch_tag', auth.uid(), 'media_item', p_media_item_id, '{}'::jsonb
    from unnest(v_added) as w(uid)
  on conflict (recipient_id, actor_id, subject_id, type) where type = 'watch_tag'
    do nothing;

  return jsonb_build_object('status', 'ok', 'tagged', coalesce(array_length(v_wanted, 1), 0));
end;
$$;

comment on function set_watch_tags(uuid, uuid, uuid[]) is
  'Replaces the caller''s companion list for one of their own watches (PRD §14). Refuses the whole call if any person is not connected, blocked, or suspended, rather than partially applying. Removal is a soft delete, so the tagged person''s own removal survives an untag and re-tag -- which is the one thing a tagger must not be able to undo.';

-- hide_watch_tag is unchanged in behaviour and recreated only so its comment can say
-- what the new column means for it: a tag the tagger has withdrawn is not the tagged
-- person's to hide, and reports as absent.
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
   where id = p_tag_id
     and tagged_id = auth.uid()
     and not removed_by_tagger;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'no such tag' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function hide_watch_tag(uuid, uuid) is
  'The tagged person hides a tag from their side (PRD §14). Sets removed_by_tagged rather than deleting, so the tagger''s log is unaltered, and nothing the tagger does afterwards clears it. Matches on tagged_id = auth.uid(), so it cannot touch a tag pointed at anybody else.';
