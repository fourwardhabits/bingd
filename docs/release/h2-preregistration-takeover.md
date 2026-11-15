# H-2: pre-registration account takeover through password sign-up

**Status: confirmed on staging, mitigated by migration `20261124000100`, mitigation verified on
staging. Production gets the mitigation with the #307 release migrations.** H-1 is tracked
separately and is not affected by this document.

## The hypothesis

Supabase Auth keeps password sign-up open (the store-review account signs in with a password,
so the email provider stays on), and an address is only checked once somebody confirms it.
Somebody could call `signUp` with another person's address and a password of their own. If
that person later signs in to bingd with an emailed code, the confirmation lands on the same
row, and the stranger's password might still work.

## The test (staging only, 2026-11-15)

- Project: staging `fjxhcbowoxuzulwirzyr`, Supabase Auth v2.197.0. Production has the same
  settings that matter here: sign-up enabled, email confirmation required (no autoconfirm),
  no auth hooks, no triggers on `auth.users` before this migration.
- Disposable accounts at `@example.invalid` only, deleted after each run (0 left). No
  password, code or token was printed or stored; only outcomes and booleans were logged.
- Staging uses the built-in mailer, which delivers only to project members, so no email can
  reach a disposable address. The stranger's sign-up therefore used the admin API's
  `generateLink({ type: 'signup', email, password })`, which writes the same unconfirmed,
  password-bearing row as `signUp` and returns the code instead of mailing it. The owner's
  side used the public `verifyOtp({ type: 'email' })` call, which is what the app makes.
- Two ways the owner could verify, each on its own account:
  - **A:** a fresh sign-in code (`generateLink({ type: 'magiclink' })`)
  - **B:** the code from the sign-up email

### Before the mitigation: confirmed

| Step                                       | A                               | B                               |
| ------------------------------------------ | ------------------------------- | ------------------------------- |
| Stranger signs up with a password          | ok, unconfirmed                 | ok, unconfirmed                 |
| Stranger's password before verification    | refused (`email_not_confirmed`) | refused (`email_not_confirmed`) |
| Owner verifies with the emailed code       | session                         | session                         |
| **Stranger's password after verification** | **session (takeover)**          | **session (takeover)**          |

### After the mitigation: not reproducible

| Step                                   | A                               | B                               |
| -------------------------------------- | ------------------------------- | ------------------------------- |
| Owner verifies with the emailed code   | session                         | session                         |
| Stranger's password after verification | refused (`invalid_credentials`) | refused (`invalid_credentials`) |
| Owner signs in again with a new code   | session                         | session                         |
| Stranger's password after that         | refused                         | refused                         |

Controls in the same run:

- An operator-created, already-confirmed account (the store-review and QA-fixture path,
  `admin.createUser({ email_confirm: true })`) still signs in with its password.
- An ordinary code sign-up signs in, then signs in again with a second code.

Regression on staging with the migration applied: `remote-smoke` 137/137 and
`two-user-acceptance` 114/114.

## The mitigation

`supabase/migrations/20261124000100_a_password_nobody_proved.sql` adds a `BEFORE UPDATE`
trigger on `auth.users`. It fires only when `email_confirmed_at` goes from null to set, and
only on a row Auth had emailed a code or link to (`confirmation_sent_at` or
`recovery_sent_at` set). In that case it replaces any password on the row with a bcrypt hash
of 32 random bytes.

That is the state an honest code sign-up is already in, because Auth gives every
code-created account a random password nobody knows. Accounts created already confirmed by
an operator were sent nothing, so they keep their password. Addresses already confirmed
never meet the trigger. The function is `security definer`, uses `search_path = ''`, and is
executable by no API role. `supabase/tests/unproven-password.test.mjs` holds the rule.

## Not covered by this test

- **Sign in with Apple or Google on production.** Staging has no OAuth providers, so linking
  an OAuth identity to a stranger's unconfirmed row was not exercised.
- **Accounts confirmed in production before the migration.** If any were pre-registered by a
  stranger, they cannot be told apart from honest sign-ups after the fact. A password-sign-in
  audit would be a separate, broader investigation.
