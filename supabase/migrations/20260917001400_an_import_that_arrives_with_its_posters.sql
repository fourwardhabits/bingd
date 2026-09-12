-- An import that arrives with its posters.
--
-- Physical QA on staging, 2026-09-12. After a real 24-film Letterboxd import, Collection's
-- Unranked and Watched shelves showed initials tiles for Shrek, Free Solo and twelve more.
-- Opening a title page drew its poster, and going back to Collection it was there too.
--
-- ===========================================================================
-- WHAT THE ROWS SAID
--
-- Fourteen of the job's twenty-four films were placed by the provider tier, and every one of
-- them was `provenance = 'tmdb'`, no poster, no overview, `fetched_at` inside the same two
-- seconds of the provider tick. Shrek and Free Solo were the same until 20:42:41 and
-- 20:42:50, which is when the founder opened them: the title page's `detail` call filled the
-- row in. The four films the local tier placed were seed rows enriched that morning and had
-- posters all along.
--
-- Two causes, in two places:
--
--   1. The provider tier threw the poster away. `/search/movie` returns `poster_path`; the
--      upsert sent only the id, title and date. Fixed in `letterboxd-import/match.mjs`
--      (`catalogueItem`), and it costs no request, because it is the response already paid
--      for.
--
--   2. Nothing enriches a thin row except somebody opening it. `tmdb_enrich_due` is drained
--      by hand (`npm run catalogue:enrich`) and by nothing on a schedule. A local match onto
--      a row that is still poster-less -- an unenriched seed title, or a stub a previous
--      import created before (1) -- stays that way.
--
-- This migration is (2).
--
-- ===========================================================================
-- THE NUDGE, AND WHAT BOUNDS IT
--
-- The import tick already runs every minute. It now also asks `tmdb-adapter`'s existing
-- service-only `enrich` action to fill in the poster-less titles somebody imported
-- recently, naming them, so they are not queued behind the catalogue's whole backlog.
--
--   * **At most 25 titles a tick**, each one TMDB detail request, at the adapter's own
--     concurrency of 8. A 10,000-film import whose films all landed on poster-less rows
--     would take seven hours to trickle through; the realistic case after (1) is a handful.
--
--   * **Once per title.** `tmdb_upsert_titles` stamps `fetched_at` on every write, so a
--     title whose detail call came back without a poster -- TMDB genuinely has none -- has
--     `fetched_at` later than the import that brought it and is not asked about again. That
--     is the rule `tmdb_enrich_due` alone cannot express: it contains posterless films for
--     ever, which is why `backfill-tmdb.mjs` never terminates on staging.
--
--   * **Only for three hours after the import.** A detail call that *failed* leaves
--     `fetched_at` alone, so the window is what stops a title TMDB has deleted being retried
--     every minute indefinitely. Past it, the title page's own enrichment is still there,
--     which is exactly the behaviour before this.
--
--   * **Guarded like the provider nudge.** No base URL, no vault key or no `pg_net`, and it
--     does nothing, and a failed post cannot take the tick's transaction down with it.
--
-- Watchlist rows are included. The importer writes them without a `source`, so they are
-- selected by age, and a native watchlist add in the window costs nothing: it came from a
-- search that carried a poster, so it is not poster-less.
-- ===========================================================================


-- The age filter below reads imported rows by `created_at`; `user_media_imported` is keyed
-- by account and cannot serve it.
create index if not exists user_media_imported_recent
  on user_media (created_at) where source = 'imported';

create index if not exists watchlist_recent on watchlist (created_at);


create or replace function _import_thin_titles(p_limit integer default 25)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  with brought as (
    select um.media_item_id, um.created_at
      from user_media um
     where um.source = 'imported'
       and um.created_at > now() - interval '3 hours'
    union all
    select wl.media_item_id, wl.created_at
      from watchlist wl
     where wl.created_at > now() - interval '3 hours'
  )
  select coalesce(array_agg(t.id), '{}'::uuid[])
    from (
      select mi.id
        from brought b
        join media_items mi on mi.id = b.media_item_id
       where mi.tmdb_id is not null
         and mi.kind in ('movie', 'series')
         and mi.poster_path is null
       group by mi.id, mi.fetched_at
      -- Not asked about since it was brought in. See "Once per title" above.
      having mi.fetched_at is null or mi.fetched_at <= max(b.created_at)
       order by max(b.created_at) desc
       limit least(greatest(coalesce(p_limit, 25), 1), 100)
    ) t;
