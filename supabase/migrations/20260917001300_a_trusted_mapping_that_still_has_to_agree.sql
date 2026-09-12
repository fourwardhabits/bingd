-- A trusted mapping that still has to agree with the row it is placing.
--
-- Second independent review of the tranche, 2026-09-12. Five findings, one of which is the
-- reason the cache fix was only half a fix.
--
-- ===========================================================================
-- 1. THE TRUST BOUNDARY WAS ASYMMETRIC, AND THE READ SIDE HAD NO GUARD AT ALL
--
-- `20260917000900` made *writing* a shared mapping require two independent accounts and a
-- year agreement. Reading one back required nothing: T0 looked the URI up and set
-- `status = 'matched'` without ever comparing the result against the row it was placing.
--
-- So a mapping that says `<Godfather slug> -> Cats (2019)` was applied to an export row
-- saying `The Godfather, 1972` — a film the local tier would have placed correctly, because
-- T0 runs first and wins. The victim's own archive flatly contradicted the mapping and was
-- never consulted.
--
-- **The check every claim had to pass now guards the read as well.** If the export carries a
-- year and the trusted target's release date disagrees by more than one, T0 declines and the
-- row falls through to T1, which has the evidence to place it properly.
--
-- This is what bounds the damage of the remaining attack rather than the attack itself.
-- Signing up is free, so "two accounts" is a formality for anybody determined; what changed
-- is what two accounts can buy. Before: bind any URI to any film. Now: bind a URI to a
-- *different film released within a year of the real one*, and only for importers whose
-- export omits the year. That is a far narrower target and a far smaller harm, and it costs
-- the cache nothing it was actually for — an alternate title still resolves, because the
-- title is what T1 could not match and the year is what the export still carries.
--
-- The residual is recorded in `docs/product/letterboxd-import.md` rather than pretended
-- away: two colluding accounts can still mislabel a film within a one-year window, and
-- nothing distinguishes a poisoned pair from an honest one after the fact.
--
-- ===========================================================================
-- 2. `watchlist` COUNTED ROWS THE IMPORT DID NOT ADD
--
-- Exactly the defect `20260917001000` exists to fix, fixed for `watched` and left standing
-- for `watchlist`. `_import_apply_batch` inserts `on conflict do nothing`, so a title already
-- on the list is a no-op — and `wl.user_id is not null` is true either way. Re-import an
-- archive of forty watchlist films and the summary says forty were added, under a heading
-- that reads "Your history is in". `watchlist` has its own `created_at`; the fix is the same
-- predicate `watched` already uses.
--
-- ===========================================================================
-- 3. THE CLAIM PASS RE-SCANNED THE WHOLE JOB ON EVERY SLICE
--
-- `20260917000900` replaced one set-based insert with `perform _import_promote_match(...)
-- from (<the same subquery>)`, which calls the function once per row — over every matched
-- row in the *job*, not the slice. A 10,000-row import at 200 a slice is roughly 255,000
-- invocations of two statements each, against a claims table that is itself growing; 25,000
-- rows is about 1.5 million. The slice runs inside a five-minute lease, and exceeding it
-- makes the job reclaimable mid-slice, which churns the attempt counters and can walk a
-- large import into the dead letter. The rows this slice touched are already known; the
-- claim pass now uses them.
--
-- ===========================================================================
-- 4. A FAILED JOB KEEPS NOTHING, BECAUSE NOTHING READS IT
--
-- Every terminal path redacts; only `_import_settle` deletes, and only `applied` and
-- `duplicate`. So the rows of a job that failed or was swept sat there for ever as
-- `{name, year}` — and unlike a completed job's unresolved rows, **nobody will ever render
-- them**: the repair surface exists for a finished import, not a failed one. Redaction was
-- the right answer to "what may we keep"; deletion is the right answer to "why are we
-- keeping it".
--
-- ===========================================================================
-- 5. CONCURRENT STAGING COULD OVERSHOOT THE JOB CEILING
--
-- The pre-check reads the counters into locals and the increment is atomic, so two
-- overlapping calls both passed. Bounded by one page each, so a wart rather than a hole —
-- and closed by taking the job row for update, which the call already selects.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The matcher: a guarded T0, and a claim pass scoped to its own slice
-- ---------------------------------------------------------------------------

