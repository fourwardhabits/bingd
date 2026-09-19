-- An exact year that knows its own title.
--
-- Follow-up to `20260924000100`, which is applied to staging and therefore immutable. This
-- file replaces `_import_match_batch` again, rebuilt in full from that migration's body with
-- one rule added. Everything else — T0 and its read guard, the adjacent-year translated-title
-- safeguard, the one-year fallback, T1b, rows without a year, and the claim pass — is
-- byte-identical to `20260924000100`.
--
-- ===========================================================================
-- WHAT STAGING FOUND (2026-09-19)
--
-- A real staging import of `Past Lives, 2023` came back unresolved. TMDB holds two 2023 films
-- titled "Past Lives": 666277, whose original title is "Past Lives", and 1164820, a Filipino
-- film whose original title is "Nagligad nga Kinabuhi". Two films in exactly the export's year
-- were a remake to `20260924000100` — and to every rule before it, so this was never a
-- regression, only a gap. The provider tier (`letterboxd-import/match.mjs` `pick`, rule 1b)
-- and this local tier now close it the same way.
--
-- ===========================================================================
-- THE RULE (1b)
--
-- With a year on the row and MORE THAN ONE cached film in exactly that year:
--
--   * exactly one of them has the exported name as its original title, and
--   * every other one has a known original title that is not the exported name
--
-- then that one film is matched. It is the mirror image of the translated-title safeguard: a
-- native original title may separate same-year namesakes that are only translations.
--
-- Otherwise the row stays `ambiguous`, as before: two native matches is a genuine remake, none
-- is no evidence, and an unknown original title could be a second native match. Popularity,
-- provider order and vote counts are never consulted.
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

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the trusted film-URI cache first -- guarded by the same year agreement every claim had to pass, so a mapping cannot speak over an export that contradicts it -- then the catalogue. With a year on the row, one cached movie in EXACTLY that year wins over its neighbours; several in that year are ambiguous unless exactly one has the exported name as its original title and every other is a known translation (1b, 20260925000100); a translated title (original title known and not the exported name) beside a cached native-titled neighbour is ambiguous, and without one goes to the provider; no exact-year film goes to the provider, except a lone undated one, which matches (T1b). With no year, exactly one title match. The catalogue is a cache, so it never settles on a neighbour it merely happens to hold (20260924000100). Strong matches in THIS slice are recorded as claims and shared only once another account agrees; see _import_promote_match. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;
