-- ROLLBACK of 20261201000200_a_story_frozen_before_it_grows (Workstream C). STAGING ONLY unless
-- separately approved. Restores set_reaction and _add_comment to 20261201000100's bodies,
-- verbatim, so the freeze is recorded without the actor lock again. No data changes. Run it
-- before docs/release/wsc/rollback-20261201000100.sql if both are being rolled back.
begin;

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

  -- 20261201000100: a follow story with no member open to this reader is no activity.
  if not _follow_story_open_to(auth.uid(), p_feed_event_id) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- 20261201000100 (Q1): a reaction freezes a follow story, for good.
  if p_kind is not null then
    insert into follow_story_engaged (event_id)
    select e.id from feed_events e where e.id = p_feed_event_id and e.type = 'follow_added'
    on conflict do nothing;
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
  -- 20261201000100: and the author is told only while the story is open to them.
  if v_actor <> auth.uid() and _follow_story_open_to(v_actor, p_feed_event_id) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'reaction', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('kind', v_kind))
    on conflict (recipient_id, actor_id, subject_id, type) where type = 'reaction'
      do nothing;
  end if;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

create or replace function _add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean,
  p_parent_id     uuid,
  p_mention_ids   uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_body         text := btrim(coalesce(p_body, ''));
  v_id           uuid;
  v_root         uuid := null;
  v_reply_author uuid := null;
  v_reply_to     uuid := null;
  v_deleted_at   timestamptz;
  v_counterpart  uuid;
  v_mentions     uuid[];
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'add_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('add_comment', 'comments.max_per_day', 100);

  perform _assert_comment_length(v_body);

  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  if p_parent_id is not null then
    v_root := _comment_root(p_parent_id, p_feed_event_id);

    if v_root is null then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    if v_reply_author is null or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    if v_deleted_at is null then
      v_reply_to := v_reply_author;
    end if;
  end if;

  for v_counterpart in
    select c.u
      from (select v_actor as u union select v_reply_author) as c
     where c.u is not null
       and c.u <> auth.uid()
     order by c.u
  loop
    perform _lock_pair(auth.uid(), v_counterpart);
  end loop;

  if not can_view_profile(auth.uid(), v_actor) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- 20261201000100: the shared engagement predicate, inside the pair locks.
  if not _follow_story_open_to(auth.uid(), p_feed_event_id) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- 20261201000100 (Q1): a comment freezes a follow story, for good.
  insert into follow_story_engaged (event_id)
  select e.id from feed_events e where e.id = p_feed_event_id and e.type = 'follow_added'
  on conflict do nothing;

  if p_parent_id is not null then
    perform 1 from comments c where c.id = p_parent_id for share;

    v_root := _comment_root(p_parent_id, p_feed_event_id);

    select c.author_id, c.deleted_at
      into v_reply_author, v_deleted_at
      from comments c
     where c.id = p_parent_id;

    if v_root is null
       or v_reply_author is null
       or not can_view_profile(auth.uid(), v_reply_author) then
      raise exception 'no such comment' using errcode = 'P0002';
    end if;

    v_reply_to := case when v_deleted_at is null then v_reply_author end;
  end if;

  insert into comments (feed_event_id, author_id, body, has_spoilers, parent_id)
  values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers, false), v_root)
  returning id into v_id;

  /**
   * Resolved before either notification is filed, and that ordering is the founder's
   * "one action, one notification" rule made mechanical.
   *
   * The comment is brand new, so every id this returns is a mention with no notified_at
   * yet -- which is what makes the two skips below safe rather than merely likely. On an
   * *edit* the same statement can return somebody already told, but `_edit_comment` files
   * no `comment` rows at all, so there is nothing there to suppress.
   */
  v_mentions := _resolve_comment_mentions(v_id, p_feed_event_id, p_mention_ids, v_body);

  -- "There is a new remark on your post", unless the remark is addressed to them, in
  -- which case the mention row below says so and says it better.
  -- 20261201000100: every recipient below must have the story open to them.
  if v_actor <> auth.uid() and not coalesce(v_actor = any (v_mentions), false)
     and _follow_story_open_to(v_actor, p_feed_event_id) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  -- The same rule for the person being replied to. Both rows open the same conversation,
  -- so losing the generic one costs the reader no destination.
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor
     and not coalesce(v_reply_to = any (v_mentions), false)
     and _follow_story_open_to(v_reply_to, p_feed_event_id) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;

  /**
   * **The author following up, without tapping Reply** (founder, 2026-09-25).
   *
   * The two rules above cover the two cases anybody designed for: somebody comments on
   * your post, or somebody replies to your comment. Neither covers the commonest
   * conversational move there is — the post's author answering a remark by typing a new
   * top-level comment instead of tapping Reply. The first rule cannot fire, because the
   * author IS the activity's owner and the guard is `v_actor <> auth.uid()`. The second
   * cannot fire, because there is no parent. So nobody was told, and the person who
   * asked the question never learned it had been answered.
   *
   * This fills exactly that gap and nothing wider: **the author's** new **top-level**
   * comment tells the people who had already commented on that post. It is deliberately
   * not "everybody who ever participated hears about every later comment" — a third
   * party's remark still notifies only the author, as before.
   *
   * It cannot double up. The first rule is mutually exclusive with this one by its own
   * guard; the second requires a parent where this requires none; and a mention of
   * somebody suppresses their row here for the same reason it does above — the mention
   * says it, and says it better. `distinct` handles a participant who commented twice.
   */
  if p_parent_id is null and v_actor = auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select distinct c.author_id, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
           jsonb_build_object('comment_id', v_id, 'participant', true)
      from comments c
     where c.feed_event_id = p_feed_event_id
       and c.id <> v_id
       and c.author_id <> auth.uid()
       and c.deleted_at is null
       and not coalesce(c.author_id = any (v_mentions), false)
       and _follow_story_open_to(c.author_id, p_feed_event_id);
  end if;

  -- A mention of yourself files nothing: `_can_mention` excludes `auth.uid()`, so the
  -- author is never in `v_mentions` and never suppresses their own rows either.
  perform _apply_comment_mentions(v_id, p_feed_event_id, v_mentions, p_parent_id is not null);

  return jsonb_build_object('status', 'ok', 'comment_id', v_id, 'parent_id', v_root);
end;
$$;

delete from supabase_migrations.schema_migrations where version = '20261201000200';

commit;
