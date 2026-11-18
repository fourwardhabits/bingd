# Security closeout, 2026-11-17

The authoritative register of open and closed security findings before bingd moves to marketing.
Everything here was checked against production on 2026-11-17, read-only. No secret value, address
or account id appears in this file.

## Verdict

**H-1 is CLOSED (2026-11-18).** No high-severity finding remains open. Two low and medium items are still open, as
founder-approval operations: m-3, the deletion of nine historical logs, and M-5, confirmation of the Sentry dashboard
rule. Neither is a high-severity exposure.

### H-1 closure evidence (2026-11-18)

| Check | Result |
| --- | --- |
| Environment copies | Founder-populated and name-verified: four in `production`, two in `nonprod`, both restricted to `main` |
| Pre-deletion dry runs (runs 44236840090, 44236843540) | Production reached `abheeqyjzekiowkztfxv`, nonprod reached `fjxhcbowoxuzulwirzyr`, both through service-role-only RPCs |
| Repository copies | Deleted by the founder |
| Presence-only probe after deletion (run 44240572227) | All six names **absent** at repository level. Jobs naming `production` and `nonprod` from a non-`main` branch were **refused** (no runner was assigned). The probe was removed in the next commit (`4330df15`) |
| Post-deletion dry runs (runs 44240581085, 44240583979) | Production reached the production project, with the Resend key and postal address present (masked, non-empty: these can only be the Environment copies now). Nonprod reached the staging project with **no** postal address, which confirms the repository fallback is gone. Nonprod holds no mail secrets by design |
| Scheduled send (run 44238100146, 04:33Z) | Passed the Resend-key presence and postal-address format checks, which run before any claim. Claimed 0 |
| Not tested | Resend API authentication (only a real send recorded `sent` proves it; the key value did not change), and the next scheduled Trending run (same four Supabase secrets, already proven by the dry runs) |

## Finding register

| ID | Issue | Boundary | Exploitable now | Evidence | Severity | Status | To close |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **H-1** (audit M-6) | Six privileged secrets existed as **repository-level** Actions secrets: both service-role keys, both project URLs, the Resend welcome key and the postal address | GitHub Actions → Supabase production (service role bypasses RLS), Resend | **No** (since 2026-11-18): the repository copies are deleted; the Environments are restricted to `main` | Probe on 2026-11-17 found all six present; the probe on 2026-11-18 (run 44240572227) found all six absent, with both Environments refusing a branch | High | **CLOSED** | — |
| m-3 | Nine historical Welcome email run logs print one or two account handles | Public Actions logs | Read-only exposure of public handles | Logs of runs 35363614512, 37075746208 and 40427285105 checked present on 2026-11-17 (first, middle, last of the nine). Current runs print only counts (run 43968912229) | Low | **OPEN** | Delete the nine runs' logs (below) |
| M-5 | Sentry spans carried PostgREST query strings | App → Sentry | No on 1.1.0: `src/lib/monitoring.ts` scrubs spans, breadcrumbs and requests (`beforeSendTransaction`), covered by tests | Code fix live since the 2026-11-03 OTA. 1.0.1 phones cannot get it and rely on the Sentry dashboard rule | Medium | **RESOLVED** for 1.1.0; dashboard rule **NOT VERIFIED** | Founder confirms the four Advanced Data Scrubbing rules in Sentry (`docs/release/security-remediation-2026-11-01.md` §1) |
| H-2 | Pre-registration takeover through password sign-up | Supabase Auth | No | Trigger `retire_unproven_password` is enabled on production `auth.users`; no API role can execute it. Staging reproduction before, and refusal after (`docs/release/h2-preregistration-takeover.md`) | High | **RESOLVED** | OAuth linking and pre-migration accounts remain untested (below) |
| B-1, M-1 to M-4 | 2026-11-01 audit findings fixed by `20261024*` | Supabase RLS and grants | No | Migrations live. The production anon smoke passed 137/137 on 2026-11-17 | — | **RESOLVED** | — |
| — | Function and table exposure | Supabase | No | Production on 2026-11-17: 81/81 public tables have RLS; `anon` holds no table grant; every `security definer` function sets `search_path`. The functions executable by `anon` (7) and `authenticated` equal `supabase/tests/function-grants.test.mjs`'s allow-list | — | **VERIFIED** | — |
| — | Environment protection | GitHub Actions | No | From a non-`main` branch, jobs naming `production` and `nonprod` were both refused (same probe run) | — | **VERIFIED** | — |
| — | Welcome canary inputs | Public Actions logs | Only if a canary were dispatched | `workflow_dispatch` took the test address and account id as inputs, which a public repository prints | Medium | **FIXED** in fourwardhabits/bingd#314, pending merge | Merge #314 |

