# Operator alerts: getting `ops_alerts` to the founder (proposal, 2026-11-20)

Status: **proposal, with a draft implementation.**

- The draft is migration `20261130000700_an_alert_that_leaves_the_database.sql`, its tests
  (`supabase/tests/ops-alert.test.mjs`) and its rollback
  (`docs/release/ops-alert/rollback-20261130000700.sql`).
- It is applied to staging only. Nothing in it does anything until the founder creates one
  external account and stores one low-privilege key (the checklist below).

It builds on `20261130000500` (#341): `ops_job_health()`, `ops_health_tick()`, the
`ops_alerts` table and the cron job `bingd-ops-health`. See background-jobs.md §2g. That
migration records every incident but sends nothing, and it cannot report its own death.

---

## 1. Recommendation

The design has one mechanism, which also provides the heartbeat:

- A new pg_cron job, `bingd-ops-alert`, runs every ten minutes. It runs two minutes after
  each health tick.
- Through `pg_net`, it pings **two checks at an external dead-man's-switch provider**,
  Healthchecks.io (hosted, free tier).
  - `bingd-heartbeat` is the dead-man's switch. It gets a success ping while the health tick
    is alive and healthy, and `/fail` when the tick is late, missing or failing. When pings
    stop entirely, for whatever reason, the provider emails after 30 minutes.
  - `bingd-alerts` is the incident signal. It gets `/fail` while any actionable incident is
    open in `ops_alerts`, and a success ping otherwise.
- **Every ping carries the whole current state, not a change.** The provider does the edge
  detection: it emails once when a check goes down and once when it comes back up. So the
  emails are deduplicated by construction, and a lost ping is corrected by the next one.

Why this is the simplest one that meets every constraint:

| Constraint | How it is met |
|---|---|
| Email via an existing service or a monitoring provider | The provider's own email to the account owner. No mail code anywhere. |
| Only actionable failures and recoveries, deduplicated | A one-tick blip never sends. A down email goes out after two ticks. An up email goes out after an hour clean. The provider emails on state changes only (§3). |
| Independent heartbeat | Absence of pings is the alarm, and the provider's clock is outside our database, Supabase and GitHub (§4). |
| No app update, no Edge Function | One migration. No client, function, or workflow change. |
| No new privileged credential | One **ping key**, which can only ping that provider project. It cannot read anything there or here (§2.3). No GitHub token, no Resend key in the database, no service-role key anywhere new. |
| No push | None. |

---

## 2. Founder checklist

Nothing below has been created. Each item needs the founder.

### 2.1 Approve

1. **Approve the design** (this document) and the provider: Healthchecks.io, hosted, free
   ("Hobbyist") plan.
   - Check the current plan limits at signup. The design needs **two checks** and email.
   - The data that leaves the database is check names, statuses and timestamps (§3.4).
2. **Approve applying `20261130000700` to production.** The coordinator does this, after
   `20261130000500` and `20261130000600`. Until step 7 below, it is inert: the job runs every
   ten minutes, returns `unconfigured` and sends nothing.

### 2.2 Create (about ten minutes)

3. **Create the account.** Sign up at healthchecks.io with the mailbox that should receive
   alerts. The account's email integration is created automatically. Keep it enabled.
4. **Create a project** named `bingd production`, used for nothing else. The ping key in step 6
   reaches every check in its project, so a dedicated project keeps its reach to these two.
5. **Create two checks** in that project. Set the slug exactly, because the database pings by
   slug and will not create checks itself.

   | Name / slug | Schedule | Period | Grace | Why |
   |---|---|---|---|---|
   | `bingd-heartbeat` | Simple | 10 minutes | 20 minutes | One tick missed, plus slack. Email within about 30 min of the last ping. |
   | `bingd-alerts` | Simple | 10 minutes | 1 day | When pings stop, the heartbeat emails, not this. A day later this one emails as a reminder that the job is still dead. |

   Both checks keep the email integration on, which is the default.
6. **Create the ping key**: Project → Settings → API Access / Ping key → Create. Copy it.
   - It is about 22 URL-safe characters.
   - Never paste it into chat, a pull request, an issue, a commit or a log.

### 2.3 Store (after step 2)

7. **Store the key in production Vault.** Open the Supabase dashboard for
   `abheeqyjzekiowkztfxv`, then the SQL Editor.

   ```sql
   select value from app_config where key = 'env.name';   -- must be "prod"
   select vault.create_secret('<ping key>', 'ops_alert_ping_key');
   ```

   - Do not save the query. Clear the editor.
   - **Never store it on staging.** Staging would not send (gate 1, §5), but a staging
     database pinging production's checks could report "healthy" while production is down.
     That is why the gate exists.
   - **Why Vault, not `app_config`.** The key is low-privilege but integrity-sensitive:
     anyone holding it can forge a success ping and hide a real failure for one interval.
     `app_config` is visible to anything that reads that table as an operator, including
     the Management API's read-only role. Vault is readable only by the owner-only function
     that sends the ping. This follows `welcome_dispatch_github_token`.
8. **Check it.** In the same editor:

   ```sql
   select public._ops_alert_ping();
   -- {"status": "posted", "heartbeat": "ok", "alerts": "ok", "open": 0, "request_ids": [N, M]}
   select id, status_code, error_msg from net._http_response where id in (N, M);
   ```

   | `status_code` | Meaning |
   |---|---|
   | `200` | Accepted. Both checks turn green on the dashboard. |
   | `404` | The slug does not match a check in the key's project. Fix step 5. |
   | Any other | See the provider's docs. |

   A return of `not_production`, `unconfigured` or `invalid_key` means the matching gate in §5
   failed and no request was made.
9. **Test the mailbox once.** Integrations → Email → "Test". Make sure the message does not
   land in spam, and add a filter that never sends it there.

That is all. There is no GitHub change, no Resend change, no new token and no app release.

---

## 3. Alert semantics

### 3.1 What each run sends

`_ops_alert_signal(p_at)` computes the state with no I/O. `_ops_alert_ping()` sends it.

| Check | Fails (`/fail`) when | Succeeds when |
|---|---|---|
| `bingd-heartbeat` | Either of these holds. The ping job is running, so the database, pg_cron and pg_net are alive, but the health tick is not: <ul><li>`_ops_observe()` says `bingd-ops-health` is not `ok` (late after 25 min, missing, or its last run failed);</li><li>`bingd-ops-health` has an open `ops_alerts` row (a caught tick error, `detail.tick_error`).</li></ul> It also fails when the observation itself raises (`reason: observe_error`); the alerts check is then not pinged, since there is no state to report. | The tick ran within 25 min and is clean. |
| `bingd-alerts` | Any `ops_alerts` row other than `bingd-ops-health` is **actionable** (§3.2). | None is. |

**Ping bodies.** The provider stores each one and shows it on the dashboard:

- heartbeat: `{at, ops_health}`, plus `reason` and `sqlstate` when the observation failed;
- alerts: `{at, open: [{check, status, since, reopened}], recovering: [{check, recovered_at}]}`.

### 3.2 Actionable, and deduplicated

- **Two ticks, not one.** An open row counts only once `last_seen_at > opened_at`. That means
  a second tick, ten minutes later, still saw it bad. A single late observation that clears
  on the next tick never emails.
  - A relapse that `ops_alerts` folds into an older row (`reopened + 1`) counts at once.
- **A reported incident ends an hour after it recovers.** When a run first sends an
  incident as failing, it records that on the row (`ops_alerts.signalled_at`, the draft's
  one new column). A row closed as `recovered` with that set keeps the alerts check failing
  for one hour. One hour is the same window in which `ops_alerts` folds a relapse into one
  row. So a flapping job sends **one** down email and **one** up email, not one pair per flap.
  - A row that was never reported is never held, however long it was open. Elapsed time
    cannot stand in for this: the tick overwrites `last_seen_at` when it closes a row, and a
    skipped tick stretches a one-observation blip to twenty minutes.
- **Muted and retired closes end the incident at once.** `ops.alert_muted_checks` is the
  existing switch, and it now also silences email.
- **The tick's own fault belongs to the heartbeat only,** so one fault is one email.
- **The provider emails only on a change of state** (up → down, down → up). Repeated `/fail`
  pings while down send nothing more.

### 3.3 Recovery messages, rate and quiet hours

- **Recovery.** The provider emails "up" when the check next gets a success ping. For
  `bingd-alerts` that is one hour after the last actionable incident recovered. For
  `bingd-heartbeat` it is the first healthy run, within ten minutes.
- **Rate.** Per check, at most one down email and one up email per incident. Pathological
  flapping slower than the one-hour window is bounded by the hold-down at about one pair
  every 80 minutes. The stop is a mute (`ops.alert_muted_checks`) or pausing the check on the
  dashboard. No cap in SQL is needed.
- **Quiet hours: none, deliberately.** An overnight failure is the case this exists for. A
  mail filter is the place for quiet hours if they are ever wanted.
- **Known coarseness.** A second incident that opens while `bingd-alerts` is already down
  sends no second email. The live list is in the latest ping body (dashboard) and in
  `ops_job_health()`.
  - The upgrade is one check per job name, by slug. The function would ping
    `bingd-<check_name>` for each check. That is a small change, but it means nine checks to
    configure and a mail storm when pings stop. It is not worth it until there is more than
    one operator.

### 3.4 What leaves the database

These go to the provider:

- check names;
- `late`, `failing` or `missing`;
- timestamps;
- the `reopened` count.

These never do:

- `detail`;
- `last_error`. A cron error message can quote a row, and the row can be a person's, as in
  `Key (user_id)=(…)`;
- any identifier.

The key appears only in the URL path, which is how the provider authenticates a ping. The
tests pin all of this.

---

## 4. Heartbeat

| What stopped | What the founder gets | When |
|---|---|---|
| The health tick (`bingd-ops-health` unscheduled, failing, or catching errors) while pg_cron runs | `bingd-heartbeat` **down**, from `/fail` | About 25–35 min after its last good run: the `late` threshold plus one ping interval. At once for a caught error. |
| The ping job, pg_cron, the database, pg_net's worker, egress, the Vault key (deleted, or wrong, which gives a 404), or the whole Supabase project | `bingd-heartbeat` **down**, from silence | About 30 min after the last ping: period plus grace. Later, `bingd-alerts` down after a day. |
| Healthchecks.io itself | Nothing | Accepted risk. The provider runs its own monitoring and status page. Both systems failing at once is the residual case. |

Why not something already in place:

- **GitHub's `schedule:`** starts this repository's runs every 5 to 10 hours. GitHub also
  disables a public repository's schedules after 60 days without activity. That is not a
  dead-man's switch.
- **Supabase** has no alerting on pg_cron.
- **A Cloudflare Worker** could poll from outside, but it would need the service-role key
  outside Supabase and GitHub, which is a new privileged credential and a new deploy.

Only an external clock that expects a ping is independent of everything here.

---

## 5. Gates and failure modes

The gates, in the order the function checks them, follow the welcome dispatcher
(`20261130000300`):

1. **`environment_name()` is `prod`.** A nonprod database returns `not_production` before it
   reads the Vault.
2. **Vault holds `ops_alert_ping_key`.** If it is missing or blank, the function returns
   `unconfigured`. Whitespace around a pasted key is trimmed. A key that is not 16 to 64
   characters of `[A-Za-z0-9_-]` returns `invalid_key`. In either case no request is made.
   The host is the literal `hc-ping.com` and the slugs are literals, so no stored value can
   redirect the request or change its path.
3. **Configured without `pg_net`** is the only case that raises, so pg_cron records it as a
   failure. The heartbeat then stops and the provider emails.

| Failure | Effect | Detected by |
|---|---|---|
| One pg_net request lost, timed out, or answered 429/5xx | That ping is lost. The next run re-sends the whole state. | Self-healing within 10 min. A heartbeat gap stays under the 20-min grace. |
| Every ping failing (wrong key, provider refuses, egress blocked) | No pings arrive. | Heartbeat down at about 30 min. `net._http_response` shows the codes for 6 h. |
| The founder's mailbox (spam, full) | Email not seen | Checklist step 9 and a filter. The dashboard always shows the state. |
| Key leaked | Forged pings: false alarms, or one interval of false "up" | Rotate it: Project → Settings → revoke and recreate, then `vault.update_secret` (§6). |
| Prod key stored on staging by mistake | Nothing sent from staging | Gate 1 |
| A migration reschedules `bingd-ops-health` (new jobid) | It reads `late` until its first new run, at most 10 min. That is under the 25-min threshold, so no email. | — |
| `cron.log_run` turned off | Every job reads `late`. Heartbeat and alerts both fail. | Correct and loud. |
| The tick's `ops_alerts` writes fail | Recorded as a tick error | Heartbeat `/fail` |
| The welcome dispatcher's GitHub readout | Unaffected. `welcome-dispatch-github` reads only answers carrying `x-github-request-id`, so provider answers cannot crowd it out. | — |

Cost:

- **Database:** two `pg_net` posts and one `_ops_observe` every ten minutes. The same reads
  as the tick: 12–21 ms on staging, never a full scan of `cron.job_run_details`.
- **Money:** nothing on the free plan.

---

## 6. Operating it

| To | Do |
|---|---|
| Silence one job's alerts | `update app_config set value = '["<check_name>"]'::jsonb where key = 'ops.alert_muted_checks';` (existing, §2g) |
| Silence everything briefly (planned maintenance) | Pause both checks on the dashboard. Resume afterwards. |
| Stop the pings | First pause both checks, then run `select cron.unschedule('bingd-ops-alert');` |
| Resume the pings | `select cron.schedule('bingd-ops-alert', '5,15,25,35,45,55 * * * *', 'select public._ops_alert_ping()');` |
| Rotate the key | Recreate it in Project → Settings, then `select vault.update_secret((select id from vault.secrets where name = 'ops_alert_ping_key'), '<new key>');` and re-run checklist step 8. |
| See what would be sent, with no I/O | `select public._ops_alert_signal(now());` (owner, SQL editor) |

---

## 7. Rollback

Each step is independent:

1. **Pause or delete both checks on the dashboard.** If you skip this, the heartbeat emails
   once that its pings stopped. That is harmless.
2. **Stop sending.** Run `select cron.unschedule('bingd-ops-alert');`, or remove everything
   the migration added with `docs/release/ops-alert/rollback-20261130000700.sql`. The
   rollback is one transaction, and it leaves `ops_alerts`, `bingd-ops-health` and every
   other job untouched.
3. **Remove the key.** Run `delete from vault.secrets where name = 'ops_alert_ping_key';`,
   then revoke it on the dashboard.
4. **Optionally, delete the Healthchecks project or account.**

`20261130000500` keeps recording either way. It is back to being a pull signal.

---

## 8. Options compared

"Heartbeat independent?" asks whether the option still alerts when the database or pg_cron
is dead.

| Option | Cost | Moving parts | New credentials | Heartbeat independent? | Verdict |
|---|---|---|---|---|---|
| **1. pg_cron → pg_net → GitHub `workflow_dispatch` → `ops-alert.yml` → Resend email or a GitHub issue** | Free | Five: pg_net, GitHub API, Actions runner, service-role read, Resend. Also delivery bookkeeping in `ops_alerts`. | A GitHub token in Vault (the planned dispatcher token, or one with the same scope). It expires every 90 days, and alerts then stop silently. Also a recipient secret. The welcome Resend key would be reused for a second purpose. | **No.** A dead database dispatches nothing, and GitHub's schedule is 5–10 h. It would still need option 3. | Rejected: more parts and more credentials, and still no heartbeat. The issue variant puts incidents in a **public** repository. |
| **2. pg_net → Resend directly** | Free | Two: pg_net, Resend. Plus edge detection and bookkeeping in SQL. | **A Resend sending key in the database.** It can send mail as bingd.app to anyone, a phishing and reputation risk if leaked. | **No.** | Rejected: a privileged credential, and no heartbeat. |
| **3. pg_net → external dead-man's switch (Healthchecks.io)** | Free tier | Two: pg_net, provider. The provider does the dedup and the email. | A **ping key**: ping-only, one project, in Vault. | **Yes.** Silence is the alarm. | **Recommended.** |
| 3b. The same through **Sentry Crons**, in the existing `fourward-habits` org | Monitors may be billed per monitor; check the plan | Two | The project DSN's public key, which is designed to be public. | Yes | A reasonable alternative if the founder wants no new vendor. Sentry raises an issue on a missed or failed check-in, and recovery resolves it, but a recovery email is not standard. The change would be the URL builder in `_ops_alert_ping` only. Needs Crons enabled and approved. |
| 4. GitHub `schedule:` as a heartbeat, polling `ops_job_health()` | Free | One workflow | None new: it uses the existing Environment secrets. | Partly: independent, but it fires 5–10 h apart and is disabled after 60 inactive days. | Rejected as a heartbeat. |
| 5. GitHub's own emails (failed workflow runs, new issues) | Free | As option 1 | As option 1 | No | Not deduplicated, no recovery email, needs option 1's token. Rejected. |

---

## 9. What the draft implements, and what it does not

Implemented in `20261130000700`, staging only:

- the job, both functions, and the nullable column `ops_alerts.signalled_at`;
- the gates;
- the tests: blip, two ticks, relapse, one-hour hold only for a signalled incident, muted and retired, the tick's own
  alert, observe error, every no-send gate, exact URLs, the key only in the path, no `detail`
  in the body, grants, idempotent scheduling that touches no other job, and the rollback.

Not done, and needing the founder:

- everything in §2;
- applying the migration to production.

No workflow, Edge Function, app code or GitHub setting changes.
