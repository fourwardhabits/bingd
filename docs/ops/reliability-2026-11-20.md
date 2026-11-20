# Reliability review, 2026-11-20

**What was measured, what was fixed, what is still open.** This was an overnight review of
database performance, background jobs and mobile release reliability, against `main` at
`ecd03517`, production at migration `20261130000300` and OTA `1c24b5cd`. It is
evidence-driven: every finding below names the number or the code that shows it. Claims that
could not be verified from here are marked as such.

How it was measured:

- **Production** (`abheeqyjzekiowkztfxv`) was read only. That covers catalog views,
  `pg_stat_statements` (on since 2026-08-13, `track = top`), `pg_stat_user_tables`,
  `cron.job_run_details`, `net._http_response` and plain `EXPLAIN`. Everything reported is an
  aggregate, with no account ids.
- **Staging** (`fjxhcbowoxuzulwirzyr`) took `EXPLAIN ANALYZE`, the before and after timings,
  and one migration (§5).

Production is small: 53 profiles, 2,295 feed events, 1,889 rankings, 27,073 titles. At this
size most tables are cheapest to read sequentially, and the planner does so. A sequential scan
of a table this size is not a finding. The findings are the costs that do not scale with page
size, or that already dominate at this size.

Job-by-job health queries and stop steps are in [background-jobs.md](background-jobs.md).

---

## 1. Ranked findings

### 1. The minute-by-minute cron history prune was 61% of all database time. **Fixed, on staging.**

`bingd-import-maintenance` runs every minute. Its last call,
`_import_prune_cron_history()`, deletes old rows from `cron.job_run_details`. That table's only
index is its primary key, so every prune is a full sequential scan. `bingd-release-evaluate`
does the same every 15 minutes.

| Production, read-only | Value |
|---|---|
| `cron.job_run_details` | 196,000 rows, 49 MB |
| sequential scans of it, ever / index scans | 101,493 / 0 |
| tuples read by those scans | 14.8 billion (146,000 per scan) |
| the maintenance statement's total execution time | **24,128 s of 39,333 s recorded (61%)** |
| the same, for every authenticated (app) query together | 8,083 s |
| maintenance runs, last 24 h | avg 400 ms, p50 150 ms, p95 2.1 s; 7-day max 10.3 s |
| `bingd-release-evaluate`, last 24 h | avg 438 ms, p95 2.5 s |

Staging has the same table shape (179,000 rows):

- the three-call maintenance job averaged 71 ms in `pg_stat_statements`;
- the two-call version that ran before the prune existed averaged 13 ms;
- the prune's `select` equivalent is a parallel seq scan taking 80 ms under EXPLAIN ANALYZE.

**Fix: #334 (`20261201000400`).** Each prune deletes once an hour (import at minute 17 UTC,
release at minute 0) and returns 0 on every other tick. The table goes from 64 scans an hour to
2. The schedules, commands, installers, retention windows (7 and 14 days, now up to an hour
later) and never-raise behaviour are unchanged. Test:
`supabase/tests/cron-history-prune.test.mjs`, 13 cases. Two mutants were tried, removing the
gate and reading the minute in the session time zone. Each turned tests red. Staging before and
after: §5.

### 2. A title page's credits read opened with an exact count of the whole cache. **Fixed, client.**

`useCredits` (`src/features/title/use-credits.ts`) first sent
`media_cache.select('*', { count: 'exact', head: true })` with no filter, then the one row it
needed. The count only short-circuits when the entire cache is empty, and the filtered read
already answers null in that case. It cost:

- 4,853 calls at a mean of 85 ms (max 7.0 s), 415 s in total, eleventh by total time;
- an extra serial round trip before the Cast section of every title page;
- a cost that grows with `media_cache`, which grows with every title anybody opens.

**Fix: #336.** The count is removed. The single remaining read and the null and missing
answers are pinned by `src/features/title/use-credits.test.ts`.

### 3. Following someone left the own profile's Following count stale. **Fixed, client.**

`useSocialWrites().refresh` invalidates 15 key families after a follow, unfollow or block, but
not `['profile-stats', viewer]`. That key is what the Profile tab's Followers and Following
counts read. `src/lib/query.ts` names it precisely because "following somebody changes two
accounts' numbers". The Profile tab stays mounted, and `refetchOnWindowFocus` is off, so after
following somebody from the Feed or People the count did not move until something else
refetched it. **Fix: #336**, which adds the key and pins it in
`src/features/profile/use-social.test.tsx`.

### 4. The Feed's cost per page is the followed accounts' whole history, not the page. Open.

