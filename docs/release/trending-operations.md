# Trending operations

**Written 2026-08-26.** What fills the Trending shelf, what happens when nothing does, and the
schedule that now stops it happening again.

---

## 1. What went wrong once

The Feed's Trending shelf reads `provider_list_cache` and **never calls TMDB**, which is what
keeps a tab switch off the provider quota (`../architecture/api.md`). The cost of that split is
that something has to fill the table.

Nothing did. `npm run trending:refresh` was a command a founder typed, the cached lists aged
past the 168-hour cutoff in `src/features/trending/trending.ts`, and the shelf **disappeared**.

Two freshness thresholds, and they are not the same thing:

| | |
|---|---|
| **6 hours** — TTL | past this the shelf is *stale but shown* |
| **168 hours** — cutoff | past this the shelf is *gone* |

**The cutoff is not relaxed.** A shelf that disappears rather than showing week-old data is
correct behaviour; the missing piece was a schedule, and relaxing the cutoff would hide the
next scheduler failure instead of fixing it.

## 2. The schedule

`.github/workflows/trending-refresh.yml` — daily at **04:17 UTC**, plus `workflow_dispatch`.

Daily is comfortably inside 168 hours: a shelf is stale-but-shown for most of the day and
refreshed long before it is dropped. More often would spend provider quota to move numbers
nobody is watching change. Off the hour on purpose — the top of an hour is where every cron on
GitHub queues up, and a delayed run is a run that reports late.

Repository-owned rather than a Supabase cron, because the work is an HTTP call to
`tmdb-adapter` with a service-role key, the failure needs to be **visible to a human**, and
GitHub Actions gives a red run, a retained log and a manual re-run for free.

### Targets

| Trigger | nonprod | production |
|---|---|---|
| Daily | always | only when repository variable `BINGD_PRODUCTION_TRENDING` is `true` |
| Manual | `target: nonprod` or `both` | `target: production` or `both`, unconditionally |

The variable exists because **there is no production project yet**, and a job that fails every
night until there is teaches the founder to ignore a red workflow — which is the failure mode
that lets the *next* one go unnoticed. Set it to `true` in the same session that provisions the
project and its secrets. A manual production run ignores the variable and fails loudly if the
secrets are absent, which is what asking for it by hand should do.

### Credentials

| Secret | |
|---|---|
| `SUPABASE_URL_NONPROD` | `https://abheeqyjzekiowkztfxv.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY_NONPROD` | |
| `SUPABASE_URL_PRODUCTION` | when it exists |
| `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | |

`trending` is a `service_role` action on `tmdb-adapter` — four provider requests and eighty
upserts per call — so each target needs that project's own key. Nothing is printed but the
project ref and the environment name, neither of which is a secret.

**The pairing is checked.** `refresh-trending.mjs` now takes `--target`, resolves the project
ref from the URL's parsed host, and refuses if the two disagree:

```
Refusing: --target production means the prod database, and abheeqyjzekiowkztfxv is
declared nonprod. The URL and the key in this run do not describe the same project.
```

The failure that matters here is not a typo. It is the **production key paired with the
nonprod URL**, which refreshes the wrong project's shelf every night and looks like a green
run. The guard is on the parsed host rather than the string, for the reason
`two-user-acceptance.mjs` records: `url.includes(ref)` says yes to `https://<ref>.example.com`,
and the next thing that happens is a service-role key arriving at a hostname anybody can
register.

## 3. By hand

```
node supabase/seed/refresh-trending.mjs                       # whatever .env.local says
node supabase/seed/refresh-trending.mjs --target nonprod
node supabase/seed/refresh-trending.mjs --target production
```

`--target` is optional so that `npm run trending:refresh` stays one argument-free command; the
workflow always passes it, which is where the mistake it catches actually happens.

Expected:

```
Refreshing trending on abheeqyjzekiowkztfxv (nonprod)
trending.movie.day: 20 titles
trending.movie.week: 20 titles
trending.series.day: 20 titles
trending.series.week: 20 titles

All four lists refreshed.
```

## 4. When it fails

**Partial failure exits non-zero.** A list that fails keeps its previous payload — three fresh
lists and one stale one is the adapter's deliberate choice — but the script still exits 1 so
the workflow goes red. A silent partial is how a shelf rots one list at a time.

| Symptom | Cause |
|---|---|
| `HTTP 401` / `403` | wrong or missing service-role key for that target |
| `HTTP 500`, adapter names TMDB | provider outage or a bad `TMDB_ACCESS_TOKEN` |
| `Refusing: … is not a Supabase project this repository declares` | the URL secret points somewhere unlisted |
| `Refusing: --target … and … is declared …` | URL and key are from different projects |

Recovery is always the same: fix the input, then **Actions → Trending refresh → Run workflow**
with the target. The shelf tolerates being a day late; it does not tolerate being a week late.

## 5. What this does not do

It does not enrich the catalogue (`catalogue:enrich`) and it does not fetch new titles
(`seed:fetch`). Those are separate, less frequent, and still by hand — they change what Bingd
knows about, which is a decision rather than a refresh.
