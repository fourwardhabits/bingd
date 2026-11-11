// Generates supabase/migrations/20261111000100_an_import_from_more_than_one_place.sql.
//
// Every function the IMDb import has to touch is copied VERBATIM from the migration that
// last defined it and edited only through `edit`, which throws unless each anchor occurs
// exactly once. That is the mechanism behind "the Letterboxd path is unchanged": the diff
// against the previous definition is exactly the listed edits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { edit, fn, MIG } from './extract.mjs';

// Usage: node scripts/migration-generators/imdb-import.mjs  (rewrites the migration; the
// committed file must be byte-identical to what this prints, which CI-free review can check
// with git diff after running it).

const OUT = join(MIG, '20261111000100_an_import_from_more_than_one_place.sql');

const REDACT_FROM = "array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches']";
const REDACT_TO =
  "array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches',\n" +
  "                         'imdbId', 'imdbRating', 'titleType', 'originalTitle']";

// ---------------------------------------------------------------------------------------
// import_stage: the Letterboxd projection untouched, an IMDb projection beside it.
// ---------------------------------------------------------------------------------------
const stageSrc = fn(
  '20260917001300_a_trusted_mapping_that_still_has_to_agree.sql',
  'import_stage',
);
const lbInsertStart = stageSrc.indexOf('  with incoming as (');
const lbInsertEndMarker = 'into v_staged, v_added from ins;';
const lbInsertEnd = stageSrc.indexOf(lbInsertEndMarker) + lbInsertEndMarker.length;
const lbInsert = stageSrc.slice(lbInsertStart, lbInsertEnd);
const indent = (s) =>
  s
    .split('\n')
    .map((l) => (l === '' ? l : `  ${l}`))
    .join('\n');

const imdbInsert = `  with incoming as (
    select p_job_id as job_id,
           'watched'::text as kind,
           -- The tt id IS the correlation. Set here rather than trusted from the client,
           -- so a re-posted page and a duplicated Const are one row by construction.
           r->>'imdbId' as correlation,
           jsonb_strip_nulls(jsonb_build_object(
             'name',          left(btrim(r->>'name'), 200),
             'originalTitle', nullif(left(btrim(r->>'originalTitle'), 200), ''),
             'year',          case when r->>'year' ~ '^\\d{4}$'
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
  select count(*), coalesce(sum(octet_length(raw::text)), 0) into v_staged, v_added from ins;`;

const importStage = edit(
  stageSrc,
  [
    ['  v_incoming   integer;\n', '  v_incoming   integer;\n  v_provider   text;\n'],
    [
      `  select user_id, status, staged_rows, staged_bytes
    into v_owner, v_status, v_rows_so_far, v_bytes_so_far`,
      `  select user_id, status, staged_rows, staged_bytes, provider
    into v_owner, v_status, v_rows_so_far, v_bytes_so_far, v_provider`,
    ],
    [
      lbInsert,
      `  -- 20261111000100: which projection is the job's provider's. A row is read only through
  -- its own provider's field list, so a Letterboxd field sent to an IMDb job (or the
  -- reverse) is discarded exactly as an unknown field always was.
  if v_provider = 'imdb' then
${indent(imdbInsert)}
  else
${indent(lbInsert)}
  end if;`,
    ],
  ],
  'import_stage',
);

// ---------------------------------------------------------------------------------------
// _import_match_batch: a dispatch line, then the Letterboxd body verbatim.
// ---------------------------------------------------------------------------------------
const matchBatch = edit(
  fn('20261024000200_a_mapping_that_has_to_agree_with_the_row.sql', '_import_match_batch'),
  [
    [
      `  select user_id into v_user from import_jobs where id = p_job_id;\n`,
      `  select user_id into v_user from import_jobs where id = p_job_id;

  -- 20261111000100. An IMDb job is matched by its own rules (identifier first); nothing
  -- below this line ever sees one of its rows.
  if (select provider from import_jobs where id = p_job_id) = 'imdb' then
    return _import_match_batch_imdb(p_job_id, p_limit);
  end if;
`,
    ],
  ],
  '_import_match_batch',
);

