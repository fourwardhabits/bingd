# Recommendation Engine V2 — scale benchmark (A3, founder spec §7)

> **SYNTHETIC DATA on one local machine.** Every number here comes from a generated workload
> in a private PostgreSQL 17.10 cluster on a 4-CPU, 16 GB container with stock memory
> settings (`shared_buffers` 128 MB, `work_mem` 4 MB). They show how the A1/A2 server
> functions scale and where they stop scaling. They are **not** production latencies:
> production adds PostgREST, the network, a different machine and a different cache, and
> real data has a different shape from this generator.

Script: [`scripts/rec-eval/scale-bench.mjs`](../../scripts/rec-eval/scale-bench.mjs). The
evaluation of ranking *quality* is separate: [`recommendations-v2-evaluation.md`](./recommendations-v2-evaluation.md).

## 1. How to run it

PostgreSQL refuses to run as root, so the script is run as an ordinary user (`postgres` here):

```bash
node scripts/rec-eval/scale-bench.mjs --users 1000000 --titles 200000 --concurrency 8 --plans --out /path/to/dir
```

It boots a throwaway cluster on a free port (the `test:race` harness), applies **every
migration verbatim**, loads the workload, measures, writes `results.json`, `results.md` and
`plans.txt` to `--out`, and deletes the cluster. It connects to nothing else. It is not an
`npm run` alias, because `package.json` `scripts` is an input to the Expo runtime
fingerprint. One run: about 4 minutes at 100k accounts, about 15 at 1M.

## 2. The workload

| | 100k tier | 1M tier |
|---|---|---|
| Accounts | 100,000 | 1,000,000 |
| …never ranked anything / casual (3–20) / engaged (20–200) / power (200–1,500) | 55% / 35% / 8.5% / 1.5% | same |
| Rankings | 1,529,251 (415 MB with indexes) | 16,178,512 (4.4 GB) |
| Catalogue rows (`media_items`: films, series, seasons) | 92,010 | 302,009 |
| Raters of the most popular title | 26,148 | 248,364 |

- **Skew.** Each pick is log-uniform over popularity rank (Zipf, s ≈ 1), so the head title is
  ranked by a quarter of active accounts at 1M. That is the case the rater cap exists for.
- **Taste.** Buckets follow eight clusters (three tied to non-English language groups), so
  Matches genuinely vary.
- **Visibility.** 85% of accounts are public, 1% are suspended, and a few are blocked.
- **Languages.** 14 original languages, English 55%.
- **What the load skips.** It runs with `session_replication_role = replica`, so ranking
  triggers (awards, Watchlist exits) do not fire. Those are write-path costs V2 does not add
  to.
- **What it leaves out.** Follows are not loaded: no V2 function reads them, which is the
  point of V2. `user_media` is loaded for the measured readers only, because every V2 read
  of it is keyed by the caller.
- **The measured readers.** 28 per size tier, all public and active: casual, engaged, power
  and non-English-cluster accounts (at 1M: 12 casual, 10 engaged, 6 power). Six power readers
  is a thin sample; their p95 is close to their maximum.
- **Engine.** Set to `v2_hybrid` at 100% **in the throwaway cluster only**.

## 3. Results, final code (2026-11-11)

The 1M tier is the target; the 100k tier is the same workload a tenth the size.

| Call (ms) | 100k p50 / p95 | 1M p50 / p95 | 1M max |
|---|---|---|---|
| `recommendation_engine()` | 0.4 / 0.7 | 0.5 / 0.6 | 3.3 |
| `catalogue_candidates` (3 languages + 2 decades) | 3.5 / 4.7 | 3.3 / 8.2 | 10.2 |
| `collaborative_candidates`, **cold** (includes the neighbour refresh) | 303 / 590 | 279 / 620 | 714 |
| `collaborative_candidates`, **warm** (cache fresh) | 142 / 173 | 147 / 239 | 366 |
| `people_taste_matches(10)`, **existing**, People screen, not For You | 630 / 2,904 | **8,766 / 28,577** | **30,892** |

| 1M, by tier | rankings p50 | cold p50 / p95 | warm p50 / p95 | neighbours found p50 |
|---|---|---|---|---|
| casual | 11.5 | 112 / 257 | 41 / 176 | 6 |
| engaged | 56.5 | 300 / 373 | 158 / 185 | 40 |
| power | 497 | 505 / 705 | 155 / 338 | 40 |

