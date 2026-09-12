-- A shared identity mapping that one account cannot assert on its own.
--
-- Independent review, 2026-09-11, the one finding left open as security. Fixed here.
--
-- ===========================================================================
-- THE HOLE, EXACTLY
--
-- `letterboxd_matches` maps a Letterboxd **film** URI to a `media_items.id`. It is global,
-- permanent, has no eviction path, and is read by `_import_match_batch`'s T0 tier as exact
-- truth for every later importer.
--
-- Both writers guard it with the same check: the export's `year` must agree with the
-- matched catalogue row's `release_date` to within one. That check is real, and it is
-- guarding the wrong edge.
--
--   the export row is   (filmUri, name, year)   -- all three from the client
--   the match is        name + year -> media_items row
--   the guard asserts   year <-> release_date   -- i.e. name <-> year consistency
--   the cache records   filmUri -> media_items row
--
-- **Nothing anywhere checks `filmUri` against the film.** The URI is carried along beside
-- the evidence and then written as the key, without ever being part of the evidence. So:
--
--   1. attacker signs in, `import_create`, `import_stage` with one row:
--        {kind:'watched', name:'Cats', year:2019, filmUri:'<the real boxd.it slug for
--         The Godfather>'}
--   2. T1 matches *Cats (2019)* uniquely; the year agrees with its release date
--   3. `letterboxd_matches['<Godfather slug>'] = Cats` is written, permanently
--   4. every later importer with The Godfather in their export gets *Cats* logged as
--      watched, carrying the bucket derived from their Godfather rating
--
-- `on conflict do nothing` makes the first writer permanent, so the true mapping can never
-- displace it. No contributor was recorded, so it was not attributable. RLS with no policy
-- meant nobody could even read the table to audit it.
--
-- ===========================================================================
-- WHY "ONLY TRUST THE PROVIDER" IS NOT THE FIX
--
-- The obvious answer is to let only the TMDB tier write here. It does not work, and it is
-- worth writing down why so nobody reaches for it again.
--
-- `_import_provider_resolve` is handed a row id and a media item. The Edge Function chose
-- that media item by searching TMDB for **the row's name and year** -- which are the
-- client's, exactly as in T1. The provider establishes `name + year -> TMDB title`. It
-- never dereferences `filmUri` either. Nothing in this system fetches a Letterboxd page, so
-- no tier can independently establish that a given URI denotes a given film. Trusting the
-- provider alone would leave the same attack reachable by the other road: name a film that
-- is not in the catalogue yet, attach somebody else's URI, and the provider confidently
-- resolves it.
--
-- ===========================================================================
-- WHAT IS ACTUALLY AVAILABLE AS EVIDENCE
--
-- One thing: **independent agreement**. If two unrelated accounts both export a row saying
-- this URI is this film, that is no longer one party's assertion. It is the only evidence
-- this architecture can obtain without crawling Letterboxd, and it is enough, because the
-- attack it has to stop is precisely "one account asserts".
--
-- So the table splits in two:
--
--   `letterboxd_match_claims`   what one account's import asserted     -- not trusted
--   `letterboxd_matches`        what enough accounts agreed on         -- trusted, read by T0
--
-- A claim is recorded per (uri, media item, user). A mapping is promoted when the number of
-- **distinct accounts** claiming that exact pair reaches `import.match_trust_claims`
-- (default 2). An attacker acting alone produces a claim and nothing else.
--
-- ===========================================================================
-- WHAT THIS COSTS, WHICH IS LESS THAN IT LOOKS
--
-- The cache's stated value is sparing the provider tier. Most of that value survives,
-- because **the provider already populates `media_items`**: once any account's import has
-- caused TMDB to be asked about a film, that film is in the catalogue with a title and a
-- release date, and every later importer matches it locally on T1 for free. The cache only
-- adds something where T1 cannot reach -- an alternate title, or a year more than one out.
-- Those are exactly the bindings least supported by evidence, and the ones most worth
-- making somebody agree about.
--
-- ===========================================================================
-- AND THE EXISTING ROWS GO
--
-- Every row in `letterboxd_matches` today was written under the rule above, so none of them
-- carries the evidence the new rule requires. They are deleted rather than grandfathered:
-- there is no way to tell a poisoned row from an honest one, which is the point. Staging
-- has run no real imports and production has none of this schema, so the practical cost is
-- zero -- and if it were not, a re-derivable cache is the right thing to drop.
-- ===========================================================================


insert into app_config (key, value) values ('import.match_trust_claims', '2'::jsonb)
  on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 1. What one account asserted
-- ---------------------------------------------------------------------------

create table if not exists letterboxd_match_claims (
  letterboxd_uri text not null,
  media_item_id  uuid not null references media_items(id) on delete cascade,
  user_id        uuid not null references profiles(id) on delete cascade,
  -- Which tier produced it. Kept because the two are not equally good evidence and a
  -- future rule may want to weigh them differently; nothing reads it today.
  tier           text not null check (tier in ('local', 'provider')),
  claimed_at     timestamptz not null default now(),
  -- At most once per account per pair, so one person cannot corroborate themselves by
  -- importing the same archive twice -- which is the first thing an attacker would try, and
  -- also the most ordinary thing an honest person does.
  primary key (letterboxd_uri, media_item_id, user_id)
);

-- The promotion count reads exactly this prefix.
create index if not exists letterboxd_match_claims_pair
  on letterboxd_match_claims (letterboxd_uri, media_item_id);

comment on table letterboxd_match_claims is
  'One account''s assertion that a Letterboxd film URI denotes a media item, recorded by the matcher and never trusted on its own. A mapping is promoted into letterboxd_matches only when import.match_trust_claims distinct accounts have claimed the same pair, because the URI is client-supplied on every tier -- the provider searches TMDB by the client''s own name and year and never dereferences the URI either, so no tier can establish the binding alone. Unlike the table it feeds, this one is attributable on purpose: a poisoning attempt should be traceable to the account that made it. No RLS policy, so no client can read it.';

alter table letterboxd_match_claims enable row level security;


-- ---------------------------------------------------------------------------
-- 2. What the trusted table now records about itself
-- ---------------------------------------------------------------------------

alter table letterboxd_matches
  add column if not exists tier        text,
  add column if not exists claim_count integer;

comment on column letterboxd_matches.tier is
  'Which tier produced the claim that reached the trust threshold. Audit only.';
comment on column letterboxd_matches.claim_count is
  'How many distinct accounts had claimed this pair when it was promoted. Audit only; it is not maintained afterwards.';

-- Written under a rule that did not require the URI to be evidence. Not grandfathered,
-- because a poisoned row is indistinguishable from an honest one.
delete from letterboxd_matches;

comment on table letterboxd_matches is
  'Film URI to media item, shared across every account and read by the matcher''s T0 tier as exact truth. TRUSTED, and therefore never written directly by an import: rows arrive only through _import_promote_match, once import.match_trust_claims distinct accounts have independently claimed the same pair in letterboxd_match_claims. Holds no user data -- the attribution lives on the claims. No RLS policy, so clients cannot read it at all; the matching worker runs as service_role and bypasses row security.';


-- ---------------------------------------------------------------------------
-- 3. The one place a trusted mapping can be created
-- ---------------------------------------------------------------------------

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
  'Records one account''s claim that a film URI denotes a media item, and promotes the pair into the trusted letterboxd_matches only once import.match_trust_claims distinct accounts have claimed it. The single writer of that table. Never overwrites an existing trusted mapping, so a later crowd cannot unseat an earlier one and an attacker gains nothing by bringing a second account to a URI somebody already established. Internal.';

revoke execute on function _import_promote_match(text, uuid, uuid, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The local tier claims instead of asserting
--
-- Re-emitted from `20260917000300` with the trailing cache insert replaced. Everything
-- above the insert -- the T0/T1/T1b tiers, the ambiguity rule, the candidates column -- is
-- byte-identical to that definition.
-- ---------------------------------------------------------------------------

create or replace function _import_match_batch(p_job_id uuid, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done integer := 0;
  v_user uuid;
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
           -- T0. An exact, previously **corroborated** film.
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
  -- A CLAIM, NOT AN ASSERTION
  --
  -- The evidence bar is unchanged and still worth stating: only a unique squashed title
  -- whose year agrees with the catalogue row's release date to within one. T1b -- a match
  -- against an undated catalogue row -- is still excluded, because the catalogue is a cache
  -- of whatever anybody searched for and a stub for one *Nosferatu* would otherwise speak
  -- for another.
  --
  -- What changed is where it goes. This is now one account saying so. It becomes shared
  -- truth when another account, independently, says the same thing.
  -- ---------------------------------------------------------------------------
  if v_user is not null then
    perform _import_promote_match(r.uri, r.media_item_id, v_user, 'local')
      from (
        select distinct r.raw->>'filmUri' as uri, r.media_item_id
          from import_rows r
          join media_items mi on mi.id = r.media_item_id
         where r.job_id = p_job_id
           and r.status = 'matched'
           and r.media_item_id is not null
           and r.raw->>'filmUri' is not null
           and (r.raw->>'year') is not null
           and mi.release_date is not null
           and abs(extract(year from mi.release_date)::integer - (r.raw->>'year')::integer) <= 1
      ) r;
  end if;

  return v_done;
end;
$$;

comment on function _import_match_batch(uuid, integer) is
  'One bounded slice of local matching: the trusted film-URI cache first, then exactly-one squashed title with a year within one. Two or more survivors is ambiguous and stays unresolved -- a remake picked by popularity is a film the person did not watch, carrying a rating they gave to a different one. Anything unresolved becomes needs_provider rather than unmatched, so an unconfigured project does not permanently condemn titles a provider would have found. Strong matches are recorded as claims and shared only once another account agrees; see _import_promote_match. Internal.';

revoke execute on function _import_match_batch(uuid, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. And so does the provider tier
--
-- Re-emitted with the same substitution, and for a sharper reason: the provider chose its
-- media item by searching TMDB for the client's own name and year, so its confidence is
-- about the title, never about the URI.
-- ---------------------------------------------------------------------------

create or replace function _import_provider_resolve(p_row_id uuid, p_media_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uri  text;
  v_year integer;
  v_user uuid;
begin
  if p_media_item_id is not null then
    update import_rows
       set media_item_id = p_media_item_id, status = 'matched', candidates = null
     where id = p_row_id
    returning raw->>'filmUri', (raw->>'year')::integer into v_uri, v_year;

    select j.user_id into v_user
      from import_rows r join import_jobs j on j.id = r.job_id
     where r.id = p_row_id;

    -- Only a FILM uri can reach this: it reads `raw->>'filmUri'`, which `import_stage`
    -- builds from the client's `filmUri` field alone and never from a `watches` element.
    -- And only a match the years agreed on -- `match.mjs`'s `isConfident` accepts on the
    -- squashed title alone when the export had no year, which is weaker than this bar.
    if v_uri is not null and v_year is not null and v_user is not null then
      perform _import_promote_match(v_uri, p_media_item_id, v_user, 'provider')
        from media_items mi
       where mi.id = p_media_item_id
         and mi.release_date is not null
         and abs(extract(year from mi.release_date)::integer - v_year) <= 1;
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
  'Records what the provider worker found for one row, or that it found nothing. A null media item leaves the row retryable until its third attempt and then settles it as unmatched -- a transient provider failure and an unknown film must not look the same. A resolved row records a CLAIM on letterboxd_match_claims, film URIs only: the provider searched TMDB by the client''s own name and year and never dereferenced the URI, so its confidence is about the title and cannot establish the binding alone. service_role only.';

revoke execute on function _import_provider_resolve(uuid, uuid) from public, anon, authenticated;
grant execute on function _import_provider_resolve(uuid, uuid) to service_role;
