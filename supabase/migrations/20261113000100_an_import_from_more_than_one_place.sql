-- An import from more than one place: IMDb ratings beside Letterboxd (founder spec 2026-11-10).
--
-- Design record: docs/product/imdb-import.md. The short version:
--
--   * import_jobs.provider says whose file a job is. Every client call that predates it is
--     a Letterboxd call: import_create() keeps working through a default.
--   * An IMDb row is matched by its identifier first: a catalogue title TMDB has already
--     confirmed carries that tt id (media_items.imdb_id), else the provider tier asks TMDB's
--     /find, else a conservative title search. Only the service role writes imdb_id, and
--     only from /find.
--   * IMDb's 1-10 lands on imported_titles.imdb_rating: provenance, never a score, never a
--     bucket. The Letterboxd star column keeps its own constraint, untouched.
--   * Canonical identity is media_items.id, so a film imported from Letterboxd and then IMDb
--     is one collection row with two providers on its provenance.
--   * A whole TV show is RECOGNISED (matched to the canonical series) and REPORTED, and not
--     added: bingd's collection holds movies and seasons, and "a series can never be
--     logged" (PRD §10) is founder canon this change does not get to reverse. The one
--     switch is _import_imdb_destination_supported(); see the design record's escalation.
--
-- Every function below that already existed is copied verbatim from the migration that
-- last defined it and changed only where a 20261113000100 comment says so (the generator
-- asserts each edit lands exactly once). claim_push_batch is #254's two-argument function
-- (20261101000100): this branch is built on #254, and the import's one change to it is
-- applied to that body rather than to main's one-argument one.
--
-- Version 20261113000100 sorts after every #254 migration (20261028000100 … 20261112000100).
-- It was 20261111000300 on #256, before it was rebuilt on #254.

-- ===========================================================================
-- 1. Schema, additive only
-- ===========================================================================

alter table import_jobs
  add column if not exists provider text not null default 'letterboxd';
alter table import_jobs
  add constraint import_jobs_known_provider check (provider in ('letterboxd', 'imdb'));
comment on column import_jobs.provider is
  'Whose export this job is. Decides which projection import_stage applies and which matcher and applier run. Every job before 20261113000100 is letterboxd, which is also the default an older client gets from import_create().';

alter table media_items add column if not exists imdb_id text;
alter table media_items
  add constraint media_items_imdb_id_shape
  check (imdb_id is null or (imdb_id ~ '^tt[0-9]{7,10}$' and kind in ('movie', 'series')));
create index if not exists media_items_imdb on media_items (imdb_id) where imdb_id is not null;
comment on column media_items.imdb_id is
  'The IMDb title id TMDB''s own /find returned THIS title for. Written only by _import_provider_resolve on a /find answer, never over an existing value and never onto a second title; a title search proves nothing about the id and never writes it. Deliberately not unique: TMDB can hold duplicates, and the matcher treats more than one title per id as ambiguous rather than letting a write fail.';

alter table imported_titles
  add column if not exists imdb_id     text,
  add column if not exists imdb_rating smallint,
  add column if not exists providers   text[] not null default '{letterboxd}';
alter table imported_titles
  add constraint imported_titles_imdb_id_shape
  check (imdb_id is null or imdb_id ~ '^tt[0-9]{7,10}$');
alter table imported_titles
  add constraint imported_titles_imdb_rating_is_out_of_ten
  check (imdb_rating is null or imdb_rating between 1 and 10);
alter table imported_titles
  add constraint imported_titles_known_providers
  check (cardinality(providers) >= 1 and providers <@ array['letterboxd', 'imdb']::text[]);
comment on column imported_titles.imdb_rating is
  'The person''s own IMDb rating, 1-10, as exported ("Your Rating"). PROVENANCE ONLY: never a bucket, a position or a score, and never converted to one (founder, 2026-11-10). Not the community "IMDb Rating", which is never sent.';
comment on column imported_titles.imdb_id is
  'The IMDb Const the person''s own export carried for this title.';
comment on column imported_titles.providers is
  'Which imports have contributed this row, in the order they first did. Rows before 20261113000100 are all letterboxd, which the default backfills.';

-- Two terminal states an IMDb file needs and a Letterboxd one never produces.
--   unsupported  bingd has no collection destination for it (an episode, a whole show)
--   failed       matched, and the write raised -- distinct from "we couldn't find it"
alter table import_rows drop constraint import_rows_known_status;
alter table import_rows add constraint import_rows_known_status
  check (status in ('pending', 'needs_provider', 'matched', 'ambiguous',
                    'unmatched', 'duplicate', 'applied', 'unsupported', 'failed'));

-- ===========================================================================
-- 2. What an IMDb type means here
-- ===========================================================================

create or replace function _import_imdb_title_type(p_raw text)
returns text
language sql
immutable
as $$
  -- IMDb has written both "TV Mini Series" and "tvMiniSeries" over the years; letters
  -- only, lower case, and anything not on the list is 'other'.
  select case
    when x in ('movie', 'tvmovie', 'video', 'short', 'tvshort', 'tvspecial',
               'tvseries', 'tvminiseries', 'tvepisode', 'videogame', 'musicvideo',
               'podcastseries', 'podcastepisode')
    then x else 'other' end
  from (select lower(regexp_replace(coalesce(p_raw, ''), '[^A-Za-z]', '', 'g')) as x) t;
$$;
comment on function _import_imdb_title_type(text) is
  'An IMDb Title Type, folded to letters only and lower case, or other. Mirrored by imdbTitleType in src/features/import/imdb.ts.';

create or replace function _import_imdb_kind(p_title_type text)
returns media_kind
language sql
immutable
as $$
  select case p_title_type
    when 'movie'        then 'movie'::media_kind
    when 'tvmovie'      then 'movie'::media_kind
    when 'video'        then 'movie'::media_kind
    when 'short'        then 'movie'::media_kind
    when 'tvshort'      then 'movie'::media_kind
    when 'tvspecial'    then 'movie'::media_kind
    when 'tvseries'     then 'series'::media_kind
    when 'tvminiseries' then 'series'::media_kind
  end;
$$;
comment on function _import_imdb_kind(text) is
  'The canonical kind an IMDb type may resolve to, or null when bingd has none (episodes, games, music videos, podcasts, anything unknown). Matching EVIDENCE: a title TMDB files as something else is a conflict and stays unmatched, never a reclassification. TMDB files TV movies, videos, shorts and most specials as movies. Mirrored by imdbKind in src/features/import/imdb.ts.';

create or replace function _import_imdb_destination_supported(p_kind media_kind)
returns boolean
language sql
immutable
as $$
  select p_kind = 'movie';
