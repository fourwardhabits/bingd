-- ===========================================================================
-- A CONVERSATION ABOUT WHO YOU FOLLOW
--
-- Workstream C: reactions and comments on follow activity. Founder decisions, 2026-11-19.
-- The plan is `docs/plans/follow-activity-engagement.md` on ops/preview-1115-records, with
-- the requirements audit beside it.
--
-- What the founder decided:
--   · Reactions AND comments on follow stories, one shared thread per story, grouped or not.
--   · ONE shared server-side engagement predicate across writes, reads, counts, mentions and
--     notifications. Ordinary feed posts behave exactly as before.
--   · Q1: a story FREEZES on its first reaction or comment. The next follow starts a new one.
--   · Q2: being named in a story grants nothing. Ordinary eligible followers participate, and
--     nobody is notified merely for being a member.
--   · Q3: when no eligible member remains, the story and its conversation are hidden from
--     everyone, the author included. Nothing is deleted, and visibility returns when
--     authorization does (a re-follow).
--   · Heart Magnet excludes reactions on follow stories.
--
-- THE PREDICATE
--
-- `_follow_story_open_to(reader, event)` is TRUE for every event that is not a follow story.
-- So each existing path keeps its own checks and gains one clause, a no-op for ordinary posts.
--
-- For a `follow_added` event it requires at least one member who:
--   (a) is still followed by the story's actor (`follows` approved). An unfollow, or a block
--       in either direction (which deletes both edges), removes them;
--   (b) is active, and identifiable by the reader (`can_identify_profile`: blocks either way,
--       suspension);
--   (c) is not the reader. Under Q2, naming you in a story does not open it to you.
--
-- Every caller already establishes `can_view_profile(reader, actor)` itself, as before.
--
-- THE REBUILDS
--
-- Every function below is rebuilt from its TRUE latest body (the rebuild trap), changed only
-- where a `20261130000100` comment says so. No signature changes, so installed clients keep
-- working. A refusal is the P0002 they already handle.
-- ===========================================================================

create or replace function _follow_story_open_to(p_reader uuid, p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
      from feed_events e
     where e.id = p_event_id
       and e.type = 'follow_added'
       and not exists (
         select 1
           from feed_follow_targets ft
           join profiles p on p.id = ft.followed_id
           join follows f on f.follower_id = e.actor_id
                         and f.followee_id = ft.followed_id
                         and f.state = 'approved'
          where ft.event_id = e.id
            and p.status = 'active'
            and p.id is distinct from p_reader
            and can_identify_profile(p_reader, p.id)
       )
  );
$$;

comment on function _follow_story_open_to(uuid, uuid) is
  'The follow-story clause of the shared engagement predicate (20261130000100). TRUE for any event that is not a follow story. For a follow_added event: at least one member the actor still follows (approved), who is active, is not the reader, and whom the reader may identify. Composed with each path''s own can_view_profile(reader, actor). Takes a reader, so a client grant would be a block-graph oracle. Internal.';

revoke execute on function _follow_story_open_to(uuid, uuid) from public, anon, authenticated;

-- The same clause for the CALLER only, for the table policies, which run as the caller and
-- so cannot call the internal form above. It answers only about the caller's own view, as
-- `can_i_view` does.
--
-- **It says nothing about a story whose actor the caller may not view.** Every policy that
-- calls it already requires `can_i_view(actor)`, so for such a story it answers TRUE and the
-- policy is decided by that clause, exactly as before. Otherwise a direct call would be an
-- oracle on a private or blocking actor's follow graph: "does this actor still follow
-- somebody I can identify?". Where the caller may view the actor, the answer is what
-- `follow_activity_people` already shows them.
create or replace function follow_story_open_to_me(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from feed_events e
       where e.id = p_event_id
         and e.type = 'follow_added'
         and not can_view_profile(auth.uid(), e.actor_id)
    ) then true
    else _follow_story_open_to(auth.uid(), p_event_id)
  end;
$$;

comment on function follow_story_open_to_me(uuid) is
  '_follow_story_open_to for auth.uid(), for the reactions_read and comments_read policies (20261130000100). Caller-relative, like can_i_view.';

revoke execute on function follow_story_open_to_me(uuid) from public, anon;
grant  execute on function follow_story_open_to_me(uuid) to authenticated;


-- 0. Q1's freeze, recorded rather than inferred (Codex, PR 322)
--
-- A story is frozen by its FIRST reaction or comment, and stays frozen if that reaction is
-- later removed: otherwise the next follow could append to a story somebody had already been
-- notified about, and change what the notification was about. One row per engaged follow
-- story, written by set_reaction and _add_comment, read by _post_follow_activity. No client
-- reads it: row security on, no policy, and no grant to either client role.
create table if not exists follow_story_engaged (
  event_id   uuid primary key references feed_events(id) on delete cascade,
  engaged_at timestamptz not null default now()
);
alter table follow_story_engaged enable row level security;
revoke all on follow_story_engaged from anon, authenticated;

-- Stories engaged before this migration: any reaction or comment, deleted comments included.
insert into follow_story_engaged (event_id)
select e.id from feed_events e
 where e.type = 'follow_added'
   and (exists (select 1 from reactions r where r.feed_event_id = e.id)
        or exists (select 1 from comments c where c.feed_event_id = e.id))
on conflict do nothing;

comment on table follow_story_engaged is
  'Follow stories that have had a reaction or comment (20261130000100, Q1). Once a row exists the story is frozen: the next follow opens a new one. Server-only.';

-- 1. Follow stories name only who is still followed

