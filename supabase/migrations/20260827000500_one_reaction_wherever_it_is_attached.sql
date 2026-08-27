-- Comments get the same six meanings a feed activity has.
-- Specification: PRD §14 (reactions) · the founder's physical pass of 2026-08-27.
--
-- ===========================================================================
-- WHAT WAS DELIBERATE, AND IS NOW WRONG
--
-- `comment_reactions` (20260826000600) has no `kind` column, and that was a decision
-- rather than an omission — its own table comment says so: "Deliberately has no kind
-- column: the six meanings in `reactions` are about a whole activity, and the smallest
-- thing that works on a single remark is a toggle and a count."
--
-- The founder overturned it on a device, and the reason outranks the argument above: a
-- reaction is one interaction in this product, and it stopped being one at the boundary
-- between an activity and a remark about it. Holding the control on a feed row offers
-- six; holding it on a comment offered nothing, and the same gesture doing different
-- things in two places one swipe apart is the inconsistency, whatever the smaller
-- surface deserved on its own.
--
-- So the taxonomy moves down to the comment. The *interaction* is what is being
-- unified; everything else about this table stays exactly as 20260826000600 built it.
--
-- ===========================================================================
-- WHAT IS NOT CHANGING, AND MUST NOT BE READ AS AN OVERSIGHT
--
--   **Comment reactions still never notify.** `set_reaction` writes a PRD §15 inbox row
--   for the activity's actor; this writer deliberately does not, and that difference is
--   preserved here on purpose. It is not a gap left for a later migration to close: a
--   remark on somebody's remark is the densest thing in the product, and six meanings
--   on it would multiply an inbox the founder has not asked to grow. The interaction is
--   being unified; the notification volume is not.
--
--   **Row level security is untouched.** `comment_reactions_read` is still the pair
--   (`can_i_view(user_id)` and the comment being readable), and `activity_comments`
--   still resolves the same rule for a definer the policy does not apply to. A `kind`
--   column discloses nothing the row's existence did not already.
--
--   **The primary key is still `(comment_id, user_id)`**, so one person still holds one
--   reaction per comment — changing your mind is an update, exactly as it is for an
--   activity (`set_reaction`'s `on conflict do update set kind`).
--
-- ===========================================================================
-- 1. The column, and every existing heart
--
-- `not null default 'love'` backfills in one statement: every like anybody has already
-- pressed becomes the canonical heart, which is the reaction the old control was
-- pressing all along. Nothing is dropped and nothing is re-interpreted.
--
-- The default is then removed. `reactions.kind` has none, and a writer that must state
-- the meaning cannot store a row that means "whatever the column decided" — the point
-- of the taxonomy is that the value is a claim.
-- ===========================================================================

alter table comment_reactions add column kind text not null default 'love';
alter table comment_reactions alter column kind drop default;

-- The same list, in the same words, as `reactions` carries since 20260813001500.
-- Stated again rather than shared: a check constraint cannot reference another table's.
alter table comment_reactions
  add constraint comment_reactions_kind
  check (kind in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved'));

comment on table comment_reactions is
  'One reaction per person per comment. Carries the same six meanings as `reactions` since 20260827000500 -- the founder''s rule that a reaction is one interaction whether it is attached to an activity or to a remark about one. Written only through set_comment_reaction. Still never notifies: the inbox row `set_reaction` writes has no counterpart here, deliberately.';

comment on column comment_reactions.kind is
  'One of love, agree, disagree, funny, wow, moved -- PRD §14''s list, the same values `reactions.kind` takes. Meanings rather than glyph names, so swapping a thumb for a face stays a copy change. Every row that predates 20260827000500 is ''love'': that is what the heart-only control was storing.';

-- ===========================================================================
-- 2. The write, split so two entry points cannot drift
--
-- The visibility rule and the write are lifted into one internal function, because
-- there are now two public ways in and they must not become two implementations. The
-- claim and the rate limit stay in the *public* functions: each call is one operation
-- whichever signature it arrived through, and an internal that claimed would claim
-- twice for one tap.
-- ===========================================================================

create or replace function _set_comment_reaction(p_comment_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok   boolean;
  v_kind text := nullif(btrim(coalesce(p_kind, '')), '');
begin
  -- Checked here as well as by the column constraint, so a client gets a field error it
  -- can act on rather than a 23514 it has to guess at. `set_reaction` does the same, and
  -- the two lists are the same list.
  if v_kind is not null
     and v_kind not in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved') then
    raise exception 'unknown reaction %', v_kind using errcode = '22023';
  end if;

  -- Unchanged from 20260826000600: `comments_read`'s two predicates, restated for a
  -- definer the policy does not apply to. A deleted comment, one by an author the caller
  -- may not see, and one on activity they may not see are all the same P0002 a missing
  -- comment gets -- telling them apart is the disclosure.
  select true into v_ok
    from comments c
    join feed_events e on e.id = c.feed_event_id
   where c.id = p_comment_id
     and c.deleted_at is null
     and can_view_profile(auth.uid(), c.author_id)
     and can_view_profile(auth.uid(), e.actor_id);

  if v_ok is null then
    raise exception 'no such comment' using errcode = 'P0002';
  end if;

  if v_kind is null then
    delete from comment_reactions
     where comment_id = p_comment_id and user_id = auth.uid();
    -- Not an error when there was nothing to remove, for the reason `set_reaction`
    -- gives: removal is a state being reached, not a transaction against a row.
    return jsonb_build_object('status', 'ok', 'kind', null);
  end if;

  -- Assignment, not insert-or-ignore. Changing your mind from a heart to a laugh is an
  -- update of the one row the primary key allows, which is `set_reaction`'s behaviour
  -- and is what keeps "one reaction per person per comment" true through a change.
  insert into comment_reactions (comment_id, user_id, kind)
  values (p_comment_id, auth.uid(), v_kind)
  on conflict (comment_id, user_id) do update
    set kind = excluded.kind;

  return jsonb_build_object('status', 'ok', 'kind', v_kind);
end;
$$;

revoke all on function _set_comment_reaction(uuid, text) from public;
revoke all on function _set_comment_reaction(uuid, text) from anon;
revoke all on function _set_comment_reaction(uuid, text) from authenticated;

comment on function _set_comment_reaction(uuid, text) is
  'The visibility check and the write behind both set_comment_reaction signatures. Internal: not granted to any client role, because it neither claims an operation nor spends a rate slot, and a caller that reached it directly would have neither.';

-- ---------------------------------------------------------------------------
-- The canonical writer: a meaning, or null to take it back.
-- ---------------------------------------------------------------------------

create or replace function set_comment_reaction(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_kind         text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_comment_reaction') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_comment_reaction', 'comment_reactions.max_per_day', 300);

  return _set_comment_reaction(p_comment_id, p_kind);
end;
$$;

comment on function set_comment_reaction(uuid, uuid, text) is
  'Sets, changes or removes the caller''s one reaction to a comment (PRD §14''s six meanings, since 20260827000500). Null kind removes, idempotently. Takes the state wanted rather than "toggle", so a retry after a lost reply converges instead of undoing itself. Refuses a deleted comment, or one on activity or by an author the caller may not see, with the same P0002 a missing one gets. Rate-limited per day. Writes no notification, deliberately -- unlike set_reaction.';

-- ---------------------------------------------------------------------------
-- And the boolean signature, kept alive on purpose.
--
-- Every phone already running the beta calls `set_comment_reaction(p_operation_id,
-- p_comment_id, p_on)`. An over-the-air update reaches those phones on their next
-- launch, which is hours or days rather than minutes, and the migration lands first by
-- the runbook's order. Dropping this signature would break the heart on a comment for
-- every tester who has not relaunched -- a regression introduced by the fix for an
-- inconsistency, which is the worst kind.
--
-- `p_on` rather than `p_kind` is what keeps the pair unambiguous: PostgREST resolves an
-- RPC by the argument *names* in the body, so the two overloads are never a coin toss.
-- ---------------------------------------------------------------------------

create or replace function set_comment_reaction(
  p_operation_id uuid,
  p_comment_id   uuid,
  p_on           boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_comment_reaction') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_comment_reaction', 'comment_reactions.max_per_day', 300);

  -- Maps to the canonical heart, which is exactly what the old control meant.
  perform _set_comment_reaction(p_comment_id, case when coalesce(p_on, false) then 'love' end);

  -- The old contract's return shape, preserved exactly: callers of this signature read
  -- `on`, not `kind`, and a client that has not been updated must not have to learn a
  -- new key to understand the answer it already handles.
  return jsonb_build_object('status', 'ok', 'on', coalesce(p_on, false));
end;
$$;

comment on function set_comment_reaction(uuid, uuid, boolean) is
  'Compatibility signature for clients published before 20260827000500, which know a comment reaction as a boolean like. Maps true to the canonical ''love'' and false to removal, and answers in the old shape (`on`, not `kind`). Kept because an OTA reaches a phone on its next launch while the migration lands first: dropping this would break the heart for every tester who has not relaunched. Disambiguated from the text signature by argument name, which is how PostgREST resolves an overload.';

grant execute on function set_comment_reaction(uuid, uuid, text) to authenticated;

-- ===========================================================================
-- 3. Reading a thread, now carrying the meanings
--
-- Dropped and recreated rather than replaced: `create or replace function` cannot
-- change a `returns table` signature, and two columns are being added to it.
--
-- **The two existing columns stay, and stay first.** `reaction_count` and
-- `reacted_by_me` are what the published beta bundle reads, and a client that has not
-- taken the OTA yet must keep getting the answer it understands. The new columns are
-- additive: an old client ignores them, a new one uses them.
-- ===========================================================================

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
  -- The distinct meanings present, most common first — the order `useReactions` sorts
  -- an activity's into, computed here because the client is handed a summary rather
  -- than the rows.
  --
  -- **Ties break on the value, and that is a deliberate difference from the feed.**
  -- `useReactions` sorts by count alone, so two equally common meanings come out in
  -- whatever order their rows happened to arrive in — which is not a contract, it is an
  -- accident of paging, and it can differ between two reads of the same data. Reproducing
  -- an undefined order is not possible; what is possible is being stable, so a comment's
  -- cluster does not reshuffle under the reader between refetches. The alternative —
  -- making the feed deterministic too — would change feed behaviour, which this tranche
  -- is explicitly not allowed to do.
  reaction_kinds text[],
  -- The caller's own, or null. `reacted_by_me` says *whether*; this says *which*, and
  -- the control needs the second to draw a mind that has changed.
  my_reaction    text
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  -- The event, once. Returning no rows here is the whole of the privacy answer: a
  -- reader who may not see the activity gets an empty thread and cannot tell that from
  -- an activity with no comments.
  event as (
    select e.id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
  ),
  rows as (
    select c.* from comments c, event where c.feed_event_id = event.id
  ),
  -- Each author, once. This is the line the twenty-five-fold cost was in.
  authors as (
    select p.id, p.username::text as username, p.display_name, p.avatar_path
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  ),
  -- And each reactor once, at the same arity and for the same reason.
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
  /**
   * Every reaction this reader is allowed to know about, once — the one set the count,
   * the glyphs and "mine" are all read from.
   *
   * Lifted out of the correlated subqueries it replaces so the number and the meanings
   * beside it cannot disagree: they are now three reads of one row set, filtered by the
   * same join to `reactors` the count already used. A blocked account's reaction is
   * absent from all three, which is the "absent rather than counted anonymously" rule
   * `useReactions` states for an activity and which independent review 43 found missing
   * from the count here.
   */
  visible as (
    select cr.comment_id, cr.user_id, cr.kind
      from comment_reactions cr
      join rows r on r.id = cr.comment_id
      join reactors rv on rv.id = cr.user_id
  ),
  /**
   * Which tombstones are worth drawing for this reader.
   *
   * A tombstone exists only to hold replies together, and whether it has any is a
   * viewer-relative question: the reader who blocked its author sees none of them, and
   * would be left looking at "Comment deleted" with nothing under it.
   */
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
         -- A retracted comment's text does not leave the database. The row is returned
         -- so the replies under it keep their place; the body is not.
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
         (select v.kind from visible v, me where v.comment_id = r.id and v.user_id = me.id)
    from rows r
    -- Inner, which is `comments_read`'s author predicate: a comment whose author this
    -- reader may not see is absent rather than anonymised.
    join authors a on a.id = r.author_id
    -- And a tombstone only where this reader can see something under it.
    join live_roots lr on lr.id = coalesce(r.parent_id, r.id)
   -- Oldest first, because a conversation runs downward -- and the root before its
   -- replies, because the client draws one indent level and needs no sorting of its own.
   order by coalesce(r.parent_id, r.id), (r.parent_id is not null), r.created_at, r.id;
$$;

comment on function activity_comments(uuid) is
  'One activity''s comments and replies, oldest first, roots before their replies, with each author named and each comment''s reaction summary resolved in the same statement. Since 20260827000500 it also returns reaction_kinds (the distinct meanings present, most common first) and my_reaction (the caller''s own), so a comment draws the same glyph cluster a feed row does; reaction_count and reacted_by_me are unchanged and still first, because a client published before that migration reads them. Definer and takes no viewer (20260813001900). Every reaction fact comes from one visibility-filtered set, so the count and the glyphs cannot disagree, and a blocked account appears in none of them.';

grant execute on function activity_comments(uuid) to authenticated;