create or replace function _import_match_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_ids  uuid[];
begin
  select user_id into v_user from import_jobs where id = p_job_id;

  with due as (
    select id, raw->>'name' as name, (raw->>'year')::integer as year, raw->>'filmUri' as uri
      from import_rows
     where job_id = p_job_id and status = 'pending'
     order by id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  ),
  resolved as (
    select d.id,
           d.uri,
           -- T0. An exact, previously corroborated film — **and one that agrees with this
           -- row.** The year test is the same one every claim had to pass to get in here;
           -- applying it on the way out is what stops a mapping speaking over an export
           -- that contradicts it.
           (select m.media_item_id
              from letterboxd_matches m
              join media_items mi on mi.id = m.media_item_id
             where m.letterboxd_uri = d.uri
               and (
                 d.year is null
                 or mi.release_date is null
                 or abs(extract(year from mi.release_date)::integer - d.year) <= 1
               )) as t0,
           -- T1 / T1b. Exactly one catalogue movie whose squashed title matches and whose
           -- year is within one -- or which has no release date at all, which is how an
           -- announced-but-undated title is still findable.
           (select array_agg(mi.id)
              from media_items mi
             where mi.kind = 'movie'
               and mi.sort_key_squashed = media_squash(d.name)
               and (
                 d.year is null
                 or mi.release_date is null
                 or abs(extract(year from mi.release_date)::integer - d.year) <= 1
               )) as local
      from due d
  ),
  upd as (
    update import_rows r
       set media_item_id = case
             when x.t0 is not null then x.t0
             when array_length(x.local, 1) = 1 then x.local[1]
             else null
           end,
           status = case
             when x.t0 is not null then 'matched'
             when array_length(x.local, 1) = 1 then 'matched'
             when array_length(x.local, 1) > 1 then 'ambiguous'
             else 'needs_provider'
           end,
           candidates = case
             when x.t0 is null and array_length(x.local, 1) > 1
               then to_jsonb(x.local)
             else null
           end
      from resolved x
     where r.id = x.id
    returning r.id
  )
  select array_agg(id) into v_ids from upd;

  -- ---------------------------------------------------------------------------
  -- A claim, not an assertion — over this slice's rows only.
  --
  -- The evidence bar is unchanged: a unique squashed title whose year agrees with the
  -- catalogue row's release date to within one, and never a match against an undated row.
  -- What changed is the scope. This used to run over every matched row in the job on every
  -- slice, which is quadratic in the size of the import and was the one thing here that got
  -- slower as an import got bigger.
  -- ---------------------------------------------------------------------------
  if v_user is not null and v_ids is not null then
    perform _import_promote_match(c.uri, c.media_item_id, v_user, 'local')
      from (
        select distinct r.raw->>'filmUri' as uri, r.media_item_id
          from import_rows r
          join media_items mi on mi.id = r.media_item_id
         where r.id = any(v_ids)
           and r.status = 'matched'
           and r.media_item_id is not null
           and r.raw->>'filmUri' is not null
           and (r.raw->>'year') is not null
           and mi.release_date is not null
           and abs(extract(year from mi.release_date)::integer - (r.raw->>'year')::integer) <= 1
      ) c;
  end if;

  return coalesce(array_length(v_ids, 1), 0);
end;
$$;

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the trusted film-URI cache first -- guarded by the same year agreement every claim had to pass, so a mapping cannot speak over an export that contradicts it -- then exactly-one squashed title with a year within one. Two or more survivors is ambiguous and stays unresolved. Anything unresolved becomes needs_provider rather than unmatched, so an unconfigured project does not permanently condemn titles a provider would have found. Strong matches in THIS slice are recorded as claims and shared only once another account agrees; see _import_promote_match. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The summary: a watchlist count that means what it says
-- ---------------------------------------------------------------------------