create or replace function follow_activity_people(p_event_ids uuid[])
returns table (
  event_id     uuid,
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  visibility   profile_visibility
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- One page of the Feed holds twenty events and only a few of them can be follow rows, so
  -- this is a floor under a pathological caller rather than a real limit. It bounds how many
  -- *events* one call resolves, which is nothing to do with how completely each is answered.
  events as (
    -- 20261130000100: the actor too, for the edge check below.
    select e.id, e.actor_id
      from feed_events e, me
     where me.id is not null
       and e.id = any (coalesce(p_event_ids, '{}'::uuid[]))
       and e.type = 'follow_added'
       and can_view_profile(me.id, e.actor_id)
     limit 50
  )
  select ev.id, p.id as user_id, p.username::text as username,
         p.display_name, p.avatar_path, p.visibility
    from events ev
    join feed_follow_targets ft on ft.event_id = ev.id
    join profiles p on p.id = ft.followed_id
    -- 20261130000100: only members the actor STILL follows. An unfollow, or a block in
    -- either direction (which deletes both edges), takes a name out of every viewer's
    -- story. Reader-side: nothing is deleted, and a re-follow restores the name.
    join follows f on f.follower_id = ev.actor_id
                  and f.followee_id = p.id
                  and f.state = 'approved'
    cross join me
   where p.id <> me.id
     and p.status = 'active'
     and can_identify_profile(me.id, p.id)
   -- When each follow joined the story, so the name in the sentence's emphasised slot is the
   -- same one across refetches -- and `followed_id` breaks the tie two appends in one
   -- transaction always produce, because `created_at` defaults to transaction-scoped `now()`.
   -- It is the membership's own primary-key column: immutable, and already in the index this
   -- scan uses. The previous tie-break was `username`, which its owner can change from
   -- Settings, so renaming yourself could reorder somebody else's Feed row.
   order by ev.id, ft.created_at, ft.followed_id;
$$;

revoke execute on function follow_activity_people(uuid[]) from public, anon;
grant  execute on function follow_activity_people(uuid[]) to authenticated;

-- 2. Writes

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

  -- 20261130000100: a follow story with no member open to this reader is no activity.
  if not _follow_story_open_to(auth.uid(), p_feed_event_id) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- 20261130000100 (Q1): a reaction freezes a follow story, for good.
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
  -- 20261130000100: and the author is told only while the story is open to them.
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

  -- 20261130000100: the shared engagement predicate, inside the pair locks.
  if not _follow_story_open_to(auth.uid(), p_feed_event_id) then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  -- 20261130000100 (Q1): a comment freezes a follow story, for good.
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
  -- 20261130000100: every recipient below must have the story open to them.
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

create or replace function _set_comment_reaction(p_comment_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok     boolean;
  v_author uuid;
  v_kind   text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  if v_kind is not null
     and v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  select true, c.author_id into v_ok, v_author
    from comments c
    join feed_events e on e.id = c.feed_event_id
   where c.id = p_comment_id
     and c.deleted_at is null
     and can_view_profile(auth.uid(), c.author_id)
     and can_view_profile(auth.uid(), e.actor_id)
     -- 20261130000100
     and _follow_story_open_to(auth.uid(), e.id);

  if v_ok is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from comment_reactions
     where comment_id = p_comment_id and user_id = auth.uid();
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  insert into comment_reactions (comment_id, user_id, kind)
  values (p_comment_id, auth.uid(), v_kind)
  on conflict (comment_id, user_id) do update
    set kind = excluded.kind;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

create or replace function _edit_comment(
  p_operation_id   uuid,
  p_comment_id     uuid,
  p_body           text,
  p_has_spoilers   boolean,
  p_mention_ids    uuid[],
  p_apply_mentions boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body  text := btrim(coalesce(p_body, ''));
  v_at    timestamptz;
  v_event uuid;
  v_reply boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'edit_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_comment_length(v_body);

  update comments
     set body         = v_body,
         has_spoilers = coalesce(p_has_spoilers, has_spoilers),
         edited_at    = now()
   where id = p_comment_id
     and author_id = auth.uid()
     and deleted_at is null
  returning edited_at, feed_event_id, parent_id is not null
       into v_at, v_event, v_reply;

  if v_at is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  -- 20261130000100: a comment under a follow story closed to its author cannot be edited.
  -- Raised after the update, so the whole statement rolls back. A no-op for other events.
  -- Asked only of a caller who may view the story's actor (Codex, PR 322): for anyone else
  -- the answer would depend on the actor's follow graph, and an edit's success or failure
  -- would report it. They keep today's rule, which is ownership alone.
  if can_view_profile(auth.uid(), (select e.actor_id from feed_events e where e.id = v_event))
     and not _follow_story_open_to(auth.uid(), v_event) then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if p_apply_mentions then
    perform _apply_comment_mentions(
      p_comment_id,
      v_event,
      _resolve_comment_mentions(p_comment_id, v_event, p_mention_ids, v_body),
      v_reply
    );
  end if;

  return jsonb_build_object('status', 'ok', 'edited_at', v_at);
end;
$$;

-- 3. Reads and counts

create or replace function activity_comments(p_feed_event_id uuid)
returns table (
  id             uuid,
  parent_id      uuid,
  author_id      uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  body           text,
  has_spoilers   boolean,
  created_at     timestamptz,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  reaction_count integer,
  reacted_by_me  boolean,
  reaction_kinds text[],
  my_reaction    text,
  /**
   * Who this comment currently names:
   * `[{"id": ..., "username": ..., "handle": ...}, ...]`.
   *
   * `username` is what they are called now; `handle` is what this comment's body spells,
   * frozen when the mention was applied. They differ exactly when somebody has renamed
   * since, and the composer needs both — see `comment_mentions.handle`.
   *
   * Filtered through the same `can_view_profile` every other identity here is,
   * so a mention of somebody this reader has blocked is absent rather than
   * rendered as a name they should not be shown. Empty array, never null, so the
   * client has one shape to read.
   *
   * A retracted comment reports none. Its text has gone; the row survives only
   * to hold replies, and a tombstone that still listed the people it named would
   * be leaking half of what was retracted.
   */
  mentions       jsonb
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  event as (
    select e.id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
       and _follow_story_open_to(me.id, e.id)  -- 20261130000100
  ),
  rows as (
    select c.* from comments c, event where c.feed_event_id = event.id
  ),
  authors as (
    select p.id, p.username::text as username, p.display_name, p.avatar_path
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  ),
  reactors as (
    select p.id
      from profiles p, me
     where p.id in (
             select distinct cr.user_id
               from comment_reactions cr
               join rows r on r.id = cr.comment_id
           )
       and can_view_profile(me.id, p.id)
  ),
  visible as (
    select cr.comment_id, cr.user_id, cr.kind
      from comment_reactions cr
      join rows r on r.id = cr.comment_id
      join reactors rv on rv.id = cr.user_id
  ),
  -- Each mentioned person once, at the same arity as the authors and reactors
  -- above and for the same reason: one oracle call per distinct person, not one
  -- per mention row.
  mentioned as (
    select p.id, p.username::text as username
      from profiles p, me
     where p.id in (
             select distinct m.mentioned_id
               from comment_mentions m
               join rows r on r.id = m.comment_id
              where m.active
           )
       -- **Identity, not content, and that is why this one line differs from the two
       -- above.** `authors` and `reactors` stay on `can_view_profile` because a name
       -- attached to somebody's writing on a private account is a fact about that
       -- account. A mention is the reader being told who a comment *names*, and the
       -- three fields carried are the id, the handle and the frozen spelling — exactly
       -- the set `20260819000100` established is reachable for any discoverable
       -- account, and exactly what People search already returns.
       --
       -- Left on `can_view_profile` this would have been a visible regression from
       -- `20260909000100` rather than a theoretical one: a mention of a private
       -- account the reader does not follow is now a *valid* mention that fires a
       -- notification, and it would have rendered as plain text in the one place the
       -- comment is read.
       --
       -- `me.id = p.id` first because `can_discover_profile` answers false for
       -- yourself — correctly, since finding yourself is not discovery — and a reader
       -- must see their own name light up in a comment that names them.
       and (me.id = p.id or can_discover_profile(me.id, p.id))
  ),

  live_roots as (
    select r.id
      from rows r
     where r.deleted_at is null
        or exists (
             select 1
               from rows reply
               join authors a on a.id = reply.author_id
              where reply.parent_id = r.id
                and reply.deleted_at is null
           )
  )
  select r.id,
         r.parent_id,
         r.author_id,
         a.username,
         a.display_name,
         a.avatar_path,
         case when r.deleted_at is null then r.body end,
         r.has_spoilers,
         r.created_at,
         r.edited_at,
         r.deleted_at,
         (select count(*)::integer from visible v where v.comment_id = r.id),
         exists (
           select 1 from visible v, me where v.comment_id = r.id and v.user_id = me.id
         ),
         (select coalesce(array_agg(k.kind order by k.n desc, k.kind), '{}'::text[])
            from (
              select v.kind, count(*) as n
                from visible v
               where v.comment_id = r.id
               group by v.kind
            ) k),
         (select v.kind from visible v, me where v.comment_id = r.id and v.user_id = me.id),
         case
           when r.deleted_at is not null then '[]'::jsonb
           else coalesce(
             (select jsonb_agg(jsonb_build_object(
                                 'id', mp.id,
                                 'username', mp.username,
                                 -- What the body spells, which is not always what the
                                 -- person is called now. See the column's own comment.
                                 'handle', m.handle)
                               order by mp.username)
                from comment_mentions m
                join mentioned mp on mp.id = m.mentioned_id
               where m.comment_id = r.id and m.active),
             '[]'::jsonb)
         end
    from rows r
    join authors a on a.id = r.author_id
    join live_roots lr on lr.id = coalesce(r.parent_id, r.id)
   order by coalesce(r.parent_id, r.id), (r.parent_id is not null), r.created_at, r.id;
$$;

create or replace function activity_comment_counts(p_feed_event_ids uuid[])
returns table (feed_event_id uuid, comment_count integer)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  ids as (
    select distinct unnest(coalesce(p_feed_event_ids, '{}'::uuid[])) as id limit 60
  ),
  events as (
    select e.id
      from feed_events e
      join ids on ids.id = e.id
     cross join me
     where can_view_profile(me.id, e.actor_id)
       and _follow_story_open_to(me.id, e.id)  -- 20261130000100
  ),
  rows as (
    select c.feed_event_id, c.author_id
      from comments c
      join events on events.id = c.feed_event_id
     where c.deleted_at is null
  ),
  authors as (
    select p.id
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  )
  select r.feed_event_id, count(*)::integer
    from rows r
    join authors a on a.id = r.author_id
   group by r.feed_event_id;
$$;

create or replace function _can_read_comment(p_reader uuid, p_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from comments c
      join feed_events e on e.id = c.feed_event_id
     where c.id = p_comment_id
       and can_view_profile(p_reader, c.author_id)
       and can_view_profile(p_reader, e.actor_id)
       and _follow_story_open_to(p_reader, e.id)  -- 20261130000100
  );
$$;

create or replace function comment_reactors(p_comment_id uuid)
returns table (
  user_id      uuid,
  username     text,
  display_name text,
  avatar_path  text,
  kind         text
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  the_comment as (
    select c.id
      from comments c
      join feed_events e on e.id = c.feed_event_id
      cross join me
     where c.id = p_comment_id
       and can_view_profile(me.id, e.actor_id)
       and can_view_profile(me.id, c.author_id)
       and _follow_story_open_to(me.id, e.id)  -- 20261130000100
  )
  select cr.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         cr.kind
    from comment_reactions cr
    join the_comment tc on tc.id = cr.comment_id
    join profiles p on p.id = cr.user_id
    cross join me
   where can_view_profile(me.id, cr.user_id)
   -- Newest first, stably: the person who just reacted is the one the reader opened
   -- this to find. The client floats the reader's own row to the top itself, the
   -- same as the feed's list.
   order by cr.created_at desc, cr.user_id;
$$;

create or replace function mention_candidates(
  p_feed_event_id uuid,
  p_query         text default '',
  p_limit         integer default 8
)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_path  text,
  participant  boolean
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  event as (
    select e.id, e.actor_id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
       and _follow_story_open_to(me.id, e.id)  -- 20261130000100
  ),
  fragment as (
    -- Capped the way `search_users` caps its own query, and for its reason: nothing
    -- good comes of a 4kB search box.
    select btrim(left(coalesce(p_query, ''), 100)) as q
  ),
  participants as (
    select ev.actor_id as uid from event ev
    union
    select c.author_id from comments c, event ev where c.feed_event_id = ev.id
  ),
  followed as (
    select f.followee_id as uid
      from follows f, me
     where f.follower_id = me.id and f.state = 'approved'
  ),
  /**
   * The widening, and the `f.q <> ''` is the whole of the restraint.
   *
   * Bounded before `_can_mention` runs rather than after: the oracle is a function
   * call per row, and this is the one source that could otherwise offer it the whole
   * profiles table. The limit is generous against the outer one so that ranking by
   * participant-first still has something to choose from.
   */
  discoverable as (
    select p.id as uid
      from profiles p, fragment f, event ev
     where f.q <> ''
       and (
         p.username::text ilike f.q || '%'
         or coalesce(p.display_name, '') ilike f.q || '%'
         -- Any word of the display name, so "Abi Sola" answers to `@sola`.
         or coalesce(p.display_name, '') ilike '% ' || f.q || '%'
       )
       and can_discover_profile((select id from me), p.id)
     order by p.username
     limit 50
  ),
  candidates as (
    select uid, true as participant from participants
    union all
    select uid, false from followed where uid not in (select uid from participants)
    union all
    select uid, false from discoverable
     where uid not in (select uid from participants)
       and uid not in (select uid from followed)
  )
  select p.id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         bool_or(c.participant)
    from candidates c
    join profiles p on p.id = c.uid
    cross join fragment f
   where _can_mention(p_feed_event_id, p.id)
     and (
       f.q = ''
       or p.username::text ilike f.q || '%'
       or coalesce(p.display_name, '') ilike f.q || '%'
       or coalesce(p.display_name, '') ilike '% ' || f.q || '%'
     )
   group by p.id, p.username, p.display_name, p.avatar_path
   order by bool_or(c.participant) desc, p.username
   limit least(greatest(coalesce(p_limit, 8), 1), 10);
$$;

-- 4. Mentions: recipient-side only (Codex, PR 322)

create or replace function _apply_comment_mentions(
  p_comment_id    uuid,
  p_feed_event_id uuid,
  p_mention_ids   uuid[],
  -- Whether the comment is a reply, for the copy alone. The notification type is
  -- the same either way: a mention is a mention, and splitting it into two types
  -- would give it two preference categories to be silenced through.
  p_is_reply      boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max    integer;
  v_wanted uuid[];
  v_bad    uuid;
begin
  -- Aliased `w(uid)`, and the alias is not decoration: written as `unnest(...) as
  -- id`, an inner reference inside a correlated subquery over a table with its own
  -- `id` silently binds to the wrong one. `set_watch_tags` shipped that bug and
  -- filed three notifications for one save.
  select coalesce(array_agg(distinct w.uid), '{}') into v_wanted
    from unnest(coalesce(p_mention_ids, '{}'::uuid[])) as w(uid)
   where w.uid is not null;

  select coalesce((select (value)::integer from app_config where key = 'mentions.max_per_comment'), 10)
    into v_max;

  if coalesce(array_length(v_wanted, 1), 0) > v_max then
    raise exception 'you can mention up to % people in one comment', v_max using errcode = '22023';
  end if;

  -- Refused as a whole rather than partially applied, which is `set_watch_tags`'
  -- rule and for its reason: silently dropping the one person who is no longer
  -- eligible leaves the author believing they said something they did not.
  --
  -- A person already carrying an *active* mention on this comment is exempt, so
  -- an edit does not fail because somebody went private after the original
  -- comment was posted. Their stamp is already spent, so the exemption cannot
  -- produce a notification. A block is not exempted this way -- `_can_mention`
  -- fails for the blocked pair, and the exemption only reaches somebody the
  -- author is already, actively, naming.
  select w.uid into v_bad
    from unnest(v_wanted) as w(uid)
   where not _can_mention(p_feed_event_id, w.uid)
     and not exists (
       select 1 from comment_mentions m
        where m.comment_id = p_comment_id and m.mentioned_id = w.uid and m.active
     )
   limit 1;

  if v_bad is not null then
    raise exception 'you can only mention people you follow or who are in this conversation'
      using errcode = '42501';
  end if;

  -- The handle is read here rather than trusted from the client: it has to be what the
  -- *body* spells, and the body was written from this same list a moment ago.
  insert into comment_mentions (comment_id, mentioned_id, active, handle)
  select p_comment_id, w.uid, true, p.username::text
    from unnest(v_wanted) as w(uid)
    join profiles p on p.id = w.uid
  -- `notified_at` is deliberately absent from this SET list, and its absence is
  -- the whole feature. A row that survives keeps its stamp.
  --
  -- `handle` is deliberately absent too, and for the opposite reason: the stored
  -- spelling must stay the one the *body* uses, so re-saving a comment after the person
  -- renamed does not overwrite the only record of what the text says.
  on conflict (comment_id, mentioned_id) do update set active = true;

  update comment_mentions
     set active = false
   where comment_id = p_comment_id
     and mentioned_id <> all (v_wanted)
     and active;

  with claimed as (
    update comment_mentions m
       set notified_at = now()
     where m.comment_id = p_comment_id
       and m.mentioned_id = any (v_wanted)
       and m.notified_at is null
       -- 20261130000100 (Codex, PR 322): nobody is told about a follow story closed to
       -- them. Recipient-side and silent: whom the author may NAME is still `_can_mention`
       -- alone, unchanged, because refusing a name (42501) or dropping it from the
       -- candidates on this predicate would tell the author whether a third party and the
       -- story's member have blocked each other. Not stamped either, so the stamp is not
       -- spent on a mention nobody received.
       and _follow_story_open_to(m.mentioned_id, p_feed_event_id)
    returning m.mentioned_id
  )
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
  select c.mentioned_id,
         'mention',
         auth.uid(),
         'feed_event',
         p_feed_event_id,
         jsonb_build_object('comment_id', p_comment_id, 'reply', coalesce(p_is_reply, false))
    from claimed c;
end;
$$;

-- 5. The table policies (direct PostgREST reads of reactions and comments)

drop policy if exists reactions_read on reactions;
create policy reactions_read on reactions for select
  using (
    can_i_view(user_id)
    and exists (
      select 1 from feed_events e
       where e.id = feed_event_id
         and can_i_view(e.actor_id)
         and follow_story_open_to_me(e.id)  -- 20261130000100
    )
  );

drop policy if exists comments_read on comments;
create policy comments_read on comments for select
  using (
    can_i_view(author_id)
    and exists (
      select 1 from feed_events e
       where e.id = feed_event_id
         and can_i_view(e.actor_id)
         and follow_story_open_to_me(e.id)  -- 20261130000100
    )
  );

-- comment_reactions_read is unchanged: its `exists (select 1 from comments ...)` runs under
-- the caller's RLS, so it inherits comments_read above.


-- 6. Q1: freeze a story on its first reaction or comment

create or replace function _post_follow_activity(p_actor uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval;
  v_event  uuid;
  v_cap    integer;
  v_held   integer;
begin
  if p_actor is null or p_target is null or p_actor = p_target then
    return;
  end if;

  -- Ordered pair first, then the actor's own key. `for update` cannot lock a story that does
  -- not exist yet, and the actor is not always the caller.
  perform _lock_pair(p_actor, p_target);
  perform pg_advisory_xact_lock(hashtextextended('follow_story:' || p_actor::text, 0));

  select make_interval(mins => coalesce(
           (select (value)::integer from app_config
             where key = 'feed.follow_aggregation_minutes'),
           60))
    into v_window;

  -- §A11. The reverse story is still open and already says this relationship exists.
  if exists (
    select 1
      from feed_events e
      join feed_follow_targets ft on ft.event_id = e.id
     where e.type = 'follow_added'
       and e.actor_id = p_target
       and ft.followed_id = p_actor
       and e.causal_at > now() - v_window
  ) then
    return;
  end if;

  -- The actor's open story, if they have one. `for update` because the actor of a story is
  -- not always the caller: two people redeeming the same inviter's link at the same moment
  -- are two transactions appending to one row.
  select e.id
    into v_event
    from feed_events e
   where e.type = 'follow_added'
     and e.actor_id = p_actor
     and e.causal_at > now() - v_window
     -- 20261130000100 (Q1): a story somebody has reacted to or commented on is frozen,
     -- recorded at first engagement so removing the reaction does not thaw it (Codex,
     -- PR 322). The next follow opens a new story, so a conversation is always about what
     -- its participants saw.
     and not exists (select 1 from follow_story_engaged x where x.event_id = e.id)
   order by e.causal_at desc
   limit 1
     for update;

  if v_event is null then
    -- `causal_step` 0: a follow is an act rather than a consequence of one, so it takes the
    -- base step a ranking takes (20260901000100).
    insert into feed_events (actor_id, type, payload, causal_at, causal_step)
    values (p_actor, 'follow_added', '{}'::jsonb, now(), 0)
    returning id into v_event;
  else
    -- §2. A full story takes no more, and the ceiling is itself bounded: this is the only
    -- thing keeping a Feed read small now that the reader truncates nothing, so it may not
    -- be an unconstrained row in a table. 1..200, defaulting to 50.
    --
    -- The count is safe inside the actor lock: nobody else can be adding to this actor's
    -- open story, so it cannot be stale by the time the insert below runs.
    select least(greatest(coalesce(
             (select (value)::integer from app_config where key = 'feed.follow_story_max_people'),
             50), 1), 200)
      into v_cap;

    select count(*) into v_held from feed_follow_targets ft where ft.event_id = v_event;

    -- The membership test comes first, on a re-follow's behalf: a person already in the
    -- story is already counted, so the insert below is a no-op and the ceiling does not
    -- apply to them. Without it a full story would silently drop a name it already holds.
    if v_held >= v_cap and not exists (
      select 1 from feed_follow_targets ft
       where ft.event_id = v_event and ft.followed_id = p_target
    ) then
      return;
    end if;
  end if;

  -- Idempotent by the primary key, which is what keeps a follow, an unfollow and a re-follow
  -- inside one window to one mention of one person.
  insert into feed_follow_targets (event_id, followed_id)
  values (v_event, p_target)
  on conflict (event_id, followed_id) do nothing;
end;
$$;

-- 7. Heart Magnet excludes follow stories

create or replace function _award_metric(p_user uuid, p_award text, p_threshold integer)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v bigint;
begin
  case p_award
    when 'movie-muncher' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'movie';

    when 'season-snacker' then
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind = 'season';

    when 'invite-instigator' then
      -- The predicate 20260827001100 declared canonical: attributed AND activated.
      select count(*) into v
        from invite_attributions ia
       where ia.inviter_id = p_user and ia.activated_at is not null;

    when 'queue-dragon' then
      select count(*) into v
        from watchlist w join media_items m on m.id = w.media_item_id
       where w.user_id = p_user and m.kind in ('movie', 'season');

    when 'rating-rascal' then
      select count(*) into v
        from rankings r join media_items m on m.id = r.media_item_id
       -- 20261114000200: a ranked show is a ranking, so it counts toward the rankings award.
       where r.user_id = p_user and m.kind in ('movie', 'season', 'series');

    when 'comment-gremlin' then
      -- Comments authored, and ONLY comments (founder split, 20260901000100).
      -- The public-note term that used to be added here is gone: a review is a
      -- different behaviour from a comment and no longer moves this track.
      -- Tombstones are still counted -- a retraction does not un-say that the
      -- person wrote. Owner truth: no viewer-relative comments_read filtering,
      -- for the reason 20260828000100's header gives.
      select count(*) into v from comments c where c.author_id = p_user;

    when 'hype-courier' then
      select count(*) into v
        from title_recommendations tr
       where tr.sender_id = p_user;

    when 'scream-snack' then
      v := _award_genre_count(p_user, array['Horror']);
    when 'lol-mode' then
      v := _award_genre_count(p_user, array['Comedy']);
    when 'softie-hours' then
      v := _award_genre_count(p_user, array['Drama', 'Romance']);
    when 'space-brain' then
      v := _award_genre_count(p_user, array['Science Fiction']);
    when 'boom-club' then
      v := _award_genre_count(p_user, array['Action']);
    when 'toon-bloom' then
      v := _award_genre_count(p_user, array['Animation']);
    when 'truth-worm' then
      v := _award_genre_count(p_user, array['Documentary']);

    when 'passport-mode' then
      -- effectiveLanguage: own trimmed non-empty, else the parent's for a season.
      select count(*) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and coalesce(
               nullif(btrim(coalesce(m.original_language, '')), ''),
               case when m.kind = 'season'
                    then nullif(btrim(coalesce(par.original_language, '')), '') end
             ) not in ('en');

    when 'time-hopper' then
      -- Number(release_date.slice(0,4)) < 2000, with the same silence for a
      -- missing or malformed date the JS NaN gives.
      select count(*) into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user
         and m.kind in ('movie', 'season')
         and m.release_date is not null
         and left(m.release_date::text, 4) ~ '^[0-9]{4}$'
         and left(m.release_date::text, 4)::integer < 2000;

    when 'genre-gremlin' then
      -- COUNT DISTINCT canonical genres present anywhere in the collection.
      select count(distinct ap.canonical) into v
        from user_media um
        join media_items m on m.id = um.media_item_id
        left join media_items par on par.id = m.parent_id
        cross join lateral unnest(
          _award_effective_genres(m.kind::text, m.genres, par.genres)
        ) as label
        join award_genre_patterns ap on lower(label) ~ ap.pattern
       where um.user_id = p_user
         and m.kind in ('movie', 'season');

    when 'two-screen-life' then
      -- The one tier-dependent metric: each side capped at threshold / 2
      -- (thresholds are even by construction; awards.test.ts pins cap = t/2).
      select least(count(*) filter (where m.kind = 'movie'),  p_threshold / 2)
           + least(count(*) filter (where m.kind = 'season'), p_threshold / 2)
        into v
        from user_media um join media_items m on m.id = um.media_item_id
       where um.user_id = p_user and m.kind in ('movie', 'season');

    when 'heart-magnet' then
      -- Reactions on the user's own feed events, excluding their own — the
      -- client's neq(user_id) written where the database can see it.
      select count(*) into v
        from reactions r
        join feed_events fe on fe.id = r.feed_event_id
       where fe.actor_id = p_user and r.user_id <> p_user
         -- 20261130000100: reactions on follow stories do not count.
         and fe.type <> 'follow_added';

    when 'mutual-mania' then
      -- Approved in both directions, with a profile that still exists. Existence,
      -- not can_i_view — the ledger has no viewer. Self is impossible
      -- (no_self_follow), stated anyway.
      select count(*) into v
        from follows a
        join follows b on b.follower_id = a.followee_id
                      and b.followee_id = a.follower_id
        join profiles p on p.id = a.followee_id
       where a.follower_id = p_user
         and a.followee_id <> p_user
         and a.state = 'approved'
         and b.state = 'approved';

    else
      raise exception 'unknown award %', p_award using errcode = '22023';
  end case;

  return coalesce(v, 0);
end;
$function$;

-- 8. Push copy: the activity type rides with the job

create or replace function claim_push_batch(p_limit integer default 20, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
  v_pro_dead uuid[];
  v_sent    uuid[];
  v_mine    uuid[];
  v_busy    uuid[];
begin
  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  -- 20261028000100. LOCK FIRST, THEN JUDGE, AND NEVER WAIT (Codex final reviews, MAJOR).
  --
  -- Every proactive candidate behind this batch is locked before anything about it is
  -- checked, and stays locked until it is marked sent at the end of this transaction, so
  -- nothing (a mute, a social writer) can change it between the checks and the send.
  --
  -- SKIP LOCKED, so the claim never waits on a candidate row. A candidate another
  -- transaction owns at this moment (a mute suppressing it, a friend joining its cluster)
  -- is not judged, not sent and not charged: its job is put back in the queue exactly as
  -- it was before this claim (pending, no lease, the attempt given back), and the next
  -- drain judges it afresh with every check, dropping it if it was muted, suppressed or
  -- expired meanwhile. A claim that waits could close a lock cycle with a writer that
  -- holds rows of several readers; one that skips cannot be in any cycle. Optional
  -- delivery prefers late or missed over blocked, deadlocked or duplicated.
  --
  -- THIS DEPENDS ON claim_push_batch STAYING VOLATILE (the default; do not mark it stable
  -- or immutable). Under READ COMMITTED a volatile function takes a fresh snapshot for
  -- each statement, so the checks below read the very row version this statement locked,
  -- including a change committed an instant before. A stable function shares one snapshot
  -- across its whole body and could judge an older version than the one it holds.
  select coalesce(array_agg(s.notification_id), '{}'::uuid[]) into v_mine
    from (
      select pc.notification_id
        from proactive_candidates pc
       where pc.notification_id = any (v_claimed)
       order by pc.id
         for update skip locked
    ) s;

  select coalesce(array_agg(pc.notification_id), '{}'::uuid[]) into v_busy
    from proactive_candidates pc
   where pc.notification_id = any (v_claimed)
     and not (pc.notification_id = any (v_mine));

  if array_length(v_busy, 1) is not null then
    -- Back to a clean, claimable state, as if this claim had never taken it.
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
           attempts   = greatest(o.attempts - 1, 0)
     where o.notification_id = any (v_busy);
    v_claimed := array(select unnest(v_claimed) except select unnest(v_busy));
    if array_length(v_claimed, 1) is null then
      return jsonb_build_array();
    end if;
  end if;

  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  -- 20261028000100 (a). The proactive jobs that must not go, and the candidate told why.
  -- At most once: a job whose candidate is already `sent` (an expired lease, a retry) is
  -- dropped and its outbox row deleted below; the candidate stays `sent`. Reactive jobs
  -- are not in this set and keep their at-least-once retries unchanged.
  with pro as (
    select pc.id, pc.notification_id, pc.state,
           _proactive_claim_reason(pc.id, p_now) as reason
      from proactive_candidates pc
     where pc.notification_id = any (v_claimed)
  ),
  settled as (
    update proactive_candidates pc
       set state              = case when pro.reason in ('expired', 'outside_window', 'no_timezone')
                                     then 'expired' else 'suppressed' end,
           suppression_reason = pro.reason,
           decided_at         = p_now
      from pro
     where pc.id = pro.id and pro.reason is not null and pc.state = 'selected'
    returning pc.id
  )
  select coalesce(array_agg(pro.notification_id) filter (where pro.reason is not null), '{}'::uuid[])
    into v_pro_dead
    from pro;

  v_dead := v_dead || v_pro_dead;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        'feed_event_id',   j.feed_event_id,
        -- 20261130000100. The activity's own type, so a follow story's push can say
        -- "your follow activity". Read through the `fe` join, so it is null wherever the
        -- title is: no activity, or an activity that is not the recipient's own.
        'feed_event_type', j.feed_event_type,
        'comment_excerpt', j.comment_excerpt,
        -- 20260917001500. The job an import notification is about, and the summary its
        -- completion push quotes. Null for every other type.
        'import_job_id',   j.import_job_id,
        'import_counts',   j.import_counts,
        -- 20260920000200. Which award and tier an award_earned push is about, and the
        -- names its row was written with. Null for every other type. Not `award_name`:
        -- see the header.
        'award_key',        j.award_key,
        'award_tier',       j.award_tier,
        'award_family',     j.award_family,
        'award_tier_label', j.award_tier_label,
        -- 20261028000100. goal_completed's year, medium and target. Null otherwise.
        'goal',            j.goal,
        -- 20261028000100. A proactive job's copy facts, resolved now. Null otherwise.
        'proactive',       j.proactive,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           fe.type::text                           as feed_event_type,
           case when n.subject_type = 'import_job' then n.subject_id end as import_job_id,
           case when n.type in ('import_started', 'import_completed', 'import_failed')
                then n.payload end as import_counts,
           -- award_earned only (20260920000200). The keys the celebration route takes and
           -- the push copy is looked up by; the names are the fallback for a key the
           -- sender does not know.
           case when n.type = 'award_earned' then n.payload ->> 'award' end      as award_key,
           case when n.type = 'award_earned' then n.payload ->> 'tier' end       as award_tier,
           case when n.type = 'award_earned' then n.payload ->> 'award_name' end as award_family,
           case when n.type = 'award_earned' then n.payload ->> 'tier_label' end as award_tier_label,
           -- goal_completed only (20261028000100).
           case when n.type = 'goal_completed' then jsonb_build_object(
             'year',     n.payload -> 'year',
             'category', n.payload ->> 'category',
             'target',   n.payload -> 'target'
           ) end                                   as goal,
           -- Proactive only (20261028000100). Ids, dates and display names: nothing
           -- anybody wrote.
           case when pc.id is not null then jsonb_build_object(
             'type',        pc.type,
             'opens_on',    pc.metadata ->> 'opens_on',
             'local_today', (p_now at time zone coalesce(ac.timezone, 'UTC'))::date,
             -- The last instant this push may reach a phone (Codex re-review, MAJOR): the
             -- earlier of the candidate's own expiry and the close of the evening it was
             -- selected for, in the reader's zone. push-sender sends it to Expo as the
             -- message's `expiration`, so a phone that is offline at 19:59 is not woken
             -- by it the next morning, and drops the message itself if it is already past.
             'deliver_by',  least(
                              pc.expires_at,
                              (pc.selected_local_date
                                 + make_time(_proactive_int('proactive.window_end_hour', 20), 0, 0))
                                at time zone coalesce(ac.timezone, 'UTC')),
             'reason',      pc.metadata ->> 'reason',
             'actor_count', case when pc.type = 'watchlist_social'
                              then (select count(*) from _proactive_social_actors(pc.id, n.recipient_id)) end,
             -- 20261031000100: the two STRONGEST visible friends by affinity, then the
             -- earliest. Names only; the affinity itself never leaves the database.
             'actor_names', case when pc.type = 'watchlist_social' then (
                              select jsonb_agg(coalesce(nullif(s.display_name, ''), s.username)
                                               order by s.rn)
                                from (select * from _proactive_ranked_social_actors(pc.id, n.recipient_id, p_now)
                                       order by rn limit 2) s
                            ) end,
             -- 20261031000100, season_premiere only: which season, and the verified date.
             'season_number', case when pc.type = 'season_premiere'
                                then (pc.metadata ->> 'season_number')::integer end,
             'available_on',  case when pc.type = 'season_premiere'
                                then pc.metadata ->> 'available_on' end
           ) end                                   as proactive,
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           -- Only what the recipient could open and read right now.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and _can_read_comment(n.recipient_id, c.id)
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
                -- 20261028000100 (b). A proactive job goes only to devices whose build can
                -- route it; a reactive job, as always, to every live device.
                and (pc.id is null or _proactive_capable_token(d))
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            -- The same three rules `my_notifications` states, in the same words, from
            -- the recipient's side -- including the read-time `can_view_profile` on a
            -- mention's activity owner, so a title whose owner has since blocked the
            -- recipient or gone private is not pushed to their lock screen.
            and case
                  when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                  when n.type = 'mention' then can_view_profile(n.recipient_id, fe.actor_id)
                  else fe.actor_id = n.recipient_id
                end
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
      left join proactive_candidates pc
             on pc.notification_id = n.id
      left join account_context ac
             on ac.user_id = n.recipient_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- 20261130000100 (Codex, PR 322): eligibility at delivery, not only at filing. A
       -- notification about a follow story that has since closed to its recipient is not
       -- pushed (and, unclaimed, is reaped below). TRUE for every other subject.
       -- Only where the recipient may view the story's owner (Codex, PR 322): for anyone
       -- else the answer would track the owner's follow graph. Their rows keep today's
       -- rules, which already withhold what they may not see.
       and not exists (
         select 1 from feed_events sfe
          where n.subject_type = 'feed_event'
            and sfe.id = n.subject_id
            and sfe.type = 'follow_added'
            and can_view_profile(n.recipient_id, sfe.actor_id)
            and not _follow_story_open_to(n.recipient_id, sfe.id)
       )
       -- **Restored 2026-08-30 (20260904000100).** An actorless notification has nobody
       -- to have gone, and this predicate was the actorless filter by accident until
       -- 20260828000100 wrote the escape. The 20260830000100 rebuild -- which added the
       -- mention join two lines up -- was assembled from an ancestor that predated that
       -- escape and dropped it again, silently: an award congratulations was claimed,
       -- filtered out here, and its outbox row deleted by the reap below, so it never
       -- retried and never sent. Exactly the failure 20260828000100 warns a
       -- create-or-replace can make invisible in a diff.
       and (p.id is not null or n.actor_id is null)
  ) j;

  -- 20261028000100 (c). Handed to push-sender. Not Expo acceptance, not delivery.
  with sent as (
    update proactive_candidates pc
       set state               = 'sent',
           sent_at             = now(),
           actor_count_at_send = (job -> 'proactive' ->> 'actor_count')::integer
      from jsonb_array_elements(v_jobs) as job
     where pc.notification_id = (job ->> 'notification_id')::uuid
       and pc.state = 'selected'
    returning pc.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_sent from sent;

  -- A proactive job goes out ONLY if its candidate went selected -> sent in this claim.
  -- Under the lock above that is every proactive job that passed the checks; this is the
  -- guarantee written down rather than inferred, so no future path can return a proactive
  -- job whose ledger row does not say it was sent (and so counted against the caps).
  -- Reactive jobs carry no proactive facts and are untouched.
  select coalesce(jsonb_agg(job order by ord), jsonb_build_array())
    into v_jobs
    from jsonb_array_elements(v_jobs) with ordinality as e(job, ord)
   where jsonb_typeof(job -> 'proactive') is distinct from 'object'
      or (job ->> 'notification_id')::uuid = any (v_sent);

  -- Everything claimed and not returned leaves the queue, including a proactive job the
  -- line above withheld, so it cannot be claimed again and leak later.
  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

revoke execute on function claim_push_batch(integer, timestamptz) from public, anon, authenticated;
grant execute on function claim_push_batch(integer, timestamptz) to service_role;

-- 9. The inbox reads eligibility now, not when the row was filed

create or replace function my_notifications(p_limit integer default 50)
returns table (
  id                 uuid,
  kind               text,
  created_at         timestamptz,
  read_at            timestamptz,
  actor_id           uuid,
  actor_username     text,
  actor_display_name text,
  actor_avatar_path  text,
  subject_type       text,
  subject_id         uuid,
  media_item_id      uuid,
  media_kind         media_kind,
  media_title        text,
  series_title       text,
  payload            jsonb,
  -- One line of what was written, or null. See the header for the three
  -- conditions and for why the server rather than the client withholds it.
  comment_excerpt    text,
  -- True when the live comment this row is about is spoiler-marked. The reason
  -- there is no excerpt, said out loud, so the row can draw "Contains spoilers"
  -- rather than an empty second line that reads as a rendering bug.
  comment_spoilers   boolean,
  -- `watch_tag` only: whether this reader has already ranked the title. Decides
  -- whether the row offers Rank, and goes true on the next refetch after they do.
  viewer_ranked      boolean,
  -- The subject feed event's own type, for the row's sentence (20260901000100).
  subject_activity_type text,
  -- watchlist_social only (20261028000100): up to three members, as
  -- [{username, display_name, avatar_path}], and how many there are in all. Strongest
  -- first by affinity, then earliest, since 20261031000100.
  cluster_actors     jsonb,
  cluster_count      integer
)
language sql stable security definer
set search_path = public
as $$
  select n.id,
         n.type,
         n.created_at,
         n.read_at,
         n.actor_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         n.subject_type,
         n.subject_id,
         m.id,
         m.kind,
         m.title,
         parent.title,
         -- A theatrical row states the release's date as it stands NOW, not the date it
         -- was written with (Codex re-review): see the filter below.
         case when n.type = 'theatrical_release'
              then n.payload || jsonb_build_object('opens_on', rel.opens_on)
              -- 20261031000100. A season row states the verified date as it is now.
              when n.type = 'season_premiere'
              then n.payload || jsonb_build_object('available_on', sea.available_on)
              else n.payload end,
         case
           when n.type in ('comment', 'mention') then (
             select left(c.body, 140)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and _can_read_comment(auth.uid(), c.id)
           )
         end,
         coalesce(
           case
             when n.type in ('comment', 'mention') then (
               select c.has_spoilers
                 from comments c
                where c.id = (n.payload ->> 'comment_id')::uuid
                  and c.deleted_at is null
                  and _can_read_comment(auth.uid(), c.id)
             )
           end,
           false
         ),
         case
           when n.type = 'watch_tag' then exists (
             select 1 from rankings r
              where r.user_id = auth.uid()
                and r.media_item_id = case
                                        when n.subject_type = 'media_item' then n.subject_id
                                        else null
                                      end
           )
           else false
         end,
         fe.type,
         cl.actors,
         cl.n
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one. See
     * 20260901000100 for the full reasoning; carried across unchanged.
     */
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and case
                when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                when n.type = 'mention' then can_view_profile(auth.uid(), fe.actor_id)
                else fe.actor_id = auth.uid()
              end
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    left join media_items parent
           on parent.id = m.parent_id
    left join proactive_candidates pc
           on n.type in ('watchlist_social', 'theatrical_release', 'season_premiere')
          and pc.notification_id = n.id
    /**
     * theatrical_release: the date the release event holds now. A film still scheduled
     * opens on its current scheduled date; one that has opened, on the day it did. One
     * that was withdrawn, lost its date, or is gone has none, and its row is not drawn
     * (Codex re-review): a postponed film must not keep saying the old date, and a
     * cancelled one must not keep saying it opens at all. Read-time, so it is true
     * whenever the inbox is read, before or after the push, with one row throughout.
     */
    left join lateral (
      select case
               when re.state = 'scheduled' then re.scheduled_date
               when re.state = 'released'  then coalesce(re.released_on, re.scheduled_date)
             end as opens_on
        from release_events re
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
    ) rel on pc.type = 'theatrical_release'
    /**
     * season_premiere (20261031000100): the verified date, while the verification row
     * still exists and still agrees with a release event that is still released on that
     * date. Removed, moved or retracted: no date, and the row is not drawn. Expiry of the
     * verification does not hide it (it is a dated fact); it only stops delivery.
     */
    left join lateral (
      select v.available_on
        from release_events re
        join proactive_season_availability v
          on v.release_event_id = re.id
         and v.region = coalesce(pc.metadata ->> 'region', 'US')
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
         and re.state = 'released'
         and re.scheduled_date = re.released_on
         and v.available_on = re.released_on
    ) sea on pc.type = 'season_premiere'
    left join lateral (
      select count(*)::integer as n,
             jsonb_agg(jsonb_build_object('username', s.username,
                                          'display_name', s.display_name,
                                          'avatar_path', s.avatar_path)
                       order by s.rn) filter (where s.rn <= 3) as actors
        from _proactive_ranked_social_actors(pc.id, auth.uid(), now()) s
    ) cl on pc.type = 'watchlist_social'
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
     -- 20261028000100. The push-only type's carrier row is never part of the inbox.
     and n.type <> 'watchlist_resurface'
     -- And a social row nobody is left in says nothing true.
     and (n.type <> 'watchlist_social' or coalesce(cl.n, 0) > 0)
     -- And a theatrical row whose release no longer has a date says nothing true.
     and (n.type <> 'theatrical_release' or rel.opens_on is not null)
     -- And a season row whose availability is no longer on record says nothing true.
     and (n.type <> 'season_premiere' or sea.available_on is not null)
     -- 20261130000100 (Codex, PR 322): and a row about a follow story that has since closed
     -- to this reader is not drawn. Read-time, so it returns if the story opens again.
     -- Only where the reader may view the story's owner (Codex, PR 322), for the reason
     -- given in claim_push_batch.
     and not exists (
       select 1 from feed_events sfe
        where n.subject_type = 'feed_event'
          and sfe.id = n.subject_id
          and sfe.type = 'follow_added'
          and can_view_profile(auth.uid(), sfe.actor_id)
          and not _follow_story_open_to(auth.uid(), sfe.id)
     )
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
