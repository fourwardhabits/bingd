-- Comments on feed activity (Comments V1).
-- Specification: founder addendum 2026-08-16 §1, amending PRD §14's deferral.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS, AND WHAT IT REFUSES TO BE
--
-- Flat comments on a feed event. The founder's list of exclusions is longer than the
-- list of features, and most of them are enforced here by *absence of a column*
-- rather than by a rule someone has to keep applying:
--
--   no replies / threading  -> there is no `parent_id`. A thread cannot be
--                              represented, so no client can accidentally start one
--                              and no read path needs a recursive CTE.
--   no comment reactions    -> `reactions.feed_event_id` references `feed_events`,
--                              and nothing references `comments`. Adding them later
--                              is a migration; adding them by accident is not
--                              possible.
--   no media, no GIFs       -> one `text` column. There is nowhere to put a URL that
--                              the client would render as anything but text.
--   no rich text            -> same column. The client renders it as a plain string.
--
-- That is deliberate. Each of those is a product decision the founder made once, and
-- a schema that cannot express the excluded thing is the only version of the decision
-- that survives a future contributor who did not read this file.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO INSERT POLICY
--
-- The same reason `reactions` has none (20260816000200): a policy admits a row, and
-- the authorisation this needs is "and only on an event you are allowed to see",
-- which a row policy on `comments` cannot express without a subquery that would then
-- have to be repeated identically in three writers. Every write in this database goes
-- through a SECURITY DEFINER function that authorises first, and this follows it.
--
-- ---------------------------------------------------------------------------
-- THE ID LEAK THE FOUNDER NAMED, AND HOW EACH WRITER CLOSES IT
--
-- "Do not allow comment ids/event ids to become cross-account information leaks."
--
-- Event ids and comment ids travel: a share link's analytics, a crash report, a
-- screenshot, another user's own copy of a row that has since become invisible. An
-- id in a stranger's hands must buy nothing. So every writer here resolves
-- *existence and visibility in a single query* and reports both failures with the
-- same P0002 and the same message. There is no branch that says "this exists but you
-- may not touch it", because the existence of that branch is itself the disclosure —
-- a caller who can tell 'no such comment' from 'not yours' has learned that a
-- particular id names a real comment on activity they cannot see.
--
-- `edit_comment` and `delete_comment` fold ownership into the same predicate for the
-- same reason: `where c.id = $1 and c.author_id = auth.uid()` returns nothing for a
-- comment that is not yours *and* for one that does not exist, and the caller cannot
-- tell which.
--
-- ---------------------------------------------------------------------------
-- SPOILERS
--
-- `has_spoilers` is the author's own claim about their own writing, exactly as
-- `user_media.note_has_spoilers` is. The server never infers it and never enforces
-- masking: masking is a *viewer-relative* question — "has this particular reader
-- watched this exact media item" — and the answer lives in the reader's own
-- `user_media`, which is where `shouldMask` already reads it from.
--
-- Exact-entity semantics therefore come free and stay correct: the client masks
-- against `feed_events.media_item_id`, which is one row, so a Season 2 comment stays
-- masked for someone who has only watched Season 1 and for someone who has "watched"
-- the parent series. Those eleven cases are already tested in
-- `use-watched.test.ts`; a second implementation here would be a second chance to get
-- them wrong.
--
-- What this migration must not do is make the flag *load-bearing for privacy in the
-- database*, and it does not: an unmasked comment body is readable by exactly the
-- same set of accounts as a masked one. Spoiler masking is a courtesy about
-- narrative, not an access control, and conflating the two would produce a
-- server-side filter that a modified client trivially bypasses while the product
-- claims otherwise.
-- ---------------------------------------------------------------------------

create table comments (
  id            uuid primary key default gen_random_uuid(),
  feed_event_id uuid not null references feed_events(id) on delete cascade,
  author_id     uuid not null references profiles(id) on delete cascade,
  body          text not null,
  -- The author's claim that this comment spoils the exact title the event is about.
  -- Consumed by the client through `shouldMask`; never acted on by the server.
  has_spoilers  boolean not null default false,
  created_at    timestamptz not null default now(),
  -- Null until the author changes it. Distinguishable from `created_at` because the
  -- surface says "edited", and a comment that silently changed under a reader who had
  -- already replied to it in their head is the thing that annoys people about edits.
  edited_at     timestamptz,

  -- Empty is not a comment. Enforced here as well as in the writers so that no future
  -- path can create one; the writers raise a field error the client can act on.
  constraint comments_body_present check (btrim(body) <> ''),
  -- 1000 characters. An engineering bound, not a product decision: a column with no
  -- limit is a column a modified client can put a megabyte in, per event. Notes get
  -- 2000 (20260813002300) because a note is someone's considered writing about a film
  -- they finished; a comment is a remark on someone else's activity, and the shorter
  -- bound is the honest description of the thing. In a check rather than a
  -- `varchar(1000)` so that changing it is an `alter constraint` and not a rewrite.
  constraint comments_body_length check (char_length(body) <= 1000)
);

