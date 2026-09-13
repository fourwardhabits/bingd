# Sending the welcome email on a schedule

**Status: WRITTEN, TESTED, NOT ENABLED.** The SQL is not applied to any project, the
workflow has no schedule, `welcome.delivery_enabled` would be `false` and
`welcome.start_after` would be 2099. Turning it on is the numbered procedure at the bottom,
and its last step is a separate decision from every other step.

---

## What it does

About 36 hours after somebody creates a bingd. account, it sends them the founder's note
once, and never again. 36 hours, because the note assumes the reader has used the app: an
instant welcome lands during onboarding and reads as a system message. Accounts older than
a week are never selected, so a paused job does not send stale welcomes when resumed.

## The pieces

```
emails/welcome/automation/
  welcome_email.sql      the ledger, the suppression list, the switches, three functions
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

## Where the guarantees live

In SQL, not in the worker. The worker never selects a person: it asks
`welcome_email_claim` who it owns and sends to exactly those rows.

| function | who can call it | what it does |
|---|---|---|
| `welcome_email_preview(limit, canary_user, canary_email)` | service role | who a claim would take right now, taking nobody. Handles only, no addresses. The dry run. |
| `welcome_email_claim(limit, canary_user, canary_email)` | service role | the switch, the window, eligibility, suppression, the claim and the retry, in that order |
| `welcome_email_record(user, attempt, outcome, resend_id, reason)` | service role | `claimed` → `sent` or `failed`, for exactly that attempt |

### Eligibility

Selected only when **all** hold:

- `welcome.delivery_enabled` is `true` (read before anything is written)
- the profile was created at or after `welcome.start_after`
- and at least `welcome.delay_hours` (36) and less than `welcome.max_age_hours` (168) ago
- the profile is `active` (not suspended)
- the auth user has an address, **confirmed**, and is not banned, soft-deleted or anonymous
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
   the same row.
4. **An unrecorded send is never retried.** If Resend accepted a message and the record
   call then failed, the row stays `claimed`, which is never picked up again. The run
   exits non-zero and says `NOT RECORDED`. Look at it; do not re-run it away.

### The cases that are not a send

| situation | what happens |
|---|---|
| delivery off, or the cutoff still 2099 | nothing is claimed and nothing is written: hold, do not drop |
| account created before activation | never in the window, so never selected. **This is why switching it on cannot mail the existing beta population.** |
| unconfirmed, banned, soft-deleted, anonymous, suspended, no address | held: nothing written, so fixing it later still allows a welcome |
| account deleted before or after the send | `delete from auth.users` cascades through `profiles` to the ledger row |
| address on `email_suppressions` | recorded as `suppressed`, never sent, never reconsidered |
| a person excluded by hand | a pre-inserted row of any status; see below |
| copy not approved, or no postal address | the worker refuses the run before claiming anybody |
| `dist/` older than `copy.json` | the worker refuses the run before claiming anybody |

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
commercial email and carries: the sender (`bingd. is made by Suraj Kandukuri.`), a
**physical mailing address** (`footer.postalAddress`, a founder input, and the worker
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

```bash
# Keys into the child process only, never onto disk. Staging shown; production is abheeqyjzekiowkztfxv.
export SUPABASE_URL=https://fjxhcbowoxuzulwirzyr.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...   # npx supabase projects api-keys --project-ref <ref> -o json
export RESEND_API_KEY=re_...           # the welcome key, not the Supabase one
export WELCOME_FROM="Suraj from bingd. <suraj@auth.bingd.app>"   # until bingd.app is verified

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
nobody unless the id and the confirmed address belong to the same account, which is
checked inside SQL before any write. The same sequence runs in CI on every pull request
(`supabase/tests/welcome-email.test.mjs`, "canary on the real draft copy").

---

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
2. **The copy.** Rewrite the note, set `footer.postalAddress`, check the P.S. title, set
   `note.status` to `"APPROVED"`, run `node emails/welcome/build.mjs` and the tests, and send
   yourself a test at two inboxes. Read both on a phone in light and dark mode, reply from
   the one that is not the forwarding Gmail, and tap every link with and without the app.
3. **The SQL.** Move it into the migrations under a fresh timestamp newer than every file
   there, keeping the name the test support module looks for:

   ```bash
   ls supabase/migrations | tail -1                      # pick a later timestamp
   git mv emails/welcome/automation/welcome_email.sql \
     supabase/migrations/<timestamp>_a_welcome_note_sent_once.sql
   npm run test:db && npm run test:race                  # both suites follow the file
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
   `start_after` you just wrote are ever eligible. The first real send is about 36 hours
   later, to the first person who signed up after activation.

**The emergency stop** is one statement, with no deploy:

```sql
update app_config set value = 'false'::jsonb where key = 'welcome.delivery_enabled';
```

A disabled run claims nobody, so everybody eligible is still eligible when it is turned
back on, within the one-week window.
