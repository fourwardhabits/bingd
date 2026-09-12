-- Starting over means starting over, and not quietly importing two archives as one.
--
-- Independent review of the Phase 3 client, 2026-09-11.
--
-- ===========================================================================
-- THE HOLE
--
-- `import_create` finds an open job by `user_id` and adopts it, which is deliberate and
-- right: a client that lost its connection halfway through staging should carry on rather
-- than start again, and `import_rows_once` makes the pages it already sent free to re-send.
-- Its own comment names the failure that bounds it -- "the person's *next* export, a
-- different archive, weeks later, would stage onto the same job and import both as one" --
-- and guards it by refusing to adopt a `pending` job older than an hour.
--
-- The client's **Start over** button lives entirely inside that hour:
--
--   1. import archive A; some pages stage; the connection drops
--   2. the job is left `pending`, holding A's rows
--   3. Start over -> the screen forgets the job; the job does not forget A
--   4. pick archive B, import -> `import_create` returns the *same* job
--   5. B stages beside A, and `import_ready` hands the worker A united with B
--
-- Nothing about that is exotic. It is two taps after a dropped connection, and the result
-- is a collection containing films from an archive the person explicitly abandoned.
--
-- The client cannot fix this alone: it has no way to say "that job is not mine any more",
-- because deleting the job is the one thing an owner cannot do through RLS -- `import_jobs`
-- has a `select` policy and nothing else, so every write goes through a definer function.
-- This is that function.
--
-- ===========================================================================
-- WHY ONLY A PENDING JOB
--
-- `pending` means the client is still staging and the worker has never seen it. Anything
-- further along belongs to the worker: it may be mid-batch, holding a row lock, or applying
-- rows that have already become collection entries, and letting a button on a phone delete
-- that would race `_drain_import_jobs` for no benefit anybody asked for.
--
-- So a job that is already running is left alone and the caller is told so, rather than
-- being refused with an error. The client uses that answer to show the running import
-- instead of starting a second one -- which is the other half of the same review finding.
-- ===========================================================================

create or replace function import_discard(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner   uuid;
  v_status  text;
  v_deleted integer;
begin
  perform assert_can_write();

  select user_id, status into v_owner, v_status
    from import_jobs where id = p_job_id;

  -- Already gone is a success. A client retrying after a dropped response must not be told
  -- its own completed request failed.
  if v_owner is null then
    return jsonb_build_object('status', 'gone');
  end if;

  if v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;

  if v_status <> 'pending' then
    return jsonb_build_object('status', 'running', 'job_status', v_status);
  end if;

  -- `import_rows` cascades from `import_jobs`, so the staged archive goes with it. That is
  -- the point: a half-staged export that nobody is going to finish is not evidence of
  -- anything, and leaving it is what let the next one merge into it.
  delete from import_jobs
   where id = p_job_id and user_id = auth.uid() and status = 'pending';

  get diagnostics v_deleted = row_count;

  return jsonb_build_object('status', case when v_deleted > 0 then 'discarded' else 'running' end);
end;
$$;

comment on function import_discard(uuid) is
  'Abandons the caller''s own half-staged import, deleting the job and cascading its staged rows. Only a pending job: anything the worker has claimed belongs to the worker, and is answered with status "running" rather than refused, so the client can show the running import instead of starting a second one. Idempotent -- a job that is already gone answers "gone". Exists because import_create adopts an open job for an hour, which is correct for a retry and wrong for a person who pressed Start over and chose a different archive.';

revoke execute on function import_discard(uuid) from public, anon;
grant execute on function import_discard(uuid) to authenticated;
