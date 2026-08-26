# Auth email templates

The two emails Bingd's sign-in sends, as files, because they are the only part of this
product's configuration that lives entirely in somebody else's dashboard and had drifted
from what the app expects without anything noticing.

## What went wrong, and why it needs a directory

`sendEmailCode` calls `signInWithOtp` and `verifyEmailCode` calls `verifyOtp({ type:
'email' })`. Bingd is a **code** product: the person stays in the app, types six digits,
and never opens a browser. That has been true since the first commit and the client has
never done anything else.

Supabase's built-in templates send `{{ .ConfirmationURL }}` — a magic link. A friend-beta
tester reported it exactly: *"When I open the app and put in email it sends me a link to
confirm and no code. And the confirm link just opens in the email browser."*

Nothing in this repository said what the templates should be, so nothing could tell that
the deployed ones were wrong. That is the gap these files close.

## The two templates, and why there are two

**One client call reaches both.** `sendEmailCode` calls `signInWithOtp` with
`shouldCreateUser: true`, and Supabase picks the template by the *address*, not by the
call:

| The address | Template | Management API key | Verified as |
| --- | --- | --- | --- |
| has no account yet | **Confirm signup** | `mailer_templates_confirmation_content` | `'email'` |
| already has one | **Magic Link** | `mailer_templates_magic_link_content` | `'email'` |

That is the whole of Bingd's email auth since the founder's final 2026-08-26 decision:
ordinary users have no password, nobody declares whether they are new, and one six-digit
code screen serves both rows. `mailer_autoconfirm` is `false` on the project and stays
that way — a real address is verified before an account is usable.

**Fixing only one produces the worst possible bug.** Get Magic Link right and Confirm
signup wrong and sign-in works for everybody who already has an account and fails for
everybody new — invisible to whoever is testing it, total for whoever is arriving. That
is the bug the tester hit: she was new.

Both files carry `{{ .Token }}`, neither carries a link, and both say the same sentence.
The sameness is deliberate: the client cannot tell which template was sent, the code
screen therefore cannot say, and two emails that read differently would leak the one thing
the flow is careful not to disclose.

**The `verifiedAs` column is in `templates.json` and is checked.** It reads `'email'` for
both, because `@supabase/auth-js` documents `'email'` as the type for a code "sent to the
user's email during sign-up or sign-in" and marks `signup` and `magiclink` **deprecated**.
A client that picked between two types would have to know which kind of address it was
holding before it could verify — the question this flow exists in order not to ask.

## `{{ .Token }}` and `{{ .ConfirmationURL }}`

`{{ .Token }}` interpolates the numeric one-time code — the thing `verifyOtp` accepts.
`{{ .ConfirmationURL }}` interpolates a link that completes the sign-in **in a browser**,
which produces a session Bingd never sees. Neither template may contain it: a link beside
a code is a link somebody will tap, and tapping it strands them in Safari.

`config/auth-templates.test.mjs` asserts that, in CI, on every pull request.

## Applying them

These are **not** applied by `supabase db push`. They are project configuration, and this
repository has no credential that can write it. Two ways:

1. **Dashboard** — Authentication → Emails → *Confirm signup* and *Magic Link*. Paste the
   subject and the body of each file.
2. **Management API**, with a personal access token:

   ```
   node scripts/check-auth-config.mjs          # read-only: reports the live shape
   node scripts/check-auth-config.mjs --apply  # writes the templates above
   ```

   The script sends a **partial** `PATCH` naming only the keys in `templates.json`.
   That is deliberate and it is the expensive lesson recorded in
   `docs/architecture/auth.md`: `supabase config push` sends a whole `[auth]` block and
   reverts every field it does not mention, **including the Apple and Google client
   secrets**. Do not reach for it to apply these.

## The prerequisite that is not a template

Supabase refuses template edits altogether while a project is on the free tier with the
built-in email sender:

> Email template modification is not available for free tier projects using the default
> email provider. Please upgrade your plan or configure a custom SMTP provider.

So **custom SMTP is a prerequisite for email auth working at all**, not a deliverability
improvement to schedule later. Until it is configured on a project, these files describe
a state that project cannot be put into, and `check-auth-config.mjs` will say so rather
than appearing to succeed.

The built-in sender's rate limit is also low enough that a handful of people signing up
within a few minutes will hit it — which is the shape of a movie night, and the exact
population this app is for.


### There is no password path to reduce the bill

Worth stating because a short-lived amendment made email-and-password the default email
method on the reasoning that a password sends no mail. That is reverted. The only account
in Bingd with a password is the one provisioned for App Store and Play review
(`../../docs/release/store-review-access.md`), and it is one account signing in a handful
of times a year.

So every one of these needs mail to arrive, and each is somebody's first or worst moment
with the product:

- a new person's first sign-in, which is also how their account is created;
- every returning sign-in that is not Apple or Google;
- *Send a new code*, which is what somebody taps when the first one did not arrive.

`docs/release/production-bootstrap.md` carries SMTP as a launch prerequisite rather than a
nice-to-have.