**Concurrency, 1M.** 8 sessions doing cold refreshes for 32 different readers at once took
2.1 s, which is 14.9 refreshes/s on 4 CPUs (call p50 385 ms, p95 792 ms). Two other sessions
inserted rankings the whole time: p50 3.9 ms, p95 12 ms, max 25 ms. No write waited on a
refresh. That is **by construction** rather than measured: a refresh takes only a per-reader
advisory lock and writes only the reader's own cache rows, and reads `rankings` without
locking it. What the writer numbers show is only that nothing blocked. They are bare INSERTs
with triggers off, on dormant accounts, with no baseline run without refreshes, so they do
not measure how much CPU contention from refreshes slows a real ranking write (writer p50 was
1.2 ms at 100k and 3.9 ms at 1M under that contention). The concurrent figure is one 2.1 s
burst of 32 calls.

**A2's index on `rankings`, 1M.**

| Build | Time | Size |
|---|---|---|
| Plain, inside the migration | 12.7 s, during which every ranking write waits | 767 MB |
| `create index concurrently` | 18.1 s, writes continue | |

That is why the docs ask for a hand-built `concurrently` index before `db push` on a large
table (`recommendations-v2.md` §1.5 and §2.6).

### 3.1 100k tier, before and after the review fixes

These are the comparative evidence for the 2026-11-11 changes, on identical data:

| 100k, p50 / p95 (ms) | as first submitted | after the A1/A2 review fixes | final (+ hashed semi-join) |
|---|---|---|---|
| `catalogue_candidates` | 19.4 / 24.6 | 3.8 / 13.6 | 3.5 / 4.7 |
| cold `collaborative_candidates` | 747 / 1,158 | 297 / 979 | 303 / 590 |
| warm `collaborative_candidates` | 205 / 256 | 134 / 202 | 142 / 173 |
| power readers, cold p50 | 1,115 | 860 | 545 |
| concurrent cold refreshes/s (8 sessions) | 4.8 | 14.1 | 15.4 |
| `people_taste_matches(10)` (unchanged code) | 471 / 2,444 | 591 / 2,532 | 630 / 2,904 |

What each fix bought:

- **The decade index (A1).** The catalogue read's p50 went from 19 ms to 4 ms. Before, the
  era window bitmap-scanned every title of the decade and sorted them; now it is an ordered
  index range (plans in §4).
- **Scoring only shared titles, and one category per read (A2).** Cold p50 went from 747 to
  297 ms, warm from 205 to 134 ms, and concurrent throughput tripled.
- **The hashed semi-join (A2).** The captured plan for a power reader showed a linear
  `media_item_id = any(<851-element array>)` check over the ~70,000 rankings of the
  shortlist: 580 of an 870 ms refresh. `in (select unnest(…))` is hashed. The 1M numbers above
  include this fix.

## 4. Plans (EXPLAIN ANALYZE, from `auto_explain` inside the functions)

Full output is written to `plans.txt` by `--plans`. The excerpts here are from the final-code
100k run. The 1M run's refresh plans have the same shapes (including the hashed semi-join);
the catalogue-window EXPLAINs were added after the 1M run, so they exist at 100k only.

**The catalogue windows: one ordered index range each, at default planner settings.**

```text
catalogue window, decade 1990
Limit (actual time=0.023..0.058 rows=60)
  ->  Index Scan using media_items_catalogue_decade on media_items mi (actual rows=60)
        Index Cond: ((kind = 'movie') AND ((((EXTRACT(year FROM release_date))::integer / 10) * 10) = 1990))
        Filter: (release_date <= CURRENT_DATE)
        Buffers: shared hit=15
Execution Time: 0.075 ms

catalogue window, language ja
Limit (actual time=0.012..0.054 rows=60)
  ->  Index Scan using media_items_catalogue_language on media_items mi (actual rows=60)
        Index Cond: ((kind = 'movie') AND (original_language = 'ja'))
Execution Time: 0.065 ms
```

**The shortlist's rankings of a power reader's 851 titles, inside `_taste_matches`.** Before
the hashed semi-join, the same scan took 585 of the statement's 865 ms, because each of the
~70,000 rows was checked linearly against an 851-element array:

```text
Hash Join (actual time=62.753..253.216 rows=16988)
  ->  Bitmap Heap Scan on rankings r (actual time=4.922..24.403 rows=16988)
        Filter: (... ($3 IS NULL) OR (ANY (media_item_id = (hashed SubPlan 1).col1)))
        Rows Removed by Filter: 52584
  ->  Hash
        ->  GroupAggregate                    -- band sizes of the 200 shortlisted people
              ->  Sort  Sort Method: external merge  Disk: 2320kB
```

What is left in that statement:

