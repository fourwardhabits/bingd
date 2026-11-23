-- A recommendation you can put away (founder request, 2026-11-22: let recipients dismiss
-- "Sent to You" recommendations).
--
-- ===========================================================================
-- WHAT THIS IS FOR
--
-- Sent to You lets the recipient open a recommendation, see it listed and bookmark it, but
-- not remove it. Seeing (`seen_at`) and opening (`opened_at`) are facts about attention, not
-- a decision, so neither can stand in for "take this out of my list". This adds the third,
-- separate fact:
--
--   dismissed_at   the recipient removed it from Sent to You. Null again after Undo.
--
-- ===========================================================================
-- THE AUDIT, AND WHY NOTHING EXISTING IS REUSED
--
-- Three things in the schema are called "dismiss". None of them means this.
--
--   * `title_recommendations.state = 'dismissed'` (20260826000400) is a tombstone on a
--     PENDING REQUEST: the recipient threw away something held for them, a later follow
--     will not release it, and `recommend_title` moves it back to `pending` on a resend.
--     Reusing it for a delivered row would (a) lose whether the row was pending or delivered,
--     so Undo could not restore it; (b) make a resend take it through `dismissed → delivered`,
--     which files a fresh `recommendation` notification; (c) take it out of `_rank_finalize`'s
--     fulfilment (`state = 'delivered'`) and `_proactive_affinity` — changing the sender's
--     outcome and the recipient's ranking-side signals. All three are things this request
--     says a dismissal must not do.
--   * `dismiss_recommendation(uuid)` / `dismiss_all_recommendation_requests(uuid)` are the
--     writers of that tombstone, guarded on `state = 'pending'`. A delivered row is a no-op
--     there. Not overloaded with a two-argument form either: PostgREST would resolve
--     `dismiss_recommendation` to one of two different acts by which keys the client sent.
--   * `recommendation_feedback` kind `dismiss` (`dismiss_for_you`, 20260827000700) is For
--     You's "not interested": a signal about the algorithmic slate that the engine reads.
--     A person-to-person recommendation must not feed it.
--
-- So: one nullable column on the recipient's existing row, and two recipient-only writers
-- named for what they act on (`dismiss_received_recommendation`,
-- `restore_received_recommendation`).
--
-- ===========================================================================
-- WHERE THE FILTER LIVES: THE RECIPIENT POLICY
--
-- `title_recommendations_recipient` already decides what the recipient's invoker reads see
-- (delivered rows only), and every reader of the recipient's list is `security invoker` with
-- no visibility logic of its own — `recommendations_to_me`, `recommendations_to_me_page` and
-- `title_recommendations_for_me` (20261121000100, 20261121000400). Adding
-- `dismissed_at is null` to that one policy therefore:
--
--   * takes a dismissed row out of Sent to You on every client, including builds already
--     shipped that only know `recommendations_to_me` — so a removal on one device holds on
--     every other one, with no client change and no function rebuilt;
--   * filters BEFORE the 200-row limit, so a dismissed row never occupies a slot on the page
--     and the "200+" floor stays honest;
--   * takes it off the title page's "Recommended by …" card too, while every other sender's
--     recommendation of the same title stays (that rule is decided here, below).
--
-- The sender policy (`title_recommendations_sender`) is untouched, and `dismissed_at` is
-- granted to nobody: the sender's view of what they sent is exactly what it was, and
-- dismissal is not a read receipt (20261121000100 O2's rule for `opened_at` and `seen_at`).
--
-- ===========================================================================
-- THE TITLE PAGE'S "Recommended by …" CARD
--
-- Decided: a dismissed recommendation's attribution is hidden from the card; other senders'
-- recommendations of the same title still show. If every recommendation of the title is
-- dismissed, there is no card. The row is not erased: Undo (or `restore_…` at any time)
-- brings it back to both places.
--
-- ===========================================================================
-- WHAT A DISMISSAL DOES NOT TOUCH, STATED BECAUSE EACH WAS A TEMPTATION
--
--   * The row. Nothing is deleted; `state`, `recommended_at`, `message`, `opened_at`,
--     `seen_at` and `fulfilled_at` keep their values, so Undo restores it exactly.
--   * `opened_at` / `seen_at` and their writers. Opening or seeing never dismisses, and
--     dismissing never marks anything opened or seen.
--   * The watchlist. Saving a title does not dismiss its recommendation, and dismissing does
--     not unsave it.
--   * `recommend_title`. A resend never lists `dismissed_at` in its SET, the same anti-spam
--     rule `opened_at` and `seen_at` have: a sender cannot put a recommendation back into
--     somebody's list by sending it twice. It still moves `recommended_at` and may replace
--     the note, silently, exactly as before. Not rebuilt, so its body is 20260929000100's.
--   * `_rank_finalize`'s fulfilment, its `recommendation_ranked` notification and
--     `_proactive_affinity`. They read as the owner and filter on `state`, which does not
--     change. If the recipient later ranks the title, the sender hears what they would have
--     heard anyway — which is also what keeps a dismissal invisible to the sender.
--   * Notifications and push. Neither writer inserts anything anywhere but this column and
--     the operation ledger.
--   * For You, the engine, `recommendation_feedback`, rankings and watch history.
--   * Pending requests (`recommendation_requests`, Add, Dismiss): a request is not in Sent to
--     You, and both writers here act on delivered rows only.
--
-- ===========================================================================
-- APPLYING IT
--
-- Additive. The Supabase CLI applies a migration file as one transaction (the repo's
-- convention: no explicit begin/commit in the file). Re-runnable: the column is `if not
-- exists`, the policy is `alter policy`, the functions are `create or replace`, and the
-- comments, revokes and grants are idempotent. Old clients keep working: no signature or
-- return type changes, and the two writers are new names.
--
-- Rollback: docs/release/recs-dismiss/rollback-20261130001200.sql.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------

alter table title_recommendations
  add column if not exists dismissed_at timestamptz;

comment on column title_recommendations.dismissed_at is
  'When the recipient removed this delivered recommendation from Sent to You, or null (20261130001200). Recipient-only and reversible: written by dismiss_received_recommendation, cleared by restore_received_recommendation, and by nothing else -- a resend leaves it as it is. Independent of opened_at, seen_at, state, fulfilled_at and the watchlist. Granted to nobody, so the sender cannot read it; it is applied through title_recommendations_recipient.';

-- Restated rather than assumed: a column added after 20260826000400 §2's column list
-- inherits no select privilege, and that is the intended state.
revoke select (dismissed_at) on title_recommendations from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. The recipient policy: delivered and not dismissed
--
-- `alter policy` rather than drop and create, so there is no instant inside the transaction
-- at which the recipient has no policy at all. The sender policy is not touched.
-- ---------------------------------------------------------------------------

alter policy title_recommendations_recipient on title_recommendations
  using (recipient_id = auth.uid() and state = 'delivered' and dismissed_at is null);

comment on policy title_recommendations_recipient on title_recommendations is
  'The recipient sees their own delivered recommendations that they have not removed from Sent to You (20261130001200). Pending requests (state) and dismissed ones (dismissed_at) are absent from every security invoker reader -- recommendations_to_me, recommendations_to_me_page and title_recommendations_for_me -- because of this policy, not because of anything in those functions.';


-- ---------------------------------------------------------------------------
-- 3. Dismissing one
--
-- Takes an operation id, as `mark_recommendations_seen` does, and here it is about
-- correctness rather than an honest answer: a dismissal followed by an Undo followed by a
-- replay of the dismissal's lost reply must not remove the recommendation again. The ledger
-- makes the replay answer `already_applied` and write nothing.
--
-- Recipient-only by the WHERE clause, which is not a parameter: somebody else's id, a
-- pending or already-dismissed row and an unknown id all answer `dismissed: false`, so it is
-- not an oracle about anybody's inbox. The single row is the lock; there is nothing to order.
-- ---------------------------------------------------------------------------

create or replace function dismiss_received_recommendation(
  p_operation_id      uuid,
  p_recommendation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dismissed integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'dismiss_received_recommendation') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  update title_recommendations r
     set dismissed_at = now()
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'delivered'
     and r.dismissed_at is null;

  get diagnostics v_dismissed = row_count;

  -- No notification, in either direction, and nothing else written: the sender is not told,
  -- and the recipient's watchlist, rankings and For You are not this function's business.
  return jsonb_build_object('status', 'ok', 'dismissed', v_dismissed > 0);
end;
$$;

comment on function dismiss_received_recommendation(uuid, uuid) is
  'Removes one of the caller''s own delivered recommendations from Sent to You (and from the title page''s Recommended by card) by setting dismissed_at (20261130001200). Recipient-only; anything else answers dismissed: false. Deletes nothing and changes no other column, notifies nobody, and touches no watchlist, ranking, For You signal or sender-visible state. Not dismiss_recommendation, which throws away a pending request. A replayed operation id answers already_applied.';

revoke execute on function dismiss_received_recommendation(uuid, uuid) from public, anon;
grant execute on function dismiss_received_recommendation(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Undoing it
--
-- The exact inverse, and nothing more: `dismissed_at` back to null on the caller's own
-- delivered row. Every other column was left alone by the dismissal, so the row returns to
-- the list in the same place, with the same read state and the same note.
--
-- The block test is the one `add_recommendation` makes, for its reason: `block` deletes these
-- rows, but if one survived some path nobody has thought of, restoring it would put a blocked
-- account's suggestion back in the caller's list.
-- ---------------------------------------------------------------------------

create or replace function restore_received_recommendation(
  p_operation_id      uuid,
  p_recommendation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_restored integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'restore_received_recommendation') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  update title_recommendations r
     set dismissed_at = null
   where r.id = p_recommendation_id
     and r.recipient_id = auth.uid()
     and r.state = 'delivered'
     and r.dismissed_at is not null
     and not blocked_between(r.sender_id, auth.uid());

  get diagnostics v_restored = row_count;

  return jsonb_build_object('status', 'ok', 'restored', v_restored > 0);
end;
$$;

comment on function restore_received_recommendation(uuid, uuid) is
  'Puts one of the caller''s own dismissed recommendations back in Sent to You (Undo) by clearing dismissed_at (20261130001200). Recipient-only; anything else answers restored: false. Changes no other column and notifies nobody. A replayed operation id answers already_applied.';

revoke execute on function restore_received_recommendation(uuid, uuid) from public, anon;
grant execute on function restore_received_recommendation(uuid, uuid) to authenticated;
