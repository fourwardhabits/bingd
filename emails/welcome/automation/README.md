# Sending the welcome email on a schedule

**Status: WRITTEN, TESTED, NOT ENABLED.** The SQL is not applied to any project, the
workflow has no schedule, `welcome.delivery_enabled` would be `false` and
`welcome.start_after` would be 2099. Turning it on is the numbered procedure at the bottom,
and its last step is a separate decision from every other step.

---

## What it does

About 48 hours after somebody creates a bingd account, it sends them the founder's note
once, and never again. 48 hours, because the note assumes the reader has used the app: an
instant welcome lands during onboarding and reads as a system message. Accounts older than
a week are never selected, so a paused job does not send stale welcomes when resumed.

## The pieces

```
supabase/migrations/20260923000100_a_welcome_note_sent_once.sql
                         the ledger, the suppression list, the switches, the functions
emails/welcome/automation/
  send-welcome.mjs       the worker: claim, send, record
.github/workflows/welcome-email.yml   manual only; no schedule
supabase/tests/welcome-email.test.mjs            the SQL against every migration, and the
                                                 worker end to end over it
supabase/tests/concurrency/races/welcome-email.mjs   two connections, real PostgreSQL
emails/welcome/email.test.mjs                    the message itself
```

A GitHub Action rather than an Edge Function because **nothing in the release path deploys
`supabase/functions/`**: the TMDB adapter once ran thirteen days behind its source. What an
Action runs is always what is on `main`, template included.

## Why this and not a Resend Automation

Reopened 2026-09-17, because Resend now has Automations: a custom application event, a
48-hour delay step and an email step, with run-level observability in their dashboard. For
**one** lifecycle email operated by one person, that is the right question to ask, and the
answer is still this. Recorded here so it is not re-litigated from memory.

The Resend account as it actually stands on 2026-09-17: one verified domain
(`auth.bingd.app`), one API key (`Supabase`, the relay every sign-in code goes through),
**zero webhooks, zero event definitions, zero automations**, open and click tracking both
off. Both options therefore start from the same DNS work in step 1 of "Turning it on";
neither is cheaper there.

What separates them is the four things this email needs that an Automation's email step
cannot do from an event payload.

**1. The invite link has to be minted, and only the database can mint it.** The letter
links the reader's *own* personal token. `_welcome_email_ensure_invite_token` takes
`create_invite_link`'s exact advisory lock, writes `invite_tokens` with the environment
read from `app_config`, and deliberately does not call `create_invite_link` itself because
that writes `invite_link_creations` — the Link-created funnel stage, which this is not.
Tokens are minted **lazily** today, on the first Invite-friends tap. An Automation renders
from the event payload, so the token would have to exist at *account creation*, 48 hours
early, for every account including the ones that never invite anybody. That is a product
change (an eager write for everyone) made to suit a mail provider.

**2. Suppression must not be account-wide.** The same Resend account relays every sign-in
code. Resend's suppression list is account-wide, so suppressing somebody there to stop a
welcome note would also stop them signing in. `email_suppressions` is a local table for
exactly that reason, and an Automation's unsubscribe writes Resend's list, not ours.

**3. The record of who was mailed has to be joinable to the account.** `welcome_emails` is
one row per account, `on delete cascade` from `profiles`, readable in the SQL editor beside
every other fact about that person. Automation runs are observable in Resend's dashboard,
which is a different system with a different identifier: "did this user get the note, and
did they come back afterwards" stops being one query.

**4. The rollout cutoff is absolute.** `welcome.start_after` defaults to 2099 and is read
inside SQL before anything is claimed, so the existing beta population cannot be mailed even
by a mistake. The Automation equivalent — only contacts created after a date — depends on a
contact sync that does not exist, and whose backfill would be the blast this is built to
prevent.

**What the Automation would genuinely buy**, stated fairly: no GitHub Actions cron, and no
service-role key in CI secrets. That is real operational simplification and it is the only
honest argument on that side. It does not outweigh the four above, and taking it while this
ledger exists would leave two scheduling systems for one email — the specific outcome the
founder ruled out.

