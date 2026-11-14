-- A verified IMDb id outweighs a display title (founder QA, 2026-11-12; spec §3 P0).
--
-- The founder's own IMDb import ended nine titles in "Couldn't match" whose right film was
-- one tt id away: IMDb "Harry Potter and the Sorcerer's Stone" is TMDB 671 "Harry Potter
-- and the Philosopher's Stone"; IMDb "Star Wars: Episode VII - The Force Awakens" is TMDB
-- 140607 "Star Wars: The Force Awakens". TMDB's own /find for the exact id names the right
-- title, and every IMDb tier then required a squashed display title in common
-- (_import_imdb_identity_agrees), so a regional title, a franchise prefix or subtitle, "&"
-- for "and", or a show the two catalogues name differently was refused as a conflict.
--
-- The rule now, in the Edge Function (match.mjs verifiedIdentityAgrees) and here alike:
--
--   A /find answer, or a catalogue title carrying the id (which only a /find answer ever
--   writes), is the title when it is the one title of the kind the IMDb type implies and
--   its release year is within one of IMDb's. The display title is not consulted.
--
--   Still vetoes: the other kind (never a reclassification), two titles claiming one id
--   (ambiguous), an episode or season (unsupported), a year out of tolerance (unmatched).
--
--   A title search still proves nothing about the id, keeps the title rule, never writes
--   the id, and never chooses by popularity.
--
-- Changed, and nothing else:
--   _import_imdb_verified_agrees   new; service internals only, like its siblings
--   _import_match_batch_imdb       Tier 1 calls it instead of the title rule
--   _import_provider_resolve       the IMDb branch calls it for a /find answer; the
--                                  Letterboxd branch is byte-for-byte what it was
--
-- Both functions are copied verbatim from 20261113000100 and changed only through the
-- single-occurrence edits in scripts/migration-generators/imdb-verified-id.mjs. No
-- applied migration is edited. Signatures are unchanged, so `create or replace` keeps
-- every ACL; the grants are restated so the file says what it means.
--
-- Version 20261118000100: 20261116* is #275's and 20261117* is #278's.

create or replace function _import_imdb_verified_agrees(
  p_media_item_id uuid,
  p_expected      media_kind,
  p_year          integer
)
returns boolean
language sql
stable
set search_path = public
as $$
  -- The media item is of the kind the IMDb type implies, and its release year is within
  -- one of the row's where both are known. The title is deliberately not read: this is
  -- the test for a title TMDB itself mapped to the row's tt id. Mirrors
  -- verifiedIdentityAgrees (supabase/functions/letterboxd-import/match.mjs).
  select exists (
    select 1
      from media_items mi
     where mi.id = p_media_item_id
       and p_expected is not null
       and mi.kind = p_expected
       and (p_year is null or mi.release_date is null
            or abs(extract(year from mi.release_date)::integer - p_year) <= 1)
  );
$$;
comment on function _import_imdb_verified_agrees(uuid, media_kind, integer) is
  'Whether a media item TMDB mapped to an IMDb row''s own tt id (a /find answer, or media_items.imdb_id, which only a /find answer writes) is that row''s title: the expected kind, and release years within one where both are known. The display title is not consulted: a verified id outweighs a regional, franchise or translated title (20261118000100). Mirrored by verifiedIdentityAgrees in match.mjs.';
revoke execute on function _import_imdb_verified_agrees(uuid, media_kind, integer) from public, anon, authenticated;

comment on function _import_imdb_identity_agrees(uuid, text, text, integer) is
  'Whether a media item is plausibly the title an IMDb row names: a squashed title or original title in common, and release years within one where both are known. Since 20261118000100 the test for a TITLE-SEARCH answer only; a /find answer and a catalogue title carrying the id are held to _import_imdb_verified_agrees.';

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
  -- for this exact tt id. Its kind must be the one the IMDb type implies and its year must
  -- agree with the row's own (20261118000100: the mapping is TMDB's own /find answer, so a
  -- display-title difference is not a contradiction; _import_imdb_verified_agrees).
  -- Anything else -- no title, two titles, a different kind -- is not settled here:
  --
  --   no IMDb type bingd can place    unsupported, and the provider is never asked
  --   no title carries the id         needs_provider (TMDB /find, then a title search)
  --   two titles carry it             ambiguous: conflicting ids are not broken by guessing
  --   a different kind, or a year     unmatched: the id is TMDB-confirmed, so asking TMDB
  --   out of tolerance                again would return the same title
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
             when not _import_imdb_verified_agrees(l.only_id, l.expected, l.year) then null
             else l.only_id
           end as media_item_id,
           case
             when l.expected is null then 'unsupported'
             when l.n = 0 then 'needs_provider'
             when l.n > 1 then 'ambiguous'
             when l.only_kind <> l.expected then 'unmatched'
             when not _import_imdb_verified_agrees(l.only_id, l.expected, l.year)
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
  'One bounded slice of local matching for an IMDb job: the tt id against media_items.imdb_id, with the IMDb type''s kind and the row''s year checked (_import_imdb_verified_agrees; the display title is not, since 20261118000100). Unsupported types settle here without a provider request. Never writes a mapping. Internal; reached only through _import_match_batch.';
revoke execute on function _import_match_batch_imdb(uuid, integer) from public, anon, authenticated;

create or replace function _import_provider_resolve(
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
                   else _import_imdb_identity_agrees(p_media_item_id, v_name, v_original, v_year)
                 end)
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
