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

### Not yet done, and one of them is the dangerous one

**§2 linking is unverified.** The rules in §2 are stated as this document's requirements, and nothing in the code enforces them — Supabase decides whether a provider sign-in attaches to an existing account by matching email, and its behaviour has not been tested against the table in §2. This is the row that fails open: if Supabase links on an unverified address, the vector §2 exists to close is open, and the outside view of the bug is a user successfully reaching an account. **It must be tested against the running project before external testers exist**, and the test to write first is the unverified-email row.

**The remaining matrix rows** — returning users by each method, Hide My Email on second authorization, adding a method from Settings — need a device and a real provider, so they are manual for now. Settings has no link-a-method screen at all yet, which §3 notes is load-bearing for Apple relay users rather than a convenience.

**Sign-out does not clear an outbox or a SQLite cache**, because neither exists. §5 requires it when they do.

### Two settings this depends on

Both are in the Supabase dashboard, and both fail in ways that do not name their cause.

1. **The email template must contain `{{ .Token }}`.** Supabase's default sends `{{ .ConfirmationURL }}`, a magic link. The app asks for a six-digit code, so with the default template the email arrives with no code in it and the verification screen has nothing to accept. Authentication → Emails → Magic Link.
2. **The OAuth redirect must be registered.** Google returns to `Linking.createURL('auth/callback')`, which resolves per variant — `bingd://auth/callback`, `bingd-preview://auth/callback`, `bingd-dev://auth/callback`. An unregistered value is refused by Supabase before the provider is ever reached.
