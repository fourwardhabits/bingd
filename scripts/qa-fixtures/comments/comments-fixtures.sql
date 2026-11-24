-- ===========================================================================
-- Comments QA fixture (`comments-v1`) — STAGING ONLY
--
-- Rebuilds a small, known set of conversations for testing comments, replies and their
-- notifications. Idempotent: running it again is the reset — the fixture's own posts,
-- comments, reactions and notifications are deleted and written again; the accounts are
-- reused. Refuses to run unless `app_config['env.name']` is `nonprod`.
--
-- Optional: send the fixture's notifications to YOUR staging account instead of a QA one,
-- by setting the placeholder in the same session first:
--
--   select set_config('qa.notify_username', 'your_staging_username', false);
--
-- See README.md beside this file for what it creates and how to run it.
-- ===========================================================================

do $$
declare
  -- Three disposable accounts. Fixed ids, so every run reuses them. No email, no password,
  -- no personal data: they cannot sign in and exist only to be the other people.
  alex  constant uuid := '0c0a0000-0000-4000-8000-0000000c0a01';  -- posts
  blair constant uuid := '0c0a0000-0000-4000-8000-0000000c0a02';  -- default recipient
  casey constant uuid := '0c0a0000-0000-4000-8000-0000000c0a03';  -- replies
  qa    constant uuid[] := array['0c0a0000-0000-4000-8000-0000000c0a01',
                                 '0c0a0000-0000-4000-8000-0000000c0a02',
                                 '0c0a0000-0000-4000-8000-0000000c0a03']::uuid[];
  target   uuid;     -- who the notifications are for: Blair, or the placeholder account
  movie    uuid;
  post     uuid;     -- Alex's title post: the conversations and the notifications
  long     uuid;     -- Alex's second post: a long thread for scrolling
  r_root   uuid;     -- the target's own comment on Alex's post
  c_reply  uuid;     -- Casey's reply to it         -> notification about a REPLY
  a_reply  uuid;     -- Alex's reply in that thread
  a_root   uuid;     -- Alex's new top-level comment -> notification about a ROOT
  b_root   uuid;
  i        integer;
  wanted   text := nullif(current_setting('qa.notify_username', true), '');
