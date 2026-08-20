-- What TMDB's readers wrote, and who worked on what.
-- Specification: master prompt Phase E (E2 TMDB Reviews, E3 Person discovery) ·
-- PRD §19 (provider retention) · docs/reference/tmdb-integration.md.
--
-- Two provider surfaces arrive together because they are the same architectural
-- question asked twice: where does provider data live when it belongs to something
-- other than a title this database already holds. One of them has an answer already
-- (`media_cache`, keyed on a media item) and one does not (a person is not a media
-- item and never will be).
--
-- ===========================================================================
-- 1. A reviews facet
--
-- TMDB publishes reviews written by **its own site's users**. They are not critics,
-- not professionals, and not a community of Bingd's. The product decision that
-- follows from that is a labelling one and it is enforced in the client, but it is
-- worth stating at the storage layer too, because the name of this facet is what a
-- future reader will reach for when they want "the reviews": there is exactly one
-- kind of review in this schema and it is TMDB's, in TMDB's words, attributed to
-- TMDB's authors.
--
-- Bingd's own three text-or-number surfaces stay entirely separate and none of them
-- is stored here: `community_score` is an aggregate over `rankings`, a user Note is
-- `user_media.note`, and a Feed comment is a `comments` row. Nothing in this
-- migration touches any of them.
--
-- It is a facet rather than a table for the same reason `credits` is: it is provider
-- data about one title, it expires, and `media_cache` already carries the whole
-- lifecycle contract — jsonb payload, `expires_at` derived from `app_config`, capped
-- at the retention window, world-readable because a catalogue fact is not anybody's
-- private data.
--
-- WHY 24 HOURS AND NOT THE `credits` HORIZON
--
-- A cast list is settled once a film is released; a review list is not — it is the
-- one facet here that grows for as long as people keep watching the film. A day is
-- short enough that a title in its opening week is not stuck showing three reviews
-- for a fortnight, and long enough that a popular title is fetched once a day rather
-- than once a viewer. It is also simply the `tmdb_put_facet` default, so this insert
-- records the intent rather than changing the behaviour.
--
-- WHY SEASONS ARE ABSENT AND THAT IS NOT A GAP
--
-- TMDB has no season-level reviews endpoint. /tv/{id}/reviews exists and returns
-- reviews of the *series*; presenting those on a season page would attribute to
-- "Season 2" text somebody wrote about the show. So a season simply has no reviews
-- facet, the adapter never writes one, and the screen omits the section — which is
-- the same rule the Videos tab already follows.
-- ===========================================================================

alter table media_cache drop constraint media_cache_known_facet;

alter table media_cache
  add constraint media_cache_known_facet
  check (facet in ('credits', 'keywords', 'providers', 'similar', 'videos', 'reviews'));

comment on table media_cache is
  'Provider metadata too large or too volatile for media_items, one row per facet. Facets are a closed set so an unknown one is a failed write rather than a row nothing reads. `videos` was added 2026-08-16 with the title-page redesign; `reviews` was added 2026-08-17 and holds TMDB site users'' reviews, which are neither critic reviews nor anything of Bingd''s.';

update app_config
   set value = value || '{"reviews": 24}'::jsonb
 where key = 'tmdb.cache_ttl_hours';

insert into app_config (key, value)
values ('tmdb.cache_ttl_hours', '{"reviews": 24}'::jsonb)
on conflict (key) do nothing;

