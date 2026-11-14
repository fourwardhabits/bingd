-- A recommendation seen when it is listed (FU1113-E, founder approval t174u 2026-11-13).
--
-- ===========================================================================
-- WHAT THIS IS FOR
--
-- Today "unread" in Sent to You means `opened_at is null`, and `opened_at` is written only
-- when the recipient opens the *title* (`mark_recommendation_opened`, 20260817001300). So a
-- recommendation the reader has plainly looked at in the list — and decided not to open yet —
-- keeps the tab's dot and its own tint for ever. This adds the second, weaker fact:
--
--   seen_at   the recipient saw it listed in Sent to You.
--
-- Unread becomes `opened_at is null and seen_at is null`, decided on the client. Nothing on
-- the server is ordered or filtered by it.
--
-- ===========================================================================
-- WHAT IT DOES NOT TOUCH, STATED BECAUSE EACH WAS A TEMPTATION
--
--   * `opened_at`. It drives `recommendation_opened`, the sent → opened conversion interval
--     and the server order "unopened first". Seeing a row in a list is not opening it, and
--     reusing the column would corrupt every one of those.
--   * `recommendations_to_me`'s order, filter, security mode and grants. Only one trailing
--     column is added.
--   * `recommend_title`. A resend never lists `seen_at` in its SET, which is the same
--     anti-spam rule `opened_at` has: a sender cannot re-badge somebody's tab by sending the
--     same title twice. Not rebuilt here, so its body is exactly 20260929000100's.
--   * State, dismissal, the watchlist, rankings, notifications, push. Marking writes one
--     timestamp on the caller's own delivered rows and nothing else.
--   * The send/delivery rule (`_may_recommend_to`, `_delivers_directly_to`). Unchanged.
--
-- ===========================================================================
-- WHO CAN READ IT
--
-- **Not the sender.** `title_recommendations_sender` admits the sender to their own rows, so a
-- column granted to `authenticated` is a column the sender can select — and `seen_at` would
-- then be a read receipt ("they looked at their list at 21:04"), which 20260826000400 rules
-- out. So, as with `state`, the column is granted to nobody. The recipient reads it through
-- `recommendation_seen_at`, a definer helper that answers only for `recipient_id = auth.uid()`
-- and only for a delivered row, and `recommendations_to_me` stays `security invoker` with no
-- visibility logic of its own.
--
-- ===========================================================================
-- APPLYING IT
--
-- Additive. The Supabase CLI applies a migration file as one transaction, which is the repo's
-- convention (no explicit begin/commit in any file). Every statement is re-runnable: the
-- column is `if not exists`, the functions are `create or replace` or dropped `if exists`
-- first, and grants and comments are idempotent.
--
-- Rollback (in the PR body as well):
--
--   drop function if exists mark_recommendations_seen(uuid, uuid[]);
--   drop function if exists recommendations_to_me(integer);
--   -- recreate recommendations_to_me exactly as 20260929000100 §4 defines it, with its
--   -- revoke from public, anon and grant to authenticated
--   drop function if exists recommendation_seen_at(uuid);
--   alter table title_recommendations drop column if exists seen_at;
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table title_recommendations
  add column if not exists seen_at timestamptz;

comment on column title_recommendations.seen_at is
  'When the recipient saw it listed in Sent to You (20261121000100). Independent of opened_at, which only opening the title writes. Never cleared: a resend does not make a seen recommendation unread again. Written only by mark_recommendations_seen. Granted to nobody, so the sender cannot read it; the recipient reads it through recommendation_seen_at.';

-- Restated rather than assumed: a column added after 20260826000400 §2's column list inherits
-- no select privilege, and that is the intended state.
revoke select (seen_at) on title_recommendations from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. Reading it, as the recipient only
--
-- `security definer` so the column needs no grant, and safe for the reason
-- `mark_recommendation_opened` is: the filter is `recipient_id = auth.uid()` and is not a
-- parameter. A row that is somebody else's, pending, dismissed or missing answers null, which
-- is indistinguishable from "not seen yet" — so it is not an oracle about anybody's inbox.
-- ---------------------------------------------------------------------------