create or replace function _import_settle(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid;
  v_started timestamptz;
  v_counts  jsonb;
begin
  select user_id, created_at into v_user, v_started from import_jobs where id = p_job_id;
  if v_user is null then return '{}'::jsonb; end if;

  perform set_config('bingd.import_running', txid_current()::text, true);

  perform _maybe_award_unlocks(v_user,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);

  select jsonb_build_object(
           'applied',    count(*) filter (where r.status = 'applied'),

           'watched',    count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source = 'imported' and um.created_at >= v_started),

           'kept',       count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source is distinct from 'imported'),

           'already',    count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source = 'imported' and um.created_at < v_started),

           -- **`created_at`, for the same reason `watched` has it.** The apply step inserts
           -- a watchlist row `on conflict do nothing`, so a title already on the list is a
           -- no-op -- and the row existing said nothing about who put it there. Re-importing
           -- an archive of forty watchlist films reported forty additions.
           'watchlist',  count(*) filter (
                           where r.status = 'applied' and r.kind = 'watchlist'
                             and wl.user_id is not null and wl.created_at >= v_started),

           'ambiguous',  count(*) filter (where r.status = 'ambiguous'),
           'unmatched',  count(*) filter (where r.status in ('unmatched', 'needs_provider')),
           'stragglers', count(*) filter (where r.status in ('pending', 'matched'))
         )
    into v_counts
    from import_rows r
    left join user_media um
           on um.user_id = v_user and um.media_item_id = r.media_item_id
    left join watchlist wl
           on wl.user_id = v_user and wl.media_item_id = r.media_item_id
   where r.job_id = p_job_id;

  v_counts := v_counts || jsonb_build_object('viewings', (
    select count(*)
      from imported_watches iw
     where iw.user_id = v_user
       and iw.media_item_id in (
             select r.media_item_id from import_rows r
              where r.job_id = p_job_id and r.kind = 'watched'
                and r.media_item_id is not null)
  ));

  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate');

  update import_rows
     set raw = jsonb_strip_nulls(jsonb_build_object(
                 'name', raw->>'name',
                 'year', raw->'year'))
   where job_id = p_job_id
     and status in ('ambiguous', 'unmatched', 'needs_provider')
     and (raw ?| array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches']);

  update import_jobs
     set status = 'done',
         completed_at = now(),
         claimed_at = null,
         counts = counts || v_counts
   where id = p_job_id and completed_at is null;

  return v_counts;
end;
$$;

comment on function _import_settle(uuid) is
  'Ends a job: evaluates the thirteen collection award tracks once, silently, under the marker; writes the counts the summary screen reads; deletes every applied and duplicate staging row; and redacts what is left down to the name and year the repair surface renders. Every film-unit count says what this run did rather than what it found -- watched and watchlist both test created_at against the job''s own, so a re-import reports nothing added; kept is what the person built here and the import left alone; already is what a previous import owns. viewings is in diary entries rather than films. Once only: the final update is guarded on completed_at is null.';

revoke execute on function _import_settle(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- A failed job keeps nothing
-- ---------------------------------------------------------------------------

create or replace function _import_redact_on_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- **A job that failed has no reader.** The repair surface -- "182 films we couldn't
  -- place", by name -- belongs to a finished import. Nothing renders the leftovers of one
  -- that failed or was swept as abandoned, so redacting them to `{name, year}` and keeping
  -- them for ever answered "what may we keep" without ever asking "why are we keeping it".
  if new.status = 'failed' then
    delete from import_rows where job_id = new.id;
    return null;
  end if;

  -- Anything else that reaches a completed state keeps the two fields the repair surface
  -- renders. A no-op after `_import_settle`, which redacts before it writes `completed_at`.
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
  'Cleans up whatever staging rows a finished job still holds. A failed job -- dead-lettered, or swept as abandoned -- has its rows deleted outright, because nothing will ever render them: the repair surface exists for a completed import. Any other completion redacts down to name and year. Fires on the transition into a completed job, so it covers every road out that does not go through _import_settle. Internal.';

revoke execute on function _import_redact_on_complete() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Staging: the job row is taken for update, so two pages cannot both pass the check
-- ---------------------------------------------------------------------------

create or replace function import_stage(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner      uuid;
  v_status     text;
  v_staged     integer;
  v_bytes      integer;
  v_added      bigint;
  v_max        integer;
  v_rows_so_far integer;
  v_bytes_so_far bigint;
  v_max_rows   integer;
  v_max_bytes  bigint;
  v_incoming   integer;
begin
  perform assert_can_write();

  -- **`for update`.** The ceiling is read into locals and checked against them, so two
  -- overlapping pages both saw a passing check and both inserted -- an overshoot of one
  -- page each. The row is already being selected; locking it costs nothing and makes the
  -- check mean what it says.
  select user_id, status, staged_rows, staged_bytes
    into v_owner, v_status, v_rows_so_far, v_bytes_so_far
    from import_jobs where id = p_job_id
     for update;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;
  if v_status <> 'pending' then
    raise exception 'this import is no longer accepting rows' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  v_incoming := jsonb_array_length(p_rows);

  if v_incoming > 1000 then
    raise exception 'too many rows in one page' using errcode = '22023';
  end if;

  v_max := coalesce(
    (select case when value #>> '{}' ~ '^\d{1,9}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.max_page_bytes'),
    2097152);

  v_bytes := octet_length(p_rows::text);
  if v_bytes > v_max then
    raise exception 'this page is too large (% bytes, limit %)', v_bytes, v_max
      using errcode = '22023',
            hint = 'Send fewer rows per call. A page of a thousand real rows is about 190 KiB.';
  end if;

  v_max_rows := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,9}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.max_job_rows'),
    50000), 1000), 1000000);

  v_max_bytes := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,12}$' then (value #>> '{}')::bigint end
       from app_config where key = 'import.max_job_bytes'),
    33554432), 4194304), 1073741824);

  if v_rows_so_far + v_incoming > v_max_rows then
    raise exception 'this import is too large (% rows, limit %)',
      v_rows_so_far + v_incoming, v_max_rows
      using errcode = '22023',
            hint = 'Bingd imports libraries up to about ten thousand films. An export larger than that is beyond what this is built for.';
  end if;

  if v_bytes_so_far + v_bytes > v_max_bytes then
    raise exception 'this import is too large (% bytes, limit %)',
      v_bytes_so_far + v_bytes, v_max_bytes
      using errcode = '22023',
            hint = 'Bingd imports libraries up to about ten thousand films. An export larger than that is beyond what this is built for.';
  end if;

  with incoming as (
    select p_job_id as job_id,
           r->>'kind' as kind,
           left(r->>'correlation', 200) as correlation,
           jsonb_strip_nulls(jsonb_build_object(
             'name',      left(r->>'name', 200),
             'year',      case when r->>'year' ~ '^\d{4}$'
                               and (r->>'year')::integer
                                   between 1870 and extract(year from current_date)::integer + 5
                          then (r->>'year')::integer end,
             'filmUri',   left(r->>'filmUri', 300),
             'rating',    case when r->>'rating' ~ '^[0-5](\.[05])?$'
                               and (r->>'rating')::numeric between 0.5 and 5.0
                          then (r->>'rating')::numeric end,
             'bucket',    case when r->>'bucket' in ('loved', 'fine', 'not_for_me')
                          then r->>'bucket' end,
             'watchedOn', case when r->>'watchedOn' ~ '^\d{4}-\d{2}-\d{2}$'
                               and _safe_date(r->>'watchedOn')
                                   between date '1870-01-01' and current_date + 1
                          then _safe_date(r->>'watchedOn') end,
             'watches',   (
               select jsonb_agg(jsonb_build_object(
                        'diaryUri',  left(w->>'diaryUri', 300),
                        'watchedOn', _safe_date(w->>'watchedOn'),
                        'isRewatch', coalesce(w->>'isRewatch' = 'true', false)
                      ))
                 from jsonb_array_elements(
                        case when jsonb_typeof(r->'watches') = 'array'
                             then r->'watches' else '[]'::jsonb end) w
                where jsonb_typeof(w) = 'object'
                  and w->>'diaryUri' is not null
                  and w->>'watchedOn' ~ '^\d{4}-\d{2}-\d{2}$'
                  and _safe_date(w->>'watchedOn')
                      between date '1870-01-01' and current_date + 1
             )
           )) as raw
      from jsonb_array_elements(p_rows) r
     where left(r->>'correlation', 200) is not null
       and r->>'name' is not null
       and r->>'kind' in ('watched', 'watchlist')
  ),
  ins as (
    insert into import_rows (job_id, kind, correlation, raw, status)
    select job_id, kind, correlation, raw, 'pending' from incoming
    on conflict (job_id, kind, correlation) do nothing
    returning raw
  )
  select count(*), coalesce(sum(octet_length(raw::text)), 0) into v_staged, v_added from ins;

  update import_jobs
     set staged_rows  = staged_rows + v_staged,
         staged_bytes = staged_bytes + v_added
   where id = p_job_id;

  return jsonb_build_object(
    'status', 'ok', 'staged', v_staged, 'bytes', v_bytes,
    'job_rows', v_rows_so_far + v_staged, 'job_bytes', v_bytes_so_far + v_added);
end;
$$;

comment on function import_stage(uuid, jsonb) is
  'Stages one page of normalised rows onto the caller''s own open job. Bounded three ways: rows per page (1000), bytes per page (app_config import.max_page_bytes, default 2 MiB), and the whole job (import.max_job_rows, default 50,000; import.max_job_bytes, default 32 MiB). The job row is taken for update, so two concurrent pages cannot both pass a check the other is about to invalidate. The job bounds are a safety ceiling against filling the table and NOT the supported library size, which is about ten thousand films -- they sit five times above it so that no real Letterboxd account can reach them. The job is refused before any row of it is written. Idempotent through import_rows_once, and the running totals are counted from the insert''s own returning so a retried page adds nothing to them. Projects the payload field by field: whatever else the client sends is discarded rather than stored.';

grant execute on function import_stage(uuid, jsonb) to authenticated;
