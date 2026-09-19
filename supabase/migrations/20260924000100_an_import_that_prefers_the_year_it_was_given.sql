-- An import that prefers the year it was given.
--
-- A real Android beta user, 2026-09-18: their Letterboxd *Hamlet* arrived in bingd as a
-- different film, logged and unranked, with no way to take it out short of ranking it.
-- This file is the matcher half. The removal half is a client change and needs no SQL:
-- `unlog` has always accepted an unranked title.
--
-- ===========================================================================
-- WHAT HAPPENED
--
-- The production claim ledger records the provider tier placing that user's "Hamlet" on
-- TMDB 1234733 — the Romanian *Cătun* (2025-12-01), whose English title is a translation of
-- the word — when the film meant was TMDB 843342, *Hamlet*, primary release 2026-02-06.
--
-- The provider asks TMDB for `primary_release_year = <the export's year>`, an EXACT filter,
-- and then accepts "exactly one" result within a year. A 2026 search cannot return *Cătun*,
-- so the row carried 2025: a year earlier than TMDB's for the same film, the
-- festival/territory gap the ±1 tolerance exists for. The 2025 search could not see the
-- real film, *Cătun* was the only survivor, and one survivor passed for certainty.
-- `letterboxd-import/match.mjs` `pick` records that half and its fix.
--
-- ===========================================================================
-- WHY THE LOCAL TIER NEEDS THE SAME CORRECTION
--
-- It has the identical flaw with a different truncation. T1 accepts "exactly one catalogue
-- movie with this squashed title within a year", and the catalogue is a cache of whatever
-- anybody has searched for — so "exactly one" means "exactly one *cached*".
--
-- Now that *Cătun* is cached, a row reading `Hamlet, 2026` resolves locally to it if the
-- 2026 film has not been cached too: the sole candidate, a year out, never offered to the
-- provider that would have found the right one. And when both are cached, the same row
-- lands as `ambiguous` even though one of them has exactly the year the export gave.
--
-- ===========================================================================
-- THE RULE, SHARED WITH `match.mjs`
--
-- With a year on the row:
--
--   1. One cached film in exactly that year wins, whatever else is within a year of it.
--      Two in exactly that year is a remake: `ambiguous`, as before.
--   2. Unless that film's ORIGINAL title is known and is not the exported name — a
--      translated title, *Cătun* for "Hamlet". Then a cached neighbour whose original title
--      IS the name makes it `ambiguous`; with no such neighbour cached it goes to the
--      provider, which can see all three years. The cache is not allowed to settle the one
--      shape that has already put a wrong film in somebody's collection.
--   3. No cached film in exactly that year: the provider decides, because the right one may
--      simply not be cached. The exception is a single UNDATED cached film (T1b), which the
--      provider cannot reach through a year filter and which matched before; it still does.
--
-- With no year: unchanged. Exactly one title match, else ambiguous, else the provider.
--
-- T0 (the trusted URI cache), its read guard, and the claim pass are byte-identical to
-- `20260917001300`. Only the `resolved` and `upd` CTEs changed.
--
-- ===========================================================================
-- WHAT IT COSTS, AND WHAT IT DOES NOT TOUCH
--
-- Rows the cache used to settle weakly now spend provider requests: an adjacent-year sole
-- match, and a foreign film whose export name is its translated title. That is the price of
-- the cache no longer claiming uniqueness it cannot see. A project with no provider
-- configured places those rows as `unmatched` instead of guessing.
--
-- Nothing already imported moves. This decides how pending rows resolve and nothing else:
-- no collection row, provenance row, claim or trusted mapping is read differently or
-- rewritten. Existing imports stay idempotent because apply is unchanged — a re-import
-- upserts the same collection rows and `imported_watches` stays at-most-once per diary URI.
-- ===========================================================================


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
           d.year,
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
           c.local,
           c.exact_n,
           c.exact_id,
           c.exact_translated,
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

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the trusted film-URI cache first -- guarded by the same year agreement every claim had to pass, so a mapping cannot speak over an export that contradicts it -- then the catalogue. With a year on the row, one cached movie in EXACTLY that year wins over its neighbours; two is ambiguous; a translated title (original title known and not the exported name) beside a cached native-titled neighbour is ambiguous, and without one goes to the provider; no exact-year film goes to the provider, except a lone undated one, which matches (T1b). With no year, exactly one title match. The catalogue is a cache, so it never settles on a neighbour it merely happens to hold (20260924000100). Strong matches in THIS slice are recorded as claims and shared only once another account agrees; see _import_promote_match. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;
