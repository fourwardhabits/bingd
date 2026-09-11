-- An import that runs itself.
--
-- The asynchronous pipeline: a client stages normalised rows and leaves, and the database
-- matches and applies them in bounded slices until the job is done. Nothing here holds a
-- provider key, nothing here needs the client to stay open, and every step is safe to run
-- twice.
--
-- Specification: Contract V3 §10. Depends on 20260917000100, 20260917000200.
--
-- ===========================================================================
-- THE WORKER IS THE PUSH WORKER, DELIBERATELY
--
-- `20260826000300` and `20260826000700` already solved "a queue that drains itself" for
-- push: a pg_cron tick, a claim with `FOR UPDATE SKIP LOCKED`, a `claimed_at` lease that
-- expires so a dead worker cannot strand a row, an attempt counter and a dead letter.
-- Same problem, so: same shape, same five-minute lease, same three-failures-or-six-attempts
-- dead letter. A second queue architecture would be a second set of edge cases to get wrong.
--
-- **But not the same numbers, and that distinction cost a blocker.** In `push_outbox` a
-- claim is one message: six attempts means six tries at one piece of work. Here a claim is
-- one *slice* of a job that may need hundreds, so an unreset ceiling of six dead-lettered
-- every library over about four hundred films partway through apply. The counters here
-- bound **unproductive** claims — any slice that moves a row resets them — and a 24-hour
-- wall clock bounds what the counters no longer can.
--
-- **What is also different** is that the work is SQL rather than HTTP. Matching a title
-- against the local catalogue and applying a collection row are both things Postgres can
-- do, so the tick does them directly and the Edge Function is needed only for the provider
-- tier. A project with no provider configured still imports; it resolves fewer titles, and
-- says so.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The job gets a lease, and the rows get a lifecycle
-- ---------------------------------------------------------------------------

alter table import_jobs add column claimed_at timestamptz;
alter table import_jobs add column attempts   integer not null default 0;
alter table import_jobs add column failures   integer not null default 0;
alter table import_jobs add column last_error text;

comment on column import_jobs.claimed_at is
  'When a worker took this job. A claim older than five minutes is reclaimable, so a worker that dies mid-slice cannot strand an import -- the same lease push_outbox uses.';
comment on column import_jobs.storage_path is
  'Unused and always null. The client parses and minimises on the device; the archive is never uploaded, so there is no stored object to point at. Kept rather than dropped because dropping a column is not worth a migration on its own.';

-- `raw` holds the NORMALISED staged row -- name, year, film URI, rating, watch date -- and
-- never CSV text. It is deleted when the job completes, which is what keeps this from
-- becoming a permanent warehouse of somebody's export.
comment on column import_rows.raw is
  'One normalised staged row, not raw CSV: the parser already discarded everything the contract excludes before anything left the device. Deleted on completion for applied and duplicate rows; retained only while a row is still unresolved.';

alter table import_rows add column kind        text;
alter table import_rows add column correlation text;

-- The provider tier's own attempt counter, separate from the job's. A title the provider
-- cannot resolve must stop being asked about without failing the job it belongs to: one
-- obscure short is not a reason to dead-letter somebody's library.
alter table import_rows add column provider_attempts integer not null default 0;

comment on column import_rows.kind is
  'watched or watchlist. The two halves apply in that order, because every watch signal fires _leave_watchlist and applying the watchlist first would have the database delete rows the import had just written.';
comment on column import_rows.correlation is
  'The intra-export (Name, Year) key the client computed. NOT a film identity -- it exists so several CSV rows about one film become one collection row, and so a diary viewing can find its title. Canonical identity is media_item_id.';

-- Widened, not replaced: two states the original set had no name for. `pending` is a row
-- nobody has tried to match yet, and `needs_provider` is one the local catalogue could not
-- resolve and the provider tier has not yet seen -- which must be distinct from `unmatched`,
-- or an unconfigured project would permanently mark titles unmatched that a provider would
-- have found.
alter table import_rows drop constraint import_rows_known_status;
alter table import_rows add constraint import_rows_known_status
  check (status in ('pending', 'needs_provider', 'matched', 'ambiguous',
                    'unmatched', 'duplicate', 'applied'));

-- One live job per account. A second import while one is running is a person tapping twice,
-- not a second intention, and two workers applying two archives to one collection is a race
-- nobody needs to reason about.
create unique index import_jobs_one_live on import_jobs (user_id)
  where completed_at is null;

-- Staging is idempotent on this: re-posting a page after a dropped connection changes
-- nothing. `kind` is in the key because a title can legitimately be both a watch and a
-- watchlist row in one archive -- the apply step is what resolves that, not the stage step.
create unique index import_rows_once on import_rows (job_id, kind, correlation);

create index import_jobs_due on import_jobs (created_at)
  where completed_at is null;


