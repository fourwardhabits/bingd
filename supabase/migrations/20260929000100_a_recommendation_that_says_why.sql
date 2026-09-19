-- A recommendation that says why.
-- Specification: docs/product/recommendation-note-and-watch-next.md Part A (founder-approved
-- 2026-09-19, F1 and F2) · PRD §13 (recommendations) · PRD §22 (reporting is required for
-- every surface that carries user writing).
--
-- ===========================================================================
-- WHAT THIS REVERSES, AND WHAT IT DOES NOT
--
-- `20260826000400`'s header lists, under "WHAT IS DELIBERATELY NOT HERE", *"No message,
-- no reply, no read receipt."* This migration reverses the first of the three and only
-- the first. A sender may attach one short note to a recommendation. There is still no
-- reply, no thread, and nothing that tells a sender what the recipient did.
--
-- ===========================================================================
-- THE RULES, IN ONE PLACE
--
--   * Optional, plain text, at most 140 characters after normalisation. Normalisation
--     trims and collapses every run of whitespace — newlines included — to one space, so
--     a note is always one paragraph and an all-blank note is no note.
--   * A too-long or control-character note is refused with 22023 **before** the operation
--     claim. The refusal says nothing about the recipient, so it is not an eligibility
--     probe, and a malformed call should not spend somebody's quota.
--   * Stored on the one (sender, recipient, title) row. A resend **with** a note replaces
--     it; a resend **without** one keeps it. Every existing resend rule is untouched: no
--     second notification, `opened_at` never cleared, `recommended_at` moves.
--   * Readable by both parties to a row and nobody else: `message` is granted to
--     `authenticated`, and the two existing policies decide which rows. The recipient
--     policy admits only `delivered` rows, so **a pending request's note is unreadable to
--     its recipient by construction** — the approved rule that text from somebody you have
--     not followed back waits until the recommendation is added or released.
--     `recommendation_requests` is not changed and does not return the column.
--   * Push and the inbox row are untouched. `claim_push_batch` and `my_notifications` never
--     read this column, so a note cannot reach a lock screen.
--   * Reportable, as PRD §22 requires of user writing: a new `report_subject` value.
--
-- ===========================================================================
-- OLDER BINARIES
--
-- The three-argument `recommend_title` survives as a thin wrapper over the four-argument
-- one, so every build in the field keeps calling exactly the signature it was compiled
-- against. Neither signature has a default, so PostgREST cannot find the two ambiguous: a
-- call naming three arguments matches only the first. `recommendations_to_me` gains one
-- trailing column, which a client that does not know about it ignores.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
--
-- The check restates the normalisation as a structural rule, so a future writer that
-- forgets it fails loudly instead of storing a note the readers were not designed for.
-- ---------------------------------------------------------------------------

alter table title_recommendations
  add column message text
  constraint recommendation_message_shape check (
    message is null
    or (
      char_length(message) between 1 and 140
      and message = btrim(message)
      and message !~ '[[:cntrl:]]'
    )
  );

comment on column title_recommendations.message is
  'The sender''s optional note, at most 140 characters, one normalised paragraph. Readable by the sender (own rows) and by the recipient once delivered (the recipient policy admits no pending row), and by nobody else. A resend with a note replaces it; a resend without one keeps it. Never read by push or the inbox (20260929000100).';

-- `20260826000400` §2 replaced the table-wide select with a column list, so a new column
-- is invisible until it is named here. That is the safe default and this is the deliberate
-- exception to it.
grant select (message) on title_recommendations to authenticated;

-- Serves `title_recommendations_for_me`: one recipient, one title. The inbox index leads
-- with `recommended_at` and the unique key leads with the sender, so neither can.
create index if not exists title_recommendations_recipient_media
  on title_recommendations (recipient_id, media_item_id);


-- ---------------------------------------------------------------------------
-- 2. Normalising a note
--
-- Immutable and internal. Returns null for no note. Validation is the caller's, because
-- the caller decides where in its order a refusal belongs.
-- ---------------------------------------------------------------------------

create or replace function _recommendation_message(p_message text)
returns text
language sql immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(coalesce(p_message, ''), '\s+', ' ', 'g')), '');
$$;

