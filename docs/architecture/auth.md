# Bingd — Authentication and Identity

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §22, §23, §26.1 · [`data-model.md`](./data-model.md) §2

Added 2026-08-13. Authentication was specified in the PRD as three sign-in methods and one sentence — "every account resolves to one stable internal user UUID that is independent of the sign-in method" — and then given no architecture document. Every other v1 subsystem has one.

That mattered more than an ordinary gap, because the sentence describes the hardest problem in the subsystem without describing its solution, and the acceptance criterion built on it (§26.1.3: *"signing in again by any method reaches the same account"*) is **unsafe if implemented literally**. Reaching the same account by a different method means linking two credentials, and linking two credentials on the strength of a matching email address is an account-takeover vector wherever that address is unverified. An agent building to §26.1.3 without this document would have produced either that vector or duplicate accounts, and would have had no basis for choosing.

---

## 1. The identity model

One `auth.users` row per person, one `profiles` row keyed to it, and **one UUID that never changes**. Sign-in methods are credentials attached to that identity; none of them *is* the identity. Everything downstream — rankings, follows, attributions, tokens — references the UUID, so adding, removing, or replacing a credential is invisible to the rest of the schema.

Three methods in v1:

| Method | Platform | Notes |
|---|---|---|
| Email one-time code | Both | Six-digit code, no password. Nothing to leak, reuse, or reset |
| Sign in with Apple | Both, **required on iOS** | Apple's guidelines require it wherever a third-party social login is offered |
| Google | Both | |

No passwords anywhere. That removes password storage, strength rules, reset flows, credential-stuffing exposure, and the single largest category of account-security incident, at the cost of an email round trip.

---

## 2. Linking — Required

This is the section §26.1.3 needs, and the rule is deliberately more conservative than the acceptance criterion's wording.

**An email address links two credentials only when the provider asserts it is verified, on both sides.**

| Situation | Behaviour |
|---|---|
| New email, no existing account | Create the identity |
| Provider asserts a **verified** email matching an existing account | Attach the credential to that identity. Sign the user in |
| Provider gives an **unverified** email matching an existing account | **Do not link, do not create.** Refuse, and name the method the account already has |
| Apple private relay address, no match possible | Treated as a new identity unless linked explicitly (§3) |
| Signed-in user adds a second method in Settings | Link. The session is the proof of ownership |

The third row is the one that matters. If an unverified email were enough, anyone could create an account at a third-party provider claiming a victim's address and walk into the victim's Bingd account. Email OTP is verified by construction — possession of the code *is* the verification. Apple and Google both assert verification status in the token, and that assertion is what gets checked; the address alone is never sufficient.

Refusal is a real product surface, not an error state, and its copy is fixed:

> *This email already has a Bingd account. Sign in with the method you used before, then add this one in Settings.*

The fifth row is the safe path to the same outcome, and it is the reason refusal is acceptable rather than a dead end. Linking from inside an authenticated session needs no email heuristics at all: the session already proves who is asking.

---

## 3. Apple private relay — Required

When a user chooses **Hide My Email**, Apple returns a per-app relay address at `privaterelay.appleid.com` rather than the real one. Three consequences, and all three are the kind of thing that is discovered in the wrong week:

1. **A relay address can never match anything.** It is unique to this app and this user, so an Apple-first account will never auto-link to Google or email OTP by address comparison. For these users, §2's fifth row is the *only* path to a second method. The Settings link flow is therefore not a convenience; it is load-bearing for a population Apple actively encourages.
2. **Apple returns the name and email exactly once**, on the first authorization. A subsequent sign-in returns neither. They are captured at first authorization and persisted, or they are gone — and reproducing the bug requires revoking the app in iOS Settings, which is not an obvious step when a tester reports a blank display name.
3. **Sending mail to a relay address requires registering the sending domain with Apple.** Bingd v1 sends no transactional email except the OTP, which never goes to a relay address, so this is not a v1 blocker. It becomes one the moment any email notification exists, and PRD §15's notification categories are the obvious place that will start.

Nothing about a relay address is treated as second-class. It is a valid email in `auth.users` and a valid identity, and the product never asks a user to reveal their real address as a condition of anything.

---

## 4. The gap between authentication and account

Authenticating is not having an account, and this is a real state rather than a transient one. `profiles.id` references `auth.users(id)`, the 13+ gate reads `profile_private.date_of_birth`, and the date of birth is collected during onboarding — so between first authorization and profile creation there is an `auth.users` row with **no profile**, and no age check yet performed.

