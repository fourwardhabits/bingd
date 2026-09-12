-- The worker nobody started, and the archive a failed job kept for ever.
--
-- Independent read-only review of the full branch, 2026-09-11. Two blockers, one of which
-- meant the feature could not work at all on a real database, and neither of which any
-- test could see. A new migration rather than an edit to `20260917000300`: that one is
-- applied on staging, and an applied migration is history.
--
-- ===========================================================================
-- 1. NOTHING EVER INSTALLED THE CRON JOB
--
-- `20260917000300` defines `schedule_import_drain()` and then never calls it. It has no
-- self-install block, no grant to `service_role`, and no step in
-- `scripts/bootstrap-production.mjs`. The precedent it names in its own comment --
-- `schedule_push_drain`, `20260826000300` -- has all three.
--
-- So on any real project the pg_cron job does not exist, and `_drain_import_jobs` is never
-- called by anything. What that costs is worse than "imports are slow":
--
--   1. `import_ready` sets the job `matching`. Nothing drains it.
--   2. `import_status` keeps answering **successfully** with `matching`, so the client's
--      blind-poll counter never increments and the `unknown` bail-out never fires. The
--      person sits on "Matching your films" -- a screen with no buttons -- indefinitely.
--   3. The 24-hour dead letter also lives inside `_drain_import_jobs`, so `completed_at`
--      stays null for ever, `import_jobs_one_live` holds, and `import_create` re-adopts
--      that same job on every later attempt. The importer is bricked for that account with
--      no way out from the client.
--
-- The whole pipeline suite calls `_drain_import_jobs()` directly, which is the right way to
-- test a worker deterministically and precisely why none of it noticed that nobody calls it
-- in production.
--
-- ===========================================================================
-- 2. A FAILED JOB KEPT THE WHOLE PAYLOAD FOR EVER
--
-- Every deletion and every redaction lives in `_import_settle`. The dead-letter path in
-- `_drain_import_jobs` does not go through it -- it writes `status = 'failed'`,
-- `completed_at = now()` straight onto `import_jobs` -- so a job that exhausted its
-- attempts kept its entire staged payload: film URIs, ratings, buckets, watch dates and
-- every diary URI, permanently, with nothing to sweep them.
--
-- Contract V3 §14 says the export source is not retained indefinitely, and `20260917000400`
-- went to some length to honour that on the settle path. It was true on the happy path and
-- false on the failure path, which is the wrong way round: a person whose import *failed*
-- is the one least likely to come back and least served by us keeping their diary.
--
-- **Fixed with a trigger rather than by re-emitting the worker.** `_drain_import_jobs` is
-- two hundred lines and re-stating it to change four would be four lines of fix and a
-- hundred and ninety-six of transcription risk. A trigger on the transition into a
-- completed state is also strictly more general: it covers the dead letter, it covers
-- `_import_settle`, and it covers whatever writes `completed_at` next year.
--
-- On the settle path it is a no-op by construction -- `_import_settle` deletes the applied
-- and duplicate rows and redacts the rest *before* it writes `completed_at`, so by the time
-- this fires there is nothing left matching its predicate.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The redaction, on any road into a finished job
-- ---------------------------------------------------------------------------

create or replace function _import_redact_on_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Down to the two fields the repair surface renders, exactly as `_import_settle` does:
  -- `imported_titles` already keeps `source_name` and `source_year` permanently for every
  -- film that matched, so keeping the same two for the ones that did not is symmetric, and
  -- "182 films we couldn't place" is a count of nothing without the names.
  --
  -- `candidates` is a column of its own and is deliberately left alone: an ambiguous row
  -- without its candidates cannot be resolved by anybody.
  update import_rows
     set raw = jsonb_strip_nulls(jsonb_build_object(
                 'name', raw->>'name',
                 'year', raw->'year'))
   where job_id = new.id
     and raw ?| array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches'];

  return null;
end;
$$;

comment on function _import_redact_on_complete() is
  'Redacts whatever staging rows a finished job still holds down to name and year. Fires on the transition into a completed job, so it covers the dead-letter path in _drain_import_jobs -- which never called _import_settle and therefore kept failed imports'' film URIs, ratings, buckets, watch dates and diary URIs permanently, against Contract V3 §14. A no-op after _import_settle, which redacts before it writes completed_at. Internal.';

revoke execute on function _import_redact_on_complete() from public, anon, authenticated;

drop trigger if exists import_jobs_redact_on_complete on import_jobs;

create trigger import_jobs_redact_on_complete
  after update of completed_at on import_jobs
  for each row
  when (new.completed_at is not null and old.completed_at is null)
  execute function _import_redact_on_complete();


-- ---------------------------------------------------------------------------
-- The grants the worker's own callers were missing
-- ---------------------------------------------------------------------------

-- `schedule_import_drain` is what `scripts/bootstrap-production.mjs` calls over PostgREST,
-- which reaches it as `service_role`. Without this it was revoked from everybody and
-- grantable by nobody, so the one documented way to install the job could not be used
-- either. Mirrors `20260826000300:290`.
grant execute on function schedule_import_drain(text) to service_role;

-- The two halves of the provider tier. The Edge Function calls both with the service key,
-- and every comparable function in this repo that an Edge Function calls carries this grant
-- explicitly -- `claim_push_batch`, `settle_push_batch`, `tmdb_claim_facet`. These were
-- revoked from public/anon/authenticated and then granted to nobody, surviving only on
-- whatever default privileges the role happens to hold. Said out loud, so that a future
-- tightening of those defaults is not a silent outage of the matcher.
grant execute on function _import_provider_claim(integer) to service_role;
grant execute on function _import_provider_resolve(uuid, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- And the install itself, best-effort, exactly as the push drain does it
--
-- Written to *notice* rather than to fail. The test harness has neither extension, and a
-- raised exception here would cost the entire suite; the bootstrap script re-runs
-- `schedule_import_drain()` explicitly on a real project, so a notice costs nothing.
-- ---------------------------------------------------------------------------

do $bootstrap$
begin
  begin
    execute 'create extension if not exists pg_net';
  exception when others then
    raise notice 'import drain: pg_net unavailable (%), scheduler not installed', sqlerrm;
    return;
  end;

  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'import drain: pg_cron unavailable (%), scheduler not installed', sqlerrm;
    return;
  end;

  begin
    perform schedule_import_drain();
    raise notice 'import drain: scheduled every minute';
  exception when others then
    raise notice 'import drain: could not schedule (%); call schedule_import_drain() once the extensions are on', sqlerrm;
  end;
end;
$bootstrap$;
