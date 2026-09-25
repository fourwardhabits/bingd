-- ===========================================================================
-- THE AUTHOR ANSWERING WITHOUT TAPPING REPLY (founder, 2026-09-25)
--
-- Reported from real use: the founder commented on somebody's post, the post's author
-- answered — as a new top-level comment rather than a reply — and no notification was
-- filed for anybody.
--
-- That is not a bug in the two existing rules, it is a case neither of them covers:
--
--   1. "somebody commented on your post"   guarded by `v_actor <> auth.uid()`, and the
--                                          author commenting on their own post is
--                                          precisely `v_actor = auth.uid()`;
--   2. "somebody replied to your comment"  requires a parent, and a top-level comment
--                                          has none.
--
-- So the commonest conversational move in the product — the author answering a question
-- under their own post — reached nobody.
--
-- **The narrow rule, and why it is narrow.** Only the POST AUTHOR's own new TOP-LEVEL
-- comment notifies prior participants. A third party commenting still notifies the author
-- alone, exactly as before: "everybody who once commented hears about every later
-- comment" is the thread-spam this deliberately is not.
--
-- No new notification type, no new preference, no taxonomy change: it is a `comment` row
-- like the other two, so it is already push-eligible, already counted as unread, already
-- routed to the conversation, and already covered by the reader's comment preference.
-- `payload.participant` is what lets the inbox word it differently, the same way
-- `payload.reply_to` already distinguishes the other two.
--
-- Rebuilds `_add_comment` whole, because plpgsql has no way to add a statement to a
-- function; the body below is `20260908000100`'s with one block inserted and nothing else
-- touched.
-- ===========================================================================

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
  if v_actor <> auth.uid() and not coalesce(v_actor = any (v_mentions), false) then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  -- The same rule for the person being replied to. Both rows open the same conversation,
  -- so losing the generic one costs the reader no destination.
  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor
     and not coalesce(v_reply_to = any (v_mentions), false) then
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
       and not coalesce(c.author_id = any (v_mentions), false);
  end if;

  -- A mention of yourself files nothing: `_can_mention` excludes `auth.uid()`, so the
  -- author is never in `v_mentions` and never suppresses their own rows either.
  perform _apply_comment_mentions(v_id, p_feed_event_id, v_mentions, p_parent_id is not null);

  return jsonb_build_object('status', 'ok', 'comment_id', v_id, 'parent_id', v_root);
end;
$$;


comment on function _add_comment(uuid, uuid, text, boolean, uuid, uuid[]) is
  'The whole of posting a comment, behind both published signatures so the five-argument form a phone predating 20260830000100 still calls cannot drift from the six-argument one. Since 20260908000100 the mentions are resolved from the body as well as from the picked ids, and whoever the comment names does not also get the generic comment or reply row -- one action, one notification, and the specific one wins. Since 20261021000100 the POST AUTHOR''s own new TOP-LEVEL comment also notifies everyone who had already commented on that post, which is the case the other two rules structurally cannot reach: the author is the activity owner, so the owner rule is guarded off, and a top-level comment has no parent, so the reply rule cannot fire. Deliberately narrow -- a third party''s comment still notifies the author alone. Internal.';