**Revisit if** a second or third lifecycle email arrives, *and* by then the invite link has
either left the copy or is minted eagerly for other reasons. One email does not justify a
contact-sync pipeline; four might.

## Where the guarantees live

In SQL, not in the worker. The worker never selects a person: it asks
`welcome_email_claim` who it owns and sends to exactly those rows.

| function | who can call it | what it does |
|---|---|---|
| `welcome_email_preview(limit, canary_user, canary_email)` | service role | who a claim would take right now, taking nobody. Handles only, no addresses. The dry run. |
| `welcome_email_claim(limit, canary_user, canary_email)` | service role | the switch, the window, eligibility, suppression, the claim and the retry, in that order |
| `welcome_email_record(user, attempt, outcome, resend_id, reason)` | service role | `claimed` → `sent` or `failed`, for exactly that attempt |

All three, and two private helpers every path shares (`_welcome_email_can_receive`,
`_welcome_email_in_scope`), are installed inside one `do` block with their grants. The
CLI applies migration statements outside a transaction, and a function created on its own
is executable by PUBLIC until its `revoke` runs.

### Eligibility

Selected only when **all** hold:

- `welcome.delivery_enabled` is `true` (read before anything is written)
- the profile was created at or after `welcome.start_after`
- and at least `welcome.delay_hours` (48) and less than `welcome.max_age_hours` (168) ago
- the profile is `active` (not suspended)
- the auth user has an address, **confirmed**, and is not banned, soft-deleted or anonymous
- the account does not hold a live invite token of another environment or kind (see "The invite link"); one with no link at all is given its personal link by the claim
- there is no row for the account in `welcome_emails`, whatever its status

At most `welcome.max_per_run` (25) per run, whatever the caller asks for.

### Exactly once

1. **The claim is a primary-key insert.** `welcome_emails.user_id` is the key; the claim is
   `insert ... on conflict do nothing` and returns only rows it inserted. A second run, or
   an overlapping one, gets nobody. A primary key is at-most-once: it stops a second send
   starting, which is the failure that cannot be undone.
2. **Resend deduplicates the retry.** Every send carries
   `Idempotency-Key: welcome-v1-<user_id>`, identical on every attempt.
3. **Retries are bounded and inside Resend's window.** A `failed` row is retried at most to
   three attempts, and only within 20 hours of its first claim, because Resend holds a key
   for 24. The retry is a compare-and-set on `status = 'failed'`, so two runs cannot retry
   the same row, and it re-asks the claim's own questions (still in scope, still able to
   receive, not suppressed, same mode), so moving the cutoff back to 2099 stops retries too.
4. **An unrecorded send is never retried.** If Resend accepted a message and the record
   call then failed, the row stays `claimed`, which is never picked up again. The run
   exits non-zero and says `NOT RECORDED`. Look at it; do not re-run it away.

### The cases that are not a send

| situation | what happens |
|---|---|
| delivery off, or the cutoff still 2099 | nothing is claimed and nothing is written: hold, do not drop |
| account created before activation | never in the window, so never selected. **This is why switching it on cannot mail the existing beta population.** |
| unconfirmed, banned, soft-deleted, anonymous, suspended, no address | held: nothing written, so fixing it later still allows a welcome |
| no personal invite link yet | the claim mints the one personal link, then claims; the dry run counts these as `invite_links_to_create` |
| a live invite token of another environment or kind | held: nothing written, no token replaced |
| account deleted before or after the send | `delete from auth.users` cascades through `profiles` to the ledger row |
| address on `email_suppressions` | recorded as `suppressed`, never sent, never reconsidered |
| a person excluded by hand | a pre-inserted row of any status; see below |
| copy not approved, or no postal address | the worker refuses the run before claiming anybody |
| `dist/` older than `copy.json` | the worker refuses the run before claiming anybody |

## The invite link

The letter says "here's your invite link" and links the recipient's own personal token,
`https://bingd.app/i/<token>`: the same one the app shares from Invite friends.

**Tokens are minted lazily** (the first Invite friends tap, or an off-platform title share),
so many new accounts have none. Founder decision, 2026-09-13: don't hold the email for that.
Inside the claim, `_welcome_email_ensure_invite_token` returns the account's live personal
token, minting it first if there is none:

