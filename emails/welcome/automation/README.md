# Sending the welcome email on a schedule

**Status: DESIGNED, WRITTEN, AND NOT ENABLED.** Nothing in this directory runs. There is
no workflow trigger, no cron entry, no deployed function, and the migration that would
create the ledger is deliberately **not** in `supabase/migrations/`, so no `db push` can
pick it up by accident.

Turning it on is five deliberate steps and they are listed at the bottom.

---

## What it would do

About 36 hours after somebody creates a bingd. account, send them the founder's note
once, and never again.

36 rather than immediately, because the note says *"you will find rough edges"* and
*"bingd. gets much better once one person you already talk about films with is on it"*.
Both sentences need the reader to have used the thing. An instant welcome arrives while
they are still in onboarding and reads as a system message; a week later it reads as an
apology for silence. A day and a half means it lands the evening after the evening they
signed up, which is when somebody who liked it has ranked a few more things and somebody
who did not has already stopped.

---

## Why a GitHub Action and not an Edge Function

The obvious shape in this stack is `pg_cron` calling a Supabase Edge Function, next to
`push-sender`. It is the wrong choice here, for a reason this repository has already paid
for once:

> **Nothing in the release path deploys `supabase/functions/`.** The TMDB adapter drifted
> thirteen days behind its source and nulled every `episode_count` before anybody noticed,
> because a merged commit and a deployed function are separate events and only one of them
> is visible in git.

A welcome email that silently runs a fortnight-old template has exactly that failure
shape, and it is worse here: the email is the product's only direct line to a new user,
and a stale one is sent to people who cannot be un-sent to.

`.github/workflows/trending-refresh.yml` is the pattern to copy instead. It is a scheduled
Action that runs a Node script from the repository against production, it has been running
nightly since 2026-09-01, and what it runs is always exactly what is on `main`. The
template travels with the code.

The other two options and why not:

| | why not |
|---|---|
| **Resend Automations** with contacts synced from Supabase | It means continuously exporting every user's email address to a third party. The privacy policy names exactly who receives what, and an email vendor holding the user list is not on that list. It would need a policy edit first, and a policy edit is a document. |
| **A Postgres trigger on signup** | The send would sit inside the transaction that creates the account. A Resend outage would then fail signups. |

---

## The pieces

```
.github/workflows/welcome-email.yml     NOT WRITTEN. The trigger. See step 5.
emails/welcome/automation/
  20260916000100_welcome_email.sql      the ledger and the two switches. NOT APPLIED.
  send-welcome.mjs                      the worker. Runs, refuses, exits 0.
emails/welcome/build.mjs                renders the template the worker sends
```

---

## Exactly once

Three mechanisms, because no one of them is enough on its own.

**1. The ledger claims before it sends.** `welcome_emails` has `user_id` as its primary
key, and the worker's first act for each recipient is

```sql
insert into welcome_emails (user_id, status) values ($1, 'claimed')
on conflict (user_id) do nothing
returning user_id
```

No row back means somebody else has it, so this run skips it. A primary key is
**at-most-once, not at-least-once**: it guarantees a second send cannot start, and it
guarantees nothing about the first one finishing. That is the right way round here. The
failure it forecloses is mailing somebody twice, which cannot be undone; the failure it
permits is mailing them zero times, which the retry below fixes.

**2. Resend's idempotency key covers the retry.** Every send carries
`Idempotency-Key: welcome-v1-<user_id>`, so a claim that was made, sent, and lost its
reply can be retried without a second message arriving. This is what makes step 1 safe to
combine with step 3.

**3. Retries are bounded and visible.** A send that fails leaves the row at
`status = 'failed'` with `attempts` incremented and the reason recorded. A later run picks
up `failed` rows with `attempts < 3`. After three the row stays failed and is never
touched again, which is a thing to look at rather than a thing to keep hammering.

### The cases that are not a send

| situation | what happens |
|---|---|
| Account deleted before the send | `user_id references profiles(id) on delete cascade`, so the ledger row goes with it. The selection query joins `profiles`, so a deleted account is never selected in the first place. |
| Account deleted after the send | The row cascades away. Nothing tries to re-send, because the account is gone from the selection too. |
| No email address on the account | `status = 'no_address'`, claimed and never retried. Sign in with Apple can withhold one, and a row that retries forever on a fact that will not change is noise that trains you to ignore the table. |
| Address hard-bounces | Resend records it. The ledger says `sent`, which is true: it was sent. Bounce handling is a webhook and is not built. See **Not built** below. |
| The reader unsubscribes | They were sent one email and there is no second one. The unsubscribe matters for the next email, whatever it turns out to be, which is why the link is in this one. |

---

## The two switches, and the order they are read in

**`welcome.delivery_enabled`** in `app_config`, default **`false`**.

