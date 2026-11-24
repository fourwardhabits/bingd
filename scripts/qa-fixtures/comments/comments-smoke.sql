-- ===========================================================================
-- Comments reply/notification smoke (`comments-v1`) — STAGING ONLY, writes nothing
--
-- Runs on top of comments-fixtures.sql. Two accounts reply as the app does: QA Casey
-- replies to a ROOT (QA Blair's comment) and QA Blair replies to a REPLY (QA Casey's), then
-- the smoke checks what was stored, who was notified with what, and what the reader
-- returns. Everything happens inside one transaction that always ends in an exception, so
-- nothing is kept: the result is the exception's message, `SMOKE_RESULT {...}`, with a
-- `pass` flag and one boolean per check.
-- ===========================================================================

do $$
declare
  alex  constant uuid := '0c0a0000-0000-4000-8000-0000000c0a01';
  blair constant uuid := '0c0a0000-0000-4000-8000-0000000c0a02';
  casey constant uuid := '0c0a0000-0000-4000-8000-0000000c0a03';
  post  uuid;
  root  uuid;   -- Blair's root on the fixture post
  r1    uuid;   -- Casey -> Blair's root
  r2    uuid;   -- Blair -> Casey's reply (a reply to a reply)
  checks jsonb := '{}'::jsonb;
  ok    boolean;
begin
  if coalesce(trim(both '"' from (select value::text from app_config where key = 'env.name')), '')
     <> 'nonprod' then
    raise exception 'comments smoke: refusing to run outside a non-production database';
  end if;

  select id into post from feed_events
   where payload ->> 'qa_fixture' = 'comments-v1' order by created_at desc limit 1;
  if post is null then
    raise exception 'comments smoke: run comments-fixtures.sql first';
  end if;
  select id into root from comments
   where feed_event_id = post and author_id = blair and parent_id is null
   order by created_at limit 1;
  delete from processed_operations where user_id in (alex, blair, casey);

  -- 1. Casey replies to Blair's root.
  perform set_config('request.jwt.claims', json_build_object('sub', casey, 'role', 'authenticated')::text, true);
  r1 := (add_comment(gen_random_uuid(), post, 'smoke: reply to a root', false, root, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- 2. Blair replies to Casey's reply.
  perform set_config('request.jwt.claims', json_build_object('sub', blair, 'role', 'authenticated')::text, true);
  r2 := (add_comment(gen_random_uuid(), post, 'smoke: reply to a reply', false, r1, '{}'::uuid[]) ->> 'comment_id')::uuid;

  checks := checks || jsonb_build_object(
    'reply_to_root_stored_under_root',  (select parent_id = root from comments where id = r1),
    'reply_to_reply_stored_under_root', (select parent_id = root from comments where id = r2),
    -- Blair is told Casey replied to her comment, naming that comment.
    'root_author_notified_of_reply', exists (
      select 1 from notifications
       where recipient_id = blair and actor_id = casey and type = 'comment'
         and payload ->> 'comment_id' = r1::text and payload ->> 'reply_to' = root::text),
    -- Casey — the author of the reply Blair tapped — is told, naming Casey's reply.
    'tapped_reply_author_notified', exists (
      select 1 from notifications
       where recipient_id = casey and actor_id = blair and type = 'comment'
         and payload ->> 'comment_id' = r2::text and payload ->> 'reply_to' = r1::text),
    -- Nobody is told about their own reply, and nobody twice.
    'no_self_or_duplicate_rows', not exists (
      select 1 from notifications
       where payload ->> 'comment_id' in (r1::text, r2::text)
       group by recipient_id, payload ->> 'comment_id'
      having count(*) > 1 or bool_or(recipient_id = actor_id)),
    -- The post's owner hears about both, as the generic comment row.
    'post_owner_notified', (select count(*) = 2 from notifications
       where recipient_id = alex and payload ->> 'comment_id' in (r1::text, r2::text)
         and not payload ? 'reply_to')
  );

  -- 3. The reader, as Casey: both replies, under the root, in time order.
  perform set_config('request.jwt.claims', json_build_object('sub', casey, 'role', 'authenticated')::text, true);
  checks := checks || jsonb_build_object(
    'reader_returns_both_under_root', (
      select count(*) = 2 from activity_comments(post) x
       where x.id in (r1, r2) and x.parent_id = root),
    -- And Blair's inbox carries the comment id the app routes on.
    'inbox_payload_has_comment_id', (
      select bool_and(m.payload ? 'comment_id')
        from (select set_config('request.jwt.claims',
                json_build_object('sub', blair, 'role', 'authenticated')::text, true)) s,
             my_notifications(100) m
       where m.subject_id = post and m.kind = 'comment')
  );

  select bool_and(value::boolean) into ok from jsonb_each_text(checks);
  raise exception 'SMOKE_RESULT %', (jsonb_build_object('pass', ok) || checks)::text;
end $$;