- **The same lock as the app.** It takes `create_invite_link`'s per-account advisory lock,
  so a send, a Share tap and `revoke_invite_link` serialise on one key. Two overlapping
  sends mint one token; a send and a Share tap agree on one token in either order. Both are
  proven on real PostgreSQL (races W3, W4), and a mutant with the lock deleted collides on
  `invite_tokens_one_live`.
- **The same token.** A dashless uuid, a separately drawn short code, `env` stamped from
  `env.name`, kind `personal`, which is exactly what `redeem_invite` accepts. An existing live
  token is reused, never replaced.
- **No other side effect.** It does not call `create_invite_link`, because that also writes an
  `invite_link_creations` row, the "Link created" stage of the invite funnel, and a welcome
  email is not somebody sharing their link. `revoke_invite_link` already mints without that
  row. Nothing else observes a token being created: there is no trigger on `invite_tokens`,
  no attribution, Invite Instigator progress, notification, feed event or push. A test
  counts every table in the schema before and after a claim, and only `invite_tokens` and
  `welcome_emails` change.
- **Minted only for the one being mailed.** Never in a dry run, never for a suppressed,
  held or out-of-window account.

An account whose live token is from another environment, or is not personal, cannot be
given a personal link without revoking that token, which the email will not do. It is held.
No writer creates such tokens today.

## Somebody asked not to be emailed

The Unsubscribe link and the `List-Unsubscribe` header both open an email to
`suraj@bingd.app` with the subject `Unsubscribe`. Act on it with one statement in the SQL
editor of the project concerned:

```sql
insert into email_suppressions (email, reason) values (lower('person@example.com'), 'unsubscribed')
on conflict (email) do nothing;
```

**Not Resend's suppression list.** That list is account-wide and the same account sends
every sign-in code: suppressing somebody there stops them signing in.

To keep an account out by handle instead:

```sql
insert into welcome_emails (user_id, status)
select id, 'excluded' from profiles where username = 'someone'
on conflict (user_id) do nothing;
```

## Compliance, simply

The note asks the reader to invite somebody and to try a feature, so it is treated as
commercial email and carries: the sender (`bingd is made by Suraj Kandukuri.`), a
**physical mailing address** (the `WELCOME_POSTAL_ADDRESS` secret, and the worker
refuses the cohort while it is null), and a visible **unsubscribe** plus a
`List-Unsubscribe` header.

The unsubscribe is a `mailto:` for v1. Gmail's and Yahoo's one-click requirement applies to
bulk senders; this is nowhere near that. There is no `List-Unsubscribe-Post` header, because
RFC 8058 one-click requires HTTPS and pairing it with a mailto is invalid. Build an HTTPS
endpoint before volume, and the header turns on in `envelope.mjs` by itself.

**Not built:** a Resend webhook for bounces and complaints. At this volume the Resend
dashboard is where to look.

---

## The canary: proving exactly-once without switching anything on

Needs: the SQL applied to the project (step 3 below), a test account in that project
whose email you control and have signed in with, its user id, and a Resend key.

First, put that inbox on the canary allowlist in the project's SQL editor. It starts
empty, and a canary claims nobody whose address is not on it:

```sql
update app_config set value = '["founder.test@example.com"]'::jsonb where key = 'welcome.canary_addresses';
```

```bash
# Keys into the child process only, never onto disk. Staging shown; production is abheeqyjzekiowkztfxv.
export SUPABASE_URL=https://fjxhcbowoxuzulwirzyr.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...   # npx supabase projects api-keys --project-ref <ref> -o json
export RESEND_API_KEY=re_...           # the welcome key, not the Supabase one
export WELCOME_FROM="Suraj from bingd <suraj@auth.bingd.app>"   # until bingd.app is verified
# The footer address. A send refuses without it, canary included: a canary is a real
# message to a real inbox, and the address is the legal line rather than a nicety. An
# obviously fake one is the right value for a test.
export WELCOME_POSTAL_ADDRESS="1 Example Street, Sampleton EX1 2MP"

W=emails/welcome/automation/send-welcome.mjs
ID=<test account user id>; EMAIL=<its confirmed address>

node $W --dry-run --canary $ID --canary-email $EMAIL   # expect: would claim 1
node $W --canary $ID --canary-email $EMAIL             # expect: claimed 1, sent 1, exit 0
node $W --canary $ID --canary-email $EMAIL             # expect: claimed 0, sent 0, exit 0
node $W --dry-run                                      # expect: delivery_enabled false; nobody else touched
```