comment on table comments is
  'Flat comments on feed events (founder addendum 2026-08-16). No parent_id, deliberately: threading is excluded from V1 and a schema that cannot represent a thread is the durable form of that decision. Written only through add_comment/edit_comment/delete_comment, which resolve visibility and ownership in the same query that resolves existence.';

comment on column comments.has_spoilers is
  'The author''s own claim that this comment spoils the exact media item its event is about. Never inferred, never enforced server-side: masking is viewer-relative and decided by shouldMask against the reader''s own user_media. Not an access control -- a masked body is readable by exactly the accounts an unmasked one is.';

-- The list query: one event, newest last, because a comment list reads as a
-- conversation and a conversation runs downward.
create index comments_event on comments (feed_event_id, created_at);

-- "Delete my account" and "how many have I written today" both ask by author. Also
-- what makes the author_id half of the edit/delete predicate an index lookup rather
-- than a filter over one event's comments.
create index comments_author on comments (author_id);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Read authorisation is `reactions_read`'s, exactly: both the comment's author and
-- the event's actor must clear AD-5 from this viewer's side. Two predicates rather
-- than one, because they are two different disclosures —
--
--   the actor    : whose activity this is. A private account's activity must not
--                  become readable because someone the viewer *can* see commented on
--                  it. Without this half, a public account commenting on a private
--                  account's event would publish the event's existence, its id, and
--                  the fact that the private account ranked that title.
--   the author   : who wrote the comment. A blocked account's comment is *absent*
--                  rather than anonymised, which is what a block means. Without this
--                  half, blocking someone would stop you seeing their activity and
--                  not their commentary on yours.
--
-- Both matter, and each covers a case the other does not.
--
-- `can_i_view` and not `can_view_profile(auth.uid(), x)`, which is 20260813001900's
-- rule and not a stylistic preference: the two-argument form accepts a *viewer*, and
-- a client-reachable function that does discloses approved-follow and block
-- relationships between third parties. A policy is client-reachable by definition, so
-- the one-argument form — whose perspective is always the caller's own and cannot be
-- forged — is the only one that belongs in one. The definer writers below use the
-- two-argument form, which is exactly where it is legitimate: they run as the owner
-- and ask about a pair the caller never names.
-- ---------------------------------------------------------------------------

alter table comments enable row level security;

create policy comments_read on comments for select
  using (
    can_i_view(author_id)
    and exists (
      select 1 from feed_events e
       where e.id = feed_event_id
         and can_i_view(e.actor_id)
    )
  );

-- And the policy is not the only gate. `anon` is revoked outright.
--
-- The policy above admits an anonymous reader for a public author on a public
-- actor's event, because `can_view_profile(null, <public account>)` is true — which
-- is correct for `feed_events` and for `reactions`, and is how those two behave
-- today. Comments are not those two. A reaction is a glyph from a closed set of six;
-- a feed event is a fact about a catalogue title. A comment is free text somebody
-- wrote, which makes anonymous read access a scraping surface over user-authored
-- content and the only moderation-bearing table a stranger could enumerate.
--
-- `public_notes` set the precedent and stated the rule: a grant should follow a
-- surface rather than precede it, and no anonymous surface renders user text. Bingd
-- has no signed-out screens at all. If a public web title page ever wants comments on
-- it, this revoke is the one line to reconsider, deliberately.
--
-- Explicit rather than relying on default privileges, because those grant SELECT on
-- new tables to `anon` and the absence would otherwise be invisible.
revoke select on comments from anon;

-- ---------------------------------------------------------------------------
-- Writing one
-- ---------------------------------------------------------------------------

create or replace function _assert_comment_length(p_body text)
returns void
language plpgsql immutable
as $$
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception 'a comment cannot be empty' using errcode = '22023';
  end if;
  if char_length(p_body) > 1000 then
    raise exception 'a comment is limited to 1000 characters' using errcode = '22023';
  end if;
end;
$$;

comment on function _assert_comment_length(text) is
  'Field-level validation for a comment body, raised as 22023 so a client gets something it can show against the input rather than a 23514 it has to decode. The check constraints on comments are the same rules stated where nothing can bypass them. Internal.';

