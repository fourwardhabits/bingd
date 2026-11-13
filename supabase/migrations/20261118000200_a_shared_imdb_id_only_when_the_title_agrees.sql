-- A shared IMDb id only when the title agrees; every row counted once; a moved release date
-- (founder QA staging reimport, 2026-11-13; fix-up of 20261118000100, which is not edited).
--
-- 20261118000100 made a verified /find id outweigh a display title. Staging went from nine
-- "Couldn't match" to one. Three corrections:
--
-- 1. The shared mapping. media_items.imdb_id is global: once written, every account's Tier 1
--    settles that tt id onto it with no provider call. A verified id is enough to LINK one
--    person's row, but the mapping is now written only when the title agrees too (exactly,
--    after punctuation/diacritics, "&" as "and", a leading article, or the original title)
--    and the catalogue's own date is within a year. A verified id that won over a
--    disagreeing display title links the row and writes nothing shared.
--
-- 2. One bucket per row. _import_provider_resolve returns the status it settled the row in,
--    so the Edge Function counts what the database decided. An undated /find hit the Edge
--    accepted and the re-check refused against a catalogue date used to be counted matched.
--
-- 3. A moved release date. TMDB's primary date moves (Hamilton, tt8503618: IMDb 2020, TMDB
--    556574 now primary 2025). After a year conflict the Edge Function reads the movie's
--    release dates; any within a year of IMDb's is passed as p_release_year and accepted.
--    Such a match never writes the shared id (point 1: the catalogue's date disagrees).
--
-- Changed, and nothing else:
--   _import_imdb_title_norm             new; mirrors mappingNorm (match.mjs)
--   _import_imdb_mapping_title_agrees   new; mirrors mappingTitleAgrees (match.mjs)
--   _import_provider_resolve            + p_release_year, returns text, the write gate;
--                                       dropped and re-created (a new signature and return
--                                       type cannot be replaced in place). The Letterboxd
--                                       branch only gains its final return.
-- Tier 1 (_import_match_batch_imdb) is unchanged: every mapping it can now meet was written
-- under the stricter gate, or by 20261113000100's title rule, which is stricter still.
--
-- Generated from 20261118000100 by scripts/migration-generators/imdb-shared-id-gate.mjs.
-- Apply BEFORE deploying the matching letterboxd-import: the old function has no
-- p_release_year, while an old Edge Function calls the new one exactly as before.

create or replace function _import_imdb_title_norm(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  -- "&" read as "and", one leading English article dropped, then media_squash. Regex on the
  -- text before the fold, exactly as mappingNorm in match.mjs does it.
  select media_squash(regexp_replace(replace(coalesce(p_value, ''), '&', ' and '),
                                     '^\s*(the|a|an)\s+', '', 'i'));
$$;
comment on function _import_imdb_title_norm(text) is
  'A title folded for the shared-mapping test: "&" as "and", a leading article dropped, then media_squash. Mirrored by mappingNorm in supabase/functions/letterboxd-import/match.mjs (20261118000200).';
revoke execute on function _import_imdb_title_norm(text) from public, anon, authenticated;

create or replace function _import_imdb_mapping_title_agrees(
  p_media_item_id uuid,
  p_name          text,
  p_original      text
)
returns boolean
language sql
stable
set search_path = public
as $$
  -- A title or original title of the media item equal to the row's title or original
  -- title, squashed, or once "&" and a leading article are folded (_import_imdb_title_norm).
  select exists (
    select 1
      from media_items mi
      cross join lateral (values (mi.title), (mi.original_title)) theirs(t)
      cross join lateral (values (p_name), (p_original)) ours(o)
     where mi.id = p_media_item_id
       and ((nullif(media_squash(theirs.t), '') is not null
             and media_squash(theirs.t) = media_squash(ours.o))
         or (nullif(_import_imdb_title_norm(theirs.t), '') is not null
             and _import_imdb_title_norm(theirs.t) = _import_imdb_title_norm(ours.o)))
  );
$$;
comment on function _import_imdb_mapping_title_agrees(uuid, text, text) is
  'Whether a verified title may also become the SHARED media_items.imdb_id: its title or original title agrees with the row''s, squashed or with "&" and a leading article folded. Mirrored by mappingTitleAgrees in match.mjs (20261118000200).';
revoke execute on function _import_imdb_mapping_title_agrees(uuid, text, text) from public, anon, authenticated;

drop function if exists _import_provider_resolve(uuid, uuid, boolean, text, boolean);

create function _import_provider_resolve(
  p_row_id uuid,
  p_media_item_id uuid,
  p_final boolean default false,
  p_imdb_id text default null,
  p_unsupported boolean default false,
  p_release_year integer default null
)
returns text
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

  if v_job is null then return 'stale'; end if;

  -- ---------------------------------------------------------------------------
  -- 20261113000100. An IMDb row. The Edge Function's answer is checked again here rather
  -- than trusted: the destination type must be what the IMDb type implies (IMDb's type
  -- is matching evidence, never a reclassification), and the year must agree.
  -- A disagreement settles the row unmatched: asking again would get the same answer.
  --
  -- 20261118000100. WHICH rule depends on what the answer is. A /find answer for this
  -- row's own tt id (p_imdb_id = the row's id) is TMDB's mapping, and is held to kind and
  -- year only (_import_imdb_verified_agrees), exactly as the Edge Function's
  -- verifiedIdentityAgrees holds it, so neither side rejects what the other accepted. A
  -- title-search answer proves nothing about the id and keeps the title rule
  -- (_import_imdb_identity_agrees), which accepts every title the Edge Function's strict
  -- pick and pickOriginal can choose.
  --
  -- 20261118000200. Two more things, both mirrored in match.mjs:
  --   * p_release_year: a year from the title's OTHER TMDB release dates (the Edge Function
  --     reads /movie/{id}/release_dates only after a year conflict). Within one year of the
  --     row's, it stands in for the catalogue's primary date, which TMDB moves (Hamilton,
  --     IMDb 2020, TMDB primary 2025). The catalogue keeps one date, so the evidence is
  --     passed rather than re-derived; the caller is the service role only.
  --   * The SHARED id is a higher bar than the match. It is written only when the title
  --     also agrees (_import_imdb_mapping_title_agrees: squashed, "&"/"and", a leading
  --     article, or the original title) AND the catalogue's own date agrees, i.e. only a
  --     mapping Tier 1 could accept on its own. A verified id that won over a disagreeing
  --     display title, or was rescued by another release date, links this row and writes
  --     nothing every other account would then inherit (mappingTitleAgrees).
  --
  -- Returns the status the row was settled in, so the caller counts what happened rather
  -- than what it hoped ('stale' when the job had already settled and nothing was written).
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
         or not (case
                   when p_imdb_id is not null and p_imdb_id = v_tt
                     then _import_imdb_verified_agrees(p_media_item_id, v_expected, v_year)
                          or (p_release_year is not null and v_year is not null
                              and abs(p_release_year - v_year) <= 1)
                   else _import_imdb_identity_agrees(p_media_item_id, v_name, v_original, v_year)
                 end)
      then
        update import_rows
           set status = 'unmatched', provider_claimed_at = null
         where id = p_row_id;
        return 'unmatched';
      end if;

      if p_imdb_id is not null and p_imdb_id = v_tt
         and _import_imdb_verified_agrees(p_media_item_id, v_expected, v_year)
         and _import_imdb_mapping_title_agrees(p_media_item_id, v_name, v_original)
      then
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
    return (select status from import_rows where id = p_row_id);
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
  return (select status from import_rows where id = p_row_id);
end;
$$;
revoke execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean, integer) from public, anon, authenticated;
grant execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean, integer) to service_role;
