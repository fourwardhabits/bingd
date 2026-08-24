-- Reporting reaches the two surfaces that actually carry user writing.
-- Specification: PRD §22 (reporting is Required by policy) · docs/architecture/api.md §6a
-- · docs/product/moderation.md · public-launch blocker M1.
--
-- ---------------------------------------------------------------------------
-- 1. What was missing, and why it was missing
--
-- 20260813001700 built the whole moderation spine — `reports`, `report()`, the eight
-- reasons, the daily cap, the one-open-report index, `moderation_actions`, the two
-- operator views, suspension and `assert_can_write`. It is not a sketch and nothing
-- here redesigns it.
--
-- What it could not cover is everything written since. Its subject list —
--
--     profile, display_name, username, list, list_title, watch_tag
--
-- is the set of surfaces that carried user-generated text in August, and neither of
-- the two that carry most of it now existed yet: comments arrived in 20260817000100
-- and Reviews were named in 20260817000800. So the product shipped a report button's
-- worth of backend for usernames and list titles, and none at all for the two places
-- a person actually writes a paragraph about somebody else.
--
-- Both `use-title-reviews.ts` and `title_reviews`' own header already describe a
-- review as "reportable the same way". That was aspiration rather than description:
-- the enum had no value for it and `report()` had no branch. This migration makes
-- those sentences true.
--
-- ---------------------------------------------------------------------------
-- 2. A review needs a name before it can be reported
--
-- This is the only part of this migration that touches an existing table, and it is
-- forced by the shape of `reports` rather than chosen.
--
-- `reports.subject_id` is a single `uuid`, and `reports_one_open_per_reporter` is
-- unique on `(reporter_id, subject_type, subject_id) where state = 'open'`. A review
-- is a public note on `user_media`, whose primary key is the *pair*
-- `(user_id, media_item_id)`. There is no uuid to put in `subject_id`.
--
-- The tempting shortcut is to report a review by its `media_item_id` and pass the
-- author alongside, and it is wrong in a way that would have been discovered by a
-- user rather than by a test: two people's reviews of the same film would collide on
-- that unique index, so the second report a reporter filed about that title would hit
-- `on conflict do nothing` and be silently discarded. The abusive review would never
-- reach the queue and the reporter would be told it had been received. A moderation
-- system that quietly drops the second complaint about a popular title is worse than
-- one that has no button, because the first one lies.
--
-- So the review gets an identity. One surrogate column, unique, never the primary key
-- — the pair remains the key and every existing writer, index and upsert is untouched.
-- `report()` then resolves the author from it exactly as it resolves a list's owner
-- from a list id, and the duplicate-report guarantee holds for reviews with no change
-- to the index at all.
--
-- Not a new table and not a new content model: a review is still a public note on
-- `user_media` (20260817000800), and this adds a name for a row that already existed.
-- ---------------------------------------------------------------------------

alter table user_media add column id uuid not null default gen_random_uuid();

-- Unique rather than primary: `(user_id, media_item_id)` stays the key, because every
-- RPC in the schema addresses a row by that pair and a changed primary key would be a
-- rewrite of all of them for no gain. This is an alternate identity, used by exactly
-- one caller.
create unique index user_media_id_key on user_media (id);

comment on column user_media.id is
  'A stable surrogate name for this row, so that a Review — a public note on it (20260817000800) — can be the subject of a report. reports.subject_id is one uuid and the composite key cannot be put in it; reporting by media_item_id instead would make two authors'' reviews of one title collide on reports_one_open_per_reporter and silently drop the second complaint. Not the primary key: (user_id, media_item_id) still is, and every writer still addresses rows by the pair.';

