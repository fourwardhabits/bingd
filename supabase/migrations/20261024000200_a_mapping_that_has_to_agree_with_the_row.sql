-- A mapping that has to agree with the row.
-- Security audit 2026-11-01, finding M-1. Replaces `_import_match_batch`, rebuilt in full
-- from `20260925000100`, and `_import_promote_match`, rebuilt from `20260917000900`.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- `20260917000900` required two accounts to agree before a film URI became a shared
-- mapping, and recorded why one account could not assert it: the URI is client-supplied and
-- nothing dereferences it. The same is true of two accounts, and two accounts are free.
--
--   account A stages  (name = "Attacker Film", year = 2011, filmUri = <the real film's URI>)
--   account B stages  the same row
--   -> T1 resolves the name, the pair reaches the threshold, the mapping is trusted
--   -> a third account importing (name = "Real Film", year = 2011, filmUri = <same URI>)
--      is placed on Attacker Film by T0, and apply writes it into their history
--
-- T0's year guard (`20260917001300`) only limited the attack to films within a year of the
-- real one. The mapping spoke over a row whose own name contradicted it, and the first
-- mapping to reach the bar was permanent.
--
-- ===========================================================================
-- THE RULE NOW
--
-- **A shared mapping confirms what a row says. It never overrides it.** Real exports carry
-- `boxd.it` short links, which say nothing about the film, so no count of accounts can
-- establish that a URI denotes a film. T0 therefore answers only when all three hold:
--
--   1. the row's own name is the mapped film's title or original title;
--   2. the row's own year is the mapped film's release year exactly;
--   3. nothing else in the cache answers to that name within a year of the row.
--
-- Anything else falls through to T1, the provider or the person, which is what would have
-- happened with no mapping at all. A poisoned row in `letterboxd_matches` is inert under
-- this rule, so no cleanup is needed for the matcher to be safe: every wrong mapping that
-- already exists stops being read the moment this applies.
--
-- **What T0 is still for.** Saving a provider request on a row the catalogue can place but
-- T1 will not settle alone: a film known here under its original title, and a translated
-- title with no neighbour in the cache.
--
-- **What it stopped doing, deliberately.** It used to place an alternate title, a
-- year-less row, and one namesake over another. Each of those trusted the URI with nothing
-- behind it, which is the vulnerability. They now cost a provider request or an
-- `ambiguous` row the person settles, and a person being asked is the failure this
-- importer chose over a silently wrong history in `20260917001300`.
--
-- ===========================================================================
-- PROMOTION
--
-- The two guards here are defence in depth, and neither replaces the read rule above.
--
-- **A URI that carries a name has to agree with the film.** `letterboxd.com/film/<slug>/`
-- is the one identifier the attacker cannot rewrite, so a slug that disagrees with the
-- claimed film is refused. Fails closed: a slug that differs for an honest reason costs a
-- trusted row and nothing else, because T1 and the provider still place the film. A
-- `boxd.it` link has nothing to compare and passes, which is why the read rule exists.
--
-- **A contested URI is not promoted.** A pair has to lead every rival pair on that URI.
-- `on conflict do nothing` stays: displacing a trusted row hands the attack back.
--
-- No existing claim or mapping is touched: this changes what is read and written next. See
-- `docs/ops/letterboxd-match-audit.md` for the read-only audit and the cleanup.
-- ===========================================================================


create or replace function _letterboxd_slug_agrees(p_uri text, p_media_item_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  with parts as (
    select (regexp_match(p_uri, '^https?://(?:www\.)?letterboxd\.com/film/([^/?#]+)'))[1] as slug
  )
  select case
    when parts.slug is null then true
    else exists (
      select 1
        from media_items mi
       where mi.id = p_media_item_id
         and array[mi.sort_key_squashed, media_squash(mi.original_title)]
             && array[
               media_squash(parts.slug),
               -- Letterboxd separates namesakes with a suffix: `dune-2021`, `hamlet-1`.
               media_squash(regexp_replace(parts.slug, '-[0-9]+$', ''))
             ]
    )
  end
  from parts;
$$;

comment on function _letterboxd_slug_agrees(text, uuid) is
  'False when p_uri is a letterboxd.com/film/<slug> link whose slug names something other than the film, by title or original title, with or without a trailing namesake suffix. True for a boxd.it short link, which carries no name to compare. Read by _import_promote_match and by the read-only audit. Internal.';

revoke execute on function _letterboxd_slug_agrees(text, uuid) from public, anon, authenticated;


create or replace function _import_promote_match(
  p_uri           text,
  p_media_item_id uuid,
  p_user_id       uuid,
  p_tier          text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claims    integer;
  v_threshold integer;
  v_rival     integer;
begin
  if p_uri is null or p_media_item_id is null or p_user_id is null then
    return;
  end if;

  insert into letterboxd_match_claims (letterboxd_uri, media_item_id, user_id, tier)
  values (p_uri, p_media_item_id, p_user_id, p_tier)
  on conflict (letterboxd_uri, media_item_id, user_id) do nothing;

  -- Shape-tested before the cast, and clamped. An operator typo must not raise here: this
  -- runs inside the worker's slice, where a raise costs the whole job. A floor of two is
  -- deliberate -- a threshold of one is the bug this migration exists to fix, so the
  -- configuration cannot express it.
  v_threshold := least(greatest(coalesce(
    (select case when value #>> '{}' ~ '^\d{1,4}$' then (value #>> '{}')::integer end
       from app_config where key = 'import.match_trust_claims'),
    2), 2), 50);

  select count(*) into v_claims
    from letterboxd_match_claims
   where letterboxd_uri = p_uri and media_item_id = p_media_item_id;

  if v_claims < v_threshold then
    return;
  end if;

  -- The claim stands either way, because it is attributable. Only the shared row is refused.
  if not _letterboxd_slug_agrees(p_uri, p_media_item_id) then
    return;
  end if;

  select coalesce(max(r.n), 0) into v_rival
    from (
      select count(*) as n
        from letterboxd_match_claims
       where letterboxd_uri = p_uri and media_item_id <> p_media_item_id
       group by media_item_id
    ) r;

  if v_claims <= v_rival then
    return;
  end if;

  -- **`do nothing`, so an established mapping is never overwritten by a later crowd.**
  -- Two accounts agreeing on B does not unseat a mapping to A that already reached the
  -- bar: displacing a trusted row would hand an attacker the same attack back, at the cost
  -- of one extra account. A genuine correction is an operator's job, and the claims are
  -- there to make that case visible.
  --
  -- This is also what makes the concurrent case deterministic rather than merely rare. Two
  -- imports racing on the same pair both insert their claim, both may read a count at or
  -- over the threshold, and both attempt the promotion; one wins and the other is a no-op,
  -- and the row that exists is the same either way. Two imports racing on the *same URI*
  -- with *different* media items each see a count of one for their own pair, so neither
  -- promotes and the URI stays unresolved -- which is the correct answer to a genuine
  -- disagreement, and the same answer T1 gives an ambiguous title.
  insert into letterboxd_matches (letterboxd_uri, media_item_id, tier, claim_count)
  values (p_uri, p_media_item_id, p_tier, v_claims)
  on conflict (letterboxd_uri) do nothing;
end;
$$;

comment on function _import_promote_match(text, uuid, uuid, text) is
  'Records one account''s claim that a film URI denotes a media item, and promotes the pair into letterboxd_matches once import.match_trust_claims distinct accounts have claimed it, the URI''s own slug does not contradict the film, and the pair leads every rival pair on that URI. The single writer of that table. Reaching the bar does not make a mapping authoritative: since 20261024000200 T0 only ever confirms a row''s own name and exact year. Never overwrites an existing mapping, so a later crowd cannot unseat an earlier one. Internal.';

revoke execute on function _import_promote_match(text, uuid, uuid, text) from public, anon, authenticated;


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
           -- T0. A corroborated film **that this row independently names**: its own name
           -- and its own exact year, read off the catalogue. See the header for why count
           -- and URI are not evidence. `decided` below applies the third condition.
           (select m.media_item_id
              from letterboxd_matches m
              join media_items mi on mi.id = m.media_item_id
             where m.letterboxd_uri = d.uri
               and d.year is not null
               and extract(year from mi.release_date)::integer = d.year
               and media_squash(d.name) in (mi.sort_key_squashed, media_squash(mi.original_title))
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
  -- The third condition: nothing else in the cache answers to this name. A mapping never
  -- chooses between namesakes, so it can only ever agree with what the row already says.
  guarded as (
    select r.*,
           r.t0 is not null and coalesce(r.local, '{}'::uuid[]) <@ array[r.t0] as t0_holds
      from resolved r
  ),
  decided as (
    select x.id,
           case
             when x.t0_holds then x.t0
             when x.year is null then
               case when coalesce(array_length(x.local, 1), 0) = 1 then x.local[1] end
             when x.exact_n > 1 and x.exact_native_n = 1 and x.exact_translated_n = x.exact_n - 1
               then x.exact_native_id
             when x.exact_n = 1 and not x.exact_translated then x.exact_id
             when x.exact_n = 0 and coalesce(array_length(x.local, 1), 0) = 1 and x.undated_n = 1
               then x.local[1]
           end as media_item_id,
           case
             when x.t0_holds then 'matched'
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
      from guarded x
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
  'One bounded slice of local matching. T0, the shared film-URI cache, answers only when the row''s own name and exact year agree with the mapped film and nothing else in the cache answers to that name within a year (20261024000200): a mapping confirms a row and never overrides or chooses for it, because no tier can establish what a URI denotes. Then the catalogue. With a year on the row, one cached movie in EXACTLY that year wins over its neighbours; several in that year are ambiguous unless exactly one has the exported name as its original title and every other is a known translation (1b, 20260925000100); a translated title (original title known and not the exported name) beside a cached native-titled neighbour is ambiguous, and without one goes to the provider; no exact-year film goes to the provider, except a lone undated one, which matches (T1b). With no year, exactly one title match. The catalogue is a cache, so it never settles on a neighbour it merely happens to hold (20260924000100). Strong matches in THIS slice are recorded as claims; see _import_promote_match. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;
