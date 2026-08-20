-- One provider request per stale facet, however many people ask at once.
-- Specification: independent review 08, 2026-08-16.
--
-- ---------------------------------------------------------------------------
-- 1. The failure this closes
--
-- `similar` (added 2026-08-16) is the first adapter action a *user* can trigger that
-- spends provider quota on a shared resource. Its first implementation read the
-- facet, saw it stale, called TMDB, and wrote the result — with a comment claiming
-- that "two devices opening For You at the same moment" would not each pay for the
-- same list.
--
-- That comment was wrong. Read-then-write is not a claim: every concurrent caller
-- observes the same stale facet and every one of them spends. The per-user hourly
-- ceiling in 20260815000000 cannot help, because the callers are different users —
-- which is exactly the population that shares an anchor. A film in a lot of people's
-- top ten is the *most* likely list to be requested by several accounts at once.
--
-- ---------------------------------------------------------------------------
-- 2. Why the primary key is the whole mechanism
--
-- `media_cache` is already `primary key (media_item_id, facet)`, so an insert against
-- an occupied slot conflicts, and Postgres takes a row lock to resolve it. That is a
-- mutual exclusion primitive already sitting in the schema — no advisory lock, no
-- reservation table, no new state to reconcile.
--
-- The whole claim is one statement:
--
--   insert ... on conflict do update ... where media_cache.expires_at <= now()
--
-- A caller that inserts, or that updates because the row had expired, has the claim.
-- A caller that conflicts with an unexpired row does not — `returning` yields nothing
-- and the `where` is what makes "unexpired" mean "somebody else is handling it, or
-- the answer is already good". Both are reasons not to call TMDB.
--
-- WHY THE CLAIM EXPIRES IN TWO MINUTES AND NOT AT THE FACET TTL
--
-- A claim is a promise to go and fetch, and a promise can be broken: the isolate can
-- be killed, TMDB can hang, the request can fail. Two minutes is comfortably longer
-- than any adapter invocation and short enough that a broken promise costs one
-- refresh cycle rather than a facet that stays empty for weeks. The successful path
-- overwrites it moments later with the real payload and the real TTL.
--
-- WHAT A READER SEES DURING A CLAIM
--
-- A row whose payload is `{"claimed_at": ...}` and has no `ids`. Every reader of this
-- facet already treats a payload without `ids` as an empty list, so a claim reads as
-- "nothing cached yet" for up to two minutes. That is the correct answer while
-- somebody is fetching, and it is why the claim payload deliberately does not look
-- like a result.
--
-- WHAT THIS COSTS
--
-- A stale-but-present facet is replaced by the claim rather than served while the
-- refresh runs. So a refresh briefly turns old data into no data, instead of old data
-- into new data. That is the wrong trade for a facet somebody is *looking at* — and
-- the right one here, because `similar` is never rendered directly: it is one input
-- to a slate that has a popularity fallback for exactly this case.
-- ---------------------------------------------------------------------------

create or replace function tmdb_claim_facet(p_media_item_id uuid, p_facet text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  insert into media_cache (media_item_id, facet, payload, fetched_at, expires_at)
  values (
    p_media_item_id,
    p_facet,
    jsonb_build_object('claimed_at', now()),
    now(),
    now() + interval '2 minutes'
  )
  on conflict (media_item_id, facet) do update
    set payload    = excluded.payload,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    -- The only line that decides anything. An unexpired row means either a good
    -- answer or somebody already fetching one, and neither wants a second request.
    where media_cache.expires_at <= now()
  returning true into v_claimed;

  -- `returning ... into` leaves the variable null when no row was inserted or
  -- updated, which is the losing case. Not `found`: found is true for the statement
  -- having run, not for the conflict having been resolved in our favour.
  return coalesce(v_claimed, false);
end;
$$;

comment on function tmdb_claim_facet(uuid, text) is
  'Atomically claims the right to refresh one facet, using media_cache''s own primary key as the lock. Returns true to exactly one caller while the facet is absent or expired, and false to everyone else. The claim is a two-minute placeholder payload carrying no ids, so a reader sees "nothing cached" rather than stale data while a refresh is in flight. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. Privileges
--
-- Reachable only by the adapter, like every other tmdb_ function. Postgres grants
-- EXECUTE to PUBLIC on creation, so the revoke does the work and the grant records
-- the intent (20260813001800, and `function-grants.test.mjs`, which fails on this
-- becoming client-reachable).
--
-- A client holding this could evict any cached facet in the catalogue by claiming it
-- and never fetching — two minutes at a time, indefinitely.
-- ---------------------------------------------------------------------------

revoke execute on function tmdb_claim_facet(uuid, text) from public, anon, authenticated;
grant  execute on function tmdb_claim_facet(uuid, text) to service_role;