Rules for that state:

- Every read surface treats a missing profile as *not onboarded*, never as an empty profile. `can_view_profile` returns false for a subject with no profile row, which it already does by falling through to null-safe comparisons.
- The client routes an authenticated session with no profile straight back to onboarding, at whatever step it left off.
- **The 13+ refusal happens at profile creation**, which is the first moment a date of birth exists. A refused account is deleted immediately — both the profile attempt and the `auth.users` row — rather than left dormant. Retaining a date of birth belonging to a child who was just refused is the opposite of the intent, and PRD §22's minimum-age rule is about not holding the data.
- Sessions authenticated but abandoned before onboarding are pruned on a schedule. They hold no user content.

---

## 5. Sessions

- Refresh tokens live in **`expo-secure-store`**, which is Keychain on iOS and Keystore on Android. Never `AsyncStorage`, which is unencrypted plaintext on disk and is the default an agent reaches for first.
- Access tokens are short-lived and refreshed by the Supabase client. The app does not implement its own refresh loop.
- A session survives app restarts and long offline periods. Offline resilience (PRD §18) assumes it: the outbox drains under the identity that queued the writes, and an expiry that silently signed a user out would strand their queue.
- **Sign out** clears the session, the outbox, and the SQLite cache. Leaving another account's queued writes on a shared device is both a privacy leak and a correctness bug.
- **Account deletion** is a separate, irreversible action reached only from Settings, with a typed confirmation. Apple requires in-app deletion wherever an app offers in-app account creation. Semantics are in [`api.md`](./api.md) §6.

---

## 6. What is deliberately absent in v1

- No passwords, so no reset flow.
- No two-factor authentication. Both social providers already carry their own, and email OTP is single-factor by design. Revisit when the product holds anything worth stealing beyond a ranking.
- No account recovery beyond re-authenticating with a linked method. A user who loses access to every linked method loses the account, and that risk is what §2's Settings link flow reduces. Worth prompting for a second method during onboarding once the alpha shows how many users have only one.
- No email change flow. Changing the address on an identity is a credential change and gets the same treatment as adding one, from an authenticated session — deferred to early traction.

---

## 7. Testing

`SIGN_IN` matrix, per platform:

| Case | Expected |
|---|---|
| Each of three methods, new user | One identity, one profile, onboarding reached |
| Each of three methods, returning user | Same UUID as the first sign-in |
| Second method, verified email matching an existing account | Linked. Same UUID. No second account |
| Second method, unverified email matching an existing account | Refused with the §2 copy. **No link, no new account** |
| Apple with Hide My Email, first authorization | Name and email captured and persisted |
| Apple with Hide My Email, second authorization | Account resolves correctly with no name or email returned |
| Apple relay account adding Google in Settings | Linked. Same UUID |
| Authenticated, onboarding abandoned, app reopened | Returns to onboarding, not to a broken empty profile |
| Date of birth under 13 | Refused, and both rows deleted |
| Sign out with a non-empty outbox | Queue and cache cleared |
| Token refresh after a long offline period | Session restored, outbox drains under the same identity |

The unverified-email row is the one to write first and the one to keep. It is the only test in the matrix that fails *open* — an implementation that gets it wrong looks entirely correct from the outside, because the user reaches an account, and it happens to be someone else's.

---

## 8. Implementation status — added 2026-08-13

Built: session storage, the three sign-in methods, the authenticated-without-a-profile state, and account creation. `create_profile` and `username_available` are in `supabase/migrations/20260813002200_signup.sql`; the client is in `src/features/auth/`.

Two decisions in the build are worth recording because the obvious alternative is wrong in each case.

**The under-13 refusal is a returned value, not an error.** §4 requires the account to be *deleted* on refusal, and a function that raises cannot delete anything — the exception rolls the transaction back, deletion included, so the account survives every attempt to remove it. `create_profile` therefore answers `{"ok": false, "reason": "under_13"}` for that one case and raises for everything else, since rolling back is the correct outcome for a taken username or a malformed date. A consequence worth stating: an under-13 date is destructive in a way no other field on the form is, so the client confirms the date before submitting rather than after.

**Session tokens are chunked.** §5's requirement for `expo-secure-store` is not a drop-in swap for `AsyncStorage`: iOS Keychain rejects values much above 2 KB and a real Supabase session exceeds that. An unchunked adapter works for the whole of development and then fails on a live token, with the symptom being a user signed out on every cold start. `src/lib/session-storage.ts` splits values and writes the chunk count last, so an interrupted write reads as absent rather than as a short value.

