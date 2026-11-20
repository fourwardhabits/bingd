# Security findings register, 2026-11-20

This is the authoritative register after the 2026-11-20 closeout pass. It supersedes the register table in
[`security-closeout-2026-11-17.md`](security-closeout-2026-11-17.md). That file stays as the record of H-1's
closure and its runbooks. The 2026-08-19 adversarial review is
[`beta-security-review.md`](beta-security-review.md), and the 2026-11-01 audit's release steps are
[`../release/security-remediation-2026-11-01.md`](../release/security-remediation-2026-11-01.md).

- **Method.**
  - Read-only catalog and config queries on production (`abheeqyjzekiowkztfxv`). No probe ran against production.
  - Active probes on staging (`fjxhcbowoxuzulwirzyr`) only, from disposable `@example.invalid` accounts that
    were deleted afterwards. A count of leftover probe accounts on staging returned 0.
  - The repository at `main` `3fd9397b`, plus a read-only look at #322's migration.
- **Scope.** Production's database head is `20261130000300` (208 versions). Staging also has #322's
  `20261201000100`.
- **Privacy.** No secret value, email address or account id appears in this file. Account handles appear nowhere.

## Verdict

- **No critical or high finding is open, and none was found.**
- **Two infrastructure gaps are fixed in #333** (pending merge):
  - B-2 (medium): a job that holds a secret could be dispatched on any ref;
  - B-3 (low): no workflow declared its job token's permissions.
- Everything else open is low severity, a founder-only dashboard step, or deliberate design with a stated reason.

IDs in this register start at **B-2**. That avoids reusing the 2026-11-01 audit's B-1, which is resolved. Lower-case
`m-` IDs are the older low-severity items. **Status values:**

- OPEN: work remains.
- FIXED (PR): a reviewed fix is awaiting merge.
- RESOLVED: the fix is live.
- VERIFIED: checked today, and no change was needed.
- ACCEPTED: a known risk, kept on purpose.

## Register (severity-ranked)