-- ---------------------------------------------------------------------------
-- 2. Creating and staging — the only two things a client does
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A date, or null, for any text at all
--
-- **No regex can make a date cast total**, and this is the second attempt at that lesson.
-- A format guard of `^\d{4}-\d{2}-\d{2}$` admits `2026-02-31`, `2023-02-29` and
-- `2024-06-31` — every one of which raises `22008 date/time field value out of range` —
-- and those are precisely the values a naive date-arithmetic bug in a client parser
-- produces. One of them in one row of a thousand-row page made `import_stage` itself raise
-- and rejected the entire page.
--
-- `::date` inside the handler rather than `to_date`, deliberately: `to_date` would roll
-- `2026-02-31` forward to the 3rd of March, and inventing a viewing date nobody recorded
-- is worse than discarding the one that was unreadable.
-- ---------------------------------------------------------------------------
-- **STABLE, not IMMUTABLE, and the difference is not pedantry.** `date_in` is
-- `provolatile = 's'`: `'today'` resolves against the server clock, and `'1/2/2024'` means
-- January or February depending on the session's `DateStyle`. Labelling that immutable
-- invites plan-time constant folding and generic-plan caching, so the same literal could
-- resolve differently depending on which session planned the statement.
--
-- Which is also why every caller keeps an ISO format guard in front of it. This function
-- makes the cast *total*; the regex is what keeps the boundary ISO-only. Between them,
-- `2026-02-31` yields null and `today` is never reached — and `today` matters, because the
-- whole point of `imported_watches.watched_on` is that it is a date the person recorded
-- rather than one the import invented from its own clock.
create or replace function _safe_date(p_text text)
returns date
language plpgsql
stable
strict
set search_path = public
as $$
begin
  return p_text::date;
exception when others then
  return null;
end;
$$;

comment on function _safe_date(text) is
  'A date, or null, for text that has already been shape-checked as ISO — including text that is the right shape and still not a date, like 2026-02-31. Exists because the staging boundary must never raise on a client value: one unreadable date used to reject a whole page of a thousand rows. STABLE rather than IMMUTABLE because date_in is stable: it reads DateStyle, and accepts "today". Callers keep the ISO regex in front of it precisely so neither of those is ever reached.';


create or replace function import_create()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform assert_can_write();

  -- A live job is reused rather than refused. The client that lost its connection
  -- mid-stage should be able to carry on, and `import_rows_once` makes re-posting the
  -- pages it already sent free.
  --
  -- **But only for an hour.** A client that crashed halfway through staging leaves its
  -- rows behind, and without this bound the person's *next* export — a different archive,
  -- weeks later — would stage onto the same job and import both as one. An abandoned
  -- `pending` job is discarded rather than adopted; a job the worker already has is left
  -- alone, because that one is making progress.
  select id into v_id
    from import_jobs
   where user_id = auth.uid()
     and completed_at is null
     and (status <> 'pending' or created_at > now() - interval '1 hour')
   order by created_at desc
   limit 1;

  if v_id is not null then return v_id; end if;

  -- Whatever is left is abandoned. Deleting it frees `import_jobs_one_live`, and its rows
  -- go with it: a half-staged archive is not evidence of anything.
  delete from import_jobs
   where user_id = auth.uid() and completed_at is null and status = 'pending';

  insert into import_jobs (user_id, status) values (auth.uid(), 'pending')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function import_create() is
  'Opens an import job for the caller, or returns the one already open. Never refuses: a second call is a client retrying, and import_rows_once makes re-staging idempotent.';