Read once at the top of the worker, **before anything is claimed**. Disabled means the run
exits having touched nothing, so every eligible account is still eligible when it is
turned back on. This is the emergency stop: flip one row and the next run is inert, with
no deploy and no workflow edit.

> This is written the way it is because of what happened to `push.delivery_enabled`. That
> flag existed for two weeks and **was never actually read** by the code it was supposed to
> gate. The fix (PR #119) established the rule this follows: gate at claim time, and
> **hold rather than drop** — a disabled run must not consume the thing it declined to do.

**`welcome.start_after`** in `app_config`, a timestamptz, default **`'2099-01-01'`**.

Only accounts created at or after it are selected. Two jobs:

- **It is why turning the job on cannot mail the existing user base.** Every account that
  exists today was created before any plausible value, so the first run with a real date
  in it selects only people who signed up after that moment.
- It is the second switch. Setting it back to 2099 stops future selection without
  touching the first flag.

The default is 2099 rather than null so that a misconfigured run selects nobody rather
than everybody. A null would have meant "no lower bound".

### Excluding somebody by hand

Pre-claim them. The primary key does the rest:

```sql
insert into welcome_emails (user_id, status)
select id, 'excluded' from profiles where username = 'someone'
on conflict (user_id) do nothing;
```

The worker skips any user with a row, whatever the status says, so `'excluded'` needs no
special handling in the code. It is a word for the person reading the table later.

---

## Compliance, in the simplest form that is actually correct

This message carries an ask to invite a friend and an ask to try a feature. Under
CAN-SPAM's **primary purpose** test that is enough promotional content for a reasonable
recipient to read the message as commercial, however warmly it is written. Arguing that a
founder's note is transactional is a position somebody would have to defend, and the cost
of not having to is two lines in a footer.

So it is treated as **lifecycle/commercial**, and it carries:

- a **physical mailing address**. There is no company, so this is a personal address or a
  PO box. It is `footer.postalAddress` in `copy.json`, it is `null`, and the build prints
  a warning rather than inventing one. **Founder input required.**
- a **visible unsubscribe**, plus `List-Unsubscribe` and `List-Unsubscribe-Post` headers
  so Gmail and Apple Mail show their own one-tap control.

**The unsubscribe is a `mailto:` today, and that is a deliberate v1.** A one-click HTTPS
endpoint is what Gmail and Yahoo require of *bulk* senders, which begins at 5,000 messages
a day to a single provider. This is nowhere near that, and `mailto:` unsubscribe is
honoured by Gmail's interface. What it costs is that somebody has to act on the mail that
arrives. Build the HTTPS endpoint before volume, not before launch.

**Not built, and worth knowing:** there is no Resend webhook, so bounces and complaints
are not recorded anywhere and no suppression list is maintained. At this volume the Resend
dashboard is the suppression list. At any real volume it is not, and a complaint rate
nobody is measuring is how a sending domain gets quietly throttled. `auth.bingd.app` also
sends every sign-in code, so its reputation is load-bearing for people being able to log
in at all.

> **Consider a separate subdomain for anything that is not authentication.** If a welcome
> email ever earns spam complaints on `auth.bingd.app`, the collateral damage is sign-in
> codes going to spam, which looks to a user exactly like the app being broken.

SPF, DKIM and DMARC are Resend's own records on `auth.bingd.app`, which reports `verified`.
Whatever domain the real send uses has to be verified the same way, and that is DNS.

---

## Turning it on

Five steps, in this order. Steps 1 and 2 are the founder's and nobody else's.

1. **Settle the envelope.** Add `bingd.app` to Resend and verify its DNS, decide the From
   address, and confirm the Reply-To mailbox actually receives. Put the postal address in
   `copy.json`.
2. **Approve the copy.** Rewrite the note, send yourself a test, read it on a phone in
   both light and dark, tap all three buttons on a phone that has bingd. installed.
3. **Apply the migration.** Move `20260916000100_welcome_email.sql` into
   `supabase/migrations/`, review it, and push it to staging first. It creates the ledger
   and inserts both switches at their safe defaults, so applying it changes no behaviour.
4. **Create the secrets.** `RESEND_API_KEY` as a new key, not the one named `Supabase`,
   and `SUPABASE_SERVICE_ROLE_KEY`. Run the worker by hand with `--dry-run` against
   production and read the list of who it would have mailed.
5. **Add the workflow, then the switches.** Write `.github/workflows/welcome-email.yml`
   with `workflow_dispatch` only. Run it by hand. Watch the ledger. Then, and only then,
   add `schedule:` and set `welcome.start_after` to now and `welcome.delivery_enabled`
   to true.

**Do step 5's two switches last and separately.** The workflow existing is not the same
decision as the workflow being allowed to send, and keeping them apart is what makes the
first real run something you chose rather than something that happened.
