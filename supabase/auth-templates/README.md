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

Supabase chooses the template from the *account*, not from the call:

| The address | Template | Management API key |
| --- | --- | --- |
| has no account yet | **Confirm signup** | `mailer_templates_confirmation_content` |
| already has one | **Magic Link** | `mailer_templates_magic_link_content` |

`sendEmailCode` passes `shouldCreateUser: true`, so both are reachable from the one
button on the sign-in screen, and `mailer_autoconfirm` is `false` on the project — which
is what routes a brand-new address to *Confirm signup*.

**Fixing only one produces the worst possible bug.** Sign-in works for everybody who has
used the app before and fails for everybody new, so it is invisible to the person testing
it and total for the person arriving. The tester's report is that bug: she was new.

Both files below therefore say the same thing and carry `{{ .Token }}`.

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

So **custom SMTP is a prerequisite for email sign-in working at all**, not a
deliverability improvement to schedule later. Until it is configured on a project, these
files describe a state that project cannot be put into, and `check-auth-config.mjs` will
say so rather than appearing to succeed.

The built-in sender's rate limit is also low enough that a handful of people signing up
within a few minutes will hit it — which is the shape of a movie night, and the exact
population this app is for.
