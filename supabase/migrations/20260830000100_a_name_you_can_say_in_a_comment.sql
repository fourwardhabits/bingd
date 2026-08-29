-- ===========================================================================
-- A NAME YOU CAN SAY IN A COMMENT, AND A WATCH THAT NAMES YOU BACK
--
-- Final social-interaction tranche, 2026-08-30. Four founder corrections, of
-- which three land here:
--
--   1. @mentions in comments and replies, with a mention relation that outlives
--      handle changes, edits and refetches, and a notification that fires at
--      most once per (comment, person) for good.
--   2. Inbox rows that carry what was said, spoiler-safe, so "Ravi commented on
--      your activity" stops being the whole of what the reader is told.
--   3. The watched-with row learns whether the reader has ranked the title, so
--      the Bell can offer Rank without inventing a second ranking surface.
--
-- The fourth ("Add more details" must reopen the whole log editor) is a client
-- change and is not here.
--
-- ===========================================================================
-- WHY A MENTION IS A ROW AND NOT A SUBSTRING
--
-- The cheap implementation is to parse `@handle` out of the body whenever
-- somebody needs to know who was mentioned. It fails three ways the founder
-- named explicitly:
--
--   - **handles move.** `profiles.username` is changeable, so a body written
--     today resolves to a different person, or to nobody, after a rename. The
--     notification was already delivered by then; the association it was made
--     from has silently rotted.
--   - **an edit is not a new statement.** Re-parsing on every save cannot tell
--     "still mentions Ravi" from "mentions Ravi", so Ravi is told again, and
--     again, for every fixed typo.
--   - **removing and re-adding is free.** Text has no memory. A person who can
--     be re-mentioned by deleting six characters and typing them back is a
--     person who can be rung at will -- the exact ping vector `20260816000700`
--     closed for watch tags, arriving through a different door.
--
-- So the relation is a table, keyed on the pair, and **rows are never deleted**.
-- `active` says whether the current text still names them, which is what the
-- composer reads back on an edit; `notified_at` says they have been told, once,
-- and nothing ever clears it. Removing a mention sets `active = false` and
-- leaves the ledger standing, which is the whole of the anti-farming argument:
-- the second mention of the same person in the same comment finds a stamp.
--
-- ===========================================================================
-- WHO MAY BE MENTIONED, AND THE HALF THAT IS EASY TO FORGET
--
-- Two populations, union, per the founder:
--
--   A. people the commenter **follows** (approved, one direction is enough --
--      deliberately weaker than `_is_mutual_follow`, which governs watch tags,
--      because a comment mention makes no claim about anybody's evening);
--   B. **participants** in this conversation -- the activity's actor, and
--      anybody who has commented on it.
--
-- and then the condition that is not about the commenter at all:
--
--   **the mentioned person must be able to see the activity.**
--
-- Without it, mentioning is a way to tell somebody that a private account
-- ranked a particular title: the notification names the actor and the title,
-- and it arrives in the inbox of a person who could not have read either. So
-- `_can_mention` asks `can_view_profile(p_mentioned, e.actor_id)` -- the
-- *mentioned* party's view, not the caller's -- and that is why it takes the
-- event rather than only the person.
--
-- Blocks in either direction, suspended and deleted accounts, and self are out
-- by construction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The relation
-- ---------------------------------------------------------------------------

create table comment_mentions (
  comment_id   uuid not null references comments(id) on delete cascade,
  mentioned_id uuid not null references profiles(id) on delete cascade,
  -- Whether the comment's *current* text still names this person. The composer
  -- reads it back when an edit begins, so the ids survive the round trip
  -- through a text field that only knows handles.
  active       boolean not null default true,
  /**
   * The handle **as the body spells it**, recorded when the mention was applied.
   *
   * Not authority — the id above is, and nothing resolves a mention through this column.
   * It exists for one job: when the composer reopens a comment to edit it, the body may
   * still say `@ravi` while Ravi is now `ravinder`, and matching the text against current
   * handles alone would resolve nothing and quietly deactivate a mention that is plainly
   * still there. Seeding the composer with both spellings is what makes the association
   * survive a rename through an ordinary edit rather than only through a save that
   * happens to re-type the name. Independent review 68 found the gap.
   */
  handle       text,
  created_at   timestamptz not null default now(),
  -- The ledger. Set exactly once, by the writer that files the inbox row, and
  -- never cleared by anything. This column is the "at most one notification per
  -- comment id + mentioned user id, ever" rule, stored rather than argued.
  notified_at  timestamptz,
  primary key (comment_id, mentioned_id)
);

comment on table comment_mentions is
  'Who a comment names, by id rather than by the handle its body happens to spell. Rows are never deleted: removing a mention sets active = false, so re-adding the same person to the same comment finds notified_at already stamped and files nothing. That is the anti-farming rule, and it is why this is a table and not a regex over comments.body.';

comment on column comment_mentions.active is
  'Whether the comment''s current text still names this person. Read back by the composer when an edit begins; never consulted to decide whether to notify.';

comment on column comment_mentions.notified_at is
  'When the one mention notification for this pair was filed. Never cleared. A second mention of the same person in the same comment -- by editing, by removing and re-adding, or by two concurrent saves -- finds this set and files nothing.';

-- "Which comments name me", and the account-deletion path that already walks
-- every table naming a profile.
create index comment_mentions_mentioned on comment_mentions (mentioned_id) where active;

alter table comment_mentions enable row level security;

/**
 * No policy, deliberately, and the absence is the design.
 *
 * Every read of this table goes through `activity_comments`, which is
 * `security definer` and already resolves the far harder question of which
 * comments this reader may see at all. A direct-read policy would be a second
 * authorisation surface over the same rows, stating the same rule in different
 * words -- which is how the two come to disagree. RLS with no permissive policy
 * denies everything, which is the honest description of "there is no direct
 * read path".
 */

-- ---------------------------------------------------------------------------
-- 2. Eligibility
-- ---------------------------------------------------------------------------

/**
 * Whether the caller may name this person in a comment on this activity.
 *
 * Takes the event as well as the person, because two of the four conditions are
 * about the event: participation, and -- the one that matters -- whether the
 * *mentioned* party may see the thing they are about to be told about.
 *
 * The perspective for A and B is always `auth.uid()`'s, so this cannot be turned
 * into a "do these two people follow each other" oracle; it is revoked from
 * clients below regardless, exactly as `_can_tag` and `_is_mutual_follow` are.
 */
create or replace function _can_mention(p_feed_event_id uuid, p_mentioned uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_mentioned is not null
     and p_mentioned <> auth.uid()
     and exists (select 1 from profiles p where p.id = p_mentioned and p.status = 'active')
     -- Blocks override everything, and are read through `blocked_between` rather
     -- than through `blocks`, because `blocks_read` hides a block from the person
     -- it was made against -- an inline subquery would answer false for precisely
     -- the caller who must be refused. The same reasoning `_can_tag` records.
     and not blocked_between(p_mentioned, auth.uid())
     -- The mentioned person can see the activity. Their view, not the caller's:
     -- a mention must never be a way to tell somebody what a private account did.
     and exists (
       select 1 from feed_events e
        where e.id = p_feed_event_id
          and can_view_profile(p_mentioned, e.actor_id)
     )
     and (
       -- A. somebody the caller follows. One direction, approved -- a pending
       -- request to a private account is not a relationship, or requesting would
       -- become a way to put your name in their inbox before they let you in.
       exists (
         select 1 from follows f
          where f.follower_id = auth.uid()
            and f.followee_id = p_mentioned
            and f.state = 'approved'
       )
       -- B. a participant in this conversation: the actor, or anybody who has
       -- commented on it. A tombstone still counts -- its author is still in the
       -- room, and their remark is still what somebody is answering.
       or exists (
         select 1 from feed_events e
          where e.id = p_feed_event_id and e.actor_id = p_mentioned
       )
       or exists (
         select 1 from comments c
          where c.feed_event_id = p_feed_event_id and c.author_id = p_mentioned
       )
     );
$$;

comment on function _can_mention(uuid, uuid) is
  'Whether the caller may name this person in a comment on this activity: not themselves, active, unblocked either way, able to see the activity from their own side, and either followed by the caller (approved, one direction -- deliberately weaker than the mutual rule watch tags use, because a mention claims nothing about anybody''s evening) or already a participant in the thread. Internal: it answers questions about a named third party''s follow graph and about what they can see.';

-- How many people one comment may name. A ceiling rather than a product rule:
-- an unbounded array is an array a modified client fills with the whole graph.
insert into app_config (key, value)
values ('mentions.max_per_comment', '10'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The autocomplete's population
-- ---------------------------------------------------------------------------

/**
 * Who the composer may offer, for one activity and one typed fragment.
 *
 * **Not a user search.** `search_users` exists and this deliberately is not it:
 * the founder's rule is that typing `@` must not surface arbitrary accounts, and
 * the way to guarantee that is for the candidate set to be built from the two
 * populations `_can_mention` admits rather than filtered down to them afterwards.
 * A stranger is not ranked low here; they are not a row.
 *
 * Definer, and it answers nothing to a caller who cannot see the activity: the
 * `event` CTE yields no rows and the whole query is empty, which is the same
 * silence `activity_comments` chose for the same question.
 *
 * The fragment matches the start of the handle or of any word in the display
 * name -- `@ab` finds `abisola` and `Abi Sola`, and does not find `fabio`.
 * Prefix-only because an infix match over a follow list is a way to enumerate it
 * with a two-letter probe, and because it is what the reader expects of an @.
 */
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
  -- Participants sort first: in a conversation, the person you are most likely
  -- to be answering is somebody already in it.
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
  candidates as (
    select uid, true as participant from participants
    union all
    select uid, false from followed where uid not in (select uid from participants)
  ),
  fragment as (
    select btrim(coalesce(p_query, '')) as q
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
       -- Any word of the display name, so "Abi Sola" answers to `@sola`.
       or coalesce(p.display_name, '') ilike '% ' || f.q || '%'
     )
   group by p.id, p.username, p.display_name, p.avatar_path
   order by bool_or(c.participant) desc, p.username
   limit least(greatest(coalesce(p_limit, 8), 1), 10);
$$;

comment on function mention_candidates(uuid, text, integer) is
  'Who the comment composer may offer for one activity and one typed fragment: the people the caller follows plus the conversation''s own participants, each passed through _can_mention. Deliberately not search_users -- a stranger is not a low-ranked row here, they are not a row. Prefix matching only, on the handle or on any word of the display name, because an infix match over a follow list is a way to enumerate it. Returns nothing at all to a caller who cannot see the activity.';

-- ---------------------------------------------------------------------------
-- 4. Applying a comment's mentions
--
-- One function, called by the two writers, so posting and editing cannot come to
-- disagree about what a mention is.
--
-- Three statements and the order is the argument:
--
--   1. every wanted pair is upserted `active`, which creates the ledger row on a
--      first mention and re-activates a row whose stamp already exists;
--   2. every other pair on this comment goes `active = false` -- **not deleted**,
--      which is the anti-farming rule;
--   3. the stamp is claimed and the inbox rows are written from what the claim
--      returned.
--
-- Step 3 is one statement on purpose. `update ... where notified_at is null
-- returning` takes a row lock and yields exactly the pairs *this* transaction
-- moved from unstamped to stamped, so two concurrent saves of the same edit --
-- a replayed operation id that slipped past the ledger, a double-tapped Save,
-- an offline outbox flushing twice -- cannot both decide a person is new. The
-- second blocks, then sees the stamp, then returns nothing.
-- ---------------------------------------------------------------------------

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

comment on function _apply_comment_mentions(uuid, uuid, uuid[], boolean) is
  'Records what a comment names and files the inbox rows for whoever has not been told yet. Rows are never deleted -- a removed mention goes active = false and keeps its notified_at -- so remove-and-re-add files nothing. The notification claim is one `update ... where notified_at is null returning`, so two concurrent saves cannot both decide a person is new. Internal to add_comment and edit_comment.';

-- ---------------------------------------------------------------------------
-- 5. `add_comment`, rebuilt from 20260826000600 and given mentions
--
-- Rebuilt in full rather than patched, which is the discipline 20260817000200 and
-- 20260826000600 both record at length: a `create or replace` assembled from the
-- wrong ancestor is how hardening disappears without showing in a diff. Every
-- line below through the notification block is `20260826000600`'s, verbatim --
-- the two pre-lock visibility checks, the deterministic pair-lock order, the
-- `for share` pin on the parent, the re-resolution under the locks.
--
-- **The mention array is a sixth parameter with no default, and that is a
-- PostgREST decision rather than a stylistic one.** `20260826000600` had to drop
-- the four-argument `add_comment` because adding a *defaulted* parameter creates
-- a second function that the five-key payload matches ambiguously. With no
-- default, a five-key payload matches only the old signature and a six-key
-- payload matches only this one -- so a phone that has not taken this bundle
-- goes on posting comments, without mentions, exactly as it does today. The old
-- signature therefore stays, delegating rather than duplicating.
-- ---------------------------------------------------------------------------

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

  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  if v_reply_to is not null and v_reply_to <> auth.uid() and v_reply_to <> v_actor then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_reply_to, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id, 'reply_to', p_parent_id));
  end if;

  /**
   * The mentions, last, and **not deduplicated against the two rows above**.
   *
   * Somebody who is both the activity's owner and named in the comment gets a
   * `comment` row and a `mention` row, and that is correct rather than sloppy:
   * they are two different statements -- "there is a new remark on your post"
   * and "this remark is addressed to you" -- and the second is the one the
   * founder asked for because the first was not enough. They are one tap apart
   * in the inbox and both open the same conversation.
   *
   * A mention of yourself files nothing: `_can_mention` excludes `auth.uid()`.
   */
  perform _apply_comment_mentions(v_id, p_feed_event_id, p_mention_ids, p_parent_id is not null);

  return jsonb_build_object('status', 'ok', 'comment_id', v_id, 'parent_id', v_root);
end;
$$;

comment on function _add_comment(uuid, uuid, text, boolean, uuid, uuid[]) is
  'The whole of posting a comment, behind both published signatures so the five-argument form a phone predating 20260830000100 still calls cannot drift from the six-argument one. Internal.';

/**
 * **Both published wrappers call `assert_can_write()` themselves**, and the redundancy is
 * deliberate rather than sloppy.
 *
 * `_add_comment` calls it too, so functionally this is a second cheap check on a
 * suspended account. What it buys is the invariant `moderation.test.mjs` enforces: every
 * client-callable function either calls the guard *in its own body* or is named in a
 * read-only list. That test exists because two earlier versions of it were defeated —
 * once by a function that wrote in uppercase, once by a function that wrote only by
 * delegating to another — and a delegating writer that relies on its callee's guard is
 * precisely the second shape. A rule that has to be re-argued per function is a rule that
 * eventually is not applied.
 */
create or replace function add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean default false,
  p_parent_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();
  return _add_comment(p_operation_id, p_feed_event_id, p_body, p_has_spoilers, p_parent_id, '{}'::uuid[]);
end;
$$;

comment on function add_comment(uuid, uuid, text, boolean, uuid) is
  'Posts one comment, or one reply, on a feed event. Since 20260830000100 a thin delegate to _add_comment with no mentions -- the signature a bundle published before that migration calls. All of 20260826000600''s behaviour is unchanged and now lives in one place: threads exactly one level deep, both visibility checks before any lock, every notifiable pair locked in ascending counterpart-uuid order, the parent pinned with `for share`, and an inbox row for the activity''s actor and the person replied to -- never twice for one person, never to oneself, never to a tombstone.';

/**
 * The same function, told who the comment names.
 *
 * `p_mention_ids` has **no default**, which is what keeps the two signatures
 * unambiguous to PostgREST: a five-key payload cannot satisfy this one and a
 * six-key payload cannot satisfy the other. Send an empty array to mean "nobody".
 */
create or replace function add_comment(
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
begin
  perform assert_can_write();
  return _add_comment(p_operation_id, p_feed_event_id, p_body, p_has_spoilers, p_parent_id, p_mention_ids);
end;
$$;

comment on function add_comment(uuid, uuid, text, boolean, uuid, uuid[]) is
  'Posts one comment or reply and records who it names (20260830000100). Ids rather than handles, so the association survives a rename; every one is checked with _can_mention against this activity, and the whole call is refused rather than partially applied if any is ineligible. At most one mention notification per (comment, person), ever. p_mention_ids is deliberately not defaulted, so this signature and the five-argument one stay unambiguous to PostgREST and a phone that has not taken this bundle goes on posting.';

-- ---------------------------------------------------------------------------
-- 6. `edit_comment`, which is where the dedupe rule earns its keep
-- ---------------------------------------------------------------------------

create or replace function _edit_comment(
  p_operation_id   uuid,
  p_comment_id     uuid,
  p_body           text,
  p_has_spoilers   boolean,
  p_mention_ids    uuid[],
  -- False for the old signature, which knows nothing about mentions and must
  -- therefore leave them exactly as they are. Distinguishing "no mentions" from
  -- "not saying" matters: a phone predating this migration editing a comment
  -- that names somebody must not silently deactivate the mention.
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

  if p_apply_mentions then
    perform _apply_comment_mentions(p_comment_id, v_event, p_mention_ids, v_reply);
  end if;

  return jsonb_build_object('status', 'ok', 'edited_at', v_at);
end;
$$;

comment on function _edit_comment(uuid, uuid, text, boolean, uuid[], boolean) is
  'The whole of editing a comment, behind both published signatures. p_apply_mentions separates "this caller says nobody is mentioned" from "this caller does not know about mentions" -- the four-argument form passes false, so an old bundle editing a comment cannot silently deactivate its mentions. Internal.';

create or replace function edit_comment(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_body         text,
  p_has_spoilers boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();
  return _edit_comment(p_operation_id, p_comment_id, p_body, p_has_spoilers, '{}'::uuid[], false);
end;
$$;

comment on function edit_comment(uuid, uuid, text, boolean) is
  'Rewrites one of the caller''s own comments and stamps edited_at. "Not found", "not yours" and "already deleted" are one P0002. Deliberately does not re-check the event''s visibility: an author blocked after the fact must still be able to change or retract their own words. Since 20260830000100 a delegate that leaves mentions untouched -- the signature a bundle predating that migration calls.';

create or replace function edit_comment(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_body         text,
  p_has_spoilers boolean,
  p_mention_ids  uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();
  return _edit_comment(p_operation_id, p_comment_id, p_body, p_has_spoilers, p_mention_ids, true);
end;
$$;

comment on function edit_comment(uuid, uuid, text, boolean, uuid[]) is
  'Rewrites one of the caller''s own comments and restates who it names (20260830000100). A person still named is not told again; a person newly named is told once; a person removed keeps their delivered notification and their spent stamp, so re-adding them files nothing. p_mention_ids is deliberately not defaulted, so this signature and the four-argument one stay unambiguous to PostgREST.';

-- ---------------------------------------------------------------------------
-- 7. `delete_comment`, which now also clears the mention rows it announced
--
-- Rebuilt from 20260826000600 with one statement widened: the inbox sweep takes
-- `mention` as well as `comment`. A retracted comment must not leave a row in
-- somebody's Bell whose preview quotes text its author has withdrawn.
--
-- **`comment_mentions` is untouched by this.** For a tombstone the ledger has to
-- survive, because the comment can still be replied to and its author is still
-- in the thread; for an outright delete the cascade takes it, and there is
-- nothing left to re-mention. Neither case can produce a repeat notification.
-- ---------------------------------------------------------------------------

create or replace function delete_comment(
  p_operation_id uuid,
  p_comment_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent    uuid;
  v_replies   integer;
  v_outcome   text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'delete_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  select c.parent_id into v_parent
    from comments c
   where c.id = p_comment_id
     and c.author_id = auth.uid()
     and c.deleted_at is null
   for update;

  if not found then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  select count(*)::integer into v_replies
    from comments r
   where r.parent_id = p_comment_id and r.deleted_at is null;

  if v_parent is null and v_replies > 0 then
    update comments
       set deleted_at   = now(),
           body         = 'deleted',
           has_spoilers = false,
           edited_at    = null
     where id = p_comment_id;
    v_outcome := 'tombstoned';

    -- A tombstone names nobody. The ledger rows stay -- they are what stops a
    -- re-mention ringing again -- but the comment no longer says anything, so
    -- nothing should read as though it still did.
    update comment_mentions set active = false where comment_id = p_comment_id and active;
  else
    delete from comments where id = p_comment_id;
    v_outcome := 'removed';

    if v_parent is not null then
      delete from comments c
       where c.id = v_parent
         and c.deleted_at is not null
         and not exists (select 1 from comments r where r.parent_id = c.id);
    end if;
  end if;

  -- Both comment writers put the comment's id in the payload, and since
  -- 20260830000100 so does the mention writer -- so one predicate reaches all
  -- three.
  delete from notifications
   where type in ('comment', 'mention')
     and actor_id = auth.uid()
     and payload ->> 'comment_id' = p_comment_id::text;

  return jsonb_build_object('status', 'ok', 'outcome', v_outcome);
end;
$$;

comment on function delete_comment(uuid, uuid) is
  'Deletes one of the caller''s own comments, and the inbox rows that announced it -- comment, reply and, since 20260830000100, mention. A top-level comment with replies is tombstoned rather than removed, so the replies under it survive; its body is overwritten in the same statement, so no read path, cache or client version can show retracted text. Everything else is removed outright, and removing the last reply under a tombstone removes the tombstone. comment_mentions rows are deactivated but never deleted: the ledger is what stops a re-mention ringing again. "Not found", "not yours" and "already deleted" are one P0002.';

-- ---------------------------------------------------------------------------
-- 8. The thread reader carries its mentions
--
-- The composer needs them, and it needs *ids*: it holds handles in a text field,
-- and an edit that could only re-parse the body would lose the association the
-- whole of section 1 exists to keep. So an edit begins by reading back what the
-- comment names, and the client re-sends exactly those ids for the handles still
-- present in the text.
--
-- Dropped and recreated rather than replaced, because the row type gains a
-- column. Rebuilt from 20260827000500 verbatim otherwise.
-- ---------------------------------------------------------------------------

drop function if exists activity_comments(uuid);

create function activity_comments(p_feed_event_id uuid)
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
       and can_view_profile(me.id, p.id)
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

comment on function activity_comments(uuid) is
  'One activity''s comments and replies, oldest first, roots before their replies, with each author named, each comment''s reaction summary resolved, and since 20260830000100 the people it names -- ids and handles, filtered through the same can_view_profile every other identity here is, empty for a tombstone. The composer reads them back when an edit begins, which is what keeps a mention associated with a person rather than with the handle their body happens to spell. Definer and takes no viewer (20260813001900).';

-- ---------------------------------------------------------------------------
-- 9. The taxonomy learns `mention`
--
-- **The existing `comments` category, not a ninth switch.** The founder was
-- explicit, and the architecture agrees: a mention *is* somebody commenting at
-- you, the settings screen already has a row called Comments, and a second
-- control beside it would ask the reader to hold a distinction the product does
-- not otherwise make. `_notification_categories()` is therefore untouched --
-- only the map from type to category grows.
--
-- Rebuilt from 20260819000300, whose body is unchanged apart from the one arm.
-- ---------------------------------------------------------------------------

create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  if new.type = 'follow_request' then
    return new;
  end if;

  if new.type = 'invite_welcome' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'                then 'follows'
    when 'follow_approved'       then 'follow_accepted'
    when 'comment'               then 'comments'
    -- 20260830000100. A mention is somebody talking to you in a comment, and it
    -- is silenced by the control that says Comments.
    when 'mention'               then 'comments'
    when 'reaction'              then 'reactions'
    when 'watch_tag'             then 'watch_tags'
    when 'recommendation'        then 'recommendations'
    when 'recommendation_ranked' then 'recommendations'
    when 'invite_activated'      then 'invites'
    when 'award_earned'          then 'awards'
    when 'goal_completed'        then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added later
  -- and forgotten here should reach its recipient, not vanish -- the failure mode of the
  -- other default is silent and undetectable.
  if v_category is null then
    return new;
  end if;

  if _notifies(new.recipient_id, v_category) then
    return new;
  end if;

  return null;
end;
$fn$;

comment on function _apply_notification_preference() is
  'Before-insert gate on notifications. Drops a row whose category the recipient has '
  'switched off. follow_request and invite_welcome are exempt and always delivered. '
  'recommendation_ranked shares the recommendations category (20260827000600); '
  'goal_completed shares awards (20260829000200); mention shares comments '
  '(20260830000100), because a mention is somebody talking to you in a comment and the '
  'settings screen already has that row. An unmapped type is delivered.';

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow', 'follow_request', 'comment', 'mention', 'reaction', 'watch_tag',
    'recommendation', 'recommendation_ranked', 'invite_activated',
    'invite_welcome', 'award_earned', 'goal_completed'
  ]::text[]);
$$;

comment on function _push_eligible(p_type text) is
  'Which notification types may leave the inbox for the lock screen. Twelve of the fourteen: follow_approved is excluded by PRD §15, and friendship is the reader''s own action (20260827000200). award_earned joined on 20260828, goal_completed on 20260829 and mention on 20260830, each with its writer. An unmapped type is not eligible, so a new type has to be added here deliberately.';

-- ---------------------------------------------------------------------------
-- 10. The inbox says what was said
--
-- The founder's report: "Ravi commented on your activity" is not enough to know
-- whether to open it. So a comment, reply or mention row carries one line of
-- what was written.
--
-- **Three conditions, and the spoiler one is not a courtesy here.** Everywhere
-- else in this app spoiler masking is viewer-relative and decided on the client
-- (`shouldMask`), because a masked body is readable by exactly the accounts an
-- unmasked one is and pretending otherwise would be a filter a modified client
-- walks past. The inbox is the one surface where that reasoning does not hold:
-- the reader has not asked to look at this thread, the row appears without being
-- opened, and the same text goes to a lock screen. So the *server* withholds it,
-- and the client is never handed the string it must not draw. `claim_push_batch`
-- has done exactly this since 20260827000300; this is the inbox catching up.
--
--   1. the comment still exists and is not a tombstone -- a deleted remark has
--      no words to quote, and this is what makes a stale row degrade quietly;
--   2. it is not spoiler-marked -- `comment_spoilers` says so instead, which is
--      what the row draws;
--   3. its author is somebody this reader may see.
--
-- 140 characters, which is more than one line of a phone-width row; the client
-- truncates for shape and this bounds what crosses the wire.
--
-- The row also learns, for `watch_tag` alone, whether the reader has already
-- ranked the title -- which is the whole state the Rank action needs, resolved
-- in the read that draws the row rather than by a second query per row.
--
-- Rebuilt from 20260827000600.
-- ---------------------------------------------------------------------------

drop function if exists my_notifications(integer);

create function my_notifications(p_limit integer default 50)
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
  viewer_ranked      boolean
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
         n.payload,
         case
           when n.type in ('comment', 'mention') then (
             select left(c.body, 140)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and can_view_profile(auth.uid(), c.author_id)
           )
         end,
         coalesce(
           case
             when n.type in ('comment', 'mention') then (
               select c.has_spoilers
                 from comments c
                where c.id = (n.payload ->> 'comment_id')::uuid
                  and c.deleted_at is null
                  and can_view_profile(auth.uid(), c.author_id)
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
         end
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one.
     *
     * A `comment` or `reaction` is on the reader's own activity, which is the general
     * case and the original constraint. A `recommendation_ranked` is the *actor's* own
     * ranking, which is the post the row reports (20260827000600).
     *
     * **A `mention` is on whichever activity the comment was made under**, which is very
     * often neither party's -- so the reader's-own constraint would leave exactly those
     * rows with no title, and a mention on somebody else's post is the ordinary case
     * rather than the edge one.
     *
     * That widening is gated on `can_view_profile` **at read time**, and the gate is not
     * belt-and-braces. `_can_mention` established that the recipient could see the
     * activity when the mention was written; it says nothing about later. The activity's
     * owner is a *third party* to this notification -- the actor is the commenter -- so
     * the outer `can_discover_profile` filter below, which is about the actor, does not
     * cover them, and neither does `block()`, which deletes rows between the pair it
     * names and not rows about them. Without this the reader keeps the title of an
     * activity whose owner has since blocked them or gone private. Independent review
     * 68 found it.
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
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300. The feed-event join resolves the recipient''s own event for comment and reaction rows, the actor''s own for recommendation_ranked (20260827000600), and the event''s own for mention (20260830000100) -- a mention lands on somebody else''s post by construction, and _can_mention already refused it unless the recipient could see that post. Since 20260830000100 it also returns one line of the comment (withheld for a deleted, spoiler-marked or unviewable one, with comment_spoilers saying which) and, for watch_tag, whether the reader has already ranked the title.';

grant execute on function my_notifications(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. `claim_push_batch`, rebuilt from 20260827000600
--
-- Two changes, and the second is the founder's rule about mentions.
--
--   - the feed-event join learns `mention`, exactly as `my_notifications` did,
--     so a tapped mention push opens the conversation rather than falling back;
--   - `comment_excerpt` stays **`comment`-only**. The founder's instruction for
--     the mention push is that it carries no comment text: a mention is
--     addressed at somebody who has not asked to be in the conversation, and the
--     generic line is what should appear on a lock screen anybody can read over
--     the shoulder of. The comment excerpt shipped by 20260827000300 -- for a
--     remark on the reader's *own* post -- is untouched and stays spoiler-gated.
--
-- Everything else -- the reap, the lease, the claim generation, the
-- discoverability drop -- is carried across verbatim.
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
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
        'comment_excerpt', j.comment_excerpt,
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
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
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
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       and p.id is not null
  ) j;

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Carries feed_event_id since 20260826000600 so a tapped push opens the conversation -- resolved through the event''s own actor for a mention since 20260830000100 -- and comment_excerpt since 20260827000300, which stays comment-only and spoiler-gated: a mention push names who and where and never what.';

-- ---------------------------------------------------------------------------
-- 12. Grants
--
-- `_can_mention` and `_apply_comment_mentions` are internal for the reason
-- `_can_tag` and `_is_mutual_follow` are: the first answers questions about a
-- named third party''s follow graph and about what they can see, and the second
-- writes inbox rows.
-- ---------------------------------------------------------------------------

revoke execute on function _can_mention(uuid, uuid)                        from public, anon, authenticated;
revoke execute on function _apply_comment_mentions(uuid, uuid, uuid[], boolean) from public, anon, authenticated;
revoke execute on function _add_comment(uuid, uuid, text, boolean, uuid, uuid[]) from public, anon, authenticated;
revoke execute on function _edit_comment(uuid, uuid, text, boolean, uuid[], boolean) from public, anon, authenticated;

-- **`activity_comments` is re-granted because section 8 dropped it.** A `drop function`
-- takes its ACL with it, and a `create function` after one starts with no grant at all --
-- so the read that draws every conversation in the app would have answered `authenticated`
-- with 42501 while every test running as the table owner passed. `comment-reactions.test.mjs`
-- is what caught it, because it is one of the few suites that reads through `asUser`.
grant execute on function activity_comments(uuid)                          to authenticated;
grant execute on function mention_candidates(uuid, text, integer)          to authenticated;
grant execute on function add_comment(uuid, uuid, text, boolean, uuid)     to authenticated;
grant execute on function add_comment(uuid, uuid, text, boolean, uuid, uuid[]) to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean)          to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean, uuid[])  to authenticated;
grant execute on function delete_comment(uuid, uuid)                       to authenticated;
