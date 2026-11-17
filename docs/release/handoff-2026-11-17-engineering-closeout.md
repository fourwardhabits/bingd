# Final engineering closeout, 2026-11-17

The handoff for moving bingd from development to marketing. It contains no secret, address or account id.

## Production

| | |
| --- | --- |
| App | OTA from `0170506e` (Feed rails and grouping), unchanged by this closeout. The closeout merges touch no app code |
| `main` | `4531f0c3`: #314 Welcome canary fix, #315 security register, #316 recommendation benchmark (all merged 2026-11-17, Codex clean, CI green on the reviewed heads) |
| Database | 203 migrations, unchanged. The 115 Feed history groups are in place |
| Welcome email | Live since 2026-09-18: 13 sent, 0 failed. The merged workflow's production dry run passed (run 44004870067) |
| Trending | Daily, passing |
| Recommendations | V1 for everyone. V2 stays dark (switch `v1`, 0%) |

## 1. Security

| Finding | Status | What closes it |
| --- | --- | --- |
| **H-1** (audit M-6): six privileged secrets still at repository level | **OPEN. Founder action needed.** | The founder confirms the Environment copies and deletes the six repository copies; then the agent re-verifies |
| m-3: nine old Welcome run logs show account handles | **OPEN** (all nine present on 2026-11-17) | Founder approval; then the agent deletes them (`delete_workflow_run_logs`, one call per run) |
| M-5: Sentry query strings | Code fix **RESOLVED** (live since 2026-11-03). Dashboard rule **NOT VERIFIED** | The founder looks at Sentry → Project Settings → Security & Privacy → Advanced Data Scrubbing. No agent access to Sentry exists |
| H-2: pre-registration takeover | **RESOLVED**: trigger live, no client can execute it | Residual (OAuth, pre-fix accounts) is accepted, as documented |
| B-1, M-1 to M-4; RLS and grants | **RESOLVED** / **VERIFIED** | — |
| Welcome canary publishing its inbox | **FIXED** (#314, merged) | — |

**Why H-1 is not done by the agent, although authorized:**
- This session has no GitHub API access for Actions secrets: it can neither list Environment secret names nor delete repository secrets.
- A probe cannot tell an Environment copy from the repository copy it falls back to, so the agent cannot prove the Environment copies exist before deletion.
- The step therefore has to be the founder's. It takes about two minutes:

1. **Settings → Environments → `production`** must list `SUPABASE_URL_PRODUCTION`, `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`,
   `RESEND_API_KEY_WELCOME` and `WELCOME_POSTAL_ADDRESS`. **`nonprod`** must list `SUPABASE_URL_NONPROD` and
   `SUPABASE_SERVICE_ROLE_KEY_NONPROD`. If any is missing, add it first, and stop if a value is unavailable.
2. **Settings → Secrets and variables → Actions → Repository secrets**: delete exactly those six. Keep the variable
   `BINGD_PRODUCTION_TRENDING`. Rotate nothing.
3. Tell the agent. It then:
   - pushes the presence-only probe to a branch, expecting all six `absent` and both Environment jobs refused;
   - runs Trending (`both`) and a Welcome production dry run;
   - checks the next scheduled Welcome send, which proves the Resend key and the address;
   - records the result, and stops and reports on any failure.

## 2. Welcome email

- **The founder's nonreceipt:** both founder accounts predate the cohort cutoff (2026-09-18). They are outside the
  window by design; this is not a delivery failure.
- **Production:** delivery enabled; 48 h delay, 168 h maximum age, 25 per run; 13 sent, each with a Resend id; no
  failure, stuck claim or suppression.
- **Exactly once:** held by the SQL claim plus a Resend idempotency key (race suite). A canary row can never be retried
  by the cohort, or the reverse.
- **Canary: prepared, AWAITING FOUNDER APPROVAL.** The procedure is in `emails/welcome/automation/README.md`, under
  "The canary from GitHub Actions":
  1. Add two production Environment secrets, `WELCOME_CANARY_USER` and `WELCOME_CANARY_EMAIL`.
  2. Allowlist that one address in SQL.
  3. Dispatch dry-run → send → send. Expect claimed 1, then 0.
  4. Check the inbox, then clear both.
- **Routine automation:** already live and safe. The emergency stop is `welcome.delivery_enabled = false`.

## 3. Recommendation quality

- **Benchmark (#316):** stratified ladder holdout and forward replay; common-candidate and full-wall modes; movies and
  series-level TV kept separate; leakage invariants; per-person bootstrap; dev and final halves; a pre-registered
  verdict.
- **Synthetic reference results** (`docs/architecture/recommendation-benchmark-synthetic-2026-11-17.md`): 300 people,
  1,500 titles. They validate the benchmark; they are **not** evidence about real users.
  - **TV: `KEEP_V1`.** V2's Recall@50 against V1 is −0.208 [−0.276, −0.145].
  - **Movies: inconclusive.**
  - **Taste vs. retrieval.** V2's taste scoring is marginally, not significantly, better. Its losses are in retrieval:
    V2 metadata has no follow-graph source, and that source carries much of V1's pool. The social prototype restores
    Films, but not TV.
  - **V2 hybrid: NOT REPLAYED.**
- **Real-history evaluation: prepared, AWAITING FOUNDER APPROVAL.** One command does it:
  - a read-only export through the read-only API;
  - the benchmark;
  - the export deleted automatically.

  Only aggregate tables are kept, and the export never enters the repository or a chat.
- **No V2 rollout is authorized or proposed** until the real-history verdict exists.

## 4. Development freeze

**Critical issues still open:** H-1 only, and closing it is the founder's two-minute step above.

**Noncritical, deferred:**
- m-3 log deletion (with approval);
- the Sentry rule confirmation;
- the welcome canary (with approval);
- the real-history benchmark (with approval);
- the border on grouped Feed cards (optional polish);
- the `today_default` watch-date rule (a founder decision, unchanged).

**Engineering can freeze when:**
1. H-1 is closed and verified (the probe shows all six absent; Trending and Welcome pass).
2. ~~#316 is merged.~~ Done (`4531f0c3`).

Nothing else blocks the freeze. Every other item is an optional, approval-gated operation that needs no code. No new
feature roadmap is proposed.