grant execute on function import_create() to authenticated;


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

  -- ---------------------------------------------------------------------------
  -- THIS IS THE ONLY VALIDATION BOUNDARY, SO IT VALIDATES EVERYTHING
  --
  -- Every value below is cast and range-checked *here*, where a bad one is one dropped
  -- row. An earlier version cast the scalars and passed `watches` through verbatim, and
  -- independent review showed what that costs: a single unparseable date or a rating of
  -- 4.3 raised inside the apply slice, rolled back the whole batch, and three ticks later
  -- dead-lettered a two-thousand-film import having written nothing. One malformed row
  -- must cost one row.
  --
  -- It is also what makes the projection comment true. `watches` is rebuilt element by
  -- element, so an arbitrary blob nested inside it is dropped exactly as a top-level one
  -- is, and `import_rows.raw` cannot become a channel for the files this import refuses
  -- to read.
  --
  -- `nullif(..., '')` before each cast, because `->>'x'` on an absent key and on an empty
  -- string both mean "not given" and only one of them survives a cast.
  -- ---------------------------------------------------------------------------
  insert into import_rows (job_id, kind, correlation, raw, status)
  select p_job_id,
         r->>'kind',
         -- **Bounded, because this is the third column of a unique btree index.** A btree
         -- tuple cannot exceed 2704 bytes, and `correlation` is the client's normalised
         -- `(Name, Year)` key — so one unquoted comma in one CSV line puts most of a row
         -- into the Name column and produces a multi-kilobyte key that raises 54000 and
         -- rejects the whole page of up to a thousand rows. `name` and `filmUri` were
         -- bounded for this reason and this one was missed.
         --
         -- Truncation can in principle collide two films onto one correlation, which
         -- `import_rows_once` then dedupes — the same outcome as a client sending the key
         -- twice, and a far better one than refusing the import.
         left(r->>'correlation', 200),
         -- Each value is shape-tested *before* it is cast, in a CASE, so a malformed one
         -- yields null rather than raising. A bad value costs that value; it does not cost
         -- the row, and it certainly does not cost the job.
         jsonb_strip_nulls(jsonb_build_object(
           'name',      left(r->>'name', 200),
           'year',      case when r->>'year' ~ '^\d{4}$'
                             and (r->>'year')::integer
                                 between 1870 and extract(year from current_date)::integer + 5
                        then (r->>'year')::integer end,
           'filmUri',   left(r->>'filmUri', 300),
           -- Both bounds. An upper one was missing, and `^[0-5](\.[05])?$` admits `5.5` —
           -- which passed staging and was then refused by `imported_titles`' CHECK at
           -- apply time, so the film was dropped and reported to the reader as a title we
           -- could not find, over a rating.
           'rating',    case when r->>'rating' ~ '^[0-5](\.[05])?$'
                             and (r->>'rating')::numeric between 0.5 and 5.0
                        then (r->>'rating')::numeric end,
           'bucket',    case when r->>'bucket' in ('loved', 'fine', 'not_for_me')
                        then r->>'bucket' end,
           -- The regex is the ISO contract and `_safe_date` is the totality. Dropping the
           -- regex and relying on the cast alone let `today` and `1/2/2024` through — the
           -- first fabricating a watch date from the import's own clock, the second meaning
           -- a different day depending on the session's DateStyle.
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
   -- The only three things that make a row unusable rather than merely incomplete. The
   -- `left(...)` matches the SELECT list, so the not-null test and the stored value agree.
   where left(r->>'correlation', 200) is not null
     and r->>'name' is not null
     and r->>'kind' in ('watched', 'watchlist')
  on conflict (job_id, kind, correlation) do nothing;

  get diagnostics v_staged = row_count;

  return jsonb_build_object('status', 'ok', 'staged', v_staged);
end;
$$;

comment on function import_stage(uuid, jsonb) is
  'Stages one page of normalised rows onto the caller''s own open job. Idempotent through import_rows_once, so a retried page after a dropped connection stages nothing twice. Projects the payload field by field: whatever else the client sends is discarded rather than stored, so this table cannot become a side channel for the files the import refuses to read.';

grant execute on function import_stage(uuid, jsonb) to authenticated;


create or replace function import_ready(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_rows  integer;
begin
  perform assert_can_write();

  select user_id into v_owner from import_jobs where id = p_job_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'no such import' using errcode = 'P0002';
  end if;

  select count(*) into v_rows from import_rows where job_id = p_job_id;

  update import_jobs
     set status = 'matching',
         counts = counts || jsonb_build_object('staged', v_rows)
   where id = p_job_id and status = 'pending';

  return jsonb_build_object('status', 'ok', 'staged', v_rows);
end;
$$;

comment on function import_ready(uuid) is
  'Hands a fully staged job to the worker. After this the client may close: everything else happens on a pg_cron tick. Idempotent -- a second call against a job already matching changes nothing.';

grant execute on function import_ready(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Matching, against the local catalogue
--
-- Identity discipline, which is the whole of this section:
--
--   T0  the FILM uri, through letterboxd_matches   exact, shared, free
--   T1  squashed title + year within one           heuristic, local, free
--   T1b squashed title, catalogue row undated      heuristic, local, free
--   ..  anything left goes to needs_provider, and the provider tier decides
--
-- A diary-entry URI can never enter `letterboxd_matches`. Diary URIs *are* staged — inside
-- `raw->'watches'`, where the per-viewing provenance needs them — so the guarantee is not
-- that they are absent. It is that both writers of that cache read `raw->>'filmUri'` and
-- nothing else, and `import_stage` builds `filmUri` from the client's `filmUri` field
-- alone, never from a `watches` element. The cache is global and unattributed, so one
-- account's bad row would otherwise be every later importer's bad row.
--
-- **Ambiguity is left unresolved rather than guessed.** Two catalogue rows with the same
-- squashed title and a year within one of each other is a remake, and picking the popular
-- one would put a film somebody did not watch into their collection with a rating they
-- gave to a different film.
-- ---------------------------------------------------------------------------

create or replace function _import_match_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done integer := 0;
begin
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
           -- T0. An exact, previously confirmed film.
           (select m.media_item_id from letterboxd_matches m where m.letterboxd_uri = d.uri) as t0,
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
  )
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
   where r.id = x.id;

  get diagnostics v_done = row_count;

  -- ---------------------------------------------------------------------------
  -- ONLY A MATCH THE YEARS AGREED ON TEACHES THE SHARED CACHE
  --
  -- `letterboxd_matches` is global, unattributed, permanent and has no eviction path, so a
  -- wrong row in it is every later importer's wrong row, for ever. It therefore takes
  -- evidence from the strong tier only: a unique squashed title **and** a release year
  -- within one of the export's.
  --
  -- T1b — a unique squashed title against a catalogue row with no `release_date` — is
  -- deliberately excluded. The catalogue is a cache of whatever anybody has searched for,
  -- so undated stubs are ordinary; a stub for one *Nosferatu* would otherwise capture the
  -- URI of another and hand it to everybody. It is good enough to place a film in the
  -- collection of the person who told us its name and year, and not good enough to assert
  -- across accounts.
  --
  -- The provider tier is held to the same bar by `match.mjs`'s `isConfident`, which is why
  -- `_import_provider_resolve` may write here without a second check.
  -- ---------------------------------------------------------------------------
  insert into letterboxd_matches (letterboxd_uri, media_item_id)
  select distinct r.raw->>'filmUri', r.media_item_id
    from import_rows r
    join media_items mi on mi.id = r.media_item_id
   where r.job_id = p_job_id
     and r.status = 'matched'
     and r.media_item_id is not null
     and r.raw->>'filmUri' is not null
     and (r.raw->>'year') is not null
     and mi.release_date is not null
     and abs(extract(year from mi.release_date)::integer - (r.raw->>'year')::integer) <= 1
  on conflict (letterboxd_uri) do nothing;

  return v_done;
end;
$$;

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the shared film-URI cache first, then exactly-one squashed title with a year within one. Two or more survivors is ambiguous and stays unresolved -- a remake picked by popularity is a film the person did not watch, carrying a rating they gave to a different one. Anything unresolved becomes needs_provider rather than unmatched, so an unconfigured project does not permanently condemn titles a provider would have found. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Applying
--
-- Three rules, and all three are the contract made mechanical:
--
--   **Watched before watchlist.** Every watch signal fires `_leave_watchlist`, so the other
--   order has the database delete rows the import just wrote.
--
--   **Native wins.** A ranked title is not touched at all; an `in_app` row has its nulls
--   filled and nothing else. The ratchet in 20260917000200 is the backstop -- even if this
--   function were wrong, `source` cannot go back.
--
--   **Silence.** The whole slice runs under `bingd.import_running`, so the award and goal
--   triggers skip their per-row work and the gate cancels any feed event or notification
--   that something else tries to write.
-- ---------------------------------------------------------------------------

create or replace function _import_apply_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid;
  v_done  integer := 0;
  v_row   record;
  v_ranked boolean;
  v_source content_source;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return 0; end if;

  -- The whole slice is an import. Transaction-local, and the marker is the transaction id
  -- so a value that escapes is inert (20260917000100).
  perform set_config('bingd.import_running', txid_current()::text, true);

  -- `import_rows.media_item_id` is `on delete set null`, so a catalogue row deleted between
  -- matching and applying leaves a row that is `matched` and points at nothing. The loop
  -- below cannot select it, so without this it would sit there for ever holding the job
  -- open. It is honestly unplaceable now: the title it was matched to is gone.
  update import_rows
     set status = 'unmatched'
   where job_id = p_job_id and status = 'matched' and media_item_id is null;

  for v_row in
    select id, kind, correlation, media_item_id, raw
      from import_rows
     where job_id = p_job_id
       and status = 'matched'
       and media_item_id is not null
     -- Watched first, and ordered by an explicit `case` rather than by `kind` — which
     -- would happen to work, since 'watched' sorts before 'watchlist', and would be a
     -- correctness guarantee resting on a collation nobody chose for this purpose.
     order by case when kind = 'watched' then 0 else 1 end, id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  loop
    -- ---------------------------------------------------------------------------
    -- ONE ROW'S FAILURE COSTS ONE ROW
    --
    -- A subtransaction per row. Without it any error raised below — a cast, a constraint,
    -- a foreign key to a title deleted since matching — rolls back the entire slice, and
    -- the next tick meets the same row and rolls back again until the job dead-letters
    -- having written nothing. Independent review reproduced exactly that.
    --
    -- The cost is a subtransaction per applied row, which is what `begin ... exception`
    -- means in plpgsql. At a couple of hundred rows a slice that is not a concern, and it
    -- is the difference between one lost film and a lost library.
    -- ---------------------------------------------------------------------------
    begin
    -- Serialise against a ranking or a log on the same title, exactly as every other
    -- collection writer does.
    perform _lock_media(v_user, v_row.media_item_id);

    select exists (select 1 from rankings
                    where user_id = v_user and media_item_id = v_row.media_item_id)
      into v_ranked;

    select source into v_source
      from user_media
     where user_id = v_user and media_item_id = v_row.media_item_id;

    if v_row.kind = 'watched' then
      if v_ranked then
        -- Ranked here. The strongest native state there is: not the bucket, not the date,
        -- nothing. Recorded as applied so the job's counts can say how many were kept.
        null;

      elsif v_source = 'in_app' then
        -- ---------------------------------------------------------------------------
        -- Logged here. Fill the bucket if it is empty, and **leave `watched_on` alone.**
        --
        -- Filling a null date looks like the same "fill only what is empty" rule the
        -- bucket gets, and it is not, because an empty `watched_on` is load-bearing:
        -- `_leaderboard_counts` attributes a monthly row to
        -- `coalesce(watched_on, created_at)`, so writing a 2019 date onto a film somebody
        -- logged here last week silently removes it from this month's board.
        --
        -- The locked contract says an import never counts toward the monthly leaderboard.
        -- An import that *decrements* a native row's standing is the mirror of that and
        -- was not sanctioned either, so the conservative reading wins: the import does not
        -- touch the watched state of a row somebody built here.
        --
        -- The Letterboxd dates are still recorded, as provenance, in `imported_watches`
        -- below — where a future history model can find them and where no leaderboard
        -- reads them. That covers every viewing the diary knew about, which is where the
        -- real client gets `watchedOn` from; a payload carrying a bare `watchedOn` and no
        -- `watches` entry would have nowhere to put it, and no client this codebase ships
        -- produces one.
        -- ---------------------------------------------------------------------------
        update user_media
           set bucket = coalesce(bucket, (v_row.raw->>'bucket')::taste_bucket)
         where user_id = v_user and media_item_id = v_row.media_item_id;

      else
        -- Absent, or previously imported. Either way the import owns it.
        insert into user_media (user_id, media_item_id, bucket, watched_on, source)
        values (v_user, v_row.media_item_id,
                (v_row.raw->>'bucket')::taste_bucket,
                (v_row.raw->>'watchedOn')::date,
                'imported')
        on conflict (user_id, media_item_id) do update
          set bucket     = coalesce(excluded.bucket, user_media.bucket),
              watched_on = coalesce(user_media.watched_on, excluded.watched_on);
      end if;

      -- Provenance, for every watched row the import knows about -- including one it left
      -- alone, because the fact that Letterboxd rated it is still true and the title page
      -- may say so. Skipped when no collection row exists, which cannot happen above but
      -- is cheap to be sure of.
      if exists (select 1 from user_media
                  where user_id = v_user and media_item_id = v_row.media_item_id) then
        insert into imported_titles (
          user_id, media_item_id, letterboxd_uri, source_name, source_year, rating
        )
        values (v_user, v_row.media_item_id, v_row.raw->>'filmUri',
                coalesce(v_row.raw->>'name', '?'), (v_row.raw->>'year')::integer,
                (v_row.raw->>'rating')::numeric)
        on conflict (user_id, media_item_id) do update
          set letterboxd_uri   = coalesce(excluded.letterboxd_uri, imported_titles.letterboxd_uri),
              source_name      = excluded.source_name,
              source_year      = excluded.source_year,
              rating           = coalesce(excluded.rating, imported_titles.rating),
              last_imported_at = now();

        -- Per-viewing provenance. `on conflict do nothing` on (user_id, diary_uri) is what
        -- makes a second import of the same diary free.
        insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch)
        select v_user, v_row.media_item_id,
               w->>'diaryUri', (w->>'watchedOn')::date,
               coalesce((w->>'isRewatch')::boolean, false)
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
        on conflict (user_id, diary_uri) do nothing;
      end if;

    else
      -- A watchlist row. Only if the title is not already in the collection -- watched
      -- beats wanting to watch, and the watched half of this job has already run.
      --
      -- Written DIRECTLY rather than through `set_watchlist`, which writes a
      -- `watchlist_added` feed event per call. The gate would cancel those anyway; not
      -- producing them is better than producing and discarding thousands.
      if not exists (select 1 from user_media
                      where user_id = v_user and media_item_id = v_row.media_item_id) then
        insert into watchlist (user_id, media_item_id)
        values (v_user, v_row.media_item_id)
        on conflict (user_id, media_item_id) do nothing;
      end if;
    end if;

      update import_rows set status = 'applied' where id = v_row.id;

    exception
      -- A deadlock or a serialisation failure is the scheduler's problem, not the row's.
      -- Marking it terminal would silently lose a film to a race it should simply have
      -- retried, so class 40 goes back up and the slice is retried whole.
      when deadlock_detected or serialization_failure or lock_not_available then
        raise;

      when others then
        -- Poison: a constraint, a cast, a title deleted since matching. Marked so the
        -- slice makes progress and the next tick does not meet it again, and counted as
        -- unmatched — from the reader's side a row that could not be written is a film
        -- that did not arrive, which is the same sentence.
        update import_rows set status = 'unmatched', candidates = null where id = v_row.id;
    end;

    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

comment on function _import_apply_batch(uuid, integer) is
  'One bounded slice of apply, under the import marker so nothing announces. Watched rows before watchlist rows, because every watch signal fires _leave_watchlist. Never touches a ranked title, fills only an absent bucket on a natively logged one and never its watched state, and writes the watchlist directly rather than through set_watchlist so no watchlist_added events are produced. Writes no rankings and no scores: this function has no statement that could. Internal.';

revoke execute on function _import_apply_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Settling, and cleaning up
--
-- The award ledger is evaluated once, here, with the marker still set -- so the tiers an
-- imported history genuinely crosses are recorded and nobody is told in a burst. The
-- thirteen collection tracks only: `queue-dragon` was never skipped, because
-- `_award_touch_watchlist` is deliberately unguarded (20260917000100).
--
-- Then the staging rows go. `applied` and `duplicate` are deleted outright; `ambiguous` and
-- `unmatched` are kept, because they are the only record of what could not be placed and
-- the repair surface reads them. Nothing here retains CSV.
-- ---------------------------------------------------------------------------

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

  -- Every number is about THIS job. An earlier version counted `user_media where source =
  -- 'imported'` and `imported_watches` for the whole account, so a second import reported
  -- the cumulative total as its own result and any title a native action had since claimed
  -- silently dropped out. The summary screen reads these.
  --
  -- `stragglers` should always be zero, because the settle gate refuses to call this while
  -- any row is still `pending` or usefully `matched`. It is reported anyway, as the one
  -- number that would change if that gate were ever weakened — an assertion carried in the
  -- data rather than only in a test. It is not a safety net; it is a canary.
  --
  -- (The first version of this comment called it "the only place a row left behind would
  -- show up", which was true of the code it was written for and stopped being true when
  -- the gate was tightened.)
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

  -- The retention rule. A staging table is not a warehouse: what has landed is deleted,
  -- and only what is still unresolved survives, for the repair surface to read.
  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate');

  update import_jobs
     set status = 'done',
         completed_at = now(),
         claimed_at = null,
         counts = counts || v_counts
   where id = p_job_id;

  return v_counts;
end;
$$;

comment on function _import_settle(uuid) is
  'Ends a job: evaluates the thirteen collection award tracks once, silently, under the marker; writes the counts the summary screen reads; deletes every applied and duplicate staging row; and leaves only the unresolved ones behind for the repair surface. Internal.';

revoke execute on function _import_settle(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5b. The provider tier's two ends
--
-- The Edge Function holds the provider key and does the lookup; these two functions are
-- everything about it that can be reasoned about in SQL, which is the claim and the
-- accounting. Split that way so the backoff, the attempt ceiling and the terminal states
-- are testable without a provider, and the function is thin enough to read.
--
-- **Three attempts, then the row is honestly unmatched.** A title the provider cannot
-- place is not a failure of the job: an import of two thousand films with one obscure
-- short in it must finish, and say it placed 1,999.
-- ---------------------------------------------------------------------------

create or replace function _import_provider_claim(p_limit integer default 50)
returns table (row_id uuid, name text, year integer)
language sql
security definer
set search_path = public
as $$
  with due as (
    select r.id
      from import_rows r
      join import_jobs j on j.id = r.job_id
     where r.status = 'needs_provider'
       and r.provider_attempts < 3
       and j.completed_at is null
     order by r.id
     limit greatest(coalesce(p_limit, 50), 1)
     for update skip locked
  )
  update import_rows r
     set provider_attempts = r.provider_attempts + 1
    from due
   where r.id = due.id
  returning r.id, r.raw->>'name', (r.raw->>'year')::integer;
$$;

comment on function _import_provider_claim(integer) is
  'Hands the provider worker a bounded batch of titles the local catalogue could not place, incrementing each row''s own attempt counter as it goes. Rows past three attempts are not returned, so one unplaceable title cannot be asked about for ever. for update skip locked, so two workers take different rows. service_role only.';

revoke execute on function _import_provider_claim(integer) from public, anon, authenticated;


create or replace function _import_provider_resolve(p_row_id uuid, p_media_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uri  text;
  v_year integer;
begin
  if p_media_item_id is not null then
    update import_rows
       set media_item_id = p_media_item_id, status = 'matched', candidates = null
     where id = p_row_id
    returning raw->>'filmUri', (raw->>'year')::integer into v_uri, v_year;

    -- ---------------------------------------------------------------------------
    -- The same bar the local writer has, applied here rather than assumed.
    --
    -- Only a FILM uri can reach this: it reads `raw->>'filmUri'`, which `import_stage`
    -- builds from the client's `filmUri` field alone and never from a `watches` element.
    --
    -- And only a match the years agreed on. An earlier version left this to
    -- `match.mjs`'s `isConfident`, on the reasoning that it holds the provider to the
    -- local strong tier's bar — which is false: `isConfident` accepts on the squashed
    -- title alone when the export had no year, or when the provider's own result has no
    -- release date. That is exactly the weak evidence class the local writer was changed
    -- to exclude, so leaving it open here left the cross-account poisoning reachable by
    -- the other road.
    -- ---------------------------------------------------------------------------
    if v_uri is not null and v_year is not null then
      insert into letterboxd_matches (letterboxd_uri, media_item_id)
      select v_uri, p_media_item_id
        from media_items mi
       where mi.id = p_media_item_id
         and mi.release_date is not null
         and abs(extract(year from mi.release_date)::integer - v_year) <= 1
      on conflict (letterboxd_uri) do nothing;
    end if;

  else
    -- Not found this time. Terminal only once the attempts are spent, so a transient
    -- provider failure is retried and a genuinely unknown film eventually settles.
    update import_rows
       set status = case when provider_attempts >= 3 then 'unmatched' else 'needs_provider' end
     where id = p_row_id;
  end if;
end;
$$;

comment on function _import_provider_resolve(uuid, uuid) is
  'Records what the provider worker found for one row, or that it found nothing. A null media item leaves the row retryable until its third attempt and then settles it as unmatched -- a transient provider failure and an unknown film must not look the same. A resolved row teaches letterboxd_matches, film URIs only. service_role only.';

revoke execute on function _import_provider_resolve(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. The tick
--
-- `_drain_push_outbox`'s shape, with one deliberate difference.
--
-- Taken from it: the idle short-circuit, so an empty queue costs nothing and a project
-- with no imports never invokes anything; the claim with `for update skip locked` and a
-- five-minute lease; and the dead letter.
--
-- **Not** taken from it: the raise when the project is unconfigured. The push drain raises
-- because an unconfigured project cannot send push at all and pg_cron records a failure
-- only on an exception. Here an unconfigured project is not broken — the local matcher
-- places most titles without any provider, and the rest end honestly unmatched — so this
-- asks for the provider tier and carries on without it.
-- ---------------------------------------------------------------------------

-- Whether this project has a provider tier at all: an Edge Function base URL and a service
-- key to call it with, exactly what `_drain_push_outbox` requires. A project with neither
-- still imports — it places fewer titles — so this is a question rather than a demand, and
-- it is what stops a job waiting on a worker that does not exist.
create or replace function _import_provider_configured()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  select value #>> '{}' into v_url from app_config where key = 'functions.base_url';
  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';
  exception when others then
    v_key := null;
  end;
  return nullif(v_url, '') is not null and nullif(v_key, '') is not null;
end;
$$;

comment on function _import_provider_configured() is
  'Whether an Edge Function base URL and a service key both exist, which is what the provider tier needs. Read once per tick, because a job may only wait on the provider if there is one -- otherwise an unconfigured project would leave every import with an unplaceable title in it open for ever. Internal.';

revoke execute on function _import_provider_configured() from public, anon, authenticated;


insert into app_config (key, value) values ('import.provider_grace_minutes', '30'::jsonb)
  on conflict (key) do nothing;


create or replace function _drain_import_jobs(p_jobs integer default 3, p_slice integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due      integer;
  v_job      record;
  v_worked   integer := 0;
  v_slice    integer := 0;
  v_posted   integer := 0;
  v_url      text;
  v_key      text;
  v_provider boolean;
  v_waiting  boolean := false;
  v_grace    integer;
begin
  select count(*) into v_due
    from import_jobs
   where completed_at is null and status in ('matching', 'applying');

  if v_due = 0 then
    return jsonb_build_object('status', 'idle', 'due', 0);
  end if;

  -- Resolved once per tick, because every job's settle decision needs it: a job may only
  -- wait on the provider tier if there is a provider tier to wait for.
  v_provider := _import_provider_configured();
  -- Shape-tested before the cast. An operator typo in one `app_config` row must not raise
  -- here, where the raise is outside every handler and would stop every import for every
  -- account, once a minute, for ever.
  -- Shape-tested, then clamped between one minute and a day.
  --
  -- The ceiling matters because `v_waiting` resets the attempt counters: a grace longer
  -- than the 24-hour wall clock would make a job with a silent provider resettable for
  -- ever and leave nothing but that clock to end it. The floor matters because a grace of
  -- zero settles the job on the first apply tick with the provider never asked, which is
  -- the premature settle this gate exists to prevent.
  v_grace := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,5}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.provider_grace_minutes'),
    30), 1), 1440);

  -- ---------------------------------------------------------------------------
  -- Dead letter first. Three counters, and each one bounds a different failure.
  --
  --   failures >= 3   three *consecutive* unproductive slices that raised
  --   attempts >= 6   six consecutive claims that moved nothing
  --   age > 24h       everything else
  --
  -- The first two are reset by any slice that moves a row, which is what stops them
  -- dead-lettering a long import partway through — and is also why the third exists.
  -- Without a wall clock, a job that alternates one good slice with one bad one resets
  -- both counters for ever and never finishes and never dies, holding the account's
  -- `import_jobs_one_live` slot the whole time.
  -- ---------------------------------------------------------------------------
  -- **A job that only ever waited gets its summary, not a failure.** An exhausted job whose
  -- rows have all landed has nothing left to do but report; failing it would throw away
  -- counts the reader is owed and leave a half-written collection with no explanation.
  -- Settle those first; the dead letter below then catches only jobs with real work
  -- outstanding.
  for v_job in
    select j.id from import_jobs j
     where j.completed_at is null
       and (j.failures >= 3 or j.attempts >= 6 or j.created_at < now() - interval '24 hours')
       and not exists (
         select 1 from import_rows r
          where r.job_id = j.id
            and (r.status = 'pending'
                 or (r.status = 'matched' and r.media_item_id is not null)))
  loop
    begin
      perform _import_settle(v_job.id);
    exception when others then
      null;  -- it will be failed below, which is the honest outcome for a job that cannot
             -- even summarise itself.
    end;
  end loop;

  update import_jobs
     set status = 'failed', completed_at = now(), claimed_at = null,
         last_error = coalesce(last_error, 'exhausted')
   where completed_at is null
     and (failures >= 3 or attempts >= 6 or created_at < now() - interval '24 hours');

  for v_job in
    with due as (
      select id from import_jobs
       where completed_at is null
         and status in ('matching', 'applying')
         and failures < 3 and attempts < 6
         and (claimed_at is null or claimed_at < now() - interval '5 minutes')
       order by created_at
       limit greatest(coalesce(p_jobs, 3), 1)
       for update skip locked
    )
    update import_jobs j
       set claimed_at = now(), attempts = j.attempts + 1
      from due
     where j.id = due.id
    returning j.id, j.status, j.created_at
  loop
    begin
      -- Both are per-job. Declared once and reset here, because a loop variable that keeps
      -- the previous job's answer is how one job's provider wait becomes another job's.
      v_slice := 0;
      v_waiting := false;

      if v_job.status = 'matching' then
        v_slice := _import_match_batch(v_job.id, p_slice);

        -- **The phase advances on what is left, not on what the slice returned.** Both
        -- slice functions use `for update skip locked`, so a zero can mean "nothing left"
        -- or "another worker holds the rest" — and reading the second as the first strands
        -- rows in a phase nothing will revisit.
        if not exists (select 1 from import_rows
                        where job_id = v_job.id and status = 'pending') then
          update import_jobs set status = 'applying' where id = v_job.id;
        end if;

      else
        v_slice := _import_apply_batch(v_job.id, p_slice);

        -- **Waiting on the provider is a wait, not a stall.**
        --
        -- Without this distinction the attempt ceiling always beat the grace period: six
        -- unproductive claims is about six minutes, the grace is thirty, so a job whose
        -- Edge Function was undeployed or rate-limited dead-lettered at eight minutes with
        -- half the archive written, `provider_attempts` still at zero, and no counts at
        -- all. That is strictly worse than settling the row as honestly unmatched.
        v_waiting := v_provider
                 and v_job.created_at >= now() - (v_grace || ' minutes')::interval
                 and exists (select 1 from import_rows
                              where job_id = v_job.id
                                and status = 'needs_provider'
                                and provider_attempts < 3);

        if not exists (select 1 from import_rows
                        where job_id = v_job.id
                          and (status = 'pending'
                               or (status = 'matched' and media_item_id is not null)))
           and not v_waiting
        then
          perform _import_settle(v_job.id);
        end if;
      end if;

      v_worked := v_worked + 1;

      -- ---------------------------------------------------------------------------
      -- A PRODUCTIVE SLICE CLEARS BOTH COUNTERS, AND THAT IS THE WHOLE FIX
      --
      -- `attempts` is incremented on every claim, and a claim here is one *slice* of a
      -- long job rather than one unit of work as it is in `push_outbox`. A clean import
      -- needs roughly `2 * ceil(rows / slice) + 2` claims, so an unreset ceiling of six
      -- dead-letters any library over about four hundred films — partway through apply,
      -- with an arbitrary prefix of the collection already written.
      --
      -- Independent review reproduced it at thirty rows. The suite missed it because its
      -- fixtures all finished in four ticks.
      --
      -- So the counters bound **unproductive** claims. A slice that moved rows is progress
      -- and resets both; a slice that moved nothing leaves them standing, which is what
      -- still stops a job that genuinely cannot advance.
      -- ---------------------------------------------------------------------------
      -- `v_waiting` counts as progress for the same reason: the job is not stalled, it is
      -- deliberately holding for a worker that has a ladder of its own
      -- (`provider_attempts`) and a grace period that ends it.
      if v_slice > 0 or v_waiting then
        update import_jobs
           set claimed_at = null, attempts = 0, failures = 0
         where id = v_job.id and completed_at is null;
      else
        update import_jobs
           set claimed_at = null
         where id = v_job.id and completed_at is null;
      end if;

    exception when others then
      -- One job's failure is not the tick's. Record it and carry on: the lease expiry and
      -- the counters are what eventually stop a job that cannot progress.
      update import_jobs
         set failures = failures + 1, claimed_at = null,
             last_error = left(sqlerrm, 300)
       where id = v_job.id;
    end;
  end loop;

  -- The provider tier, and only if there is anything for it. Same configuration and the
  -- same raise-when-unconfigured rule as the push drain -- except that here an unconfigured
  -- project is not broken, so this asks rather than insists.
  select count(*) into v_posted
    from import_rows r join import_jobs j on j.id = r.job_id
   where r.status = 'needs_provider'
     and r.provider_attempts < 3
     and j.completed_at is null;

  if v_posted > 0 and v_provider then
    select value #>> '{}' into v_url from app_config where key = 'functions.base_url';
    begin
      select decrypted_secret into v_key
        from vault.decrypted_secrets where name = 'service_role_key';
    exception when others then
      v_key := null;
    end;

    -- ---------------------------------------------------------------------------
    -- GUARDED, BECAUSE THE PROVIDER TIER IS BEST-EFFORT AND THE TICK'S WORK IS NOT
    --
    -- This call sits after everything else the tick did — the row writes, the claim
    -- release, the counters, the dead letter. Unguarded, a missing `net` schema or a
    -- changed `http_post` signature raises here and **rolls all of that back**, every
    -- minute, for ever: `attempts` and `failures` never persist, so the dead letter can
    -- never fire, and `import_jobs_one_live` locks the account out of importing again with
    -- nothing but `cron.job_run_details` to say why.
    --
    -- pg_net being absent or different is not hypothetical — `20260826000700` exists
    -- because this project has already shipped a drain that recorded 1,221 silent
    -- successes over a pipeline that had never sent anything.
    -- ---------------------------------------------------------------------------
    if nullif(v_url, '') is not null and nullif(v_key, '') is not null
       and to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is not null
    then
      begin
        perform net.http_post(
          url     := v_url || '/letterboxd-import',
          headers := jsonb_build_object(
                       'Content-Type',  'application/json',
                       'Authorization', 'Bearer ' || v_key,
                       'apikey',        v_key
                     ),
          body    := jsonb_build_object('action', 'resolve'),
          timeout_milliseconds := 20000
        );
      exception when others then
        -- The nudge failed. The next tick will try again, and every job remains bounded by
        -- its own counters and by the wall clock — which is only true because this cannot
        -- take the transaction down with it.
        null;
      end;
    end if;
  end if;

  return jsonb_build_object('status', 'worked', 'due', v_due,
                            'jobs', v_worked, 'awaiting_provider', v_posted);
end;
$$;

comment on function _drain_import_jobs(integer, integer) is
  'One tick of the import worker: dead-letter what is exhausted, claim up to a few jobs under a five-minute lease, do one bounded slice of matching or applying, and settle a job whose rows have all landed. Errors are recorded against the job rather than raised, so one bad import cannot stop the queue. Posts to the Edge Function only when rows are waiting on the provider tier; a project with no provider still completes every job. service_role only.';

revoke execute on function _drain_import_jobs(integer, integer) from public, anon, authenticated;


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

  execute $q$ select cron.schedule('bingd-import-drain', $1, 'select public._drain_import_jobs()') $q$
    into v_jobid
    using p_schedule;

  return jsonb_build_object('status', 'ok', 'jobid', v_jobid, 'schedule', p_schedule);
end;
$$;

comment on function schedule_import_drain(text) is
  'Installs (or replaces) the pg_cron job that drains import_jobs. Idempotent by job name, for the reason schedule_push_drain is: two jobs with the same name is two workers a minute for ever. service_role only.';

revoke execute on function schedule_import_drain(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. What the client watches
-- ---------------------------------------------------------------------------

create or replace function import_status(p_job_id uuid)
returns table (status text, counts jsonb, created_at timestamptz, completed_at timestamptz)
language sql stable security invoker
set search_path = public
as $$
  select j.status, j.counts, j.created_at, j.completed_at
    from import_jobs j
   where j.id = p_job_id;
$$;

comment on function import_status(uuid) is
  'One job''s progress, for the screen that draws it. SECURITY INVOKER: import_jobs_own already restricts this to the owner, so RLS answers whose job it is and this does not have to. Deliberately omits last_error, which is operator detail rather than something a person can act on.';

grant execute on function import_status(uuid) to authenticated;
