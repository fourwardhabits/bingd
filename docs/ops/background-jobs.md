# Background jobs: what runs, how to tell it is healthy, how to stop it

**Written 2026-11-20, from read-only queries against production (`abheeqyjzekiowkztfxv`) and
staging (`fjxhcbowoxuzulwirzyr`) and the migrations on `main` at `ecd03517`.** Measurements
are aggregates and carry the date they were taken. The release-time detail for each system
stays in the doc it links to. This page is the one place that lists every scheduled job
together, with the query that says whether it is working.

> Every query here is read-only unless it is under a **Stop** heading. Run them in the
> Supabase SQL editor of the project concerned. None of them prints a secret: they read
> the names in Vault, never the values.

---

## 1. The inventory

Eight scheduled things: six pg_cron jobs inside each database (staging has the same six) and
two GitHub Actions schedules.

| Job | Where | Schedule | What it does | Defined in |
|---|---|---|---|---|
| `bingd-import-drain` | pg_cron | every 10 s | `_drain_import_jobs()`: moves staged import rows through matching, a bounded slice per tick | `20260917000300`, `20260917001700` |
| `bingd-import-maintenance` | pg_cron | every minute | `_import_sweep_abandoned()` (fails `pending` imports older than 24 h), `_import_enrich_nudge()` (posts a poster batch to `tmdb-adapter`), `_import_prune_cron_history()` (trims this job's and the drain's history to 7 days; once an hour, at :17, from `20261201000400`, #334) | `20260917001200`, `…001400`, `…001700` |
| `bingd-push-drain` | pg_cron | every minute | `_drain_push_outbox()`: if `push_outbox` has rows, posts once to `push-sender`; **raises** if rows are waiting and the URL or key is missing | `20260826000300`, `20260826000700` |
| `bingd-release-evaluate` | pg_cron | `*/15` | `_release_evaluate()` (shadow evaluation of release notices) and `_release_prune_cron_history()` (14 days; once an hour, at :00, from `20261201000400`) | `20260930000200` |
| `bingd-release-refresh` | pg_cron | `7 * * * *` | `_release_refresh_tick()`: asks `tmdb-adapter` to refresh release dates that are due | `20260930000200`, `20261031000100` |
| `bingd-welcome-dispatch` | pg_cron | `41 * * * *` | `_dispatch_welcome_email()`: asks GitHub to run `welcome-email.yml` (production/send). Production only, and only with the Vault token; see section 3 | `20261130000300` |
| Welcome email | GitHub Actions | `3,13,23,33,43,53 * * * *` (backup) | `emails/welcome/automation/send-welcome.mjs`: claim, send through Resend, record | `.github/workflows/welcome-email.yml` |
| Trending refresh | GitHub Actions | `17 4 * * *` | fills `provider_list_cache` for the Trending shelf | `.github/workflows/trending-refresh.yml`, [trending-operations.md](../release/trending-operations.md) |

`bingd-proactive-tick` (`20261028000200`) exists as an installer but is **not scheduled** on
production. Proactive delivery is off.

### The whole list, in one query

```sql
select jobid, jobname, schedule, active, command from cron.job order by jobid;
```

Production on 2026-11-20 returned exactly the six pg_cron rows above, all `active`.

---

## 2. Health, job by job

### 2a. The general check: did every job run, and did any fail

`cron.job_run_details` is where pg_cron records each run. **A function that returns normally is
recorded as `succeeded` with the message `1 row`, whatever it returned.** Only an exception
shows up as `failed`. So a `succeeded` run means "did not raise", which is why the push drain
raises on purpose (`20260826000700`) and why the other jobs have status functions.

Runs, failures and durations over the last 7 days:

```sql
select j.jobname, d.status, count(*) as runs,
       max(d.start_time) as last_start,
       round(avg(extract(epoch from d.end_time - d.start_time)) * 1000) as avg_ms,
       round(max(extract(epoch from d.end_time - d.start_time)) * 1000) as max_ms
  from cron.job_run_details d join cron.job j using (jobid)
 where d.start_time > now() - interval '7 days'
 group by 1, 2 order by 1, 2;
```

Missed runs (a gap longer than the schedule plus a margin):

```sql
with r as (
  select jobid, start_time,
         start_time - lag(start_time) over (partition by jobid order by start_time) as gap
    from cron.job_run_details
   where start_time > now() - interval '7 days')
select j.jobname, max(r.gap) as longest_gap,
       count(*) filter (where r.gap > case j.jobname
         when 'bingd-import-drain'     then interval '15 seconds'
         when 'bingd-release-evaluate' then interval '16 minutes'
         when 'bingd-release-refresh'  then interval '61 minutes'
         when 'bingd-welcome-dispatch' then interval '61 minutes'
         else interval '65 seconds' end) as gaps
  from r join cron.job j using (jobid) group by 1 order by 1;
```

**Production, 2026-11-13 to 2026-11-20:**

| Job | Runs | Failed | Avg | p99 | Max | Longest gap |
|---|---|---|---|---|---|---|
| `bingd-import-drain` | 60,253 | 0 | 5 ms | 28 ms | 726 ms | 13.3 s |
| `bingd-import-maintenance` | 10,080 | 0 | 357 ms | 2,546 ms | 10,259 ms | 61 s |
| `bingd-push-drain` | 10,080 | 0 | 6 ms | 33 ms | 137 ms | 61 s |
| `bingd-release-evaluate` | 672 | 0 | 385 ms | 2,926 ms | 4,005 ms | 15 min |
| `bingd-release-refresh` | 168 | 0 | 780 ms | 1,281 ms | 1,347 ms | 60 min |
| `bingd-welcome-dispatch` | 1 (first run 05:41Z) | 0 | 31 ms | | | |

No failure in any retained history (the push drain's goes back to 2026-08-31) and no missed run.
The maintenance and evaluation durations are mostly the history prune; see
[reliability-2026-11-20.md](reliability-2026-11-20.md) §1.

**Retention.** The import prune keeps the two import jobs' history for 7 days and the release
prune keeps the release jobs' for 14. **Nothing prunes `bingd-push-drain`** (116,000 rows on
2026-11-20, 1,440 more a day) or the welcome dispatch, and 9,277 rows belong to jobs that no
longer exist. The 7-day figures above are therefore complete for every job.

### 2b. The import pipeline

```sql
select import_drain_status();   -- service_role or the SQL editor
```

Returns `job`, `maintenance`, `last_run`, `open`, `older_than_15m`, `failed_24h`,
`provider_in_flight` and `provider_ready`.

- **Retries.** A provider claim takes a two-minute lease. An invocation that dies lets the lease
  lapse and the row is offered again, up to three attempts (`20260917001700`). A 429 refunds the
  attempt.
- **Stuck work.** A `pending` job older than `import.abandoned_hours` (24) is failed by the
  sweep with `last_error = 'abandoned'`.
- **Failure signal.** `older_than_15m > 0` with `open > 0` means a job is not moving.
  `last_run.status = 'failed'` means the drain raised.

Queue depth, production 2026-11-20: 2 jobs in total, both `done`, none open.

### 2c. The push outbox

```sql
select push_drain_status();
select state, count(*), min(created_at) as oldest, max(attempts) as max_attempts
  from push_outbox group by 1;
```

- **The tick raises when it cannot send** (rows waiting and `functions.base_url` or the Vault
  `service_role_key` missing). That is the one case pg_cron records as `failed`
  (`20260826000700`, "a drain that says when it is broken").
- **What it cannot see.** The post to `push-sender` is asynchronous (`pg_net`), and the tick
  never reads the answer. A `push-sender` that answers 401 or 500 leaves the tick `succeeded`.
  The signal is then the queue: `push_drain_status()` counts rows older than 15 minutes as
  stalled.
- Operations, the off switch and delivery semantics: [push-operations.md](../release/push-operations.md).

Queue depth, production 2026-11-20: empty.

### 2d. Release awareness

```sql
select release_status();
```

Says whether both jobs exist, whether the transport is configured, whether subjects are read
on time and evaluation is keeping up, and how many release notifications and outbox rows
exist (zero while real sending is off). Shadow observation: [release-shadow-observation.md](../release/release-shadow-observation.md).

### 2e. `pg_net`: what the HTTP calls answered

The import nudge, the push drain, the release refresh and the welcome dispatch all post
through `pg_net`. Each answer lands in `net._http_response`.

```sql
select date_trunc('hour', created) as hour, status_code, timed_out,
       (error_msg is not null) as errored, count(*)
  from net._http_response group by 1, 2, 3, 4 order by 1 desc;
```

**`pg_net` keeps answers for 6 hours** (`pg_net.ttl`), and the table holds no URL. So there is
no 7-day error rate to read. On 2026-11-20 it held two rows, both `200` from the release
refresh. A request whose answer matters later has to be read inside that window, or recorded
somewhere else.

### 2f. The GitHub Actions schedules

GitHub starts this repository's `schedule:` runs late, and sometimes not at all:

- **Trending refresh** is scheduled at 04:17Z and has started between 11:14Z and 13:17Z every
  day from 11-08 to 11-19. It is daily, so the shelf's 6-hour TTL marks it stale for part of
  each day and the 168-hour cutoff is never close.
- **Welcome email**: see 3.4.

```bash
curl -s "https://api.github.com/repos/fourwardhabits/bingd/actions/workflows/trending-refresh.yml/runs?per_page=5" \
  | python3 -c "import sys,json; [print(r['event'], r['conclusion'], r['created_at']) for r in json.load(sys.stdin)['workflow_runs']]"
```

### 2g. Alerting: what exists

Nothing pages anybody. All of the following are **pull** signals. Somebody has to look.

- A `failed` row in `cron.job_run_details`. Only the push drain, and the welcome dispatch when
  configured without `pg_net`, raise on purpose.
- `import_drain_status()`, `push_drain_status()`, `release_status()` and `proactive_status()`.
  These are service-role functions with no scheduled caller. `npm run test:remote` reads some of
  them.
- GitHub's failed-run email for the two Actions workflows, sent to whoever is subscribed.
- Sentry, for the app only.

---

## 3. The welcome email, stage by stage

The question "did the welcome email go out" has six stages. Each is checked in a different
place, and a stage can only be judged once the one before it is known. Run these on
**production**.

### 3.1 The job is scheduled

```sql
select jobid, schedule, active, command from cron.job where jobname = 'bingd-welcome-dispatch';
```

Expect one row: `41 * * * *`, `active = true`, `select public._dispatch_welcome_email()`.

### 3.2 The job ran

```sql
select d.runid, d.status, d.start_time, d.end_time, left(d.return_message, 200) as message
  from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname = 'bingd-welcome-dispatch'
 order by d.start_time desc limit 5;
```

Expect a `succeeded` run at :41 every hour. **`succeeded` does not mean a request was made.**
The function returns `not_production`, `disabled`, `unconfigured` or `posted`, and pg_cron
throws the return value away (the message is always `1 row`). Which branch it took is decided
by the three gates, which you can read without calling it:

```sql
select
  (select value #>> '{}' from app_config where key = 'env.name')                     as env_name,          -- prod
  (select value from app_config where key = 'welcome.delivery_enabled')             as delivery_enabled,  -- true
  (select count(*) from vault.secrets where name = 'welcome_dispatch_github_token') as token_rows;        -- 1
```

`token_rows` counts the secret by name. It does not decrypt it. All three as shown means the
run posted. On 2026-11-20 production read `prod`, `true`, `0`, so it returns `unconfigured`
and posts nothing until the founder stores the token.

To see the branch directly, call it once by hand. This **is a real dispatch** when configured,
and a dispatch sends nobody twice:

```sql
select public._dispatch_welcome_email();   -- {"status": "posted", "request_id": N}
```

### 3.3 GitHub accepted the dispatch

The cron run does not record the request id. Read GitHub's answer from `pg_net`, **within 6
hours**. GitHub's answers are the only ones that carry an `x-github-request-id` header. The other
posts go to Supabase Edge Functions:

```sql
select r.id, r.created, r.status_code, r.timed_out, left(r.error_msg, 200) as error
  from net._http_response r
 where exists (select 1 from jsonb_object_keys(coalesce(r.headers, '{}'::jsonb)) k
                where lower(k) = 'x-github-request-id')
    or ((r.timed_out or r.error_msg is not null)
        and extract(minute from r.created at time zone 'UTC') between 41 and 42)
 order by r.id desc;
```

The second condition also catches a dispatch that never got an answer (a timeout or a DNS
failure has no headers), by its :41 timing. With a request id from a manual call:
`select status_code, error_msg, timed_out from net._http_response where id = N;`

| Answer | Meaning |
|---|---|
| `204` | Accepted. A run starts within about a minute. |
| `401` | The token is wrong or expired. The GitHub schedule is now the only trigger. |
| `403` | The token lacks Actions write, or the organization has not approved it. |
| `404` | The token does not cover `fourwardhabits/bingd`. |
| timed out / `error_msg` | GitHub or the network did not answer in 10 s. The next hour tries again. |
| no row at all | Nothing was posted (a gate in 3.2), or it is more than 6 hours old. |

### 3.4 The worker ran

Actions → **Welcome email**. A dispatched run's event is `workflow_dispatch` and its job is
named **send on production**. A scheduled backup run's event is `schedule`, with the same job
name. Publicly, without a token:

```bash
curl -s "https://api.github.com/repos/fourwardhabits/bingd/actions/workflows/welcome-email.yml/runs?per_page=10" \
  | python3 -c "import sys,json; [print(r['event'], r['status'], r['conclusion'], r['created_at']) for r in json.load(sys.stdin)['workflow_runs']]"
```

The job log ends with the worker's summary (`claimed N, sent N`). A non-zero exit that says
`NOT RECORDED` means Resend accepted a message and the record call failed. That row stays
`claimed` and is never retried. Read it, and do not re-run it away (automation README,
"Exactly once").

Measured 2026-11-20: scheduled runs started at 04:33, 14:16 and 22:07 on 11-18, and at 03:40,
13:30 and 22:17 on 11-19. None started from 22:17Z on 11-19 to at least 06:30Z on 11-20.

### 3.5 Resend accepted the message

`welcome_emails` is the ledger: one row per account, primary key `user_id`. Columns: `status`,
`resend_id`, `attempts`, `failed_reason`, `canary`, `first_claimed_at`, `claimed_at`,
`sent_at`.

```sql
select status, canary, count(*), count(resend_id) as with_resend_id,
       max(attempts) as max_attempts, max(sent_at) as last_sent
  from welcome_emails group by 1, 2 order by 1, 2;
```

`sent` with a `resend_id` means Resend accepted the message with that id. `claimed` with no
`sent_at` is the `NOT RECORDED` case. `failed` has a `failed_reason` and is retried up to 3
attempts within 20 hours of the first claim.

Who is waiting right now. These are counts, and the eligibility details are in the automation
README:

```sql
select count(*) filter (where p.created_at <  now() - interval '48 hours'
                          and p.created_at >  now() - interval '168 hours'
                          and w.user_id is null) as in_window_not_welcomed,
       count(*) filter (where p.created_at <= now() - interval '168 hours'
                          and p.created_at >  now() - interval '14 days'
                          and w.user_id is null) as aged_out_last_week
  from profiles p left join welcome_emails w on w.user_id = p.id
 where p.created_at >= (select (value #>> '{}')::timestamptz from app_config where key = 'welcome.start_after');
```

This is an upper bound: it does not apply the confirmed-address and suspension checks.
`welcome_email_preview(25, null, null)` (service role) gives the exact count.

Production on 2026-11-20: 13 rows, all `sent`, all with a `resend_id`, all on the first
attempt, the last on 2026-11-13. Nobody was in the window and nobody aged out in the last week,
so the starved schedule has not yet cost a welcome.

### 3.6 The message was delivered

**Not visible from here.** No Resend webhook exists, nothing records bounces, complaints or
delivery, and open and click tracking are off (automation README, "Compliance, simply"). The
Resend dashboard, searched by the `resend_id` from 3.5, is the only place delivery shows.

### 3.7 Stopping it

These match `emails/welcome/automation/README.md`, "Stopping it", which is the authority.

| To stop | Run on production |
|---|---|
| The email, every trigger included | `update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled';` Runs then claim nobody and the dispatcher returns `disabled`. |
| Only the dispatcher (the GitHub schedule continues) | `select cron.unschedule('bingd-welcome-dispatch');`. Resume: `select cron.schedule('bingd-welcome-dispatch', '41 * * * *', 'select public._dispatch_welcome_email()');` |
| The token | `delete from vault.secrets where name = 'welcome_dispatch_github_token';`, then revoke it on GitHub |
| The dispatcher, entirely | `docs/release/welcome-dispatch/rollback-20261130000300.sql` |
| The GitHub schedule | Actions → Welcome email → ⋯ → Disable workflow. This also blocks dispatched runs. |

---

## 4. Stopping and resuming the other jobs

Each installer is idempotent by job name, and each off switch keeps the data. `service_role` or
the SQL editor.

| Jobs | Stop | Resume |
|---|---|---|
| import drain and maintenance | `select unschedule_import_drain();` | `select schedule_import_drain();` |
| push drain | `select unschedule_push_drain();`. Notifications stay in-app, and the outbox fills and drains on resume ([push-operations.md](../release/push-operations.md)) | `select schedule_push_drain();` |
| release refresh and evaluation | `select unschedule_release_awareness();` | `select schedule_release_awareness();` |
| one job, by name | `select cron.unschedule('<jobname>');` | that job's installer above |
| trending refresh | Actions → Trending refresh → Disable workflow | Enable workflow |

`cron.alter_job(jobid, active := false)` pauses a job and keeps its row, if you would rather
not unschedule it.