comment on function _recommendation_message(text) is
  'A recommendation note as it is stored: trimmed, every whitespace run collapsed to one space, and null when nothing is left. Internal to recommend_title (20260929000100).';

revoke execute on function _recommendation_message(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Sending one, with or without a note
--
-- Rebuilt in full from `20260826000400` §5, which is its only body (grep for the name,
-- the rename and the grant found no other). The diff against that body is:
--
--   * the signature gains `p_message`;
--   * the note is normalised and validated after `assert_can_write` and before the claim;
--   * the insert writes it, and the update applies `coalesce(new, old)`.
--
-- Nothing else moved: the rate limits, the pair lock, the follow rule, the pending cap
-- and its position before the state lookup, the delivered-is-terminal rule and the
-- single notification writer are carried over verbatim.
-- ---------------------------------------------------------------------------

create or replace function recommend_title(
  p_operation_id  uuid,
  p_recipient_id  uuid,
  p_media_item_id uuid,
  p_message       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind      media_kind;
  v_id        uuid;
  v_state     recommendation_state;
  v_next      recommendation_state;
  v_direct    boolean;
  v_created   boolean;
  v_pending   integer;
  v_cap       integer;
  v_refusal   text;
  v_message   text;
begin
  perform assert_can_write();

  -- NEW (20260929000100). Before the claim, so a malformed note costs nothing and changes
  -- nothing. The refusal is independent of the recipient, so raising it discloses nothing
  -- about them.
  v_message := _recommendation_message(p_message);
  if v_message is not null and char_length(v_message) > 140 then
    raise exception 'a note can be up to 140 characters' using errcode = '22023';
  end if;
  if v_message ~ '[[:cntrl:]]' then
    raise exception 'a note cannot contain control characters' using errcode = '22023';
  end if;

  if not _claim_operation(p_operation_id, 'recommend_title') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_hour', 20, interval '1 hour');
  perform _assert_operation_rate('recommend_title', 'recommendations.max_per_day', 50, interval '1 day');

  perform _lock_pair(auth.uid(), p_recipient_id);

  if p_recipient_id = auth.uid() then
    v_refusal := 'yourself';
  elsif not _may_recommend_to(p_recipient_id) then
    v_refusal := 'not_following';
  else
    select m.kind into v_kind from media_items m where m.id = p_media_item_id;

    if v_kind is null or rankable_category(v_kind) is null then
      v_refusal := 'not_recommendable';
    end if;
  end if;

  if v_refusal is not null then
    return jsonb_build_object('status', 'refused', 'reason', v_refusal);
  end if;

  select r.id, r.state into v_id, v_state
    from title_recommendations r
   where r.sender_id = auth.uid()
     and r.recipient_id = p_recipient_id
     and r.media_item_id = p_media_item_id;

  v_direct := _delivers_directly_to(p_recipient_id);

  -- The pair ceiling, asked before the row's own state for the reason 20260826000400
  -- records at length: a cap that answered differently per title would be an oracle.
  if not v_direct then
    select coalesce(
             (select (value)::integer from app_config where key = 'recommendations.max_pending_per_pair'),
             5)
      into v_cap;

    select count(*) into v_pending
      from title_recommendations r
     where r.sender_id = auth.uid()
       and r.recipient_id = p_recipient_id
       and r.state = 'pending';

    if v_pending >= v_cap then
      return jsonb_build_object('status', 'refused', 'reason', 'too_many_pending');
    end if;
  end if;

  if v_state = 'delivered' then
    v_next := 'delivered';
  elsif v_direct then
    v_next := 'delivered';
  else
    v_next := 'pending';
  end if;

  v_created := v_id is null;

  if v_created then
    insert into title_recommendations (sender_id, recipient_id, media_item_id, state, message)
    values (auth.uid(), p_recipient_id, p_media_item_id, v_next, v_message)
    returning id into v_id;
  else
    -- `opened_at` is deliberately absent from this SET list (see its column comment).
    -- NEW (20260929000100): a resend with a note replaces the note, and one without keeps
    -- it. A resend that silently erased what somebody wrote would be a loss nobody chose.
    update title_recommendations
       set recommended_at = now(),
           state = v_next,
           message = coalesce(v_message, message)
     where id = v_id;
  end if;

  if v_next = 'delivered' and v_state is distinct from 'delivered' then
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    values (p_recipient_id, 'recommendation', auth.uid(), 'media_item', p_media_item_id,
            jsonb_build_object('recommendation_id', v_id));
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'created', v_created,
    'id', v_id,
    'delivered', v_next = 'delivered'
  );
end;
$$;

comment on function recommend_title(uuid, uuid, uuid, text) is
  'Recommends one exact title to somebody the caller approvedly follows, with an optional note of at most 140 characters (20260929000100). Delivers immediately when that person follows the caller back, and otherwise stores a pending request the recipient can add or dismiss. A malformed note raises 22023 before the operation claim. Refusals for the relationship, a block, a suspension or a series are returned as {"status":"refused"} so they still cost a rate-limit slot. At most five pending per pair. A resend with a note replaces it and one without keeps it; neither files a second notification. The notification is filed only when the row enters delivered.';

-- The signature every shipped binary calls. Kept, and reduced to one line, so there is one
-- body to rebuild next time rather than two to keep in step.
create or replace function recommend_title(
  p_operation_id  uuid,
  p_recipient_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The four-argument body calls it too. Called here as well so the guard is visible on
  -- every client-callable function by inspection (moderation.test.mjs's structural sweep),
  -- rather than inferred through a delegation.
  perform assert_can_write();
  return recommend_title(p_operation_id, p_recipient_id, p_media_item_id, null::text);
end;
$$;

comment on function recommend_title(uuid, uuid, uuid) is
  'The pre-note signature, kept for binaries in the field. Exactly recommend_title(op, recipient, title, null): no note, and every other rule of the four-argument form (20260929000100).';

revoke execute on function recommend_title(uuid, uuid, uuid, text) from public, anon;
grant execute on function recommend_title(uuid, uuid, uuid, text) to authenticated;
grant execute on function recommend_title(uuid, uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Sent to you, with the note
--
-- The return type gains a column, so this is a drop and a create rather than a replace,
-- and the grant is restated because the drop takes it (the 20260817001300 §7 lesson).
-- Everything else is carried over from 20260826000400 §6 verbatim — including having no
-- visibility logic of its own. `message` is appended rather than inserted, so a client
-- that maps columns by name and one that ignores extras both keep working.
-- ---------------------------------------------------------------------------

drop function if exists recommendations_to_me(integer);

create function recommendations_to_me(p_limit integer default 100)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  media_item_id       uuid,
  media_kind          media_kind,
  media_title         text,
  series_title        text,
  poster_path         text,
  release_date        date,
  genres              text[],
  original_language   text,
  runtime_minutes     integer,
  recommended_at      timestamptz,
  opened_at           timestamptz,
  message             text
)
language sql stable security invoker
set search_path = public
as $$
  select r.id,
         r.sender_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         m.id,
         m.kind,
         m.title,
         parent.title,
         m.poster_path,
         m.release_date,
         m.genres,
         m.original_language,
         m.runtime_minutes,
         r.recommended_at,
         r.opened_at,
         r.message
    from title_recommendations r
    join profiles p    on p.id = r.sender_id and p.status = 'active'
    join media_items m on m.id = r.media_item_id
    left join media_items parent on parent.id = m.parent_id
   -- Pending and dismissed rows are absent because `title_recommendations_recipient`
   -- does not admit them, not because of anything written here.
   where r.recipient_id = auth.uid()
   order by (r.opened_at is not null), r.recommended_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

comment on function recommendations_to_me(integer) is
  'The caller''s "Sent to you" list, unopened first and newest within that, with the sender''s note (20260929000100). security invoker on purpose: profiles_read makes a blocked or newly private sender disappear, and title_recommendations_recipient makes a pending request — and therefore its note — disappear, so this function contains no visibility logic of its own. Cannot be asked about another account.';

revoke execute on function recommendations_to_me(integer) from public, anon;
grant execute on function recommendations_to_me(integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. The title page's question: who recommended *this* to me
--
-- The approved rule is that the context shows however the reader arrived — Sent to you,
-- the inbox, a push, search, the Feed — rather than only when a route carried it. So the
-- page asks. `security invoker`, with the same join and the same absence of visibility
-- logic as `recommendations_to_me`: RLS decides delivered-only, `profiles_read` decides
-- blocked and private senders, the `active` join decides suspension.
--
-- The exact object, never a parent: a season's page asks about the season, and a series
-- page finds nothing, because nothing can recommend a series.
--
-- Whether the reader has since ranked the title is the page's to decide (it already
-- knows), exactly as `withoutRanked` decides it for Sent to you.
-- ---------------------------------------------------------------------------

create or replace function title_recommendations_for_me(p_media_item_id uuid)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  message             text,
  recommended_at      timestamptz,
  opened_at           timestamptz
)
language sql stable security invoker
set search_path = public
as $$
  select r.id,
         r.sender_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         r.message,
         r.recommended_at,
         r.opened_at
    from title_recommendations r
    join profiles p on p.id = r.sender_id and p.status = 'active'
   where r.recipient_id = auth.uid()
     and r.media_item_id = p_media_item_id
   order by r.recommended_at desc, r.id
   limit 10;
$$;

comment on function title_recommendations_for_me(uuid) is
  'Every delivered recommendation of one exact title to the caller, newest first, at most ten, with each sender''s note (20260929000100). security invoker: title_recommendations_recipient admits only delivered rows, profiles_read drops blocked and private senders, and the active join drops suspended ones — no visibility logic is written here. Cannot be asked about another account.';

revoke execute on function title_recommendations_for_me(uuid) from public, anon;
grant execute on function title_recommendations_for_me(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Reporting a note
--
-- PRD §22: every surface that carries user writing has a report path. A note is user
-- writing addressed at one named person, which is the harassment shape reporting exists
-- for.
--
-- The enum value is added in the same file as the function that names it. That is safe
-- for exactly the reason `20260825000100` §3 records: the value appears only inside a
-- plpgsql body, which is parsed on first execution, not at CREATE. Nothing in this file
-- *executes* `report()` with the new value, and nothing may be added that does.
--
-- `report()` is rebuilt from its latest body, `20260825000100` §4 (grep for the name,
-- renames and grants found no later one). The diff is one `when` arm. It resolves the
-- owner as the sender, and it narrows three ways that the other arms do not need:
--
--   * **only the recipient** may report a note. The uuid of a recommendation is handed
--     out to its two parties and nobody else, so this admits nobody who could have read
--     it and refuses nobody who could;
--   * **only while the note exists**, the `review` arm's rule — a note-less
--     recommendation has no writing to report;
--   * **only once delivered**, because a pending note is one its recipient has never been
--     shown.
--
-- Blocking does not remove the ability to report: the row and its recipient survive a
-- block, which is the 20260813002000 §4 principle carried over. The sender answering
-- about their own row gets P0002 from the recipient test, before the self-report check.
-- ---------------------------------------------------------------------------

alter type report_subject add value if not exists 'recommendation';

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
    -- NEW (20260929000100). The note's sender, reported by its recipient, while there is
    -- a note and the recipient has been shown it. See §6's header.
    when 'recommendation' then (
      select sender_id from title_recommendations
       where id = p_subject_id
         and recipient_id = v_user
         and message is not null
         and state = 'delivered'
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
  'Files a report. The subject''s owner is resolved server-side — a comment from comments.author_id, a review from the user_media row named by user_media.id, a recommendation note from title_recommendations.sender_id — because a client-supplied owner would let anyone attribute a report to an account of their choosing. Checks that the subject exists but deliberately NOT that the caller can currently see it, so that blocking someone does not make them unable to report you. A review resolves only while its note is public; a recommendation only for its recipient, while it carries a note and is delivered (20260929000100). The per-day cap is advisory: it is counted before insert without a lock, so concurrent calls can exceed it slightly. Idempotency is not advisory — it rests on the reports_one_open_per_reporter index.';

grant execute on function report(report_subject, uuid, text, text) to authenticated;