$$;
comment on function _import_imdb_destination_supported(media_kind) is
  'Whether a matched IMDb title may enter the collection. A movie may. A whole series may not: bingd collects TV by season (PRD §10, "a series can never be logged"), and the founder spec forbids moving a show''s history onto a season. A matched series is therefore recorded as unsupported with its media item kept for the count, and reported. THE single switch if the founder decides otherwise -- see docs/product/imdb-import.md, "Escalation".';

create or replace function _import_imdb_identity_agrees(
  p_media_item_id uuid,
  p_name          text,
  p_original      text,
  p_year          integer
)
returns boolean
language sql
stable
set search_path = public
as $$
  -- The title (or original title) of the media item must equal the row's title (or
  -- original title) after media_squash, and the years must agree within one when both
  -- are known. Popularity and order are never consulted.
  select exists (
    select 1
      from media_items mi
     where mi.id = p_media_item_id
       and (p_year is null or mi.release_date is null
            or abs(extract(year from mi.release_date)::integer - p_year) <= 1)
       and array_remove(array[nullif(media_squash(mi.title), ''),
                              nullif(media_squash(mi.original_title), '')], null)
           && array_remove(array[nullif(media_squash(p_name), ''),
                                 nullif(media_squash(p_original), '')], null)
  );
$$;
comment on function _import_imdb_identity_agrees(uuid, text, text, integer) is
  'Whether a media item is plausibly the title an IMDb row names: a squashed title or original title in common, and release years within one where both are known. The validation every IMDb tier applies to the title its identifier pointed at.';

revoke execute on function _import_imdb_title_type(text) from public, anon, authenticated;
revoke execute on function _import_imdb_kind(text) from public, anon, authenticated;
revoke execute on function _import_imdb_destination_supported(media_kind) from public, anon, authenticated;
revoke execute on function _import_imdb_identity_agrees(uuid, text, text, integer) from public, anon, authenticated;

-- ===========================================================================
-- 3. The client's surface: create, stage, status
-- ===========================================================================

drop function if exists import_create();

create function import_create(p_provider text default 'letterboxd')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_status   text;
  v_provider text;
begin
  perform assert_can_write();

  if p_provider is null or p_provider not in ('letterboxd', 'imdb') then
    raise exception 'unknown import provider' using errcode = '22023';
  end if;

  -- 20260917000300's rule, unchanged: one live job per account, and a running one is handed
  -- back rather than refused, so the client can say an import is already running.
  select id, status, provider into v_id, v_status, v_provider
    from import_jobs
   where user_id = auth.uid()
     and completed_at is null
     and (status <> 'pending' or created_at > now() - interval '1 hour')
   order by created_at desc
   limit 1;

  if v_id is not null and (v_status <> 'pending' or v_provider = p_provider) then
    return v_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- The one addition: a half-staged job from the OTHER provider is never handed back, because
  -- its rows would be read through the wrong projection. Two cases:
  --
  --   rows already staged   somebody may be sending that file right now, from another
  --                         device. Clearing it would break their upload, and their retry
  --                         would clear this one (independent review, 2026-11-11). Refused
  --                         with 22023, which the client already reads as "an import is
  --                         already running; this file wasn't sent".
  --   nothing staged        a job opened and never used: cleared, exactly as a stale one is.
  --
  -- Both are inside the existing one-hour window; an older pending job is stale either way.
  -- ---------------------------------------------------------------------------
  if v_id is not null
     and exists (select 1 from import_jobs where id = v_id and staged_rows > 0)
  then
    raise exception 'another import is being sent' using errcode = '22023';
  end if;

  delete from import_jobs
   where user_id = auth.uid() and completed_at is null and status = 'pending';

  insert into import_jobs (user_id, status, provider) values (auth.uid(), 'pending', p_provider)
  returning id into v_id;

  return v_id;
end;
$$;
comment on function import_create(text) is
  'Opens (or hands back) the caller''s one live import job for p_provider, letterboxd by default so a client that predates 20261113000100 is unchanged. A running job of either provider is handed back; a half-staged job of the other provider is cleared rather than reused.';
revoke execute on function import_create(text) from public, anon;
grant execute on function import_create(text) to authenticated;

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
  v_provider   text;
begin
  perform assert_can_write();

  -- **`for update`.** The ceiling is read into locals and checked against them, so two
  -- overlapping pages both saw a passing check and both inserted -- an overshoot of one
  -- page each. The row is already being selected; locking it costs nothing and makes the
  -- check mean what it says.
  select user_id, status, staged_rows, staged_bytes, provider
    into v_owner, v_status, v_rows_so_far, v_bytes_so_far, v_provider
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

  -- 20261113000100: which projection is the job's provider's. A row is read only through
  -- its own provider's field list, so a Letterboxd field sent to an IMDb job (or the
  -- reverse) is discarded exactly as an unknown field always was.
  if v_provider = 'imdb' then
    with incoming as (
      select p_job_id as job_id,
             'watched'::text as kind,
             -- The tt id IS the correlation. Set here rather than trusted from the client,
             -- so a re-posted page and a duplicated Const are one row by construction.
             r->>'imdbId' as correlation,
             jsonb_strip_nulls(jsonb_build_object(
               'name',          left(btrim(r->>'name'), 200),
               'originalTitle', nullif(left(btrim(r->>'originalTitle'), 200), ''),
               'year',          case when r->>'year' ~ '^\d{4}$'
                                     and (r->>'year')::integer
                                         between 1870 and extract(year from current_date)::integer + 5
                                then (r->>'year')::integer end,
               'imdbId',        r->>'imdbId',
               'titleType',     _import_imdb_title_type(r->>'titleType'),
               -- The person's own 1-10. Never a bucket, a position or a score: it is kept on
               -- imported_titles.imdb_rating as provenance and nothing reads it as an opinion.
               -- Kept for a movie only: a show is recognised and not added, and an episode
               -- is not matched, so neither has anywhere for a rating to live.
               'imdbRating',    case when r->>'imdbRating' ~ '^([1-9]|10)$'
                                     and _import_imdb_kind(_import_imdb_title_type(r->>'titleType')) = 'movie'
                                then (r->>'imdbRating')::integer end
             )) as raw
        from jsonb_array_elements(p_rows) r
       where jsonb_typeof(r) = 'object'
         and r->>'kind' = 'watched'
         and r->>'imdbId' ~ '^tt[0-9]{7,10}$'
         and nullif(btrim(r->>'name'), '') is not null
    ),
    ins as (
      insert into import_rows (job_id, kind, correlation, raw, status)
      select job_id, kind, correlation, raw, 'pending' from incoming
      on conflict (job_id, kind, correlation) do nothing
      returning raw
    )
    select count(*), coalesce(sum(octet_length(raw::text)), 0) into v_staged, v_added from ins;
  else
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
  end if;

  update import_jobs
     set staged_rows  = staged_rows + v_staged,
         staged_bytes = staged_bytes + v_added
   where id = p_job_id;

  return jsonb_build_object(
    'status', 'ok', 'staged', v_staged, 'bytes', v_bytes,
    'job_rows', v_rows_so_far + v_staged, 'job_bytes', v_bytes_so_far + v_added);