Then, in the SQL editor:

```sql
select status, attempts, canary, resend_id, sent_at from welcome_emails;   -- exactly one row: sent, 1, true
```

A canary ignores `delivery_enabled` and the signup window, and nothing else. It claims
nobody unless the id and the confirmed address belong to the same account **and** that
address is on `welcome.canary_addresses`, all checked inside SQL before any write. A
canary's failed row is retried only by a canary run, never by the cohort, and the reverse.
Empty the allowlist again when you are done: `update app_config set value = '[]'::jsonb
where key = 'welcome.canary_addresses';` The same sequence runs in CI on every pull request
(`supabase/tests/welcome-email.test.mjs`, "canary on the real draft copy").

---

## Rehearsing the cohort without waiting 48 hours

The canary above proves exactly-once for **one named inbox**. What it does not exercise is
the cohort path — the signup window, the ordering, the per-run cap — because a canary
ignores the window on purpose. This is how to exercise that path in minutes instead of two
days, on staging, without creating anything that could shorten production timing.

**The mechanism is the window itself, not a test mode.** `welcome.delay_hours` is an
`app_config` row, and `app_config` is per project: staging's copy and production's copy are
different rows in different databases. Setting staging's to `0` makes an account created a
minute ago eligible immediately. There is no flag in the code that means "go faster", no
environment variable that bypasses a gate, and therefore nothing that can be left switched
on by accident — the only way to shorten production is to run the statement against
production, which is why the worker now prints the project ref above the window.

On **staging** (`fjxhcbowoxuzulwirzyr`), in that project's SQL editor:

```sql
-- Shorten the window and open the cutoff, on staging only.
update app_config set value = '0'::jsonb                       where key = 'welcome.delay_hours';
update app_config set value = to_jsonb((now() - interval '1 day')::text) where key = 'welcome.start_after';
update app_config set value = 'true'::jsonb                    where key = 'welcome.delivery_enabled';
```

Then, with staging's URL, key, From and `WELCOME_POSTAL_ADDRESS` exported (the block under
"The canary" shows all four — the address is required for a send and an obviously fake one
is correct here), sign up one or two throwaway accounts in the staging build and:

```bash
W=emails/welcome/automation/send-welcome.mjs

node $W --dry-run     # check the banner says project fjxhcbowoxuzulwirzyr, window 0h to 168h
node $W               # claims and sends to those accounts
node $W               # claims 0, sends 0 — the same accounts are not mailed twice
```

The first line of output is the project. **If it says `abheeqyjzekiowkztfxv`, stop**: that is
production, and the window statements above must never have been run there.

Put staging back when you are done, so a later rehearsal starts from the real shape:

```sql
update app_config set value = '48'::jsonb          where key = 'welcome.delay_hours';
update app_config set value = 'false'::jsonb       where key = 'welcome.delivery_enabled';
```

The same three-account scenario runs in CI on every pull request without any of this — see
`supabase/tests/welcome-email.test.mjs`, "onboarding state does not decide who is mailed",
which mails an account that never started the first-run flow, one that paused two titles
into it and one that finished, and asserts all three are claimed exactly once. The staging
rehearsal is for the parts CI cannot have: a real Resend send, a real inbox, real rendering
on a phone.

---

## Measuring this one email

Deliberately small. One email does not need an experimentation platform, and the two
systems that already exist answer the questions worth asking.

**From the ledger** (`welcome_emails`, Supabase SQL editor). How many were sent, how many
failed and why, and — because it is one row per account in the same database — who. That is
the join that makes the rest possible:

```sql
select status, count(*) from welcome_emails where not canary group by status;
```

