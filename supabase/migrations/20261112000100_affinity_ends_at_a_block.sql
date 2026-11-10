-- Affinity notifications, B1: bring draft #220's Affinity forward onto main (founder spec
-- 2026-11-10, §5 B1). Two changes, neither of which touches a weight, the 90-day lookback or
-- the 30-day half-life.
--
-- ## 1. A block ends affinity, whatever the history
--
-- `_proactive_affinity` (20261031000100) scores interaction between two people. Its callers
-- re-derive visibility themselves (`_proactive_social_actors`: active, mutual, viewable), and
-- it already forgets comments and comment reactions on activity whose *owner* the reader can
-- no longer view — a third person's block. It did not look at the pair itself: two people who
-- had blocked each other kept their recommendations, co-watches and reactions to each other's
-- posts, so the function answered a positive affinity for a pair that may not interact. No
-- current caller acts on that, but the function is the reusable answer to "how close are these
-- two", and the next caller (friend-activity eligibility, a reaction summary) should not have
-- to know to re-check. It now answers 0 when either has blocked the other or either account is
-- not active.
--
-- The original is renamed rather than copied, so its 150 lines stay exactly as reviewed. Its
-- callers resolve `_proactive_affinity` by name when they run, so they get the guarded one.
--
-- Unblocking restores the history: `blocks` keeps no record of a block once it is lifted, so
-- interaction from before it counts again while it is inside the 90-day window. Recorded as a
-- product decision in the handoff rather than invented here.
--
-- ## 2. The distribution, for choosing the threshold
--
-- The spec asks for the high-affinity threshold to come from an actual or realistically
-- simulated distribution. `proactive_affinity_distribution(sample)` is the "actual" half: a
-- service-role-only read that scores a bounded random sample of mutual pairs and returns
-- quantiles and threshold shares — never a pair, an id or a single person's value. An operator
-- runs it on staging and production before choosing `proactive.friend_min_affinity` (B2).

alter function _proactive_affinity(uuid, uuid, timestamptz) rename to _proactive_affinity_unguarded;
revoke execute on function _proactive_affinity_unguarded(uuid, uuid, timestamptz) from public, anon, authenticated;

create or replace function _proactive_affinity(p_reader uuid, p_actor uuid, p_now timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_reader is null or p_actor is null or p_reader = p_actor then 0::numeric
    when exists (
      select 1 from blocks b
       where (b.blocker_id = p_reader and b.blocked_id = p_actor)
          or (b.blocker_id = p_actor and b.blocked_id = p_reader)
    ) then 0::numeric
    when (select count(*) from profiles p where p.id in (p_reader, p_actor) and p.status = 'active') < 2
      then 0::numeric
    else _proactive_affinity_unguarded(p_reader, p_actor, p_now)
  end;
$$;

revoke execute on function _proactive_affinity(uuid, uuid, timestamptz) from public, anon, authenticated;

comment on function _proactive_affinity(uuid, uuid, timestamptz) is
  'Directional social-interaction affinity of p_reader toward p_actor (20261031000100), 0 for a '
  'blocked or inactive pair (20261112000100). Never displayed; notifications only. Internal.';

create or replace function proactive_affinity_distribution(p_sample integer default 2000)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_sample  integer := least(greatest(coalesce(p_sample, 2000), 50), 20000);
  v_rows    numeric;
  v_percent numeric;
  v_now     timestamptz := now();
  v_result  jsonb;
begin
  select greatest(reltuples, 1) into v_rows from pg_class where oid = 'public.follows'::regclass;
  -- Oversample: roughly half of approved follows are not mutual, and the sample is per row.
  v_percent := least(100, 100.0 * v_sample * 4 / coalesce(v_rows, 1));

  execute format($q$
    with sampled as (
      select f.follower_id as reader, f.followee_id as actor
        from follows f tablesample bernoulli (%s)
       where f.state = 'approved'
         and exists (select 1 from follows back
                      where back.follower_id = f.followee_id and back.followee_id = f.follower_id
                        and back.state = 'approved')
       limit %s
    -- Materialized: referenced once, the CTE would be inlined and the score recomputed
    -- in every aggregate below (fourteen times a pair).
    ), scored as materialized (
      select _proactive_affinity(reader, actor, $1) as a from sampled
    )
    select jsonb_build_object(
      'pairs', count(*),
      'mean', round(avg(a), 3),
      'quantiles', jsonb_build_object(
        'p50', percentile_cont(0.5)  within group (order by a),
        'p75', percentile_cont(0.75) within group (order by a),
        'p90', percentile_cont(0.9)  within group (order by a),
        'p95', percentile_cont(0.95) within group (order by a),
        'p99', percentile_cont(0.99) within group (order by a)),
      'share_at_least', jsonb_build_object(
        '0.75', round(avg((a >= 0.75)::int), 4),
        '1',    round(avg((a >= 1)::int), 4),
        '1.5',  round(avg((a >= 1.5)::int), 4),
        '2',    round(avg((a >= 2)::int), 4),
        '3',    round(avg((a >= 3)::int), 4),
        '4',    round(avg((a >= 4)::int), 4),
        '6',    round(avg((a >= 6)::int), 4)),
      'baseline_only', round(avg((a <= 0.5)::int), 4),
      'sample_percent', %s,
      'computed_at', $1)
      from scored
  $q$, v_percent, v_sample, v_percent)
  into v_result
  using v_now;
  return v_result;
end;
$$;

revoke execute on function proactive_affinity_distribution(integer) from public, anon, authenticated;
grant execute on function proactive_affinity_distribution(integer) to service_role;