end;
$$;

drop function if exists import_status(uuid);

create function import_status(p_job_id uuid)
returns table (status text, counts jsonb, created_at timestamptz, completed_at timestamptz,
               provider text)
language sql stable security invoker
set search_path = public
as $$
  select j.status, j.counts, j.created_at, j.completed_at, j.provider
    from import_jobs j
   where j.id = p_job_id;
$$;
comment on function import_status(uuid) is
  'The caller''s own job, under RLS. provider since 20261113000100, as a trailing column so a client reading the first four by name is unchanged.';
grant execute on function import_status(uuid) to authenticated;

-- ===========================================================================
-- 4. Matching
-- ===========================================================================

create or replace function _import_match_batch_imdb(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  -- ---------------------------------------------------------------------------
  -- Tier 1, the only local tier an IMDb row has: a catalogue title TMDB already confirmed
  -- for this exact tt id. Its kind must be the one the IMDb type implies and its title and
  -- year must agree with the row's own. Anything else -- no title, two titles, a different
  -- kind -- is not settled here:
  --
  --   no IMDb type bingd can place    unsupported, and the provider is never asked
  --   no title carries the id         needs_provider (TMDB /find, then a title search)
  --   two titles carry it             ambiguous: conflicting ids are not broken by guessing
  --   a different kind, or disagree   unmatched: the id is TMDB-confirmed, so asking TMDB
  --                                   again would return the same title
  --   a whole series                  unsupported (_import_imdb_destination_supported)
  --
  -- There is deliberately no local title tier ahead of the provider. With an identifier on
  -- the row, a name-and-year guess from a cache that may not hold the right title is the
  -- weaker evidence, and spec §5 orders it last.
  -- ---------------------------------------------------------------------------
  with due as (
    select id,
           raw->>'imdbId' as tt,
           raw->>'name' as name,
           raw->>'originalTitle' as original,
           (raw->>'year')::integer as year,
           _import_imdb_kind(raw->>'titleType') as expected
      from import_rows
     where job_id = p_job_id and status = 'pending'
     order by id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  ),
  located as (
    select d.*, c.n, c.only_id, c.only_kind
      from due d
      cross join lateral (
        select count(*) as n,
               (array_agg(mi.id order by mi.id))[1] as only_id,
               (array_agg(mi.kind order by mi.id))[1] as only_kind
          from media_items mi
         where d.expected is not null
           and mi.imdb_id = d.tt
           and mi.kind in ('movie', 'series')
      ) c
  ),
  decided as (
    select l.id,
           case
             when l.expected is null or l.n <> 1 then null
             when l.only_kind <> l.expected then null
             when not _import_imdb_identity_agrees(l.only_id, l.name, l.original, l.year) then null
             else l.only_id
           end as media_item_id,
           case
             when l.expected is null then 'unsupported'
             when l.n = 0 then 'needs_provider'
             when l.n > 1 then 'ambiguous'
             when l.only_kind <> l.expected then 'unmatched'
             when not _import_imdb_identity_agrees(l.only_id, l.name, l.original, l.year)
               then 'unmatched'
             when not _import_imdb_destination_supported(l.only_kind) then 'unsupported'
             else 'matched'
           end as status
      from located l
  ),
  upd as (
    update import_rows r
       set media_item_id = y.media_item_id,
           status = y.status,
           candidates = null
      from decided y
     where r.id = y.id
    returning r.id
  )
  select count(*) into v_n from upd;

  return coalesce(v_n, 0);
end;
$$;
comment on function _import_match_batch_imdb(uuid, integer) is
  'One bounded slice of local matching for an IMDb job: the tt id against media_items.imdb_id, with the IMDb type''s kind and the row''s own title and year checked. Unsupported types settle here without a provider request. Never writes a mapping. Internal; reached only through _import_match_batch.';
revoke execute on function _import_match_batch_imdb(uuid, integer) from public, anon, authenticated;

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

  -- 20261113000100. An IMDb job is matched by its own rules (identifier first); nothing
  -- below this line ever sees one of its rows.
  if (select provider from import_jobs where id = p_job_id) = 'imdb' then
    return _import_match_batch_imdb(p_job_id, p_limit);
  end if;

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
           d.year,
           -- T0. A corroborated film **that this row independently names**, and that
           -- nothing else in the cache could be. See the header for why neither the count
           -- nor the URI is evidence, and for each of the three conditions.
           (select m.media_item_id
              from letterboxd_matches m
              join media_items mi on mi.id = m.media_item_id
             where m.letterboxd_uri = d.uri
               and d.year is not null
               and extract(year from mi.release_date)::integer = d.year
               and (
                 media_squash(mi.original_title) = media_squash(d.name)
                 or (
                   mi.sort_key_squashed = media_squash(d.name)
                   and coalesce(media_squash(mi.original_title), '') = ''
                 )
               )
               and not exists (
                 select 1
                   from media_items o
                  where o.kind = 'movie'
                    and o.id <> mi.id
                    and (
                      o.sort_key_squashed = media_squash(d.name)
                      or media_squash(o.original_title) = media_squash(d.name)
                    )
                    and (
                      o.release_date is null
                      or abs(extract(year from o.release_date)::integer - d.year) <= 1
                    )
               )
           ) as t0,
           c.local,
           c.exact_n,
           c.exact_id,
           c.exact_translated,
           c.exact_native_n,
           c.exact_native_id,
           c.exact_translated_n,
           c.native_elsewhere,
           c.undated_n
      from due d
      -- T1 / T1b. Every cached movie whose squashed title matches and whose year is within
      -- one -- or which has no release date at all -- and what the rule needs to know
      -- about them: which sit in exactly the export's year, and whose original title is
      -- the exported name.
      cross join lateral (
        select array_agg(k.id order by k.id) as local,
               count(*) filter (where k.exact) as exact_n,
               (array_agg(k.id order by k.id) filter (where k.exact))[1] as exact_id,
               coalesce(bool_or(k.native = false) filter (where k.exact), false) as exact_translated,
               -- 1b: how many exact-year films bear the name natively, and how many are known
               -- translations. An unknown original title is neither.
               count(*) filter (where k.exact and k.native = true) as exact_native_n,
               (array_agg(k.id order by k.id) filter (where k.exact and k.native = true))[1] as exact_native_id,
               count(*) filter (where k.exact and k.native = false) as exact_translated_n,
               coalesce(bool_or(k.native = true) filter (where not k.exact), false) as native_elsewhere,
               count(*) filter (where k.undated) as undated_n
          from (
            select mi.id,
                   (d.year is not null
                     and mi.release_date is not null
                     and extract(year from mi.release_date)::integer = d.year) as exact,
                   (mi.release_date is null) as undated,
                   -- null when the original title is unknown, which neither vetoes a film
                   -- nor counts against one.
                   case
                     when coalesce(media_squash(mi.original_title), '') = '' then null
                     else media_squash(mi.original_title) = media_squash(d.name)
                   end as native
              from media_items mi
             where mi.kind = 'movie'
               and mi.sort_key_squashed = media_squash(d.name)
               and (
                 d.year is null
                 or mi.release_date is null
                 or abs(extract(year from mi.release_date)::integer - d.year) <= 1
               )
          ) k
      ) c
  ),
  decided as (
    select x.id,
           case
             when x.t0 is not null then x.t0
             when x.year is null then
               case when coalesce(array_length(x.local, 1), 0) = 1 then x.local[1] end
             when x.exact_n > 1 and x.exact_native_n = 1 and x.exact_translated_n = x.exact_n - 1
               then x.exact_native_id
             when x.exact_n = 1 and not x.exact_translated then x.exact_id
             when x.exact_n = 0 and coalesce(array_length(x.local, 1), 0) = 1 and x.undated_n = 1
               then x.local[1]
           end as media_item_id,
           case
             when x.t0 is not null then 'matched'
             when x.year is null then
               case
                 when coalesce(array_length(x.local, 1), 0) = 1 then 'matched'
                 when coalesce(array_length(x.local, 1), 0) > 1 then 'ambiguous'
                 else 'needs_provider'
               end
             -- 1. A remake in the very year the export gave.
             -- 1b. Same-year namesakes, exactly one of which bears the name natively and the
             -- rest known translations.
             when x.exact_n > 1 and x.exact_native_n = 1 and x.exact_translated_n = x.exact_n - 1
               then 'matched'
             when x.exact_n > 1 then 'ambiguous'
             -- 1. The film in exactly that year, over any neighbour.
             when x.exact_n = 1 and not x.exact_translated then 'matched'
             -- 2. A translated title beside a cached film that bears the name natively.
             when x.exact_n = 1 and x.native_elsewhere then 'ambiguous'
             -- 2. A translated title whose neighbours the cache may not hold.
             when x.exact_n = 1 then 'needs_provider'
             -- 3. T1b: one undated film and nothing else.
             when coalesce(array_length(x.local, 1), 0) = 1 and x.undated_n = 1 then 'matched'
             -- 3. Nothing cached in that year: the provider can see what the cache cannot.
             else 'needs_provider'
           end as status,
           x.local
      from resolved x
  ),
  upd as (
    update import_rows r
       set media_item_id = y.media_item_id,
           status = y.status,
           candidates = case when y.status = 'ambiguous' then to_jsonb(y.local) else null end
      from decided y
     where r.id = y.id
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

drop function if exists _import_provider_claim(integer);

create function _import_provider_claim(p_limit integer default 50)
returns table (
  row_id uuid, name text, year integer,
  -- 20261113000100. Trailing, so an Edge Function that predates them reads exactly the
  -- three columns it always did. provider is the job's ('letterboxd' or 'imdb'); the
  -- other three are null on a Letterboxd row.
  provider text, imdb_id text, title_type text, original_title text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with ranked as (
    -- Round-robin across jobs: every job's first unasked title before any job's second, so
    -- one person's 2,500 films do not hold somebody else's twenty-four behind them.
    select r.id,
           row_number() over (partition by r.job_id order by r.provider_attempts, r.id) as turn
      from import_rows r
      join import_jobs j on j.id = r.job_id
     where r.status = 'needs_provider'
       and r.provider_attempts < 3
       and j.completed_at is null
       and (r.provider_claimed_at is null or r.provider_claimed_at < now() - interval '2 minutes')
  ),
  due as (
    -- The eligibility test is repeated on the locking scan itself. Under READ COMMITTED a
    -- row another invocation claimed between `ranked` and this lock is re-checked here
    -- against its new version and skipped; the `in` list alone would not be re-evaluated.
    select r.id
      from import_rows r
     where r.id in (select k.id from ranked k order by k.turn, k.id
                     limit greatest(coalesce(p_limit, 50), 1))
       and r.status = 'needs_provider'
       and r.provider_attempts < 3
       and (r.provider_claimed_at is null or r.provider_claimed_at < now() - interval '2 minutes')
       for update skip locked
  ),
  claimed as (
    update import_rows r
       set provider_attempts = r.provider_attempts + 1,
           provider_claimed_at = now()
      from due
     where r.id = due.id
    returning r.id, r.job_id, r.raw->>'name' as title, (r.raw->>'year')::integer as released,
              r.raw->>'imdbId' as tt, r.raw->>'titleType' as ttype,
              r.raw->>'originalTitle' as otitle
  ),
  touchable as (
    -- Skipped rather than waited for when a tick holds the job row: the tick is the job
    -- making progress, and the next claim touches it again.
    select j.id from import_jobs j
     where j.id in (select c.job_id from claimed c)
       for update skip locked
  ),
  touched as (
    update import_jobs j set provider_touched_at = now()
      from touchable t where j.id = t.id
    returning j.id
  )
  select c.id, c.title, c.released, jj.provider, c.tt, c.ttype, c.otitle
    from claimed c
    join import_jobs jj on jj.id = c.job_id;
end;
$$;
revoke execute on function _import_provider_claim(integer) from public, anon, authenticated;
grant execute on function _import_provider_claim(integer) to service_role;

drop function if exists _import_provider_resolve(uuid, uuid, boolean);

create function _import_provider_resolve(
  p_row_id uuid,
  p_media_item_id uuid,
  p_final boolean default false,
  p_imdb_id text default null,
  p_unsupported boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job     uuid;
  v_uri     text;
  v_year    integer;
  v_user    uuid;
  v_provider text;
  v_tt       text;
  v_name     text;
  v_original text;
  v_expected media_kind;
  v_kind     media_kind;
begin
  -- Only a row still waiting, of a job still running. An answer that arrives after its job
  -- settled has nothing to act on: the row was redacted and nothing will apply it, and
  -- writing `matched` onto it would only make a finished summary disagree with its rows.
  select r.job_id, r.raw->>'filmUri', (r.raw->>'year')::integer, j.user_id,
         j.provider, r.raw->>'imdbId', r.raw->>'name', r.raw->>'originalTitle',
         _import_imdb_kind(r.raw->>'titleType')
    into v_job, v_uri, v_year, v_user,
         v_provider, v_tt, v_name, v_original, v_expected
    from import_rows r
    join import_jobs j on j.id = r.job_id
   where r.id = p_row_id
     and r.status = 'needs_provider'
     and j.completed_at is null
     for update of r;

  if v_job is null then return; end if;

  -- ---------------------------------------------------------------------------
  -- 20261113000100. An IMDb row. The Edge Function's answer is checked again here rather
  -- than trusted: the destination type must be what the IMDb type implies (IMDb's type
  -- is matching evidence, never a reclassification), and the title and year must agree.
  -- A disagreement settles the row unmatched: asking again would get the same answer.
  --
  -- `p_imdb_id` is passed only when TMDB's own /find for that id named this title, and
  -- it is the one thing that writes media_items.imdb_id -- never over an existing value,
  -- never onto a second title, and never from a title search, which proves nothing about
  -- the id. That is what keeps the identifier mapping out of any client's reach: the
  -- client supplies an id, but which title it denotes is TMDB's answer.
  -- ---------------------------------------------------------------------------
  if v_provider = 'imdb' then
    if p_media_item_id is not null then
      select kind into v_kind from media_items where id = p_media_item_id;

      if v_kind is null or v_expected is null or v_kind <> v_expected
         or not _import_imdb_identity_agrees(p_media_item_id, v_name, v_original, v_year)
      then
        update import_rows
           set status = 'unmatched', provider_claimed_at = null
         where id = p_row_id;
        return;
      end if;

      if p_imdb_id is not null and p_imdb_id = v_tt then
        update media_items
           set imdb_id = p_imdb_id
         where id = p_media_item_id
           and imdb_id is null
           and not exists (select 1 from media_items o where o.imdb_id = p_imdb_id);
      end if;

      update import_rows
         set media_item_id = p_media_item_id,
             status = case when _import_imdb_destination_supported(v_kind)
                           then 'matched' else 'unsupported' end,
             candidates = null,
             provider_claimed_at = null
       where id = p_row_id;
    elsif p_unsupported then
      update import_rows
         set status = 'unsupported', provider_claimed_at = null
       where id = p_row_id;
    else
      update import_rows
         set status = case when p_final or provider_attempts >= 3 then 'unmatched' else 'needs_provider' end,
             provider_claimed_at = null
       where id = p_row_id;
    end if;
    return;
  end if;

  if p_media_item_id is not null then
    update import_rows
       set media_item_id = p_media_item_id, status = 'matched', candidates = null,
           provider_claimed_at = null
     where id = p_row_id;

    -- The provider's match is a claim, never an assertion: the same bar and the same
    -- promotion path as 20260917000900. A film only, dated, and agreeing on the year.
    if v_uri is not null and v_year is not null then
      perform _import_promote_match(v_uri, p_media_item_id, v_user, 'provider')
        from media_items mi
       where mi.id = p_media_item_id
         and mi.release_date is not null
         and abs(extract(year from mi.release_date)::integer - v_year) <= 1;
    end if;

  else
    -- `p_final`: the provider answered with no results at all. Asking again would send the
    -- same query and get the same answer. (A non-empty answer that was not confident keeps the
    -- retry ladder; independent review 83a.) Without it, the old ladder: retryable until the
    -- third attempt, which is what a caller that cannot tell the two apart still gets.
    update import_rows
       set status = case when p_final or provider_attempts >= 3 then 'unmatched' else 'needs_provider' end,
           provider_claimed_at = null
     where id = p_row_id;
  end if;
end;
$$;
revoke execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean) to service_role;

-- ===========================================================================
-- 5. Applying
-- ===========================================================================

create or replace function _import_apply_batch_imdb(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid;
  v_done   integer := 0;
  v_row    record;
  v_ranked boolean;
  v_source content_source;
  v_kind   media_kind;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return 0; end if;

  -- Silent, exactly as a Letterboxd slice is: no feed event, no notification, no award
  -- evaluated per title (20260917000100).
  perform set_config('bingd.import_running', txid_current()::text, true);

  update import_rows
     set status = 'unmatched'
   where job_id = p_job_id and status = 'matched' and media_item_id is null;

  for v_row in
    select id, media_item_id, raw
      from import_rows
     where job_id = p_job_id
       and status = 'matched'
       and media_item_id is not null
     order by id
     limit greatest(coalesce(p_limit, 200), 1)
     for update skip locked
  loop
    begin
      perform _lock_media(v_user, v_row.media_item_id);

      select kind into v_kind from media_items where id = v_row.media_item_id;

      if v_kind is null or not _import_imdb_destination_supported(v_kind) then
        -- Belt and braces: the matcher never marks such a row matched.
        update import_rows set status = 'unsupported' where id = v_row.id;

      elsif exists (
        select 1 from import_rows o
         where o.job_id = p_job_id
           and o.id <> v_row.id
           and o.media_item_id = v_row.media_item_id
           and o.status = 'applied'
      ) then
        -- Two Consts, one title. Counted once.
        update import_rows set status = 'duplicate' where id = v_row.id;

      else
        select exists (select 1 from rankings
                        where user_id = v_user and media_item_id = v_row.media_item_id)
          into v_ranked;

        select source into v_source
          from user_media
         where user_id = v_user and media_item_id = v_row.media_item_id;

        -- ---------------------------------------------------------------------------
        -- The whole of the collection write, and why it is this small.
        --
        -- A ranked title, a title logged here, and a title a previous import (of either
        -- provider) brought are all left exactly as they are: IMDb has no bucket, no
        -- watch date and no position to offer, and its rating is not an opinion bingd may
        -- adopt. Only an absent title is inserted: unranked, no bucket, NO watched_on
        -- ("Date Rated" is when they rated it, not when they saw it, and is never sent).
        -- The collection's deferred trigger gives it one undated watch, "watched at some
        -- point", exactly as a Letterboxd title with no diary entry gets.
        -- ---------------------------------------------------------------------------
        if not v_ranked and v_source is null then
          insert into user_media (user_id, media_item_id, source)
          values (v_user, v_row.media_item_id, 'imported')
          on conflict (user_id, media_item_id) do nothing;
        end if;

        -- Provenance, for every title the import knows about, including one it left alone.
        -- One row per (user, title): a title Letterboxd brought gains IMDb's id and rating
        -- and keeps its own name, year, star and link.
        insert into imported_titles (
          user_id, media_item_id, letterboxd_uri, source_name, source_year, rating,
          imdb_id, imdb_rating, providers
        )
        select v_user, v_row.media_item_id, null,
               coalesce(v_row.raw->>'name', '?'), (v_row.raw->>'year')::integer, null,
               v_row.raw->>'imdbId', (v_row.raw->>'imdbRating')::smallint, array['imdb']
         where exists (select 1 from user_media
                        where user_id = v_user and media_item_id = v_row.media_item_id)
        on conflict (user_id, media_item_id) do update
          set imdb_id          = excluded.imdb_id,
              imdb_rating      = coalesce(excluded.imdb_rating, imported_titles.imdb_rating),
              providers        = case when 'imdb' = any(imported_titles.providers)
                                      then imported_titles.providers
                                      else imported_titles.providers || 'imdb'::text end,
              last_imported_at = now();

        update import_rows set status = 'applied' where id = v_row.id;
      end if;

    exception
      when deadlock_detected or serialization_failure or lock_not_available then
        raise;
      when others then
        -- One row's failure costs one row, and is reported as a failure rather than as
        -- a title we could not find.
        update import_rows set status = 'failed', candidates = null where id = v_row.id;
    end;

    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;
comment on function _import_apply_batch_imdb(uuid, integer) is
  'One bounded slice of applying an IMDb job. Inserts an absent movie as imported, unranked, bucketless and undated; leaves a ranked, native or previously imported title untouched; records imdb_id, imdb_rating and the provider on imported_titles for all of them. Never writes a series (bingd collects TV by season), never a watch date, never a bucket. Internal; reached only through _import_apply_batch.';
revoke execute on function _import_apply_batch_imdb(uuid, integer) from public, anon, authenticated;

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
  v_prior  text;
begin
  select user_id into v_user from import_jobs where id = p_job_id;
  if v_user is null then return 0; end if;

  -- 20261113000100. An IMDb job has no diary, no watchlist and no star, and writes its own
  -- provenance; it is applied by its own function and never reaches the body below.
  if (select provider from import_jobs where id = p_job_id) = 'imdb' then
    return _import_apply_batch_imdb(p_job_id, p_limit);
  end if;

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
        -- 20261003000100: the date is still not written HERE, and the diary's dates now
        -- land as `diary` watch events below instead of only as provenance. The cache may
        -- therefore move to a later diary date, which is authoritative data adding a
        -- viewing rather than an import overwriting a native one -- and the monthly board
        -- stops reading the cache at all at T4 (R2), which is what makes that safe.
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
              -- 20261113000100: a title IMDb brought first keeps that, and gains Letterboxd.
              providers        = case when 'letterboxd' = any(imported_titles.providers)
                                      then imported_titles.providers
                                      else imported_titles.providers || 'letterboxd'::text end,
              last_imported_at = now();

        -- Per-viewing provenance. `on conflict do nothing` on (user_id, diary_uri) is what
        -- makes a second import of the same diary free. **Still written during the
        -- transition** (§D.5): retiring this table is a T7 item, and until then it is the
        -- evidence a re-run of T1's backfill would rebuild from.
        insert into imported_watches (user_id, media_item_id, diary_uri, watched_on, is_rewatch)
        select v_user, v_row.media_item_id,
               w->>'diaryUri', (w->>'watchedOn')::date,
               coalesce((w->>'isRewatch')::boolean, false)
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
        on conflict (user_id, diary_uri) do nothing;

        -- ---------------------------------------------------------------------------
        -- 20261003000100. The diary becomes watch history.
        -- ---------------------------------------------------------------------------

        -- One event per diary entry. The date is skipped when an existing NATIVE event
        -- already holds it: that is one viewing the reader recorded here and Letterboxd
        -- recorded there, and two events would be §O.6.3's double count.
        insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
        select v_user, v_row.media_item_id,
               (w->>'watchedOn')::date, 'diary', w->>'diaryUri'
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and (w->>'watchedOn')::date between date '1870-01-01' and date '2100-01-01'
           and not exists (
             select 1 from watch_events we
              where we.user_id = v_user
                and we.media_item_id = v_row.media_item_id
                and we.import_ref is null
                and we.watched_on = (w->>'watchedOn')::date
           )
        on conflict (user_id, import_ref) where import_ref is not null do nothing;

        -- The prior viewing the source asserts, before the supersede below can delete
        -- the undated event that would otherwise be the only record of it. `#prior` on
        -- the earliest entry's URI, so a re-import finds it and adds nothing.
        select w->>'diaryUri' into v_prior
          from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) w
         where w->>'diaryUri' is not null
           and coalesce((w->>'isRewatch')::boolean, false)
           and (w->>'watchedOn')::date = (
             select min((x->>'watchedOn')::date)
               from jsonb_array_elements(coalesce(v_row.raw->'watches', '[]'::jsonb)) x
              where x->>'diaryUri' is not null
           )
         order by w->>'diaryUri'
         limit 1;

        if v_prior is not null then
          insert into watch_events (user_id, media_item_id, watched_on, basis, import_ref)
          values (v_user, v_row.media_item_id, null, 'none', v_prior || '#prior')
          on conflict (user_id, import_ref) where import_ref is not null do nothing;
        end if;

        -- Supersede. The title's only undated event was "watched at some point"; the
        -- diary has now said when, so it is deleted. The `#prior` event above is exempt
        -- because it carries an `import_ref` and this deletes only the bare one.
        delete from watch_events we
         where we.user_id = v_user
           and we.media_item_id = v_row.media_item_id
           and we.basis = 'none'
           and we.import_ref is null
           and exists (
             select 1 from watch_events d
              where d.user_id = v_user
                and d.media_item_id = v_row.media_item_id
                and d.basis = 'diary'
           );

        -- ---------------------------------------------------------------------------
        -- A dated imported row with no diary entry to account for the date.
        --
        -- `raw->>'watchedOn'` is the diary MAXIMUM the client computed, and an archive
        -- can carry it with no `watches` array behind it. Without this the row would
        -- reach commit with no event at all, the deferred trigger would give it an
        -- UNDATED one, and the cache would then recompute `watched_on` to null --
        -- **erasing a date the importer had just written**. It is the same case §M.3
        -- step 4 handles in the backfill, and it needed handling on the live path too.
        --
        -- `basis = 'diary'`: that date came from the diary, so it is authoritative, and
        -- calling it native would put an import on the monthly board at T4.
        -- ---------------------------------------------------------------------------
        insert into watch_events (user_id, media_item_id, watched_on, basis)
        select um.user_id, um.media_item_id, um.watched_on, 'diary'
          from user_media um
         where um.user_id = v_user
           and um.media_item_id = v_row.media_item_id
           and um.watched_on is not null
           and not exists (
             select 1 from watch_events we
              where we.user_id = v_user and we.media_item_id = v_row.media_item_id
           );
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

-- ===========================================================================
-- 6. Settling, redaction, and what the person is told
-- ===========================================================================

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
  v_provider text;
begin
  select user_id, created_at, provider into v_user, v_started, v_provider
    from import_jobs where id = p_job_id;
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

  -- 20261113000100. The buckets only an IMDb file can produce. Added only to an IMDb
  -- job's counts, so a Letterboxd summary is byte-for-byte what it was.
  --
  --   duplicate            a second Const that resolved to a title this job already placed
  --   unsupported          a row bingd has no collection destination for
  --     unsupported_tv       of which: a whole TV show (bingd collects TV by season)
  --     unsupported_episode  of which: a single episode
  --   failed               a matched row whose write raised; nothing was written for it
  if v_provider = 'imdb' then
    v_counts := v_counts || (
      select jsonb_build_object(
               'duplicate',           count(*) filter (where r.status = 'duplicate'),
               'unsupported',         count(*) filter (where r.status = 'unsupported'),
               'unsupported_tv',      count(*) filter (where r.status = 'unsupported'
                                                         and mi.kind = 'series'),
               'unsupported_episode', count(*) filter (where r.status = 'unsupported'
                                                         and r.raw->>'titleType' = 'tvepisode'),
               'failed',              count(*) filter (where r.status = 'failed'))
        from import_rows r
        left join media_items mi on mi.id = r.media_item_id
       where r.job_id = p_job_id);
  end if;

  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate', 'unsupported', 'failed');

  update import_rows
     set raw = jsonb_strip_nulls(jsonb_build_object(
                 'name', raw->>'name',
                 'year', raw->'year'))
   where job_id = p_job_id
     and status in ('ambiguous', 'unmatched', 'needs_provider')
     and (raw ?| array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches',
                         'imdbId', 'imdbRating', 'titleType', 'originalTitle']);

  -- 20261113000100. An IMDb row's correlation is its tt id. The rows still here are the
  -- unresolved ones, reduced to name and year above; the id goes with the rest, so what
  -- is kept is what a Letterboxd row keeps (independent review, 2026-11-11).
  if v_provider = 'imdb' then
    update import_rows
       set correlation = 'redacted:' || id::text
     where job_id = p_job_id and correlation not like 'redacted:%';
  end if;

  update import_jobs
     set status = 'done',
         completed_at = now(),
         claimed_at = null,
         counts = counts || v_counts
   where id = p_job_id and completed_at is null;

  return v_counts;
end;
$$;

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
     and raw ?| array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches',
                         'imdbId', 'imdbRating', 'titleType', 'originalTitle'];

  -- 20261113000100: an IMDb row's correlation is its tt id, and goes with the rest.
  if new.provider = 'imdb' then
    update import_rows
       set correlation = 'redacted:' || id::text
     where job_id = new.id and correlation not like 'redacted:%';
  end if;

  return null;
