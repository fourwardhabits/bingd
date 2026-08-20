-- The tag notice is once per person per title, for good, and the function now says so.
-- Found by: independent re-review of 20260816000600, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- A comment that had stopped being true
--
-- 20260816000600 added a permanent partial unique index on
-- (recipient_id, actor_id, subject_id, type) for watch-tag notifications, to stop two
-- concurrent identical saves filing two inbox rows. It also carried a comment saying
-- that re-adding somebody the tagger had taken off "does notify them again -- it is a
-- new statement about them".
--
-- Both cannot be true, and the index wins: `on conflict do nothing` against a
-- permanent constraint means the second notice is dropped a month later exactly as it
-- is dropped a millisecond later. Review found the contradiction; the code was right
-- and the comment was wrong.
--
-- Right, because the alternative is worse. Making re-tagging ring again means the
-- notice can be re-fired at will by removing somebody and adding them back, which is
-- a way to put your name in another person's inbox repeatedly without their being
-- able to stop it -- `hide_watch_tag` hides the tag, not the notification. That is a
-- ping vector aimed at exactly the people PRD §14 already treats carefully, and it
-- would arrive through the ordinary picker rather than through anything exotic.
--
-- So the rule is stated rather than implied: one notice per (tagger, tagged, title),
-- ever. The cost is a genuine second tagging that goes unannounced, which is a small
-- loss and a quiet one -- the tag itself is visible, in the feed and on the title,
-- which is where anybody would look.
--
-- Nothing about the behaviour changes here. This migration exists so that the next
-- person to read the function is not told something the schema will not do.
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

  -- Who does not currently hold a live tag. This decides which rows to *attempt* a
  -- notification for; whether one is filed is then the index's decision, and the
  -- index says once per (tagger, tagged, title) for good. A person re-added after
  -- being taken off is therefore tagged again and not told again -- see the header.
  select coalesce(array_agg(w.uid), '{}') into v_added
    from unnest(v_wanted) as w(uid)
   where not exists (
     select 1 from watch_tags t
      where t.tagger_id = auth.uid()
        and t.tagged_id = w.uid
        and t.media_item_id = p_media_item_id
        and not t.removed_by_tagger
   );

  -- Withdrawn, not deleted. The row is what remembers that the tagged person said
  -- no, and deleting it would let the next save hand back a decision that was not
  -- the tagger's to make.
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
  'Replaces the caller''s companion list for one of their own watches (PRD §14). Refuses the whole call if any person is not connected, blocked, or suspended, rather than partially applying. Removal is a soft delete, so the tagged person''s own removal survives an untag and re-tag. The inbox notice is once per (tagger, tagged, title) for good, because a notice that can be re-fired by removing and re-adding somebody is a way to reach a person who cannot stop it.';