// ---------------------------------------------------------------------------------------
// _import_apply_batch: a dispatch line, and Letterboxd now records itself in `providers`.
// ---------------------------------------------------------------------------------------
const applyBatch = edit(
  fn('20261003000100_a_watch_that_knows_when_it_was.sql', '_import_apply_batch'),
  [
    [
      `  if v_user is null then return 0; end if;\n`,
      `  if v_user is null then return 0; end if;

  -- 20261111000100. An IMDb job has no diary, no watchlist and no star, and writes its own
  -- provenance; it is applied by its own function and never reaches the body below.
  if (select provider from import_jobs where id = p_job_id) = 'imdb' then
    return _import_apply_batch_imdb(p_job_id, p_limit);
  end if;
`,
    ],
    [
      `              rating           = coalesce(excluded.rating, imported_titles.rating),
              last_imported_at = now();`,
      `              rating           = coalesce(excluded.rating, imported_titles.rating),
              -- 20261111000100: a title IMDb brought first keeps that, and gains Letterboxd.
              providers        = case when 'letterboxd' = any(imported_titles.providers)
                                      then imported_titles.providers
                                      else imported_titles.providers || 'letterboxd'::text end,
              last_imported_at = now();`,
    ],
  ],
  '_import_apply_batch',
);

// ---------------------------------------------------------------------------------------
// _import_settle: IMDb's extra buckets, terminal rows deleted, IMDb fields redacted.
// ---------------------------------------------------------------------------------------
const settle = edit(
  fn('20260917001300_a_trusted_mapping_that_still_has_to_agree.sql', '_import_settle'),
  [
    ['  v_counts  jsonb;\n', '  v_counts  jsonb;\n  v_provider text;\n'],
    [
      `  select user_id, created_at into v_user, v_started from import_jobs where id = p_job_id;`,
      `  select user_id, created_at, provider into v_user, v_started, v_provider
    from import_jobs where id = p_job_id;`,
    ],
    [
      `                and r.media_item_id is not null)
  ));
`,
      `                and r.media_item_id is not null)
  ));

  -- 20261111000100. The buckets only an IMDb file can produce. Added only to an IMDb
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
`,
    ],
    [
      `status in ('applied', 'duplicate');`,
      `status in ('applied', 'duplicate', 'unsupported', 'failed');`,
    ],
    [REDACT_FROM, REDACT_TO],
    [
      `  update import_jobs
     set status = 'done',`,
      `  -- 20261111000100. An IMDb row's correlation is its tt id. The rows still here are the
  -- unresolved ones, reduced to name and year above; the id goes with the rest, so what
  -- is kept is what a Letterboxd row keeps (independent review, 2026-11-11).
  if v_provider = 'imdb' then
    update import_rows
       set correlation = 'redacted:' || id::text
     where job_id = p_job_id and correlation not like 'redacted:%';
  end if;

  update import_jobs
     set status = 'done',`,
    ],
  ],
  '_import_settle',
);

const redact = edit(
  fn(
    '20260917001300_a_trusted_mapping_that_still_has_to_agree.sql',
    '_import_redact_on_complete',
  ),
  [
    [REDACT_FROM, REDACT_TO],
    [
      `  return null;
end;`,
      `  -- 20261111000100: an IMDb row's correlation is its tt id, and goes with the rest.
  if new.provider = 'imdb' then
    update import_rows
       set correlation = 'redacted:' || id::text
     where job_id = new.id and correlation not like 'redacted:%';
  end if;

  return null;
end;`,
    ],
  ],
  '_import_redact_on_complete',
);

const notify = edit(
  fn('20260917001500_an_import_that_tells_you_how_it_went.sql', '_import_notify'),
  [
    [
      `jsonb_build_object('job_id', new.id)`,
      `jsonb_build_object('job_id', new.id, 'provider', new.provider)`,
    ],
  ],
  '_import_notify',
);

const claimPush = edit(
  fn('20261024000300_an_excerpt_only_for_whoever_can_still_read_it.sql', 'claim_push_batch'),
  [
    [
      `case when n.type = 'import_completed' then n.payload end as import_counts,`,
      `case when n.type in ('import_started', 'import_completed', 'import_failed')
                then n.payload end as import_counts,`,
    ],
  ],
  'claim_push_batch',
);

const resolveSrc = fn('20260917001700_an_import_that_keeps_up.sql', '_import_provider_resolve');
const claimSrc = fn('20260917001700_an_import_that_keeps_up.sql', '_import_provider_claim');