end;
$$;

create or replace function _import_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text;
begin
  if old.status = 'pending' and new.status = 'matching' and new.completed_at is null then
    v_type := 'import_started';
  elsif old.completed_at is null and new.completed_at is not null then
    if new.status = 'done' then
      v_type := 'import_completed';
    elsif new.status = 'failed' and old.status <> 'pending' then
      v_type := 'import_failed';
    end if;
  end if;

  if v_type is null then
    return null;
  end if;

  insert into notifications (recipient_id, type, subject_type, subject_id, payload)
  values (
    new.user_id,
    v_type,
    'import_job',
    new.id,
    jsonb_build_object('job_id', new.id, 'provider', new.provider)
      -- The summary, on the one notification that has one. Counts only: no film name ever
      -- enters a notification.
      || case when v_type = 'import_completed' then
           jsonb_build_object(
             'watched',   coalesce((new.counts ->> 'watched')::integer, 0),
             'watchlist', coalesce((new.counts ->> 'watchlist')::integer, 0))
         else '{}'::jsonb end
  )
  on conflict do nothing;

  return null;
end;
$$;

-- 20261113000100. #254's claim_push_batch(integer, timestamptz), with the import's one edit.
-- `create or replace` keeps its ACL; the grants are restated so the file says what it
-- means, and a one-argument form must never come back (two overloads make push-sender's
-- rpc('claim_push_batch', { p_limit }) ambiguous, and every push stops).
create or replace function claim_push_batch(p_limit integer default 20, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
  v_pro_dead uuid[];
  v_sent    uuid[];
  v_mine    uuid[];
  v_busy    uuid[];
begin
  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  -- 20261028000100. LOCK FIRST, THEN JUDGE, AND NEVER WAIT (Codex final reviews, MAJOR).
  --
  -- Every proactive candidate behind this batch is locked before anything about it is
  -- checked, and stays locked until it is marked sent at the end of this transaction, so
  -- nothing (a mute, a social writer) can change it between the checks and the send.
  --
  -- SKIP LOCKED, so the claim never waits on a candidate row. A candidate another
  -- transaction owns at this moment (a mute suppressing it, a friend joining its cluster)
  -- is not judged, not sent and not charged: its job is put back in the queue exactly as
  -- it was before this claim (pending, no lease, the attempt given back), and the next
  -- drain judges it afresh with every check, dropping it if it was muted, suppressed or
  -- expired meanwhile. A claim that waits could close a lock cycle with a writer that
  -- holds rows of several readers; one that skips cannot be in any cycle. Optional
  -- delivery prefers late or missed over blocked, deadlocked or duplicated.
  --
  -- THIS DEPENDS ON claim_push_batch STAYING VOLATILE (the default; do not mark it stable
  -- or immutable). Under READ COMMITTED a volatile function takes a fresh snapshot for
  -- each statement, so the checks below read the very row version this statement locked,
  -- including a change committed an instant before. A stable function shares one snapshot
  -- across its whole body and could judge an older version than the one it holds.
  select coalesce(array_agg(s.notification_id), '{}'::uuid[]) into v_mine
    from (
      select pc.notification_id
        from proactive_candidates pc
       where pc.notification_id = any (v_claimed)
       order by pc.id
         for update skip locked
    ) s;

  select coalesce(array_agg(pc.notification_id), '{}'::uuid[]) into v_busy
    from proactive_candidates pc
   where pc.notification_id = any (v_claimed)
     and not (pc.notification_id = any (v_mine));

  if array_length(v_busy, 1) is not null then
    -- Back to a clean, claimable state, as if this claim had never taken it.
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
           attempts   = greatest(o.attempts - 1, 0)
     where o.notification_id = any (v_busy);
    v_claimed := array(select unnest(v_claimed) except select unnest(v_busy));
    if array_length(v_claimed, 1) is null then
      return jsonb_build_array();
    end if;
  end if;

  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  -- 20261028000100 (a). The proactive jobs that must not go, and the candidate told why.
  -- At most once: a job whose candidate is already `sent` (an expired lease, a retry) is
  -- dropped and its outbox row deleted below; the candidate stays `sent`. Reactive jobs
  -- are not in this set and keep their at-least-once retries unchanged.
  with pro as (
    select pc.id, pc.notification_id, pc.state,
           _proactive_claim_reason(pc.id, p_now) as reason
      from proactive_candidates pc
     where pc.notification_id = any (v_claimed)
  ),
  settled as (
    update proactive_candidates pc
       set state              = case when pro.reason in ('expired', 'outside_window', 'no_timezone')
                                     then 'expired' else 'suppressed' end,
           suppression_reason = pro.reason,
           decided_at         = p_now
      from pro
     where pc.id = pro.id and pro.reason is not null and pc.state = 'selected'
    returning pc.id
  )
  select coalesce(array_agg(pro.notification_id) filter (where pro.reason is not null), '{}'::uuid[])
    into v_pro_dead
    from pro;

  v_dead := v_dead || v_pro_dead;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        'feed_event_id',   j.feed_event_id,
        'comment_excerpt', j.comment_excerpt,
        -- 20260917001500. The job an import notification is about, and the summary its
        -- completion push quotes. Null for every other type.
        'import_job_id',   j.import_job_id,
        'import_counts',   j.import_counts,
        -- 20260920000200. Which award and tier an award_earned push is about, and the
        -- names its row was written with. Null for every other type. Not `award_name`:
        -- see the header.
        'award_key',        j.award_key,
        'award_tier',       j.award_tier,
        'award_family',     j.award_family,
        'award_tier_label', j.award_tier_label,
        -- 20261028000100. goal_completed's year, medium and target. Null otherwise.
        'goal',            j.goal,
        -- 20261028000100. A proactive job's copy facts, resolved now. Null otherwise.
        'proactive',       j.proactive,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           case when n.subject_type = 'import_job' then n.subject_id end as import_job_id,
           case when n.type in ('import_started', 'import_completed', 'import_failed')
                then n.payload end as import_counts,
           -- award_earned only (20260920000200). The keys the celebration route takes and
           -- the push copy is looked up by; the names are the fallback for a key the
           -- sender does not know.
           case when n.type = 'award_earned' then n.payload ->> 'award' end      as award_key,
           case when n.type = 'award_earned' then n.payload ->> 'tier' end       as award_tier,
           case when n.type = 'award_earned' then n.payload ->> 'award_name' end as award_family,
           case when n.type = 'award_earned' then n.payload ->> 'tier_label' end as award_tier_label,
           -- goal_completed only (20261028000100).
           case when n.type = 'goal_completed' then jsonb_build_object(
             'year',     n.payload -> 'year',
             'category', n.payload ->> 'category',
             'target',   n.payload -> 'target'
           ) end                                   as goal,
           -- Proactive only (20261028000100). Ids, dates and display names: nothing
           -- anybody wrote.
           case when pc.id is not null then jsonb_build_object(
             'type',        pc.type,
             'opens_on',    pc.metadata ->> 'opens_on',
             'local_today', (p_now at time zone coalesce(ac.timezone, 'UTC'))::date,
             -- The last instant this push may reach a phone (Codex re-review, MAJOR): the
             -- earlier of the candidate's own expiry and the close of the evening it was
             -- selected for, in the reader's zone. push-sender sends it to Expo as the
             -- message's `expiration`, so a phone that is offline at 19:59 is not woken
             -- by it the next morning, and drops the message itself if it is already past.
             'deliver_by',  least(
                              pc.expires_at,
                              (pc.selected_local_date
                                 + make_time(_proactive_int('proactive.window_end_hour', 20), 0, 0))
                                at time zone coalesce(ac.timezone, 'UTC')),
             'reason',      pc.metadata ->> 'reason',
             'actor_count', case when pc.type = 'watchlist_social'
                              then (select count(*) from _proactive_social_actors(pc.id, n.recipient_id)) end,
             -- 20261031000100: the two STRONGEST visible friends by affinity, then the
             -- earliest. Names only; the affinity itself never leaves the database.
             'actor_names', case when pc.type = 'watchlist_social' then (
                              select jsonb_agg(coalesce(nullif(s.display_name, ''), s.username)
                                               order by s.rn)
                                from (select * from _proactive_ranked_social_actors(pc.id, n.recipient_id, p_now)
                                       order by rn limit 2) s
                            ) end,
             -- 20261031000100, season_premiere only: which season, and the verified date.
             'season_number', case when pc.type = 'season_premiere'
                                then (pc.metadata ->> 'season_number')::integer end,
             'available_on',  case when pc.type = 'season_premiere'
                                then pc.metadata ->> 'available_on' end
           ) end                                   as proactive,
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           -- Only what the recipient could open and read right now.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and _can_read_comment(n.recipient_id, c.id)
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
                -- 20261028000100 (b). A proactive job goes only to devices whose build can
                -- route it; a reactive job, as always, to every live device.
                and (pc.id is null or _proactive_capable_token(d))
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            -- The same three rules `my_notifications` states, in the same words, from
            -- the recipient's side -- including the read-time `can_view_profile` on a
            -- mention's activity owner, so a title whose owner has since blocked the
            -- recipient or gone private is not pushed to their lock screen.
            and case
                  when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                  when n.type = 'mention' then can_view_profile(n.recipient_id, fe.actor_id)
                  else fe.actor_id = n.recipient_id
                end
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
      left join proactive_candidates pc
             on pc.notification_id = n.id
      left join account_context ac
             on ac.user_id = n.recipient_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- **Restored 2026-08-30 (20260904000100).** An actorless notification has nobody
       -- to have gone, and this predicate was the actorless filter by accident until
       -- 20260828000100 wrote the escape. The 20260830000100 rebuild -- which added the
       -- mention join two lines up -- was assembled from an ancestor that predated that
       -- escape and dropped it again, silently: an award congratulations was claimed,
       -- filtered out here, and its outbox row deleted by the reap below, so it never
       -- retried and never sent. Exactly the failure 20260828000100 warns a
       -- create-or-replace can make invisible in a diff.
       and (p.id is not null or n.actor_id is null)
  ) j;

  -- 20261028000100 (c). Handed to push-sender. Not Expo acceptance, not delivery.
  with sent as (
    update proactive_candidates pc
       set state               = 'sent',
           sent_at             = now(),
           actor_count_at_send = (job -> 'proactive' ->> 'actor_count')::integer
      from jsonb_array_elements(v_jobs) as job
     where pc.notification_id = (job ->> 'notification_id')::uuid
       and pc.state = 'selected'
    returning pc.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_sent from sent;

  -- A proactive job goes out ONLY if its candidate went selected -> sent in this claim.
  -- Under the lock above that is every proactive job that passed the checks; this is the
  -- guarantee written down rather than inferred, so no future path can return a proactive
  -- job whose ledger row does not say it was sent (and so counted against the caps).
  -- Reactive jobs carry no proactive facts and are untouched.
  select coalesce(jsonb_agg(job order by ord), jsonb_build_array())
    into v_jobs
    from jsonb_array_elements(v_jobs) with ordinality as e(job, ord)
   where jsonb_typeof(job -> 'proactive') is distinct from 'object'
      or (job ->> 'notification_id')::uuid = any (v_sent);

  -- Everything claimed and not returned leaves the queue, including a proactive job the
  -- line above withheld, so it cannot be claimed again and leak later.
  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

revoke execute on function claim_push_batch(integer, timestamptz) from public, anon, authenticated;
grant execute on function claim_push_batch(integer, timestamptz) to service_role;

do $$
begin
  execute format('comment on function claim_push_batch(integer, timestamptz) is %L',
    obj_description('claim_push_batch(integer, timestamptz)'::regprocedure, 'pg_proc')
    || ' Since 20261113000100: import_started and import_failed carry their payload (the provider) as import_completed does.');
end;
$$;