### Not yet done

**§2 linking is enforced by Supabase's defaults, not by Bingd — and the default is the safe one.** An earlier draft of this section called this the row that fails open, on the reasoning that nothing in Bingd's code enforces §2 and an unverified email linking into an existing account would be an account takeover that looks like a normal sign-in. An independent review checked the actual behaviour rather than the worry: Supabase's identity-linking documentation states that automatic linking requires a verified email, and GoTrue's `internal/models/linking.go` decides `CreateAccount` unconditionally when the provider asserts no verified email, blanking the candidate address where it would duplicate an existing account. It never reaches `LinkAccount` on that path.

So the outcome of the dangerous row is a **duplicate account**, not a takeover. That is visible, recoverable, and the correct failure. What remains is a divergence from spec rather than a hole: §2 promises a fixed refusal message and the user silently gets a second account instead, and there is no Settings flow to merge the two. Both should be closed, and neither is urgent.

The live check is still worth doing once, because the above is evidence about documented behaviour and published source rather than about the GoTrue version this project is deployed against. It is no longer a gate on distributing a build.

**The remaining matrix rows** — returning users by each method, Hide My Email on second authorization, adding a method from Settings — need a device and a real provider, so they are manual for now. Settings has no link-a-method screen at all yet, which §3 notes is load-bearing for Apple relay users rather than a convenience.

**Abandoned sessions are not pruned**, which §4 said they would be. `sendEmailCode` passes `shouldCreateUser: true`, so every code request mints a permanent `auth.users` row for whatever address was typed, whether or not anyone ever verifies it, and nothing removes the profile-less ones. It needs a scheduled job deleting rows older than some window with no `profiles` row. Worth knowing before writing it: that job runs into the same delete-privilege question as the age gate below, so it is a good place to discover a non-cascading foreign key.

**Sign-out does not clear an outbox or a SQLite cache**, because neither exists. §5 requires it when they do.

**The age gate's deletion is verified only against the test harness.** In PGlite, `auth.users` is a shim table owned by the same role that owns the function, so the delete is trivially permitted and cascades to nothing; on hosted Supabase the table belongs to `supabase_auth_admin`. The delete should succeed, since a `postgres`-owned definer function is Supabase's own documented pattern and GoTrue's dependent tables cascade, but that is reasoning rather than observation. `create_profile` now raises rather than returning `ok: false` if the delete fails, so the failure cannot masquerade as a successful refusal, and one live probe against the running project would retire the question.

### What email sign-in depends on, which is more than a template

**Email one-time codes require a custom SMTP provider.** Not for deliverability, though that follows: Supabase does not permit editing email templates at all while the built-in email service is in use, and the built-in templates send `{{ .ConfirmationURL }}`, a magic link. §1 specifies a six-digit code, `verifyEmailCode` calls `verifyOtp`, and the code lives in `{{ .Token }}`. So with the shared sender the email arrives containing no code and the verification screen has nothing to accept — and the setting that would fix it is disabled, rather than merely unset.

Confirmed against the project rather than inferred, by patching the template through the Management API and reading the refusal: `Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider.` So it is a plan-and-provider restriction, not a dashboard quirk to be worked around.

The same look found a second, quieter mismatch. The project was issuing **eight-digit** codes, and `app/(auth)/verify.tsx` accepts `/^\d{6}$/` — it will not enable its own button for anything else. Email sign-in would therefore have failed even with a correct template, and the symptom would have been a code that arrives and cannot be typed. `mailer_otp_length` is now 6 and `mailer_otp_exp` 600 seconds, matching the copy on the screen. Both were set with a partial `PATCH` to `/v1/projects/{ref}/config/auth` rather than `supabase config push`, which sends a whole `[auth]` block and reverts every field it does not mention — including the Apple and Google client secrets.

Two templates need it, not one, and the difference is invisible while testing. Supabase sends **Confirm signup** to an address that has no account yet and **Magic Link** to one that does. Fixing only Magic Link produces an app where sign-in works for everyone who has used it before and fails for everyone new, which is the population you would never be a member of.

The built-in sender also carries a rate limit low enough that a handful of people signing up in the same few minutes will hit it, which is the shape of a movie night. So SMTP is a prerequisite for email sign-in reaching anyone outside the founder, not a polish step.