| Finding ID | Severity | Evidence | Affected surface | Impact | Status | Recommended fix | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **B-2** | Medium | `welcome-email.yml` and `trending-refresh.yml` ask for the `production` Environment, and nothing in either file refused a non-`main` ref. Any token that may dispatch workflows can name any existing branch or tag. #331's dispatcher token will be one such token (Actions read and write). The Environment's `main`-only rule is the only barrier. #317's probe (run 44240572227) saw it refuse a branch, but it cannot be tested from the repository | GitHub Actions → production service-role key, Resend key, postal address | Without that setting, a dispatch on an old or attacker-chosen ref would run that ref's code with production secrets | **FIXED (PR)** | Each job that holds a secret now refuses, in its own `if:`, any ref but `refs/heads/main`. `config/workflows.test.mjs` evaluates the guard for branch, tag and pull refs. Limit: a dispatch runs the dispatched ref's copy of the file, so older branches stay covered by the Environment setting alone (founder check F-1) | #333 |
| **B-4** | Medium (operational) | Read from `20261130000300` and production. Vault holds only `service_role_key`, so the dispatcher token is **not stored yet** and the dispatcher returns `unconfigured`. When stored, the token would also allow, beyond starting the welcome send: cancelling runs, disabling workflows, deleting run logs, and re-running old `main` runs at their original commit. Workers before `ef10abd0` (2026-11-01) printed handles | #331 dispatcher (pg_cron → GitHub `workflow_dispatch`) | A stolen token cannot read secrets or change code. It could disrupt Actions and erase audit logs. An expired or revoked token fails **silently**: pg_cron records `succeeded`, and GitHub's 401 lands only in `net._http_response`, which pg_net keeps for 6 hours (`pg_net.ttl`). The GitHub `schedule:` backup keeps sending, so the result is late emails, not lost ones | **OPEN** (process) | Create the token as described in founder check F-4: this repository only, Actions only, an expiry of 90 days or less, and a calendar reminder for it. After storing it, confirm one dispatch with the query in [The #331 dispatcher](#the-331-dispatcher). Later, a GitHub App installation token (short-lived, not tied to a person) would remove the expiry and owner risk. That is not needed for launch | — |
| **M-5** | Medium | `src/lib/monitoring.ts`: `sendDefaultPii: false`, and `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` scrub the user to `{id}`, request data, cookies, query strings, fragments, span URLs and `extra` non-scalars. Console breadcrumbs are dropped. This is covered by `monitoring.test.ts` and has been live since the 2026-11-03 OTA | App → Sentry | Builds before that OTA (1.0.1) have no client scrub and depend on the Sentry-side rule, which has **never been verified** | **RESOLVED** in code; dashboard rule **NOT VERIFIED** | Founder check F-3 | — |
| **B-3** | Low | `ci.yml`, `db-races.yml` and `release-gate.yml` had no `permissions:` block, so their `GITHUB_TOKEN` gets the repository default, which cannot be read from here (the Actions settings API is blocked to this session). `ci.yml` runs `npm ci` (every install script) beside it, with checkout credentials persisted | GitHub Actions CI token | A compromised dependency on a push to `main` or a release branch would get whatever the default grants. `main` itself needs a pull request with a passing required check, which a token-created pull request does not trigger | **FIXED (PR)** | Top-level `permissions: contents: read` on all five workflows, pinned by `config/workflows.test.mjs`. Founder check F-2 sets the default to read | #333 |
| **B-5** | Low | On both projects, `anon` and `authenticated` hold `USAGE` on schema `net`, `SELECT` on `net.http_request_queue` and `net._http_response`, and `EXECUTE` on `net.http_post`/`http_get`. This is Supabase's default for pg_net. What keeps it unreachable: PostgREST exposes only `public,graphql_public`; `pg_graphql` is not installed on production; `supabase_realtime` publishes no table. Staging probe: a `Content-Profile: net` RPC as anon and as a signed-in user → HTTP 406; GraphQL lists no pg_net field | Supabase pg_net | Latent only. The queue holds a request's headers, including `Authorization` (the push drain's service-role key, and later the dispatcher token), until the worker sends it, usually seconds. Adding `net` to the exposed schemas, or enabling pg_graphql or Realtime on `net`, would make that a credential leak and an SSRF primitive | **ACCEPTED** (with guard rail) | Never add `net`, `vault` or `cron` to the API's exposed schemas, and review before enabling pg_graphql. A `revoke` on Supabase-owned pg_net objects is possible, but it needs Supabase confirmation that upgrades will not undo it, and a staging trial first. It is not worth it for a latent issue | — |
| **B-6** | Low | `_add_comment`'s author follow-up path inserts a `comment` notification for every earlier commenter, with no block check. Staging probe: commenter blocks the author, the author comments → **1 row stored, 1 queued in `push_outbox`, 0 in the blocker's inbox**. `my_notifications` drops it (`can_discover_profile`), and `claim_push_batch` drops it before any push | Notifications across a block | None visible. A dormant row remains, and its push job is settled as skipped rather than sent. If a future read path forgets the read-time filter, the row would appear | **OPEN** (hygiene) | Add `and not blocked_between(c.author_id, auth.uid())` to that insert the next time `_add_comment` changes. #322 redefines `_add_comment` and owns it until it merges, so this is not changed here | — |
| **B-7** | Low | `npm audit --omit=dev`: 23 advisories (1 critical, 12 high, 10 moderate). The critical is `shell-quote`, via `react-devtools-core`, a dev tool that does not run in a release build. Most of the rest are Expo CLI and build-time tooling: `compression`, `node-forge`, `image-size`, `js-yaml`, `source-map-js`, `brace-expansion`, `glob`, `minimatch`, `uuid`, `@xmldom/xmldom`. Two are in the app bundle: `decode-uri-component` (via `expo-router`'s `query-string`) and `zod` 4.4.3 (it validates build-time env only, in `src/lib/env.ts`). The full tree adds `sharp` (brand rendering, dev) | Client bundle, build hosts | `decode-uri-component`: a crafted link could hang the app on the device that opens it (a self-inflicted denial of service, no data exposure). The others need hostile input on a build host | **OPEN** (hygiene) | Take the Expo SDK patch release after the 1.2.0 store binary (#330) ships. Do not `npm audit fix` now: a lockfile change can move the native fingerprint and the runtime version mid-release | — |
| **B-8** | Low | 66 signed-in write RPCs have no per-operation limiter. They are ranking, watchlist, logs, lists, notes, device tokens and similar. Every cross-user write is limited: follow 60/h, comments 100/day, reactions 200/day, recommendations 50/day, tags 100/day, reports 20/day, invites. Anonymous writes are capped (`record_list_open` 60 per list per minute, and `record_invite_open` is also capped) | Database growth, followers' Feed | One account can grow its own rows and feed posts without bound. Grouping folds posts made inside 30 minutes. No path notifies other people without a limit | **ACCEPTED** (hardening) | Watch per-user row growth. Add a daily cap on `feed_events` per actor only if abuse appears | — |
| **B-9** | Low | Production auth config: `password_min_length` 6, no required characters, `password_hibp_enabled` false, no CAPTCHA. Password sign-in exists only for the store-review account (`src/features/auth/methods.ts`). Everyone else signs in with a 6-digit email code (10-minute expiry) or Apple/Google. H-2's trigger retires unproven passwords | Supabase Auth | Weak only for an account that has a password, which in practice means the store-review account | **OPEN** (founder) | Founder check F-6: give the reviewer account a long random password. Raising the minimum to 8 or more is safe for everyone else, because no one else sets a password | — |
| **m-3** | Low | The nine runs below are all on `main`. On 2026-11-20, the first and last run's logs were read: the first prints one handle and its signup time, the last one handle and its Resend message id. The other seven were matched by job name: one `send on nonprod`, six `send on production`. The worker has printed counts only since `ef10abd0` (a source change). That the nine are the **only** affected logs is untested: no exhaustive scan was done (see the plan, step 4) | Public Actions logs | Read-only exposure of public handles and the dates their welcome emails were sent | **OPEN** (founder) | [m-3 cleanup plan](#m-3-cleanup-plan) | — |
| **B-10** | Info | Deleted accounts leave **released handles** in `username_history` (246 rows with `profile_id` null, deliberately `on delete set null`), and **reports** keep their subject with `reporter_id` null (22). Neither is readable by a client role | Retention | Deliberate: a released handle stays reserved so nobody can impersonate a deleted account, and moderation keeps its record | **ACCEPTED** | Founder/legal check F-7: the privacy policy should say that handles of deleted accounts stay reserved and that reports are kept | — |
| **M-5b** | Info | `monitoring.ts` keeps exception messages, and PostgreSQL can echo rejected input in a `23514` or `22P02` message. Today no call site forwards a Supabase error to Sentry: both `reportHandled` callers pass synthetic errors | App → Sentry | Only if a future `reportHandled(supabaseError)` is added | **ACCEPTED** (recorded in code) | Keep passing synthetic errors to `reportHandled` | — |
| H-1 | High | #317 (merged 2026-11-20 as `3fd9397b`): six repository-level secrets moved into the `main`-only Environments; probe run 44240572227 found all six absent; scheduled runs 44309130885 and 44322495767 passed afterwards | GitHub Actions secrets | — | **CLOSED** | — | #317 |
| H-2 | High | Trigger `retire_unproven_password` on `auth.users` (`docs/release/h2-preregistration-takeover.md`) | Supabase Auth | — | **RESOLVED** (OAuth linking untested; staging has no OAuth providers) | — | — |
| B-1, M-1 to M-4 | — | 2026-11-01 audit, fixed by `20261024*` | Supabase RLS and grants | — | **RESOLVED** | — | — |
| — | Medium | Welcome canary inputs printed an address and an account id | Public Actions logs | — | **RESOLVED** (#314 merged, `d9b2a849`) | — | #314 |
| — | — | Production catalog 2026-11-20: 82/82 public tables have RLS; `anon` can select no table or view; no client role can insert, update or delete any table; 349/349 `security definer` functions pin `search_path`; the 163 non-extension functions executable by a client role equal `supabase/tests/function-grants.test.mjs`'s allow-list exactly (7 anon). Staging has the same set plus #322's `follow_story_open_to_me`. All 12 views are `security_invoker` except `logged_collection`, a `security_barrier` view that filters on `can_i_view(user_id)` and is granted to `authenticated` only | Supabase | — | **VERIFIED** | — | — |
| — | — | Cross-feature probe on staging, 23/23 (below) | Feed, blocks, private accounts, companions, pg_net | — | **VERIFIED** | — | — |

### Accepted residual risk carried forward

These are unchanged from `security-closeout-2026-11-17.md`:

- H-2's OAuth-linking case is untested.
- Accounts confirmed before `20261124000100` cannot be told apart from other confirmed accounts.
- Custom-scheme invite-token interception remains a "Nice" item (`beta-security-review.md`).

## Cross-feature probe (staging, 2026-11-20)

The probe targets boundaries between features that a single-PR review could miss. It ran from 9 disposable accounts,
and every denial is paired with a positive control. The script is not committed: it is a one-off with a hard-coded
staging ref, in the style of the existing staging smokes.

| Boundary | Result |
| --- | --- |
| A grouped watchlist post (three adds, one post) and a reader the **actor** blocks | Before the block, the reader sees the post, its 3 posters (`feed_group_previews`), its 3 titles (`watchlist_group_titles`) and the comment. After it, all four paths return 0, and comment and reaction are refused (P0002). An unrelated follower still sees everything |
| The author follows up after a commenter **blocked** them | The author's comment posts; the blocker's inbox shows nothing. One stored row and one queued push job remain (B-6) |
| A **private** account's grouped post, Taste Match and counts | An approved follower sees the post (1/3/3). A stranger gets 0 on every path, a null `taste_match` score, `profile_title_counts` zeros (the follower gets 1 movie), an empty watchlist and an empty `followers_of`. The account stays findable by handle, as designed |
| Watch **companions** need a mutual follow | A non-mutual companion is refused (42501); a mutual one is accepted. After the companion blocks the logger, re-saving the same list keeps the existing row. That row is owner-only and notifies nobody. The blocked companion reads none of the blocker's watch tags |
| pg_net through the API | An RPC with `Content-Profile: net` returns HTTP 406 for anon and for a signed-in user. GraphQL exposes no pg_net field |

Read from code with no separate probe: `rank_promote_show`, `rank_unpromote_show`, `rank_group_note` and
`rank_batch_finalize` act only on `auth.uid()`'s own rows, with no actor parameter. `follow_activity_people` names only
members the reader may identify. `mutuals_with` and `people_mutuals` gate every person on `can_view_profile` or
`can_identify_profile`. `my_notifications` and `claim_push_batch` drop any row whose actor and recipient are blocked
in either direction. Account deletion cascades every user-keyed table: the composite foreign keys go through
`user_media`, and production has 0 orphan rows in the seven tables keyed that way.

**#322 (read-only).** Its migration keeps every function it adds or redefines `security definer` with a pinned
`search_path`. `_follow_story_open_to` is granted to nobody; `follow_story_open_to_me` and `follow_activity_people` go
to `authenticated` only; `follow_story_engaged` has RLS on and no client grant. It keeps the read-time and push-time
block filters. B-6 applies to its `_add_comment` too. Nothing new was found.

## The #331 dispatcher

`_dispatch_welcome_email()` (production only):

- It takes no parameters. The URL, `ref: main` and the inputs (`target=production`, `mode=send`, no canary) are
  literals.
- Only its owner can execute it, and pg_cron runs it as `postgres` at `:41` every hour.
- It reads Vault only after the `environment_name() = 'prod'` and `welcome.delivery_enabled` gates pass.
- The token goes into one `Authorization` header and is never returned, raised or logged.
- **The token itself:**
  - Not stored yet.
  - When created, it should be a fine-grained personal access token with the repository's owner as resource owner, the
    single repository `bingd`, **Actions: read and write** only (Metadata read is automatic), and an expiry of 90 days
    or less.
  - It is owned by the founder's account. If that account loses access, so does the dispatcher; the GitHub
    schedule still runs.
- **Auditability.** Every dispatched run appears in the Actions list as a `workflow_dispatch` by the token's owner at
  about `:41`. A dispatch from anything else would also show there.
- **Failure visibility.** This is the weak point.
  - pg_cron reports `succeeded` whatever GitHub answers.
  - GitHub's answer lands in `net._http_response` (6-hour TTL).
  - Check it within 6 hours of a dispatch. This query is untested here, because no token has been stored:

    ```sql
    select status_code, created
      from net._http_response r
     where exists (select 1 from jsonb_object_keys(r.headers) k where lower(k) = 'x-github-request-id')
     order by created desc
     limit 5;
    ```

    `204` means dispatched, `401` means the token is expired or revoked, and `404` means it lacks access to this
    repository or to Actions.
- **Shutdown, in order of reach:**
  1. `welcome.delivery_enabled = false` in production stops the email and the dispatches.
  2. `select cron.unschedule('bingd-welcome-dispatch');` stops only the dispatches.
  3. Revoking the token in GitHub stops it working everywhere.
  4. Deleting the Vault secret returns the dispatcher to `unconfigured`.
- **Workflow side.** With #333, a dispatch on any ref but `main` is skipped inside the file as well as refused by
  the Environment.

## Credentials and infrastructure, as found

- **Workflows.** All five pin every action to a commit SHA. None uses `pull_request_target` or `workflow_run`.
  - Every job that holds a secret names an Environment, persists no checkout credentials, and runs no package install
    or shared cache. `config/workflows.test.mjs` enforces all of this.
  - No `run:` line interpolates an input or a secret: secrets enter only through `env:`, which
    `emails/welcome/email.test.mjs` pins.
  - Dispatch inputs are choice-typed, and GitHub validates them against their options.
- **Vault (production).** One secret, `service_role_key`, read by `_drain_push_outbox`, `push_drain_status`,
  `_drain_import_jobs`, `_import_enrich_nudge`, `_import_provider_configured`, `_release_refresh_tick` and
  `release_status`.
  - All seven are executable by `service_role` only.
  - `_dispatch_welcome_email` is the eighth reader, and it is owner-only.
  - `vault.decrypted_secrets` is selectable by `service_role` only.
- **Resend, TMDB, EAS, Sentry.**
  - The Resend welcome key lives only in the `production` Environment.
  - The TMDB key lives only in the Edge Function environment.
  - `eas.json` carries lane names and public values only.
  - `app.config.ts` copies only `EXPO_PUBLIC_*` into the bundle.
  - A pattern scan over the whole git history for GitHub, Supabase-management and Resend tokens, private keys and
    service-role JWTs found nothing. The only hit in the tree is a test fixture.
- **Production and staging separation.**
  - Different projects, keys and Environments.
  - `refresh-trending.mjs --target` refuses a URL from the wrong project.
  - The dispatcher is gated on `environment_name()`.
  - PostgREST is identical on both: `public,graphql_public`, 1000-row cap.

## Founder checks (dashboard only; none can be done from this session)

| # | Where | Check | Why |
| --- | --- | --- | --- |
| F-1 | GitHub → Settings → Environments → `production`, then `nonprod` | **Deployment branches and tags** is "Selected branches and tags" with exactly one rule, branch `main`, and no tag rule. Each Environment holds only its own secrets (four in `production`, two in `nonprod`) | B-2. This is the real control. #333 cannot cover branches that predate it |
| F-2 | GitHub → Settings → Actions → General | **Workflow permissions**: "Read repository contents and packages permissions". "Allow GitHub Actions to create and approve pull requests" is **off**. Fork pull request workflows from outside collaborators require approval | B-3 |
| F-3 | Sentry → `bingd-react-native` → Project Settings → Security & Privacy → Advanced Data Scrubbing | The four span rules from `security-remediation-2026-11-01.md` §1 exist. Then open any transaction dated after the rule and confirm its `http.client` spans have no `http.query` and no `?` in `http.url`. Also confirm **Data Scrubber** and **Use Default Scrubbers** are on, and that "Store Native Crash Reports" does not include screenshots or view hierarchies | M-5 closes on the transaction check |
| F-4 | GitHub → Settings (personal) → Developer settings → Fine-grained tokens, then production Vault | When the dispatcher is turned on: resource owner is the repository's owner, the single repository `bingd`, **Actions: read and write** and nothing else, an expiry of 90 days or less with a calendar reminder. Store it as `welcome_dispatch_github_token` in **production only**. Within 6 hours, run the dispatcher query above and expect `204` | B-4 |
| F-5 | GitHub, each run below | m-3 log deletion (plan below) | m-3 |
| F-6 | Supabase → production → Authentication | The store-review account has a long random password. Optionally raise **Minimum password length** to 8 or more | B-9 |
| F-7 | The privacy policy | It says that a deleted account's handle stays reserved and that moderation reports are kept | B-10 |

## m-3 cleanup plan

This is a founder operation, and it is irreversible. Nothing has been deleted.

1. **The runs** (all `Welcome email`, all on `main`):

   | Run | Job | Date (UTC) |
   | --- | --- | --- |
   | 35363614512 | dry-run on nonprod | 2026-09-18 |
   | 35364208000 | send on nonprod | 2026-09-18 |
   | 35765305951 | send on production | 2026-09-22 |
   | 36047171011 | send on production | 2026-09-24 |
   | 37075746208 | send on production | 2026-10-02 |
   | 38973914723 | send on production | 2026-10-16 |
   | 39518374765 | send on production | 2026-10-20 |
   | 40241193636 | send on production | 2026-10-25 |
   | 40427285105 | send on production | 2026-10-27 |

2. **Before deleting,** keep any record you still need. The `welcome_emails` table already holds each send's status,
   time and Resend message id, so the logs add nothing to the audit trail.
3. **Delete.** For each run, open the run's page in this repository's Actions tab (`/actions/runs/<id>`), then **⋯ →
   Delete all logs**. The run record (status and timing) stays. The equivalent API call, as a repository admin, is
   `DELETE /repos/<owner>/<repo>/actions/runs/<id>/logs`.
4. **Verify.** An agent can confirm that each run's job log no longer downloads.
   - **Untested:** that no other run's log prints a handle.
   - What is established: the worker since `ef10abd0` prints counts only, which is a source change, and one later
     run, 43968912229, was checked on 2026-11-17.
   - No exhaustive scan of the runs between 40427285105 and that change, or after it, has been done.
   - Before closing m-3, an agent should read the worker step of every `Welcome email` run that claimed anyone
     before `ef10abd0` reached `main`, and add any other run that prints a handle to this list.
5. **Do not** delete whole runs or any other run's logs. Other logs are the only record of the H-1 evidence.

## How to re-run this

- Catalog checks: the queries behind the "VERIFIED" row read `pg_class.relrowsecurity`, `has_table_privilege`,
  `has_function_privilege`, `pg_proc.proconfig` and `prosecdef`.
- Allow-list comparison: compare the live executable set with the `ALLOWED` keys in
  `supabase/tests/function-grants.test.mjs`. All of these queries are read-only (`read_only: true`).
- Workflow rules: `npm run test:config`.
