-- ---------------------------------------------------------------------------
-- rank_cancel — the function api.md has always described and nobody wrote
--
-- api.md §2 has listed `rank_cancel(session_id)` — "abandon the session; the bucket
-- survives; the title stays Logged" — since the API was specified. It was never
-- implemented. The gap went unnoticed because nothing called it: there was no comparison
-- screen, so no close control, so nothing needed a way out of a session.
--
-- Building that screen is what surfaced it. A user who opens comparisons and changes their
-- mind has to leave, and the alternatives were both wrong. Pressing Back repeatedly does
-- cancel — `rank_back` deletes the session at the first comparison — but making someone
-- unwind five answers to escape is not an exit. Leaving the row behind is worse in a
-- quieter way: `rank_start` resumes an existing session, so the abandoned one would
-- reappear the next time that title was ranked, mid-search, with `resumed: true` and no
-- explanation to the user of why they were being asked about a film they thought they had
-- left alone.
--
-- Deleting the session deletes nothing else. The bucket lives in `user_media` and the
-- comparisons already answered live in `comparisons`, where they remain useful — they are
-- real judgements the user made, and PRD §10 keeps them.
-- ---------------------------------------------------------------------------

create or replace function rank_cancel(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_deleted integer;
begin
  perform assert_can_write();

  delete from ranking_sessions
   where id = p_session_id and user_id = v_user;

  get diagnostics v_deleted = row_count;

  -- Scoped by user_id as well as by id, so this cannot be used to delete someone else's
  -- session by guessing a uuid — and a session that is not the caller's is reported as
  -- absent rather than as forbidden, for the same reason api.md §8 collapses the two.
  if v_deleted = 0 then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  return jsonb_build_object('done', true, 'cancelled', true);
end;
$$;

comment on function rank_cancel is
  'Abandons a comparison session. The bucket survives in user_media and the title stays Logged; answers already given stay in comparisons, because they were real judgements.';

revoke execute on function rank_cancel(uuid) from public, anon, authenticated;
grant execute on function rank_cancel(uuid) to authenticated;