begin
  if coalesce(trim(both '"' from (select value::text from app_config where key = 'env.name')), '')
     <> 'nonprod' then
    raise exception 'comments fixture: refusing to run outside a non-production database';
  end if;

  -- ---------------------------------------------------------------- accounts
  insert into auth.users (id) select unnest(qa) on conflict (id) do nothing;
  insert into profiles (id, username, display_name, visibility) values
    (alex,  'qa_cmt_alex',  'QA Alex',  'public'),
    (blair, 'qa_cmt_blair', 'QA Blair', 'public'),
    (casey, 'qa_cmt_casey', 'QA Casey', 'public')
  on conflict (id) do nothing;
  insert into profile_private (profile_id, date_of_birth)
    select unnest(qa), date '1990-01-01' on conflict do nothing;

  target := blair;
  if wanted is not null then
    select id into target from profiles where username = wanted;
    if target is null then
      raise exception 'comments fixture: no staging account named %', wanted;
    end if;
  end if;

  -- ---------------------------------------------------------------- reset
  -- Only what this fixture made: its posts (marked in the payload), and the QA accounts'
  -- rate ledger so a replay is never refused as "too many today".
  delete from notifications
   where subject_type = 'feed_event'
     and subject_id in (select id from feed_events where payload ->> 'qa_fixture' = 'comments-v1');
  delete from feed_events where payload ->> 'qa_fixture' = 'comments-v1';  -- comments, reactions cascade
  delete from processed_operations where user_id = any (qa);

  -- The recipient hears about comments. Only a QA account's switch is touched: a real
  -- account's choice is its own, and a disabled Comments setting stays disabled.
  if target = blair then
    insert into notification_preferences (user_id, category, enabled)
    values (blair, 'comments', true)
    on conflict (user_id, category) do update set enabled = true;
  end if;

  -- ---------------------------------------------------------------- posts
  select id into movie from media_items where kind = 'movie' and tmdb_id = 438631;   -- Dune (2021)
  if movie is null then
    select id into movie from media_items where kind = 'movie' order by tmdb_id limit 1;
  end if;

  insert into feed_events (actor_id, type, media_item_id, payload)
  values (alex, 'title_ranked', movie, '{"qa_fixture": "comments-v1"}')
  returning id into post;
  insert into feed_events (actor_id, type, media_item_id, payload, created_at)
  values (alex, 'title_ranked', movie, '{"qa_fixture": "comments-v1"}', now() - interval '1 day')
  returning id into long;

  -- A reacted-to post: two reactions on Alex's post.
  insert into reactions (feed_event_id, user_id, kind) values (post, blair, 'love'), (post, casey, 'wow')
  on conflict do nothing;

  -- ---------------------------------------------------------------- the conversation
  -- Blair's top-level comment (Alex is told "commented on your …").
  perform set_config('request.jwt.claims', json_build_object('sub', blair, 'role', 'authenticated')::text, true);
  b_root := (add_comment(gen_random_uuid(), post, 'The desert sequences alone. Worth it on the big screen.', false, null, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- The recipient's own comment, so a reply can be addressed to them.
  perform set_config('request.jwt.claims', json_build_object('sub', target, 'role', 'authenticated')::text, true);
  r_root := (add_comment(gen_random_uuid(), post, 'Is Part Two as good? Deciding whether to watch it this weekend.', false, null, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- Casey replies to it: the recipient is told "replied to your comment" (a REPLY).
  perform set_config('request.jwt.claims', json_build_object('sub', casey, 'role', 'authenticated')::text, true);
  c_reply := (add_comment(gen_random_uuid(), post, 'Better, honestly. The arena scene is unreal.', false, r_root, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- Alex joins that conversation (a reply to a reply: stored under the root, Casey told).
  perform set_config('request.jwt.claims', json_build_object('sub', alex, 'role', 'authenticated')::text, true);
  a_reply := (add_comment(gen_random_uuid(), post, 'Agree with Casey — and watch it in IMAX if you can.', false, c_reply, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- Alex, the post's author, adds a new top-level comment: everyone who commented is told
  -- "also commented on their …" (a ROOT), the recipient included.
  a_root := (add_comment(gen_random_uuid(), post, 'Thanks all — rewatching it tonight.', false, null, '{}'::uuid[]) ->> 'comment_id')::uuid;

  -- ---------------------------------------------------------------- a long thread
  perform set_config('request.jwt.claims', json_build_object('sub', blair, 'role', 'authenticated')::text, true);
  b_root := (add_comment(gen_random_uuid(), long, 'Starting a long one so there is something to scroll.', false, null, '{}'::uuid[]) ->> 'comment_id')::uuid;
  for i in 1..12 loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', case when i % 2 = 0 then blair else casey end, 'role', 'authenticated')::text, true);
    if i % 4 = 0 then
      perform add_comment(gen_random_uuid(), long, format('Another thought, number %s.', i), false, null, '{}'::uuid[]);
    else
      perform add_comment(gen_random_uuid(), long, format('Reply %s in the long conversation.', i), false, b_root, '{}'::uuid[]);
    end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;

-- What was built, for whoever ran it.
select e.id as event_id,
       (select count(*) from comments c where c.feed_event_id = e.id) as comments,
       (select count(*) from reactions r where r.feed_event_id = e.id) as reactions,
       (select jsonb_agg(jsonb_build_object(
                 'to', p.username,
                 'from', a.username,
                 'about', case when c.parent_id is null then 'root' else 'reply' end,
                 'reply_to', n.payload ? 'reply_to',
                 'participant', coalesce((n.payload ->> 'participant')::boolean, false))
               order by n.created_at, n.id)
          from notifications n
          join profiles p on p.id = n.recipient_id
          join profiles a on a.id = n.actor_id
          left join comments c on c.id = (n.payload ->> 'comment_id')::uuid
         where n.subject_id = e.id) as notifications
  from feed_events e
 where e.payload ->> 'qa_fixture' = 'comments-v1'
 order by e.created_at desc;
