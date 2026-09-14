-- A ceiling on a whole import, not just on one page of it.
--
-- Independent review, 2026-09-11, finding 8.
--
-- ===========================================================================
-- WHAT WAS UNBOUNDED
--
-- `20260917000400` bounded a page: a thousand rows and two mebibytes. Nothing bounded the
-- number of pages, so an account could stage as many as it liked and `import_rows` had no
-- per-job or per-account ceiling of any kind. The client's own archive limits permit a
-- 25 MiB `watched.csv`, which is roughly 350,000 rows, and a client that is not ours is
-- bounded by nothing at all.
--
-- ===========================================================================
-- THIS IS A SAFETY CEILING AND NOT A PRODUCT LIMIT
--
-- The distinction matters enough to write down, because conflating the two is how the
-- previously rejected "5,000 titles" cap happened.
--
--   **Supported library size** is a product question answered by measurement: how large an
--   import stays pleasant on a real phone, how long the worker takes, whether the summary
--   is still meaningful. `src/features/import/scale.test.ts` measures the honest end of
--   that today -- 10,000 titles is 1,250 KiB of CSV and 130 ms to parse and normalise --
--   and the answer will move as the product does. It is a recommendation, not a refusal.
--
--   **This** is the point past which a request stops being a library and starts being a
--   way to fill a table. It exists to bound damage, not to shape behaviour, and nobody
--   importing a real Letterboxd account should ever see it.
--
-- So the numbers below are deliberately far above the supported size rather than near it:
--
--   50,000 rows     five times the documented product ceiling, and comfortably past the
--                   largest real Letterboxd accounts, which run to the low twenty
--                   thousands. The generated 2,500 / 5,000 / 10,000 fixtures stay usable
--                   for performance work with an order of magnitude to spare.
--
--   32 MiB          at the measured 185 bytes per normalised row, 50,000 rows is about
--                   9 MiB, so this is roughly three and a half times the worst case the
--                   row ceiling itself admits. The slack is for the pathological shape
--                   rather than the large one: a row may carry up to 100 viewings and
--                   fields at their length caps, so rows and bytes bound different
--                   attacks and neither implies the other.
--
-- ===========================================================================
-- COUNTED RATHER THAN MEASURED EACH TIME
--
-- The running totals live on `import_jobs` instead of being summed out of `import_rows` on
-- every call. Summing would be a scan per page -- fifty pages against a growing table --
-- to answer a question two integers can answer exactly.
--
-- They are incremented from the rows that were actually **inserted**, using the insert's
-- own `returning`, so a page re-sent after a dropped connection adds nothing. Staging is
-- idempotent through `import_rows_once`, and a counter that double-counted a retry would
-- turn a network blip into a refused import.
--
-- The pre-check uses the *incoming* page's size, before projection. That over-estimates,
-- since projection only ever shrinks a row -- which is the right direction for a guard:
-- it refuses slightly early rather than admitting one page too many, and it means the
-- refusal happens before a single row of an impossible job is written.
-- ===========================================================================

insert into app_config (key, value) values ('import.max_job_rows', '50000'::jsonb)
  on conflict (key) do nothing;
insert into app_config (key, value) values ('import.max_job_bytes', '33554432'::jsonb)
  on conflict (key) do nothing;

alter table import_jobs
  add column if not exists staged_rows  integer not null default 0,
  add column if not exists staged_bytes bigint  not null default 0;

comment on column import_jobs.staged_rows is
  'Rows actually inserted by import_stage, counted from the insert''s own returning so a re-sent page adds nothing. Bounds one job against import.max_job_rows.';
comment on column import_jobs.staged_bytes is
  'Octets of normalised payload actually inserted, counted the same way. Bounds one job against import.max_job_bytes -- a separate attack from the row count, since one row may carry a hundred viewings and every field at its length cap.';


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

  select user_id, status, staged_rows, staged_bytes
    into v_owner, v_status, v_rows_so_far, v_bytes_so_far
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

  v_incoming := jsonb_array_length(p_rows);

  -- A page, not a library. The client loops; this bounds one statement.
  if v_incoming > 1000 then
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

  -- ---------------------------------------------------------------------------
  -- And the whole job, which nothing bounded before.
  --
  -- Checked before the insert, so an impossible job is refused rather than half built. The
  -- hints name the supported size rather than the ceiling: somebody who reaches this has
  -- either a library far beyond anything the product is designed around or a client with a
  -- bug, and in both cases the number that helps is the one they should be near.
  -- ---------------------------------------------------------------------------
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
  -- Counted from what was inserted rather than from what arrived, which is what makes a
  -- re-sent page free: `import_rows_once` swallows it, `ins` is empty, and the totals do
  -- not move.
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
  'Stages one page of normalised rows onto the caller''s own open job. Bounded three ways: rows per page (1000), bytes per page (app_config import.max_page_bytes, default 2 MiB), and the whole job (import.max_job_rows, default 50,000; import.max_job_bytes, default 32 MiB). The job bounds are a safety ceiling against filling the table and NOT the supported library size, which is about ten thousand films and is a product recommendation measured in scale.test.ts -- they sit five times above it so that no real Letterboxd account can reach them. The job is refused before any row of it is written. Idempotent through import_rows_once, and the running totals are counted from the insert''s own returning so a retried page after a dropped connection adds nothing to them. Projects the payload field by field and rebuilds watches element by element: whatever else the client sends is discarded rather than stored. Every value is shape-tested before it is cast, so one malformed value costs that value and never the page.';

grant execute on function import_stage(uuid, jsonb) to authenticated;