-- ---------------------------------------------------------------------------
-- 3. Two more subjects, and deliberately not a third
--
-- `comment` and `review` are the surfaces. **Private notes get no subject and must
-- not**: a private note is readable by its author alone (`note_visibility = 'private'`,
-- 20260816000000), so there is no second person who could be harmed by one and no
-- reader who could report it. A subject for it would exist only to be probed — a way
-- to ask the server whether a given row carries private writing, which is the one
-- question `public_notes` was written to refuse.
--
-- `review` rather than `note` as the stored value, and the difference is not cosmetic.
-- 20260817000800 settled that the user-facing object is a Review; the operator reading
-- `moderation_queue` should see the word the reporter saw on the button, or triage
-- begins with a translation step. The storage is `user_media.note`; the *subject* is a
-- review, which is what a public note is.
--
-- `if not exists` so re-running against a database that already has them is a no-op
-- rather than an error, which is the shape every other guarded statement in this
-- schema uses.
--
-- **These live in the same migration as the function that names them, and that is
-- safe — but only for the reason below, so do not add a statement here that breaks
-- it.** Postgres refuses to *use* an enum value added in the current transaction, and
-- `supabase db push` runs each migration file in one. Creating §4's function is not a
-- use: it is plpgsql, so the SQL expressions in its body — including the `case` arms
-- that compare against 'comment' and 'review' — are parsed on first execution rather
-- than at CREATE time. Verified rather than assumed: `npm run test:race` applies every
-- migration to a real PostgreSQL 17 through the simple query protocol, which is the
-- same single-transaction-per-file shape, and it is green.
--
-- What would break it is a statement in this file that *executes* something with one of
-- the new values — a backfill calling `report()`, or an `insert into reports ... values
-- ('review', ...)`. There is none, and if one is ever needed it belongs in a separate
-- migration rather than here.
-- ---------------------------------------------------------------------------

alter type report_subject add value if not exists 'comment';
alter type report_subject add value if not exists 'review';

-- ---------------------------------------------------------------------------
-- 4. report(), extended — the same function, two more branches
--
-- Signature unchanged, and that is load-bearing rather than tidy:
-- `function-grants.test.mjs` asserts the ACL against the exact signature
-- `report(report_subject,uuid,text,text)`, and `create or replace` preserves the
-- grant. Nothing about the rate limit, the self-report refusal, the opaque receipt or
-- the idempotency changes, because none of them was wrong.
--
-- **Existence is checked; visibility deliberately still is not.** 20260813002000 §4
-- wrote down why and the reasoning covers the new subjects unchanged: a gate on "can
-- the caller still see it" would make an abuser unreportable the moment they blocked
-- the person they abused, which inverts the protection. Somebody who had a comment in
-- front of them a second ago must still be able to report it after being blocked, and
-- after the author deletes their side of the relationship. The accepted cost is the
-- same weak existence oracle as before — a caller who already holds a uuid can learn
-- it names a real row — and these two branches do not widen it: both uuids are issued
-- only by read paths that are themselves visibility-gated (`comments_read`,
-- `public_notes`, `title_reviews`), and neither branch returns anything about the
-- subject. The receipt is the same two booleans it has always been.
--
-- The `review` branch adds one condition the others do not have, and it *narrows*
-- rather than widens: a row qualifies only while it carries a public note. That keeps
-- the private note unreportable — §3 — rather than letting `review` become the probe
-- that the missing `note` subject was refused for. A row whose note has since been
-- deleted or made private answers P0002, which is the same "no such subject" a stale
-- client row gets anywhere else, and the client shows one sentence rather than
-- crashing.
-- ---------------------------------------------------------------------------