create or replace function recommendation_seen_at(p_recommendation_id uuid)
returns timestamptz
language sql stable security definer
set search_path = public
as $$
  select r.seen_at
    from title_recommendations r
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'delivered';
$$;

comment on function recommendation_seen_at(uuid) is
  'When the caller saw one of their own delivered recommendations listed in Sent to You, or null. Null as well for a row that is not the caller''s, is not delivered or does not exist, so it discloses nothing. Definer because seen_at is granted to nobody: the sender must not be able to read it (20261121000100).';

revoke execute on function recommendation_seen_at(uuid) from public, anon;
grant execute on function recommendation_seen_at(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Marking them
--
-- Takes an operation id for the reason `dismiss_all_recommendation_requests` does: the client
-- calls it with a batch, and a replay after a lost reply should report that it already
-- happened rather than run again. Re-running would be harmless here (`seen_at is null` makes
-- a second pass mark nothing), so the ledger is about an honest answer, not about safety.
--
-- The ids are the ones the client actually had on screen. A recommendation that arrives after
-- the list loaded is not in them, so it stays unread; that is the whole of why this takes ids
-- rather than "everything delivered to me".
--
-- Rows are locked in id order before they are written, so two overlapping batches from two
-- devices queue on the same row in the same order instead of deadlocking, and the second one
-- re-reads `seen_at is null` after the first commits and leaves the first one's time in place.
-- ---------------------------------------------------------------------------

create or replace function mark_recommendations_seen(p_operation_id uuid, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marked integer;
begin
  perform assert_can_write();

  -- Before the claim, so a malformed call spends nothing. The bound is the size of the list
  -- the client can hold (`recommendations_to_me` clamps to 200), so a larger batch is not a
  -- real client.
  if coalesce(cardinality(p_ids), 0) > 200 then
    raise exception 'at most 200 recommendations can be marked at once' using errcode = '22023';
  end if;

  if not _claim_operation(p_operation_id, 'mark_recommendations_seen') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  with target as (
    select r.id
      from title_recommendations r
     where r.id = any(coalesce(p_ids, '{}'::uuid[]))
       and r.recipient_id = auth.uid()
       and r.state = 'delivered'
       and r.seen_at is null
     order by r.id
       for update
  )
  update title_recommendations r
     set seen_at = now()
    from target
   where r.id = target.id
     and r.seen_at is null;

  get diagnostics v_marked = row_count;

  -- Somebody else's ids, pending or dismissed ids and unknown ids are silently not counted:
  -- "that exists but is not yours" is a fact about somebody else's inbox.
  return jsonb_build_object('status', 'ok', 'marked', v_marked);
end;
$$;

comment on function mark_recommendations_seen(uuid, uuid[]) is
  'Marks the named recommendations seen (listed in Sent to You) for the caller, once each: only the caller''s own delivered rows whose seen_at is null, at most 200 ids, anything else silently ignored. Never touches opened_at, state, dismissal, the watchlist, rankings or notifications. A replayed operation id answers already_applied (20261121000100).';

revoke execute on function mark_recommendations_seen(uuid, uuid[]) from public, anon;
grant execute on function mark_recommendations_seen(uuid, uuid[]) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Sent to you, with when it was seen
--
-- The return type gains a column, so this is a drop and a create (the 20260929000100 §4
-- pattern), and the grant is restated because the drop takes it. Carried over from
-- 20260929000100 verbatim except the one trailing column: same signature, `security
-- invoker`, same join, same filter (none of its own — RLS and profiles_read decide), same
-- order, same limit. Appended, so a client that maps by name or ignores extras keeps working.
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
  message             text,
  seen_at             timestamptz
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
         r.message,
         -- NEW (20261121000100). Through the recipient-only helper, because the column is
         -- granted to nobody (see the header).
         recommendation_seen_at(r.id)
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
  'The caller''s "Sent to you" list, unopened first and newest within that, with the sender''s note (20260929000100) and when the caller saw it listed (seen_at, 20261121000100). security invoker on purpose: profiles_read makes a blocked or newly private sender disappear, and title_recommendations_recipient makes a pending request — and therefore its note — disappear, so this function contains no visibility logic of its own. Cannot be asked about another account.';

revoke execute on function recommendations_to_me(integer) from public, anon;
grant execute on function recommendations_to_me(integer) to authenticated;
