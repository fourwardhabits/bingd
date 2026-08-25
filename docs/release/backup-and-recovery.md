# Backup and recovery

**Written 2026-08-26.** What protects the production database, how to get it back, and — the
part most such documents skip — **what is not verified yet and cannot be until the project
exists.**

> Every capability below is stated as either **VERIFIED** (checked against a real project) or
> **FOUNDER MUST CONFIRM**. Nothing is marked enabled on the strength of a vendor's marketing
> page. A backup you believe in and do not have is worse than no backup.

---

## 1. What the plan decides — FOUNDER MUST CONFIRM

There is no production Supabase project, so none of this is verified. It is here because the
**plan is chosen at creation** and it is the single input that decides what recovery looks
like.

| | Free | Pro |
|---|---|---|
| Daily backups | none | retained, dashboard-restorable |
| Point-in-time recovery | no | available as a paid add-on |
| Project pausing on inactivity | yes | no |
| Email template editing with the default sender | **refused** | permitted |

That last row is not a backup concern and is listed anyway, because it is the same decision:
Bingd's email one-time codes need `{{ .Token }}` in the template, and Supabase refuses template
edits entirely on free-tier projects using the built-in sender. Verified against the project,
not inferred — see [`../architecture/auth.md`](../architecture/auth.md).

**A public launch on the free tier means: no backups, no PITR, and a database that pauses.**
That is a decision the founder may make, but it must be made rather than arrived at.

## 2. What exists regardless of the plan

**The migrations are the schema's backup.** Every object in the database is in
`supabase/migrations/`, in canonical order, replayable from zero onto an empty project. That is
verified continuously: the local suite replays all 75 files into PGlite on every run, and
`supabase migration list` shows local and remote in step.

So a total loss of the production project costs **the data**, never the schema. Recreating an
empty, correct, identically-configured Bingd is
[`production-bootstrap.md`](./production-bootstrap.md) and takes under an hour.

**What is not in the repository, and would have to be re-established by hand:**

| | Where it comes back from |
|---|---|
| Auth users and identities | nowhere — this is the irreplaceable part |
| Rankings, reviews, notes, social graph | nowhere |
| `app_config['env.name']` | `bootstrap-production.mjs` |
| `app_config['functions.base_url']` | `bootstrap-production.mjs` |
| Vault `service_role_key` | founder's password manager |
| `pg_cron` job | `schedule_push_drain()` |
| Edge Function secrets | `supabase secrets set` |
| Catalogue and Trending | `seed:fetch`, `catalogue:enrich`, `trending:refresh` |

The bottom five are cheap and scripted. The top two are the reason the plan question matters.

## 3. Recommended configuration — FOUNDER MUST CONFIRM

For a public launch holding accounts that people cannot recreate:

1. **Pro plan.** Daily backups are the floor for a database with strangers' accounts in it.
2. **PITR**, if the add-on is taken. The window between daily backups is where a bad
   migration or a mistaken `delete` lives, and a daily backup can cost a full day of
   somebody's rankings.
3. **Verify the first restore.** A backup nobody has restored is a hypothesis. Restore into a
   scratch project once, run `node supabase/tests/remote-smoke.mjs` against it, and delete it.
4. Record the actual retention window here, replacing this section, once it can be read from
   the dashboard rather than guessed.

## 4. Recovery procedure

**Who can execute:** the founder only. Every step needs Supabase dashboard access to the
`Fourward` organisation, and the restore is an organisation-owner action.

### 4a. Data loss, project intact (bad write, bad migration, mistaken deletion)

1. **Stop the bleeding first.** `select unschedule_push_drain();` — the drain sends
   notifications about rows that may be about to be restored differently. It is reversible and
   costs only delivery latency.
2. Dashboard → Database → Backups → restore to the chosen point.
3. `supabase migration list` — a restore to before a migration leaves the schema behind the
   repository. Push whatever is pending.
4. `node scripts/bootstrap-production.mjs --target production --apply` — idempotent, and it
   re-asserts identity, `functions.base_url` and the drain schedule. **The restore may have
   rolled `env.name` back**, and a production database calling itself `nonprod` is the exact
   trap this repository is built around.
5. `node supabase/tests/remote-smoke.mjs` — read-only, 97 probes, environment identity first.
6. `select push_drain_status();` — job present, `older_than_15m` at zero.

### 4b. Total loss of the project

Follow [`production-bootstrap.md`](./production-bootstrap.md) from §2.1. A new project ref
means a new entry in `config/backends.cjs`, `REF_NAMES` and `REF_ENVIRONMENTS`, a new EAS
`EXPO_PUBLIC_SUPABASE_URL` and anon key — **and a new binary**, because the URL is compiled
into the bundle. The store release would have to be replaced.

That asymmetry is the argument for §3.1: recovering data is a dashboard action; recovering from
a lost project is a store submission.

### 4c. Expected data-loss window

| Configuration | Window |
|---|---|
| Free tier | **everything since the project was created** |
| Pro, daily backups | up to 24 hours |
| Pro + PITR | minutes, per the add-on's granularity — FOUNDER MUST CONFIRM the exact figure |

## 5. What this document must not claim

Until a production project exists and its plan is visible in the dashboard, this file may not
say that backups are enabled, that PITR is available, or that any retention period applies.
Those sentences go in when somebody has read them off the project, and
[`store-privacy-inventory.md`](./store-privacy-inventory.md) depends on the same facts for its
retention section.