-- ===========================================================================
-- 2. Somewhere to keep a person
--
-- The person page as it stood answered one question — "which of the titles already
-- in this database do they appear in" — by scanning `media_cache.credits` payloads
-- for their id. That is a real query and the GIN index in 20260816000500 serves it
-- well, but the question is the wrong one. Somebody who has just tapped a face wants
-- to know what else that person has worked on; answering with a filtered view of the
-- viewer's own catalogue means a newly-enriched database shows an actor with two
-- credits, and a fresh install shows them with none.
--
-- So the page needs TMDB's filmography, which means caching a person — and a person
-- is the first provider entity in this schema that is not a title.
--
-- WHY NOT media_cache
--
-- Its primary key is `(media_item_id, facet)` with `media_item_id not null references
-- media_items(id)`. A person has no media item to hang from, and inventing one is the
-- sentinel-row idea 20260816000900 already rejected: `media_items` is the one
-- unrestricted read in the schema, so a fake row appears in search, and both
-- `media_refresh_due` and `tmdb_enrich_due` would have to learn to skip it.
--
-- WHY NOT provider_list_cache
--
-- Closer — it is already the sibling table for provider data belonging to no single
-- title — but its key is a closed set of four literal strings and its writer enforces
-- that the payload is `{"ids": [...]}`. A person is an unbounded key space and its
-- payload is a record plus an ordered list, not an ordered list. Widening both would
-- leave one table whose contract is "anything", which is how a cache stops being
-- checkable.
--
-- So: a third sibling with the same lifecycle contract and a key of its own. The
-- pattern is now established rather than improvised — jsonb payload, `fetched_at`,
-- `expires_at` from `app_config`, closed shape enforced by the writer, world-readable.
--
-- WHY THE PAYLOAD HOLDS media_items IDS AND NOT TITLE METADATA
--
-- Exactly the reason `provider_list_cache` does. The adapter writes every credited
-- title through `tmdb_upsert_titles` before it writes this row, so posters, years and
-- overviews live in `media_items` where they observe the retention window and the
-- refresh job. This payload holds the person's own record and, per credit, the two
-- facts `media_items` cannot hold: which Bingd id it is, and what this person did in
-- it. A character name is a property of the pairing, not of the film.
--
-- WHY THE KEY IS TMDB'S ID AND NOT A BINGD UUID
--
-- Because there is no Bingd person. Minting one would be a second identity to
-- reconcile with the provider's on every refresh, for an entity the product never
-- needs to reference from anywhere except a route parameter that is already the TMDB
-- id (`/person/{id}`, reached from a `credits` payload whose ids are TMDB's).
-- ===========================================================================

create table person_cache (
  tmdb_person_id bigint      not null,
  payload        jsonb       not null,
  fetched_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  primary key (tmdb_person_id),

  -- A TMDB person id is a positive integer. The client already refuses anything else
  -- before it builds a request; this is the same statement made where it cannot be
  -- bypassed by a caller that forgets.
  constraint person_cache_id_positive check (tmdb_person_id > 0)
);

comment on table person_cache is
  'One cached TMDB person: their record, and an ordered list of the titles they are credited on. Third sibling of media_cache and provider_list_cache, with the same lifecycle (jsonb payload, expires_at from app_config, world-readable) and a key of its own, because a person is neither a media item nor a global list. The credited titles themselves are written through tmdb_upsert_titles first, so their metadata expires on the retention clock rather than on this one.';

comment on column person_cache.payload is
  'A person record and their credits: {"person": {"name": ..., "biography": ..., "profile_path": ..., "known_for": ..., "birthday": ..., "place_of_birth": ...}, "credits": [{"id": <media_items uuid>, "kind": "movie"|"series", "role": "...", "as": "cast"|"crew"}], "credit_total": <how many TMDB had>}. Ordered by provider popularity, most relevant first. A payload with no `credits` key is a claim placeholder, not a person with no work.';

-- ---------------------------------------------------------------------------
-- Reading it
--
-- World-readable, exactly like media_cache, media_items and provider_list_cache. A
-- filmography is catalogue metadata and says nothing about any account. Note what
-- this table deliberately does **not** hold: nothing viewer-relative. Whether the
-- reader has ranked, watched or saved a credited title is answered by the tables that
-- already answer it, under the policies that already gate them.
--
-- A reader must filter `expires_at > now()` itself, which is how media_cache behaves
-- too: expiry marks a row stale for a refresh, and nothing deletes it out from under
-- a client mid-render.
-- ---------------------------------------------------------------------------

alter table person_cache enable row level security;

create policy person_cache_read on person_cache for select using (true);

-- ---------------------------------------------------------------------------
-- Writing it
--
-- Shaped like tmdb_put_facet and tmdb_put_list, for the reasons 20260815000000
-- states: `expires_at` is not nullable, and AD-8 requires the TTL to come from
-- `app_config` rather than from a constant inside the adapter, where a change in
-- TMDB's terms would never reach it.
--
-- Seven days. A filmography changes when somebody is cast in something, which is not
-- a same-day fact, and the cost of being a week behind on an announced project is
-- lower than the cost of re-fetching a two-hundred-credit person for every viewer.
-- The 3600-hour ceiling is carried over unchanged from its two siblings so that no
-- future key can configure its way past the retention window.
--
-- The payload shape is checked here rather than by a constraint for the reason
-- tmdb_put_list gives: a check constraint reports 23514 with no indication of which
-- half was wrong, and this function is the only writer.
-- ---------------------------------------------------------------------------

update app_config
   set value = value || '{"person": 168}'::jsonb
 where key = 'tmdb.cache_ttl_hours';

insert into app_config (key, value)
values ('tmdb.cache_ttl_hours', '{"person": 168}'::jsonb)
on conflict (key) do nothing;

create or replace function tmdb_put_person(p_person_id bigint, p_payload jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours   integer;
  v_expires timestamptz;
begin
  if jsonb_typeof(p_payload -> 'credits') is distinct from 'array' then
    raise exception 'tmdb_put_person: payload must carry a credits array'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'person') is distinct from 'object' then
    raise exception 'tmdb_put_person: payload must carry a person object'
      using errcode = '22023';
  end if;

  v_hours := coalesce(
    (select (value ->> 'person')::integer from app_config
      where key = 'tmdb.cache_ttl_hours'),
    -- Reached only if the config row is absent entirely, which is the failure mode
    -- 20260813002100 exists to warn about: a missing row makes the subquery return
    -- no rows rather than null, and an unguarded coalesce never runs.
    168
  );

  v_hours := least(v_hours, 3600);

  insert into person_cache (tmdb_person_id, payload, fetched_at, expires_at)
  values (p_person_id, p_payload, now(), now() + (v_hours * interval '1 hour'))
  on conflict (tmdb_person_id)
  do update set payload    = excluded.payload,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

comment on function tmdb_put_person(bigint, jsonb) is
  'Replaces one cached person whole, with an expiry derived from app_config.tmdb.cache_ttl_hours -> person, capped at the six-month retention window. Whole rather than merged, for the reason tmdb_put_list is: a filmography is an ordering, and merging two of them leaves credits behind that the provider has since corrected. service_role only.';

-- ---------------------------------------------------------------------------
-- Claiming one
--
-- The same mechanism, and the same argument, as tmdb_claim_facet (20260816001000).
-- `person` is a user-triggered action that spends provider quota on a shared
-- resource, so a read-then-write freshness check guarantees nothing: everybody who
-- opens the same actor at the same moment sees it stale and everybody spends. The
-- per-user hourly ceiling cannot help, because they are different users — and a
-- popular actor is precisely the person several accounts open at once.
--
-- The primary key is the whole lock. A caller that inserts, or that updates because
-- the row had expired, has the claim; a caller that conflicts with an unexpired row
-- does not, and `returning` yields nothing to say so.
--
-- Two minutes for the reason the facet claim uses two minutes: a claim is a promise
-- to go and fetch, and a broken promise should cost one refresh cycle rather than a
-- person who stays blank for a week. The placeholder carries `claimed_at` and no
-- `credits`, so a reader sees "not cached yet" rather than a filmography of nothing.
--
-- Unlike the facet claim, this one costs almost nothing when it loses: the person
-- page's fetch is a background refresh behind a screen that renders from whatever is
-- cached. A losing caller shows the previous filmography, or the empty state, and the
-- winner's write arrives on the next query.
-- ---------------------------------------------------------------------------

create or replace function tmdb_claim_person(p_person_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into person_cache (tmdb_person_id, payload, fetched_at, expires_at)
  values (
    p_person_id,
    jsonb_build_object('claimed_at', now()),
    now(),
    now() + interval '2 minutes'
  )
  on conflict (tmdb_person_id) do update
    set payload    = excluded.payload,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    where person_cache.expires_at <= now()
  returning true into v_claimed;

  -- Null when no row was inserted or updated, which is the losing case. Not `found`:
  -- found is true for the statement having run, not for the conflict having been
  -- resolved in our favour.
  return coalesce(v_claimed, false);
end;
$$;

comment on function tmdb_claim_person(bigint) is
  'Atomically claims the right to refresh one cached person, using person_cache''s own primary key as the lock. True to exactly one caller while the row is absent or expired, false to everyone else. The claim is a two-minute placeholder carrying no credits, so a reader sees "not cached" rather than an empty filmography. service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Reachable only by the adapter, like every other tmdb_ function. Postgres grants
-- EXECUTE to PUBLIC on creation, so the revoke does the work and the grant records
-- the intent — see 20260813001800 and function-grants.test.mjs, which fails on either
-- of these becoming client-reachable.
--
-- A client holding tmdb_put_person could write any filmography it liked onto any
-- person id, and every viewer of that page would render it. A client holding
-- tmdb_claim_person could keep any person blank indefinitely, two minutes at a time.
-- Clients read the table directly under the policy above; they have no reason to
-- write one and no way to.
-- ---------------------------------------------------------------------------

revoke execute on function tmdb_put_person(bigint, jsonb)   from public, anon, authenticated;
grant  execute on function tmdb_put_person(bigint, jsonb)   to service_role;

revoke execute on function tmdb_claim_person(bigint)        from public, anon, authenticated;
grant  execute on function tmdb_claim_person(bigint)        to service_role;

-- ===========================================================================
-- 3. An index that has stopped answering anything
--
-- `media_cache_credits_payload` was added by 20260816000500 to serve exactly one
-- query: the old person page's "which credits payloads mention this person", a jsonb
-- containment match. That page is gone — it is now a filmography from `person_cache`
-- — and nothing else in the repository does containment on `media_cache`. The only
-- remaining reader of the credits facet is `use-credits.ts`, which looks a row up by
-- `(media_item_id, facet)`, which is the primary key.
--
-- Dropped rather than left in place, because a GIN index is not free where it is
-- unused: every title enrichment writes a credits facet, and each of those writes now
-- maintains posting lists for a query nobody makes. It is also the honest record —
-- an index whose only caller has been deleted is a claim that the query still exists.
--
-- Reversible in one statement if a containment query ever returns, and the statement
-- is in 20260816000500 where its reasoning still stands.
-- ===========================================================================

drop index if exists media_cache_credits_payload;