Until it exists, **Google is the working method on Android and Apple on iOS**, both verified. Email is the one that is configured in code and unusable in the dashboard.

#### The method order reversed — founder decision, 2026-08-26

Everything below this heading was written when a one-time code was the primary email
method. It is now the secondary one, and the reason is the paragraph above about the
built-in sender's rate limit: **a password is the only email method that sends no mail.**
A returning user signing in with one costs nothing, which is most sessions.

| | |
| --- | --- |
| Default | `signUp` / `signInWithPassword` |
| Secondary sign-in | `signInWithOtp`, `shouldCreateUser: **false**` |
| New-account verification | `verifyOtp({ type: 'signup' })`, **in app**, from the Confirm signup email |
| Passwordless verification | `verifyOtp({ type: 'email' })`, unchanged |

Three consequences worth keeping in view.

**`shouldCreateUser: false` is what stops a second registration route.** It was `true`
while the code was the door, correctly; leaving it true would mint a permanent
`auth.users` row for every mistyped address on a screen whose sibling is the one that
sets a password.

**The two OTP types are not interchangeable.** A signup token and a magic-link token look
identical in an inbox and live in different columns, so verifying one as the other answers
`otp_expired` — which every screen reports as "that code did not work", while the person
is looking at the correct code. `EMAIL_OTP_TYPES` in `methods.ts` is the single place both
are named, and `config/auth-templates.test.mjs` checks each template against the type its
code is verified with.

**An unconfirmed account is a third sign-in outcome, not an error message.** Somebody who
closed Bingd before typing the code has a correct password and an unusable account;
GoTrue answers `email_not_confirmed`, and folding that into "that email and password do
not match" tells them something false about the password they just typed — for ever,
since nothing else would correct it. `signInWithEmailPassword` returns `unverified` and
the screen routes them back to the code.

Still true and unchanged: **`shouldCreateUser` means abandoned rows accumulate** for
addresses that never verify — the note further down about pruning them applies to
`signUp` now rather than to the code flow, and the job still does not exist.

#### It reached a tester, which is what a written-down risk is for

Everything above was known and written here on 2026-08-21, and a friend-beta tester still hit it on 2026-08-25: *"When I open the app and put in email it sends me a link to confirm and no code. And the confirm link just opens in the email browser."*

Note "a link to **confirm**". `/auth/v1/settings` on `abheeqyjzekiowkztfxv` reports `mailer_autoconfirm: false`, so a brand-new address is routed through **Confirm signup** rather than **Magic Link** — she was the new-user half of the paragraph above, arriving before anyone had been able to fix either template.

What this section was missing is that a paragraph is not a check. The client was never wrong and its tests always passed; there was simply nothing in the repository stating what the *project* should send, so there was nothing for the deployed configuration to be compared against. Three things now exist:

- [`supabase/auth-templates/`](../../supabase/auth-templates/) — both templates, as files, carrying `{{ .Token }}` and no link of any kind, plus `templates.json` naming the Management API keys they belong in.
- [`config/auth-templates.test.mjs`](../../config/auth-templates.test.mjs) — the static shape check, in `npm run test:config`, so CI refuses a template that grows a `{{ .ConfirmationURL }}` or an `href`, refuses a manifest that drops back to one template, and asserts that `mailer_otp_length` still agrees with `verify.tsx`'s `/^\d{6}$/`. It also asserts `sendEmailCode` passes no `emailRedirectTo`, which is the one way this could be undone from inside the repo rather than from a dashboard.
- [`scripts/check-auth-config.mjs`](../../scripts/check-auth-config.mjs) — the live half. Read-only by default; `--apply` writes the canonical values as a partial `PATCH`, for the reason recorded two paragraphs up. With no `SUPABASE_ACCESS_TOKEN` it reports what the anon key *can* see and exits 2 with the dashboard path, rather than exiting 0 on a check that did not happen.

None of that is in a pull request's diff of the running project, and none of it travels with a deploy: **auth email configuration is console state**. The guard is that a new project now fails a check instead of failing a person.

**The OAuth redirects must be registered**, which they are, as `bingd://**`, `bingd-dev://**`, `bingd-preview://**` and `https://bingd.app/**` alongside the three exact callbacks. Google returns to `Linking.createURL('auth/callback')`, which resolves per variant, and an unregistered value is refused by Supabase before the provider is ever contacted — so the symptom names the redirect and not the provider.