create or replace function report(
  p_subject_type report_subject,
  p_subject_id   uuid,
  p_reason       text,
  p_note         text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_owner uuid;
  v_today integer;
  v_cap   integer;
begin
  perform assert_can_write();

  v_cap := coalesce(
    (select (value)::integer from app_config where key = 'report.max_per_day'),
    20
  );

  select count(*) into v_today from reports
   where reporter_id = v_user and created_at > now() - interval '1 day';

  -- Advisory, not enforced: the count is taken before the insert and without a
  -- lock, so simultaneous calls from one reporter can both pass it. Idempotency is
  -- the guarantee that does hold, and it holds because the database holds it —
  -- reports_one_open_per_reporter, not this arithmetic.
  if v_today >= v_cap then
    raise exception 'report limit reached for today' using errcode = '53400';
  end if;

  -- Resolve the owner from the subject rather than trusting the caller, which is
  -- what stops a report being attributed to an account of the reporter's choosing.
  --
  -- Existence is checked; visibility deliberately is not. Requiring the caller to
  -- be able to see the subject would make an abuser unreportable the moment they
  -- blocked the person they abused, turning the block into a way to suppress the
  -- complaint. The cost is that a caller can confirm a UUID names a real row.
  v_owner := case p_subject_type
    when 'profile'      then p_subject_id
    when 'display_name' then p_subject_id
    when 'username'     then p_subject_id
    when 'list'         then (select owner_id  from lists      where id = p_subject_id)
    when 'list_title'   then (select owner_id  from lists      where id = p_subject_id)
    when 'watch_tag'    then (select tagger_id from watch_tags where id = p_subject_id)
    -- The comment's author, from the column that defines authorship. Never a
    -- client-supplied id, and never the event's actor: a comment belongs to whoever
    -- wrote it, not to whoever it was written under.
    when 'comment'      then (select author_id from comments   where id = p_subject_id)
    -- The review's author. Qualified on the note still being public, so a private
    -- note stays unreportable and this branch cannot be used to detect one.
    when 'review'       then (
      select user_id from user_media
       where id = p_subject_id
         and note is not null
         and note_visibility = 'public'
    )
  end;

  if v_owner is null then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if p_subject_type in ('profile', 'display_name', 'username')
     and not exists (select 1 from profiles where id = p_subject_id) then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if v_owner = v_user then
    raise exception 'cannot report your own content' using errcode = '22023';
  end if;

  insert into reports (reporter_id, subject_type, subject_id, subject_owner, reason, note)
  values (v_user, p_subject_type, p_subject_id, v_owner, p_reason, p_note)
  on conflict (reporter_id, subject_type, subject_id) where state = 'open'
    do nothing;

  -- Reported twice is reported. Saying so would tell the reporter which of their
  -- earlier complaints is still open, which is not their business.
  return jsonb_build_object('done', true, 'received', true);
end;
$$;

comment on function report(report_subject, uuid, text, text) is
  'Files a report. The subject''s owner is resolved server-side — a comment from comments.author_id, a review from the user_media row named by user_media.id — because a client-supplied owner would let anyone attribute a report to an account of their choosing. Checks that the subject exists but deliberately NOT that the caller can currently see it, so that blocking someone does not make them unable to report you. A review resolves only while its note is public: private notes have no reader but their author and therefore no reporting path. The per-day cap is advisory: it is counted before insert without a lock, so concurrent calls can exceed it slightly. Idempotency is not advisory — it rests on the reports_one_open_per_reporter index.';

-- create or replace preserves the ACL, so the allow-list from 20260813002000 §5 still
-- applies. Restated because a reader should not have to know that.
grant execute on function report(report_subject, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The read paths hand out the name
--
-- A report button needs the subject's id, and neither review reader returned one —
-- they had no reason to, because until §2 there was nothing to return.
--
-- Both are dropped and recreated rather than replaced: `create or replace function`
-- cannot change a function's OUT columns, and both of these are `returns table`.
-- Dropping loses the ACL, so both grants are reissued below; that is the whole reason
-- this section restates them rather than relying on the allow-list.
--
-- Nothing else about either function moves. Same visibility predicate
-- (`can_view_profile(auth.uid(), …)`), same filters, same ordering, same limits — the
-- new column is `user_media.id` and it is the only difference. Adding a column is safe
-- for existing callers here because both are read through `supabase.rpc`, which
-- returns objects rather than positional tuples.
-- ---------------------------------------------------------------------------

drop function if exists public_notes(uuid[], uuid[], integer);

create function public_notes(
  p_user_ids       uuid[] default null,
  p_media_item_ids uuid[] default null,
  p_limit          integer default 50
)
returns table (
  id            uuid,
  user_id       uuid,
  media_item_id uuid,
  note          text,
  has_spoilers  boolean,
  updated_at    timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_user_ids is null and p_media_item_ids is null then
    raise exception 'public_notes requires a user or a title filter'
      using errcode = '22023';
  end if;

  if coalesce(array_length(p_user_ids, 1), 0) > 50
     or coalesce(array_length(p_media_item_ids, 1), 0) > 50 then
    raise exception 'public_notes accepts at most 50 ids per filter'
      using errcode = '22023';
  end if;

  return query
    select um.id,
           um.user_id,
           um.media_item_id,
           um.note,
           um.note_has_spoilers,
           um.note_updated_at
      from user_media um
     where um.note is not null
       and um.note_visibility = 'public'
       and (p_user_ids is null       or um.user_id       = any (p_user_ids))
       and (p_media_item_ids is null or um.media_item_id = any (p_media_item_ids))
       -- AD-5, from the caller's own perspective. Covers suspension, blocks,
       -- private accounts and approved follows in one place.
       and can_view_profile(auth.uid(), um.user_id)
     order by um.note_updated_at desc nulls last
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

comment on function public_notes(uuid[], uuid[], integer) is
  'Public notes for a set of authors, a set of titles, or both. The only cross-user read path for note text. Projects the note columns alone, because the row it comes from also carries the watch date, which PRD §22 keeps private at every visibility level. Returns user_media.id so a reader can report the review without a second round trip. Refuses an unfiltered call, and refuses more than fifty ids per filter.';

grant execute on function public_notes(uuid[], uuid[], integer) to authenticated;

drop function if exists title_reviews(uuid, text, integer);

create function title_reviews(
  p_media_item_id uuid,
  p_sort          text default 'top',
  p_limit         integer default 25
)
returns table (
  id             uuid,
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  note           text,
  has_spoilers   boolean,
  updated_at     timestamptz,
  score          numeric,
  reaction_count integer
)
language sql stable security definer
set search_path = public
as $$
  select um.id,
         um.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         um.note,
         um.note_has_spoilers,
         um.note_updated_at,
         -- Null when they wrote a note without ranking it, which is a real state.
         (select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)
            from rankings r
            join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
           where r.user_id = um.user_id
             and r.media_item_id = um.media_item_id),
         reacted.n
    from user_media um
    join profiles p on p.id = um.user_id
    -- The latest event, not every event: `_rank_finalize` writes a new `title_ranked`
    -- row every time a ranking completes, and summing across all of them is a lifetime
    -- total that a rebucket inflates.
    left join lateral (
      select fe.id
        from feed_events fe
       where fe.actor_id = um.user_id
         and fe.media_item_id = um.media_item_id
         and fe.type = 'title_ranked'
       order by fe.created_at desc, fe.id desc
       limit 1
    ) latest on true
    left join lateral (
      select count(*)::integer as n
        from reactions re
       where re.feed_event_id = latest.id
    ) reacted on true
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     -- The same predicate `public_notes` uses, and deliberately the same expression:
     -- suspension, blocks, private accounts and approved follows in one place.
     and can_view_profile(auth.uid(), um.user_id)
   order by
     case when p_sort = 'top' then coalesce(reacted.n, 0) end desc nulls last,
     um.note_updated_at desc nulls last,
     -- Stable, so two calls with the same data return the same order.
     um.user_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

comment on function title_reviews(uuid, text, integer) is
  'The Bingd Reviews tab for one title: every public Note on it the caller may read, with the author named, their live Bingd score, and how many people reacted to the activity it belongs to -- the *latest* title_ranked event for that pair, because reranking writes a new one and the old reactions stay behind. Not a second content model -- a review is a public Note, which is the same text the Feed shows. Reuses public_notes'' visibility predicate verbatim. Sorted by reactions then recency for `top`, recency alone for `recent`, with a stable tiebreak either way. The score is derived from live rankings rather than from the feed event''s snapshot, which drifts. Returns user_media.id so a reader can report a review without a second round trip.';

grant execute on function title_reviews(uuid, text, integer) to authenticated;
