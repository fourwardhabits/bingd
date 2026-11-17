# Security closeout, 2026-11-17

The authoritative register of open and closed security findings before bingd moves to marketing.
Everything here was checked against production on 2026-11-17, read-only. No secret value, address
or account id appears in this file.

## Verdict

**Not closed: one high finding, H-1, is open, and closing it is founder-only work** (about 15 minutes,
in GitHub settings). No code change is needed: the committed workflows already keep every privileged
secret behind a protected Environment, and CI enforces that. Everything else that is high or above is
resolved.

## Finding register

| ID | Issue | Boundary | Exploitable now | Evidence | Severity | Status | To close |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **H-1** (audit M-6) | Six privileged secrets still exist as **repository-level** Actions secrets: both service-role keys, both project URLs, the Resend welcome key and the postal address | GitHub Actions → Supabase production (service role bypasses RLS), Resend | **Yes**, for anyone who can push a branch: a workflow in that branch reads repository secrets without an Environment. Fork PRs cannot (no `pull_request_target`, no `workflow_run`) | Probe on 2026-11-17 (run 43998354499): all six printed `PRESENT at repository level`. Probe removed in the next commit | High | **OPEN** | The runbook below |
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

## H-1 runbook (founder; AWAITING FOUNDER AUTHORIZATION)

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
3. **Verify right away.** Run **Actions → Trending refresh → Run workflow**, target `both`. Then run **Welcome
   email**, target `production`, mode `dry-run`.
   - Both must pass. A missing secret shows as an immediate `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set`
     refusal that sends nothing.
   - If one fails, add that secret to its Environment and run it again.
4. **Re-probe.** An agent pushes the same presence-only probe (`git show f2c7feb6`) to a branch. The expected output
   is all six `absent`, with both Environment jobs refused. Then the agent removes the probe.
5. **Observe one scheduled run of each job.**

**H-1 closes at step 4.** It is a relocation, not a rotation: nothing indicates a value leaked. A rotation is
optional hardening, and the founder decides on it.
- **If rotating:** create the new key, put it in the Environment, verify step 3, and only then revoke the old one.
- **Whichever key is revoked**, revoke it only after the jobs pass on the new one.

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
