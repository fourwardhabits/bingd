-- An import that keeps only what it needs, and will not be handed more than it asked for.
--
-- The two review findings left open when `20260917000300` went to staging. A **new**
-- migration rather than an edit: those three have been applied, and an applied migration
-- is history.
--
-- Specification: Contract V3 §14 (retention) and §12 (bounds).
--
-- ===========================================================================
-- 1. WHY THE BOUND IS 2 MiB AND NOT A ROUND NUMBER SOMEBODY LIKED
--
-- `import_stage` bounded rows and not bytes, which is not a bound: a thousand rows each
-- carrying a ten-megabyte title is a thousand rows.
--
-- The number below is measured rather than chosen. `src/features/import/payload.test.ts`
-- builds the exact wire payload from the founder's real export and from generated
-- libraries of 500, 2,500 and 10,000 films, and prints what each weighs:
--
--     real export (22 films)        171 bytes per row
--     generated 500                 178 bytes per row
--     generated 2,500               185 bytes per row
--     generated 10,000              185 bytes per row
--     worst 1,000-row page          187 KiB
--
-- 2 MiB is eleven times the worst page a full-size export can produce at the server's own
-- row ceiling. That test asserts the headroom stays above eight, so a future field or a
-- wider length cap that ate the margin fails there rather than quietly making this tight.
--
-- **What this is and is not.** PostgREST has already parsed the request into `jsonb` by the
-- time this runs, so it is not a request-size guard — the gateway's own limit is that. It
-- bounds what one call will *expand and insert*: `jsonb_array_elements` over a pathological
-- page, a thousand `left()` calls, and the index maintenance behind them. A legitimate
-- client never approaches it, and a client that does has a bug, which deserves a refusal
-- rather than a best effort.
-- ===========================================================================

insert into app_config (key, value) values ('import.max_page_bytes', '2097152'::jsonb)
  on conflict (key) do nothing;


create or replace function import_stage(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_status text;
  v_staged integer;
  v_bytes  integer;
  v_max    integer;
begin
  perform assert_can_write();

  select user_id, status into v_owner, v_status
    from import_jobs where id = p_job_id;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;
  if v_status <> 'pending' then
    raise exception 'this import is no longer accepting rows' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;
  -- A page, not a library. The client loops; this bounds one statement.
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'too many rows in one page' using errcode = '22023';
  end if;

  -- And a page's weight, not only its length. Shape-tested like every other config read,
  -- so an operator typo cannot make every import fail (20260917000300's lesson).
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

  insert into import_rows (job_id, kind, correlation, raw, status)
  select p_job_id,
         r->>'kind',
         left(r->>'correlation', 200),
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
         )),
         'pending'
    from jsonb_array_elements(p_rows) r
   where left(r->>'correlation', 200) is not null
     and r->>'name' is not null
     and r->>'kind' in ('watched', 'watchlist')
  on conflict (job_id, kind, correlation) do nothing;

  get diagnostics v_staged = row_count;

  return jsonb_build_object('status', 'ok', 'staged', v_staged, 'bytes', v_bytes);
end;
$$;

comment on function import_stage(uuid, jsonb) is
  'Stages one page of normalised rows onto the caller''s own open job. Bounded by rows (1000) and by bytes (app_config import.max_page_bytes, default 2 MiB -- eleven times the worst page a 10,000-film export produces at that row ceiling; the derivation is measured in src/features/import/payload.test.ts). Idempotent through import_rows_once, so a retried page after a dropped connection stages nothing twice. Projects the payload field by field and rebuilds watches element by element: whatever else the client sends is discarded rather than stored, so this table cannot become a side channel for the files the import refuses to read. Every value is shape-tested before it is cast, so one malformed value costs that value and never the page.';

grant execute on function import_stage(uuid, jsonb) to authenticated;


-- ===========================================================================
-- 2. AN UNRESOLVED ROW KEEPS ITS NAME AND NOTHING ELSE
--
-- `_import_settle` deleted the applied and duplicate rows and left the rest — so a film
-- the catalogue could not place kept its whole staged payload for ever: the film URI, the
-- rating, the bucket, the watch date, and every diary URI and viewing date attached to it.
-- Contract V3 §14 says the raw export source is not retained indefinitely, and "for ever on
-- a completed job" is the definition of indefinitely.
--
-- The fix is redaction rather than deletion, because the rows have a job: the repair
-- surface lists what could not be placed, and "182 films we couldn't place" is a count of
-- nothing if the names are gone.
--
-- **What survives is exactly what a matched row already keeps.** `imported_titles` holds
-- `source_name` and `source_year` for every film that *did* match, permanently and by
-- design. Keeping the same two fields for the ones that did not is symmetric, is the
-- minimum the repair screen renders, and is not the export — it is the provenance of a
-- collection row that is still waiting to exist.
--
-- Everything else goes: the viewing history first, since a diary URI is a per-viewing
-- identity and a watch date is the most private thing an import carries.
-- ===========================================================================

create or replace function _import_settle(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid;
  v_counts jsonb;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return '{}'::jsonb; end if;

  perform set_config('bingd.import_running', txid_current()::text, true);

  perform _maybe_award_unlocks(v_user,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);

  select jsonb_build_object(
           'applied',    count(*) filter (where status = 'applied'),
           'ambiguous',  count(*) filter (where status = 'ambiguous'),
           'unmatched',  count(*) filter (where status in ('unmatched', 'needs_provider')),
           'stragglers', count(*) filter (where status in ('pending', 'matched')),
           'watched',    count(*) filter (where status = 'applied' and kind = 'watched'),
           'watchlist',  count(*) filter (where status = 'applied' and kind = 'watchlist'),
           'viewings',   coalesce(sum(
                           case when status = 'applied' and kind = 'watched'
                                then jsonb_array_length(coalesce(raw->'watches', '[]'::jsonb))
                                else 0 end), 0)
         )
    into v_counts
    from import_rows where job_id = p_job_id;

  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate');

  -- The redaction. Down to the two fields the repair surface renders, for the rows that
  -- survive; `candidates` is its own column and is left alone, because an ambiguous row
  -- without its candidates cannot be resolved by anybody.
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
  'Ends a job: evaluates the thirteen collection award tracks once, silently, under the marker; writes the counts the summary screen reads; deletes every applied and duplicate staging row; and redacts what is left down to the name and year the repair surface renders -- the film URI, the rating, the bucket, the watch date and every diary URI go, because Contract V3 §14 forbids retaining the export indefinitely and a completed job keeps its unresolved rows for ever. Name and year survive because imported_titles already keeps exactly those two for every film that did match. Once only: the final update is guarded on completed_at is null, so a second call cannot overwrite a correct summary with zeroes. Internal.';

revoke execute on function _import_settle(uuid) from public, anon, authenticated;