**From Resend.** Delivered and bounced, per message, found by the `resend_id` this ledger
stores against each sent row. **Click tracking is off on the domain and should stay off
unless the founder decides otherwise**: turning it on rewrites every link in the letter
through a tracking redirect, which is a visible change to a personal note — the reader hovers
a link to their own invite and sees a Resend URL. The one link whose clicks genuinely matter
already counts itself: `/i/<token>` writes `invite_link_opens`, so invite clicks are
measurable **without** click tracking, and better, because they are joined to the account.

**Did they come back, and did they finish.** This is a PostHog question and needs nothing
new: take the list of user ids from `welcome_emails where status = 'sent'`, and compare
their `onboarding_completed` and `ranking_completed` timestamps against `sent_at`. See
`docs/product/onboarding-observability.md` §4, which spells out the two ways to do it and is
honest about which is a real cohort and which is an eyeball.

**Not built, on purpose:** no open-tracking pixel, no per-link UTM scheme, no
`welcome_email_clicked` analytics event, no A/B variants. Each would add a lifecycle event
to a product with exactly one lifecycle email, and the first three would change what the
reader receives. Revisit when there is a second email to compare against a first.

## Turning it on

In order. **Steps 1 and 2 are the founder's.** Step 5 is a separate decision from all of
the others.

1. **The envelope.**
   - Add `bingd.app` to Resend and create the DNS records it lists in Cloudflare: the
     `resend._domainkey` TXT (DKIM), and the `send` MX and TXT (return path). None of them
     touch the root MX, so Cloudflare Email Routing keeps receiving. Leave Resend
     receiving **off**.
   - Add `_dmarc.bingd.app` TXT `v=DMARC1; p=none; rua=mailto:suraj@bingd.app`.
   - Create a Resend API key with sending access restricted to `bingd.app`, named for this
     email. Store it as the GitHub secret `RESEND_API_KEY_WELCOME`.
   - Sign in with Apple private-relay addresses only deliver mail from registered domains.
     In Apple Developer → Certificates, Identifiers & Profiles → Services → Sign in with
     Apple for Email Communication, register `bingd.app` and `suraj@bingd.app`.
2. **The copy and the address.** *Done 2026-09-18:* the founder approved the letter in
   `copy.json` (`letter.status` is `"APPROVED"`) and stored the mailing address as the
   repository secret `WELCOME_POSTAL_ADDRESS`. It is deliberately **not** in `copy.json`: a
   value committed there is in git history for ever. Any later copy edit means running
   `node emails/welcome/build.mjs` and the tests, updating `LOCKED_LETTER`, and sending
   yourself a test at two inboxes. Read both on a phone in light and dark mode, reply from
   the one that is not the forwarding Gmail, and tap every link with and without the app.
3. **The SQL.** It is already a migration — `supabase/migrations/20260923000100_a_welcome_note_sent_once.sql`
   — so it goes out with the next ordinary `db push`. Applying it changes no behaviour:
   it creates two empty tables and inserts six switches that all mean "send nothing to
   nobody". Push it to staging first:

   ```bash
   npx supabase@latest db push --project-ref fjxhcbowoxuzulwirzyr --skip-vault --dry-run --yes
   npx supabase@latest db push --project-ref fjxhcbowoxuzulwirzyr --skip-vault --yes
   ```

   Run the canary on staging. Then the same two pushes with `--project-ref
   abheeqyjzekiowkztfxv`, and the canary on production with a founder test account.
   Applying the SQL changes no behaviour: every switch lands at "send nothing".
4. **The workflow.** Merge it (it has no schedule), then run it by hand: `target:
   production`, `mode: dry-run`. It should say `delivery_enabled false` and list nobody,
   because the cutoff is still 2099.
5. **Switch it on.** In the production SQL editor, in this order:

   ```sql
   update app_config set value = to_jsonb(now()::text) where key = 'welcome.start_after';
   update app_config set value = 'true'::jsonb        where key = 'welcome.delivery_enabled';
   ```

   Then commit the `schedule:` block that is commented out in
   `.github/workflows/welcome-email.yml`. From that moment, only accounts created after the
   `start_after` you just wrote are ever eligible. The first real send is about 48 hours
   later, to the first person who signed up after activation.

**The emergency stop** is one statement, with no deploy:

```sql
update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled';
```

A disabled run claims nobody, so everybody eligible is still eligible when it is turned
back on, within the one-week window.