### Accepted residual risk

- **H-2, OAuth.** Sign in with Apple or Google linking to a stranger's unconfirmed row was not exercised. Staging has
  no OAuth providers.
- **H-2, before the fix.** Accounts confirmed before `20261124000100` cannot be told apart from honest sign-ups after
  the fact.
- **The beta review's "Nice" item.** Custom-scheme token interception (`docs/security/beta-security-review.md`) stays
  as documented there.

## H-1 runbook (completed 2026-11-18; kept for reference)

The order matters: nothing is deleted until both scheduled jobs have passed on the Environment copies.

1. **Confirm the Environment copies exist.** Open **Settings → Environments → production**. It should list
   `SUPABASE_URL_PRODUCTION`, `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`, `RESEND_API_KEY_WELCOME` and
   `WELCOME_POSTAL_ADDRESS`. Open **nonprod**: it should list `SUPABASE_URL_NONPROD` and
   `SUPABASE_SERVICE_ROLE_KEY_NONPROD`. Add any that are missing, from the sources in
   `docs/release/security-remediation-2026-11-01.md` §2.
   - Do not add the Resend key or the address to `nonprod`.
   - This step cannot be checked from outside while the repository copies exist, because an Environment job falls
     back to them.
2. **Delete the six repository copies.** Open **Settings → Secrets and variables → Actions**. Delete all six names
   above. Keep the variable `BINGD_PRODUCTION_TRENDING`.
3. **Verify right away.**
   - **Trending:** run **Actions → Trending refresh → Run workflow**, target `both`. This exercises both Supabase pairs.
   - **Welcome:** run **Actions → Welcome email → Run workflow**, target `production`, mode **`send`**.
     - This is the same job the hourly schedule already runs on production. It mails only accounts that are already due.
     - A **dry run would not do**: it returns before it reads the Resend key or the postal address.
     - A send-mode run refuses before claiming anyone, with a non-zero exit, if `RESEND_API_KEY_WELCOME` or `WELCOME_POSTAL_ADDRESS` is missing. It refuses the same way when the Supabase pair is missing.
     - So a green send run proves all four are present on the Environment.
   - **If either job fails,** add that secret to its Environment and run it again.
   - **Presence is not validity.** The Resend key is proven valid only when a real send records `sent` with a message id. Check after the next send that claimed anyone:
     `select status, failed_reason is null, sent_at from welcome_emails where not canary order by claimed_at desc limit 3;`
   - For a pure relocation (the same values), presence is enough.
4. **Re-probe.** An agent pushes the same presence-only probe (`git show f2c7feb6`) to a branch. The expected output
   is all six `absent`, with both Environment jobs refused. Then the agent removes the probe.
5. **Observe one scheduled run of each job.**

**H-1 closes at step 4.** It is a relocation, not a rotation: nothing indicates a value leaked. Rotation is optional
hardening, the founder's decision, and **outside this runbook** for the Supabase keys.

- **The Resend welcome key, if rotated:**
  1. Create the new key with sending access on `bingd.app`.
  2. Put it in the `production` Environment.
  3. Prove it with a real send that records `sent`: the canary in `emails/welcome/automation/README.md`, or the next cohort send.
  4. Only then revoke the old key in Resend.
- **The Supabase service-role keys: do not rotate under this runbook.** The production key has another consumer outside
  GitHub. A Vault secret, `service_role_key`, is the bearer credential for `_drain_push_outbox()` and
  `_import_enrich_nudge()` (`docs/release/production-environment.md` §3). A rotation needs its own plan:
  - update and verify the Vault copy and those background requests;
  - then update the GitHub Environment;
  - then verify Trending and Welcome;
  - only then revoke.

## m-3 log deletion (founder; AWAITING FOUNDER AUTHORIZATION)

For each run, open `https://github.com/fourwardhabits/bingd/actions/runs/<id>`, open the **⋯** menu, and choose
**Delete all logs**. This is irreversible, and the run record itself stays.

`35363614512 35364208000 35765305951 36047171011 37075746208 38973914723 39518374765 40241193636 40427285105`

## What stays true after H-1

- The committed workflows already name `environment:` on every job that reads a secret.
  - The trending jobs use `nonprod` and `production`.
  - The welcome job uses `production` when scheduled, or the target's Environment when dispatched.
- `config/workflows.test.mjs` fails CI if any workflow change breaks these rules:
  - a job reads a production or nonprod secret outside its Environment;
  - a job holds a secret with no Environment, or installs packages beside one;
  - a job keeps checkout credentials;
  - a workflow uses `pull_request_target` or `workflow_run`.
- Deleting the repository copies therefore changes nothing for the scheduled jobs except where their values come
  from.