$$;

comment on function _import_thin_titles(integer) is
  'The poster-less catalogue titles somebody imported (or watchlisted) in the last three hours that have not been fetched from the provider since, newest first, capped at 100. What _import_enrich_nudge names to tmdb-adapter. Once per title: tmdb_upsert_titles stamps fetched_at, so a title the provider has no poster for drops out after one attempt. Internal.';

revoke execute on function _import_thin_titles(integer) from public, anon, authenticated;


create or replace function _import_enrich_nudge(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_url text;
  v_key text;
begin
  v_ids := _import_thin_titles(p_limit);
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('status', 'idle');
  end if;

  select value #>> '{}' into v_url from app_config where key = 'functions.base_url';
  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';
  exception when others then
    v_key := null;
  end;

  if nullif(v_url, '') is null or nullif(v_key, '') is null
     or to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null
  then
    return jsonb_build_object('status', 'unconfigured', 'due', array_length(v_ids, 1));
  end if;

  begin
    perform net.http_post(
      url     := v_url || '/tmdb-adapter',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_key,
                   'apikey',        v_key
                 ),
      body    := jsonb_build_object(
                   'action', 'enrich',
                   'ids',    to_jsonb(v_ids),
                   'limit',  array_length(v_ids, 1)
                 ),
      timeout_milliseconds := 20000
    );
  exception when others then
    -- The same rule as the provider nudge: a failed post is retried by the next tick and
    -- must never roll back the drain and the sweep this runs beside.
    return jsonb_build_object('status', 'post_failed', 'due', array_length(v_ids, 1));
  end;

  return jsonb_build_object('status', 'posted', 'due', array_length(v_ids, 1));
end;
$$;

comment on function _import_enrich_nudge(integer) is
  'Asks tmdb-adapter to enrich the poster-less titles a recent import brought in, by id, at most p_limit (default 25) a tick. Runs on the import cron tick beside the drain and the sweep. Does nothing without functions.base_url, the vault service_role_key and pg_net, and swallows a failed post. Internal.';

revoke execute on function _import_enrich_nudge(integer) from public, anon, authenticated;
grant execute on function _import_enrich_nudge(integer) to service_role;


-- ---------------------------------------------------------------------------
-- The tick runs all three. Re-emitted from `20260917001200` with only the command changed.
-- ---------------------------------------------------------------------------

create or replace function schedule_import_drain(p_schedule text default '* * * * *')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed on this database'
      using errcode = '55000',
            hint = 'Enable pg_cron and pg_net (Supabase dashboard, Database > Extensions), then call this again.';
  end if;

  execute $q$ select jobid from cron.job where jobname = 'bingd-import-drain' $q$ into v_jobid;
  if v_jobid is not null then
    execute $q$ select cron.unschedule($1) $q$ using v_jobid;
  end if;

  execute $q$ select cron.schedule('bingd-import-drain', $1,
    'select public._drain_import_jobs(), public._import_sweep_abandoned(), public._import_enrich_nudge()') $q$
    into v_jobid
    using p_schedule;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', p_schedule);
end;
$$;

comment on function schedule_import_drain(text) is
  'Installs (or replaces) the pg_cron job that drains import_jobs, sweeps abandoned ones and enriches the poster-less titles a recent import brought in. Idempotent by job name, for the reason schedule_push_drain is: two jobs with the same name is two workers a minute for ever. All three run in one statement so the job stays a single command. service_role only.';

revoke execute on function schedule_import_drain(text) from public, anon, authenticated;
grant execute on function schedule_import_drain(text) to service_role;


do $bootstrap$
begin
  perform schedule_import_drain();
  raise notice 'import drain: rescheduled with the poster nudge';
exception when others then
  raise notice 'import drain: could not reschedule (%); call schedule_import_drain() once the extensions are on', sqlerrm;
end;
$bootstrap$;