- **Per-row scoring.** About 17,000 `score_for` calls make up roughly 170 ms.
- **The band-size aggregate.** It counts all ~70,000 rankings of the shortlist, and with the
  stock 4 MB `work_mem` its sort spills to disk. A larger `work_mem` for this role, or an
  index carrying `bucket`, would remove the spill. Neither is needed at the measured cost.
- **A generic plan.** The function's arguments arrive as parameters, so the planner estimates
  one row where there are thousands. The plan is still the right shape.

## 5. Capacity, and where it stops

**For You at 1M accounts is bounded per reader, not per population.**

- **A refresh is not cost-free, but it is bounded.**
  - Its cost has three parts: 40 probe titles × ≤ 50 sampled raters; 200 shortlisted
    people's band counts; and the shortlist's rankings of the reader's own titles.
  - So it grows with how much *the reader* has ranked, not with how many accounts exist. A
    power reader is the worst case: about 0.5–0.7 s.
  - It happens at most once per reader per 24 h (every 3 h for a reader with no
    neighbours).
- **Budget, both halves.** Assume 1M accounts, 10% opening For You on a given day, about
  three wall fetches each (the client caches a slate for 30 minutes), and two reads per fetch
  (films and TV).

  | Database time per day (v2_hybrid for everybody) | | |
  |---|---|---|
  | Refreshes | 100,000 × ~0.3 s | ≈ 30,000 s |
  | Warm reads | 600,000 × ~0.15 s | ≈ 90,000 s |
  | Total | | ≈ 120,000 s ≈ 1.4 CPUs on average, ~7 at a 5× peak |

  **Warm reads are about three quarters of it.** They rescore up to 40 neighbours' rankings
  on every call, because only the neighbour list is cached.
- **So the warm read needs a cache before `v2_hybrid` goes beyond the allowlist.**
  - Cache the aggregated rows per reader, with the neighbour list's TTL. It is an additive
    table and needs no redesign.
  - That reduces the budget to roughly the refresh half.
  - For the allowlist and dogfood stage the hybrid is classed for, the cost is negligible.
  - `v2_metadata`, the rollout candidate, never calls `collaborative_candidates`: its server
    cost is the catalogue read (≈ 3–8 ms).
- **Cache caveat.** Every timing follows the load on a machine whose 16 GB holds the 4.4 GB
  rankings table, so the shortlist's rankings are in memory. With a working set larger than
  RAM, refreshes read from disk and get slower; this benchmark does not show by how much.
- **Neighbour yield falls with population for light readers.**
  - At 1M a casual reader's median was 6 neighbours, against 24 at 100k.
  - Sampling 50 raters of a title with 250,000 raters finds fewer people who share the
    reader's few other titles.
  - Engaged and power readers still fill all 40.
  - This is the price of the rater cap (§7 rules out exact top-k), and it lowers the hybrid's
    reach for exactly the readers with least evidence. The levers are a larger
    `neighbour_raters_per_title` (not measured here; the sampling step's cost should grow
    roughly linearly with it), or probing less popular titles first, which the probe already
    prefers.
- **Index builds** scale linearly: 1.2–1.4 s per 1.5M rankings, 12.7 s per 16M. Build
  `concurrently` by hand on a large table.
- **`people_taste_matches` fails the 1M target. It is not V2's code, but it is a §7 blocker
  for the People screen.**
  - The People-screen RPC (`20260826000500`, unchanged here) scans every ranking that shares
    any of the caller's titles before limiting.
  - At 1M accounts it takes 2.9 s for a casual reader and 26–31 s for a power reader. That
    is beyond a typical API statement timeout (Supabase's default for `authenticated` is
    8 s).
  - Its p50 over all 1M readers was 8.8 s, so most engaged and power readers would hit the
    timeout today at that scale. At 100k accounts it is 0.6 s p50 and 2.9 s p95.
  - The gap analysis named this as a risk. It is now a measured failure at the target scale,
    raised to the founder. The fix is outside these PRs: its candidate set should come from
    the same bounded neighbour retrieval `_refresh_taste_neighbours` uses.

## 6. Limits

- One machine, one run per tier, stock memory settings, a warm cache after the load.
- The workload model decides the overlap structure. Real overlap could be denser (a smaller
  catalogue) or sparser.
- PostgREST, connection pooling and the network are not in these numbers.
- `media_items` at 300k rows is a guess at a 1M-user catalogue.
- Nothing here has been run against staging or production. A staging run of this script's
  read half, against a copy of real data and with founder approval, is the next step (see
  the PR's validation steps).