create or replace function add_comment(
  p_operation_id  uuid,
  p_feed_event_id uuid,
  p_body          text,
  p_has_spoilers  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_body  text := btrim(coalesce(p_body, ''));
  v_id    uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'add_comment') then
    -- Idempotent by the ledger, like every other outbox-eligible writer. A retry
    -- after a dropped response must not post the remark twice.
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- The same ceiling reactions got in 20260816000400, and for a stronger reason:
  -- a reaction is a glyph and a comment is text in someone else's notifications.
  -- Lower than 200 because a person having a heavy day on a busy feed reacts far
  -- more often than they write. Config, so raising it is not a migration.
  perform _assert_operation_rate('add_comment', 'comments.max_per_day', 100);

  perform _assert_comment_length(v_body);

  -- Existence and visibility in one query, reported as one failure. See the header.
  select e.actor_id into v_actor
    from feed_events e
   where e.id = p_feed_event_id
     and can_view_profile(auth.uid(), e.actor_id);

  if v_actor is null then
    raise exception 'no such activity' using errcode = 'P0002';
  end if;

  insert into comments (feed_event_id, author_id, body, has_spoilers)
  values (p_feed_event_id, auth.uid(), v_body, coalesce(p_has_spoilers, false))
  returning id into v_id;

  -- PRD §15's inbox row. Written, not delivered — push is dark in v1 (AD-10) and the
  -- row is what makes turning it on a server flag rather than a release.
  --
  -- One per comment, and deliberately *not* deduplicated the way a reaction is. A
  -- reaction is a state, so ringing twice for one person's one reaction to one event
  -- is noise; a comment is an occurrence, and suppressing the second one would mean a
  -- conversation where only the opening remark is ever announced. The per-day ceiling
  -- above is what bounds this, not a unique index.
  --
  -- Not for your own activity: nobody needs telling that they replied to themselves.
  if v_actor <> auth.uid() then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (v_actor, 'comment', auth.uid(), 'feed_event', p_feed_event_id,
            jsonb_build_object('comment_id', v_id));
  end if;

  return jsonb_build_object('status', 'ok', 'comment_id', v_id);
end;
$$;

comment on function add_comment(uuid, uuid, text, boolean) is
  'Posts one flat comment on a feed event. Refuses an event the caller may not view with P0002 -- the same error as a missing one, because telling them apart discloses the activity. Idempotent by operation id, rate-limited per day, and writes one PRD §15 inbox row per comment (never for one''s own activity).';

-- ---------------------------------------------------------------------------
-- Editing and deleting your own
--
-- Both take the comment id, and both resolve `id = $1 and author_id = auth.uid()`
-- together so that "no such comment" and "not yours" are one answer. Neither
-- re-checks the event's visibility, and that absence is deliberate rather than an
-- oversight: the row already belongs to the caller, so no branch can disclose
-- anything about another account, and re-checking would mean an author *loses the
-- ability to delete their own words* the moment the event's actor makes their
-- profile private or blocks them. Being blocked must not strand your writing in
-- someone else's thread with no way to retract it.
-- ---------------------------------------------------------------------------

create or replace function edit_comment(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_body         text,
  -- Null leaves the stored claim alone. The client always sends the value it
  -- displayed, so the state the author saw is the state that gets written; the null
  -- case exists for a caller that is only correcting a typo.
  p_has_spoilers boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_at   timestamptz;
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
  returning edited_at into v_at;

  if v_at is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok', 'edited_at', v_at);
end;
$$;

comment on function edit_comment(uuid, uuid, text, boolean) is
  'Rewrites one of the caller''s own comments and stamps edited_at. "Not found" and "not yours" are the same P0002, so a comment id learned elsewhere confirms nothing. Deliberately does not re-check the event''s visibility: an author blocked after the fact must still be able to change or retract their own words.';

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
  v_deleted uuid;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'delete_comment') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  delete from comments
   where id = p_comment_id
     and author_id = auth.uid()
  returning id into v_deleted;

  -- Unlike removing a reaction, this *is* an error when there was nothing to delete.
  -- A reaction toggle reaching its target state is success however many times it is
  -- pressed; a delete naming a specific id either found that comment or the id is
  -- wrong, and answering "ok" to the wrong id would tell a caller nothing while
  -- hiding a real bug. The idempotency ledger above already absorbs the honest retry.
  if v_deleted is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  -- The inbox rows that announced it go too. Leaving them would mean a notification
  -- that opens a thread where the comment it names is gone, and — worse — a payload
  -- that still carries the deleted comment's id. `subject_id` is the event, so the
  -- comment id in the payload is what identifies the row to remove.
  delete from notifications
   where type = 'comment'
     and actor_id = auth.uid()
     and payload ->> 'comment_id' = p_comment_id::text;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function delete_comment(uuid, uuid) is
  'Deletes one of the caller''s own comments, and the inbox rows that announced it. "Not found" and "not yours" are the same P0002. Raises rather than succeeding on a comment that is not there, unlike removing a reaction: a delete names a specific row, and the idempotency ledger already covers the honest retry.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- 20260813001800 made execute default-deny and 20260813002100 issued the global
-- form, so these arrive unreachable and each grant is deliberate.
--
-- `_assert_comment_length` is deliberately not granted. It is pure and discloses
-- nothing, but an ungranted helper is one fewer entry in the allow-list that has to
-- be justified, and nothing outside these writers needs to call it.
-- ---------------------------------------------------------------------------

grant execute on function add_comment(uuid, uuid, text, boolean)    to authenticated;
grant execute on function edit_comment(uuid, uuid, text, boolean)   to authenticated;
grant execute on function delete_comment(uuid, uuid)                to authenticated;

insert into app_config (key, value)
values ('comments.max_per_day', '100'::jsonb)
on conflict (key) do nothing;