The Feed query (`feed_events` with `actor_id = any(...)`, ordered by
`causal_at, causal_step, id`, limit 20) has no index that serves the order across many actors.
Plain `EXPLAIN` on production, for the account that follows the most people, plans a scan of
every matching event (estimated 236 rows) and a sort before the limit. Under RLS,
`can_i_view(actor_id)` runs on each of them.

On production this query is the top app statement: 6,752 calls, mean 154 ms, max 3.1 s, ≈2,100
buffer hits per call. The variant with `backdrop_path` adds 1,421 calls at a mean of 364 ms.
Without RLS on staging the same shape takes 2 ms, so the per-row policy is the cost. It grows
linearly with how much the people you follow have ever posted.

The usual remedies (a bounded time window per page, or a `security definer` feed RPC that
checks visibility once per actor rather than once per row) are design changes, not a small
fix. **Recommended next**, with an EXPLAIN ANALYZE on a staging dataset seeded to 10x
production first.

### 5. `report_device_context` costs about a second per app launch. Open, small.

It validates the timezone with
`select name from pg_timezone_names where name = …`, a function scan that reads the whole tz
database every call:

- 242 ms for one lookup on staging (918 rows removed by filter);
- on production, 443 calls with a mean of 1,206 ms and a max of 5.4 s.

The call is fire-and-forget, so nobody waits on it, but it holds a PostgREST connection for
a second at the moment the app is opening. **Recommended:** skip the lookup when the reported
zone equals the one already stored (it was validated when stored), and when nothing was
reported. That is exact, and needs one migration.

### 6. Nothing alerts. Open.

> **Update, #341 (`20261130000500`, staging only).** `ops_job_health()` reads every job and
> queue in one query, and `bingd-ops-health` records each failure and recovery in
> `ops_alerts`. It is still a pull signal: nothing is pushed to anybody, for the reason given in
> [background-jobs.md](background-jobs.md) §2g.

Every health signal is pull-only:

- the status functions (`import_drain_status`, `push_drain_status`, `release_status`,
  `proactive_status`) have no scheduled caller;
- `pg_net` keeps HTTP answers for 6 hours (`pg_net.ttl`) without URLs, so no 7-day error rate
  exists to read;
- `_drain_push_outbox` posts asynchronously and never reads `push-sender`'s answer, so a 401 or
  500 there leaves the tick `succeeded`. Only the outbox's age (stalled after 15 minutes) shows
  it.

Current state is clean: zero failed cron runs in all retained history (the push drain's goes
back to 2026-08-31), no missed run in 7 days, and both queues are empty. **Recommended:** one
scheduled reader (a GitHub Action, or the existing release gate) that calls the four status
functions and fails loudly. It is cheap, and it turns every check in background-jobs.md into a
notification.

### 7. GitHub's schedules are late, and the welcome dispatcher is not yet live. Open, founder action.

- **Welcome email.** Scheduled runs started 3 times a day on 11-18 and 11-19, and none from
  11-19 22:17Z to at least 11-20 06:30Z. The pg_cron dispatcher from #331 ran at 05:41Z, and
  production Vault holds no `welcome_dispatch_github_token` (`count = 0` by name), so it returns
  `unconfigured`. **Cost so far is zero:** nobody is in the 48 to 168 hour window, and nobody aged
  out in the last week. 13 sends to date, all accepted by Resend on the first attempt.
- **Trending refresh.** Scheduled at 04:17Z, it has started between 11:14Z and 13:17Z every
  day for 12 days. It is daily, so the 168-hour cutoff is never close.

The dispatcher's response is now readable without the request id: background-jobs.md §3.3.

### 8. Mobile: the reconnect refetch is inert, and offline writes fail rather than queue. Open, needs a binary.

- **TanStack Query never learns the device is offline.** `onlineManager`'s default listens for
  `window` `online`/`offline` events, which React Native does not fire, and the app wires no
  replacement. No network-state library is installed. So `refetchOnReconnect: true` in
  `src/lib/query.ts` never fires, and a query started offline fails after its two retries
  instead of pausing. Wiring `onlineManager` needs `expo-network` or NetInfo, which is a native
  module, a fingerprint change and a store build.
- **Offline writes are online-only.** Mutations have `retry: 0`, and the SQLite outbox
  described in `docs/architecture/offline-sync.md` §3 is not implemented in `src/`. A write made
  offline fails visibly, which is the documented intent for rankings, and is the same for
  everything else today.
- **The Feed is not virtualized.** `app/(tabs)/feed.tsx` renders every loaded page into a
  `ScrollView`, and the infinite query has no `maxPages`. Memory grows with how far a reader
  scrolls. The Collection uses FlashList (`CollectionView`). No crash report ties this to an
  incident; it is a scaling risk, not a measured one.

### 9. Release: OTA versus migration ordering is a rule, not a gate. Open.