const providerResolve = edit(
  resolveSrc,
  [
    [
      `create or replace function _import_provider_resolve(
  p_row_id uuid,
  p_media_item_id uuid,
  p_final boolean default false
)`,
      `create function _import_provider_resolve(
  p_row_id uuid,
  p_media_item_id uuid,
  p_final boolean default false,
  p_imdb_id text default null,
  p_unsupported boolean default false
)`,
    ],
    [
      '  v_user    uuid;\n',
      `  v_user    uuid;
  v_provider text;
  v_tt       text;
  v_name     text;
  v_original text;
  v_expected media_kind;
  v_kind     media_kind;
`,
    ],
    [
      `  select r.job_id, r.raw->>'filmUri', (r.raw->>'year')::integer, j.user_id
    into v_job, v_uri, v_year, v_user`,
      `  select r.job_id, r.raw->>'filmUri', (r.raw->>'year')::integer, j.user_id,
         j.provider, r.raw->>'imdbId', r.raw->>'name', r.raw->>'originalTitle',
         _import_imdb_kind(r.raw->>'titleType')
    into v_job, v_uri, v_year, v_user,
         v_provider, v_tt, v_name, v_original, v_expected`,
    ],
    [
      `  if v_job is null then return; end if;\n`,
      `  if v_job is null then return; end if;

  -- ---------------------------------------------------------------------------
  -- 20261111000100. An IMDb row. The Edge Function's answer is checked again here rather
  -- than trusted: the destination type must be what the IMDb type implies (IMDb's type
  -- is matching evidence, never a reclassification), and the title and year must agree.
  -- A disagreement settles the row unmatched: asking again would get the same answer.
  --
  -- \`p_imdb_id\` is passed only when TMDB's own /find for that id named this title, and
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
`,
    ],
  ],
  '_import_provider_resolve',
);

const providerClaim = edit(
  claimSrc,
  [
    [
      `create or replace function _import_provider_claim(p_limit integer default 50)
returns table (row_id uuid, name text, year integer)`,
      `create function _import_provider_claim(p_limit integer default 50)
returns table (
  row_id uuid, name text, year integer,
  -- 20261111000100. Trailing, so an Edge Function that predates them reads exactly the
  -- three columns it always did. provider is the job's ('letterboxd' or 'imdb'); the
  -- other three are null on a Letterboxd row.
  provider text, imdb_id text, title_type text, original_title text
)`,
    ],
    [
      `    returning r.id, r.job_id, r.raw->>'name' as title, (r.raw->>'year')::integer as released`,
      `    returning r.id, r.job_id, r.raw->>'name' as title, (r.raw->>'year')::integer as released,
              r.raw->>'imdbId' as tt, r.raw->>'titleType' as ttype,
              r.raw->>'originalTitle' as otitle`,
    ],
    [
      `  select c.id, c.title, c.released from claimed c;`,
      `  select c.id, c.title, c.released, jj.provider, c.tt, c.ttype, c.otitle
    from claimed c
    join import_jobs jj on jj.id = c.job_id;`,
    ],
  ],
  '_import_provider_claim',
);

const header = `-- An import from more than one place: IMDb ratings beside Letterboxd (founder spec 2026-11-10).
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
-- last defined it and changed only where a 20261111000100 comment says so (the generator
-- asserts each edit lands exactly once).

-- ===========================================================================
-- 1. Schema, additive only
-- ===========================================================================

alter table import_jobs
  add column if not exists provider text not null default 'letterboxd';
alter table import_jobs
  add constraint import_jobs_known_provider check (provider in ('letterboxd', 'imdb'));
comment on column import_jobs.provider is
  'Whose export this job is. Decides which projection import_stage applies and which matcher and applier run. Every job before 20261111000100 is letterboxd, which is also the default an older client gets from import_create().';

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
  'Which imports have contributed this row, in the order they first did. Rows before 20261111000100 are all letterboxd, which the default backfills.';

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
  'Opens (or hands back) the caller''s one live import job for p_provider, letterboxd by default so a client that predates 20261111000100 is unchanged. A running job of either provider is handed back; a half-staged job of the other provider is cleared rather than reused.';
revoke execute on function import_create(text) from public, anon;
grant execute on function import_create(text) to authenticated;

${importStage}

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
  'The caller''s own job, under RLS. provider since 20261111000100, as a trailing column so a client reading the first four by name is unchanged.';
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

${matchBatch}

drop function if exists _import_provider_claim(integer);

${providerClaim}
revoke execute on function _import_provider_claim(integer) from public, anon, authenticated;
grant execute on function _import_provider_claim(integer) to service_role;

drop function if exists _import_provider_resolve(uuid, uuid, boolean);

${providerResolve}
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

${applyBatch}

-- ===========================================================================
-- 6. Settling, redaction, and what the person is told
-- ===========================================================================

${settle}

${redact}

${notify}

${claimPush}
`;

writeFileSync(OUT, header);
console.log('wrote', OUT, header.length, 'chars');
