-- Saying "I watched this, and I do not remember when".
-- Specification: founder report 2026-08-24 · PRD §10 (Logged), PRD §22 (watched_on
-- is always-private).
--
-- ---------------------------------------------------------------------------
-- 1. The state already exists; nothing could reach it
--
-- `user_media.watched_on` has been nullable since 20260813000500, and a null there
-- has never meant "not watched": 20260815040000 settled that `bucket`, `watched_on`
-- and `progress = 'completed'` are three *independent* watch signals, any one of
-- which is enough. A row with a bucket and no date is a title somebody watched and
-- rated, on a day they did not record. That is a perfectly ordinary row and the
-- schema has always allowed it.
--
-- What no caller could do is *arrive* at it. Both writers of the column upsert with
--
--     set watched_on = coalesce(excluded.watched_on, user_media.watched_on)
--
-- (20260813002300 for `log_watched`, carried forward by 20260816000000), and that
-- coalesce is load-bearing in the other direction: it is what stops `save_note` and
-- every date-less re-log from wiping a date already recorded. Passing null does not
-- clear the date, it means "leave it alone" — so there was no argument to any RPC
-- that produced a null, and `user_media` has no INSERT or UPDATE policy, so a client
-- cannot write the column directly either.
--
-- The founder found the gap from the product side: the log sheet stamps today's date
-- the first time a bucket is chosen (`LogSheet.tsx`, and it must, or the sheet would
-- display a default it never saved), and there was then no way to say "actually, I
-- don't remember when". The only route was to leave the flow and edit the title
-- afterwards, which does not work either, for the same coalesce.
--
-- So: one function that writes the null, and nothing else changes. No column, no
-- constraint, no new state — this reaches a state the schema has permitted from the
-- first migration.
--
-- ---------------------------------------------------------------------------
-- 2. Why not a flag on log_watched
--
-- The obvious alternative is `p_clear_watched_on boolean default false`, and it was
-- rejected for a reason worth writing down: `log_watched` is the note-and-date
-- writer that every other surface calls, its date argument already means "leave it
-- alone" when null, and a flag would give one parameter two contradictory readings
-- decided by a second parameter. It is also the function most often called with
-- arguments assembled from a form, which is exactly where a stray `true` comes from.
--
-- A separate entry point cannot be reached by accident from the ordinary log path,
-- and it says what it does at its call site.
--
-- ---------------------------------------------------------------------------
-- 3. Clearing a date is not un-watching, and this refuses to let it become that
--
-- The founder's line: clearing the exact date must not silently mean "I did not
-- watch this". For nearly every row it cannot — the bucket is still there, and the
-- bucket is a watch signal in its own right.
--
-- The exception is real and reachable. The log sheet lets a date be set before a
-- bucket is chosen, so a row can exist whose *only* watch signal is the date.
-- Clearing that one would leave a `user_media` row asserting nothing at all: not
-- watched, not rated, not in progress — which is the deletion of a log dressed up as
-- an edit, and the user pressing "I don't remember" did not ask for it.
--
-- So this refuses that case rather than performing it, with a 22023 the client turns
-- into a sentence. It is the same shape as the future-date refusal in `log_watched`:
-- the database declines to record a thing that would not be true.
--
-- The watchlist is untouched either way, and that also falls out of 20260815040000
-- rather than needing a rule here: the update trigger fires only when a signal
-- *becomes* non-null, so clearing one moves nothing. A title you watched does not
-- return to the list of titles you mean to watch because you forgot the date.
--
-- ---------------------------------------------------------------------------
-- 4. Idempotent like every other collection write
--
-- `_claim_operation` for the reason offline-sync.md §3 gives, even though this is not
-- outbox-eligible: a replay of a clear is harmless in isolation, but the client
-- cannot distinguish a commit that lost its reply from a refusal, and the operation
-- id is what makes "already applied" an answer rather than a guess. Same guard, same
-- 'already_applied' status, same shape of return as its neighbours.
-- ---------------------------------------------------------------------------

create or replace function clear_watch_date(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'clear_watch_date') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  select * into v_row
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id
     for update;

  -- No row, or a row with no date on it. Both are the state the caller asked for, so
  -- both are success — the same reading `rank_cancel` gives a session that has already
  -- gone. Reporting "no such row" would make the client handle an error for an outcome
  -- it wanted.
  if v_row.media_item_id is null or v_row.watched_on is null then
    return jsonb_build_object('status', 'ok');
  end if;

  -- §3. The date is the only thing on this row saying the title was watched.
  if v_row.bucket is null and v_row.progress is distinct from 'completed' then
    raise exception 'the watch date is the only record that this was watched'
      using errcode = '22023';
  end if;

  update user_media
     set watched_on = null
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function clear_watch_date is
  'Sets user_media.watched_on to null for the caller''s own row, leaving the bucket, the note and every other signal alone. The title stays Logged: a bucket is a watch signal in its own right (20260815040000). Refuses with 22023 when the date is the only watch signal on the row, because clearing it there would un-log the title rather than forget a date. Idempotent through _claim_operation; a row that is absent or already dateless answers ok.';

-- 20260813001800 made EXECUTE default-deny with an explicit allow-list and
-- 20260813002100 issued the global form, so a new function arrives with no PUBLIC
-- grant. The revoke is belt-and-braces and the grant is the statement of intent —
-- function-grants.test.mjs asserts this exact pair.
revoke execute on function clear_watch_date(uuid, uuid) from public, anon;
grant  execute on function clear_watch_date(uuid, uuid) to authenticated;