`scripts/ota-gate.mjs` checks a clean tree, `main`, CI, the release gate on that commit and the
fingerprint against `config/live-runtimes.json`. Nothing checks that production's migration
head is at or beyond what the bundle's code needs. That rule is written down in
`docs/release/safe-update-runbook.md` §8 and enforced by the person publishing.

The case in front of us now is #322. Its client expects `20261201000100`, which is on staging
and not on production. **Recommended:** the gate refuses a production publish when
`supabase/migrations/` at the commit has a version newer than production's head. It needs one
read-only credential, so it is a founder decision.

### Reviewed, no defect found

- **Ranking concurrency.** `supabase/tests/concurrency/` runs on real PostgreSQL in
  `db-races.yml` and the release gate. It is green on `main` for `ecd03517` and the three
  commits before it.
- **Import and push workers.** The import has a two-minute provider lease, three attempts, a
  429 refund and a 24-hour abandoned sweep. The push drain raises when it cannot send.
  Production queue depth on 2026-11-20 was zero open imports and an empty outbox.
- **Seq scans on hot tables.** Apart from `cron.job_run_details`, every table with heavy
  sequential reads is tiny: `profiles` has 53 rows, `app_config` 126 and `import_jobs` 2. The
  large `profiles` count (9.2 M scans) is RLS's `can_view_profile` probing a 53-row table, which
  is correct at this size.
- **Client N+1.** The `Promise.all` call sites are fixed-width parallel reads, not per-row
  loops. The Feed's poster rails are batched (`get_feed_group_previews`).
- **Crash reporting.** Sentry is initialised with PII off, scrubbers and release tags, and there
  is an in-app diagnostics sheet. *Not verified from here:* whether the production EAS
  environment has its own DSN and auth token set (`docs/release/production-environment.md`).

---

## 2. Fixes made

| PR | Change | Risk class | Status |
|---|---|---|---|
| #334 | `20261201000400`: cron history pruned once an hour | migration | CI green, Codex clean on `5fa9dc82`, **applied to staging only** (§5) |
| #336 | `useCredits` drops the whole-cache count; a follow invalidates `profile-stats` | client JS, OTA-able | CI green, Codex clean on `c9f04bc5` |
| this PR | this file and background-jobs.md | docs | |

## 3. Remaining risks, in order

1. The Feed's per-page cost grows with followed history, and RLS is evaluated per row (§1.4).
2. No alerting. A broken job is found by whoever next looks (§1.6).
3. The welcome email depends on GitHub's late schedule until the founder stores the token
   (§1.7).
4. OTA publishes do not check migration order (§1.9). #322 is the live instance.
5. Offline detection is inert, and the Feed is unvirtualized (§1.8). Both need a binary.
6. `bingd-push-drain`'s cron history is unpruned and grows by 1,440 rows a day. After #334 that
   costs two scans an hour, not 64. Retention is a decision (§5).

## 4. Recommended next priorities

Only the ones with a verified need:

1. Promote `20261201000400` to production with the next migration release. It is the largest
   single cost on the database.
2. Ship #336 in the next OTA.
3. A scheduled status reader that fails loudly (§1.6).
4. The `report_device_context` lookup skip (§1.5). It is one small migration.
5. The Feed query redesign, measured on a seeded staging dataset first (§1.4).
6. The OTA migration-order gate (§1.9), and `onlineManager` wiring in the next binary (§1.8).

## 5. Staging evidence for #334

Applied to staging only, at 2026-11-20 06:50:46Z, from head `5fa9dc82`, in one transaction.
The script refused unless the pending set was exactly `20261201000400`. Timings are from
staging's `cron.job_run_details`: before is the 24 hours up to the apply, after runs to 07:19Z.

| Job, tick | Before | After |
|---|---|---|
| `bingd-import-maintenance`, the 59 ticks that do not prune | avg 99.5 ms, p50 96.1 (n 1,416) | **avg 13.4 ms, p50 12.7** (n 28) |
| `bingd-import-maintenance`, the :17 tick | 96.1 ms | 99.6 ms |
| `bingd-release-evaluate`, the :15/:30/:45 ticks | 129.6 ms | **9.7 ms** |
| `bingd-release-evaluate`, the :00 tick | 128.9 ms | 104.6 ms |

- Per hour, maintenance went from about 5.97 s to about 0.89 s (-85%), and evaluation from
  about 0.52 s to about 0.13 s (-74%).
- `cron.job_run_details` sequential scans went from 102,794 to 102,798 in 28 minutes: the two
  prunes plus two measurement queries, where about 30 were expected before.
- Retention held. After the 07:17 prune, the oldest import-job row ended at 2026-11-13 07:17
  (7 days) and the oldest release-job row at 2026-11-06 07:00 (14 days).

Production is unchanged and still at `20261130000300`.
