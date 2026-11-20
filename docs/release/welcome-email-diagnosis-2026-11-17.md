# Welcome email: diagnosis, 2026-11-17

Read-only inspection of production (`abheeqyjzekiowkztfxv`) and the scheduled workflow. No email was
sent, no row was written, and no address or account id appears in this record.

## Diagnosis: the founder's accounts are outside the eligibility window

**Classification: account outside eligibility window.** This is not a delivery failure.

- `welcome.start_after` is `2026-09-18T16:43:17Z`. The cohort is accounts created on or after it,
  mailed 48 to 168 hours after signup.
- The founder's two accounts were created on 2026-08-14 and 2026-08-25, before that cutoff. The claim
  has never selected them, by design, and must not be backdated to reach them.
- Matched by a hash of each known address inside a read-only transaction. No address was sent to or
  printed by the query.

## Actual production state

| Item | Value | Evidence |
| --- | --- | --- |
| `welcome.delivery_enabled` | **true** | `app_config` |
| `welcome.start_after` | 2026-09-18 16:43:17Z | `app_config` |
| `welcome.delay_hours` / `max_age_hours` / `max_per_run` | 48 / 168 / 25 | `app_config` |
| `welcome.canary_addresses` | empty | `app_config` (length 0) |
| Scheduled workflow | running on `main`, Environment `production`, `send` | last run 2026-11-16 22:19Z: `claimed 0, sent 0, failed 0, unrecorded 0` |
| Ledger | **13 `sent`**, each with a Resend message id; 0 failed, 0 stuck `claimed`, 0 canary | `welcome_emails` |
| Sends by month | September 3, October 5, November 5 | `sent_at` |
| Delay actually achieved | 48 to 54 hours after signup | `sent_at` − `profiles.created_at` |
| Coverage | every profile created after the cutoff has a `sent` row | 0 unsent profiles after the cutoff |
| Suppressions | none | `email_suppressions` |
| Sender | `Suraj from bingd <suraj@bingd.app>`, Reply-To `suraj@bingd.app` | `emails/welcome/envelope.mjs`. Resend accepted all 13, so the domain is accepted for sending |

The earlier handoff line describing the automation as disabled was wrong for production. The worker's
own header also said "NOT ENABLED". This PR corrects that header.

Three more `auth.users` rows were created after the cutoff, but they have no `profiles` row. These are
incomplete sign-ups, which the claim excludes by joining `profiles`. That is the intended rule.

## Not verifiable from here

- **Delivered vs. accepted.** The ledger records Resend's acceptance (a message id). Whether each of the
  13 was delivered, bounced or filtered needs Resend's Emails log, which the welcome key (sending
  access only) cannot read. The founder can check it in the Resend dashboard, filtering on the welcome
  sender. Bounces are not ingested automatically. For a note sent once per person, that has no
  repeating cost.
- **Inbox placement and rendering on a real inbox.** Only the canary below proves this.

## Fix in this PR: the canary no longer publishes its inbox

The workflow's manual canary took the test account's id and address as `workflow_dispatch` inputs. The
repository is public, so those inputs, and the job's `env:` values, would have been printed in a public
Actions log.

- The canary input is now a single boolean.
- The account comes from two Environment secrets, `WELCOME_CANARY_USER` and `WELCOME_CANARY_EMAIL`,
  which GitHub masks.
- The worker and every SQL guard are unchanged.
- `config/workflows.test.mjs` pins the inputs to `target`, `mode` and `canary`.

## Controlled canary: AWAITING FOUNDER AUTHORIZATION

The procedure is in `emails/welcome/automation/README.md`, under "The canary from GitHub Actions". It
needs three production changes, each requiring the founder's approval:

1. Add the two canary secrets to the `production` Environment.
2. Put that one approved address on `welcome.canary_addresses`.
3. Send one real email.

Verification covers:
- one row, `sent`, `canary`, with a message id;
- the inbox, rendering, links and Reply-To;
- a second run claims 0;
- the cohort count is unchanged.

Afterwards, empty the allowlist and delete the two secrets.

## Routine automation

The routine automation is already live and behaving as designed. It gives:

- the 48-hour delay;
- eligible new accounts only;
- exactly-once delivery, held by the SQL claim and a Resend idempotency key (`supabase/tests/concurrency/races/welcome-email.mjs`);
- bounded retries, at most 3, and none after 20 hours;
- an observable ledger.

The emergency stop needs no deploy: set `welcome.delivery_enabled` to false. After H-1 is remediated it
keeps working, provided the `production` Environment holds the four secrets before the repository copies
are deleted (`docs/security/security-closeout-2026-11-17.md`).
