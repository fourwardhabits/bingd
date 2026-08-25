# Store review access — the demo account

**Owner:** founder / release shepherd. **Nothing in this document may ever hold a
credential.**

Bingd signs ordinary people in with a six-digit code emailed to them, or with Apple or
Google (`../architecture/auth.md` §8, *The final email contract*). An App Store or Play
reviewer has none of those: no mailbox this project can send to, no Apple ID they will sign
into on a test device, no Google account they will attach to a submission. **An OTP-only
app is an app whose sign-in screen review cannot get past**, and the rejection reads
"we were unable to sign in", costs a full submission round, and repeats until it is fixed.

That is the entire reason Supabase's password capability is retained and the entire reason
*More sign-in options → Sign in with password* exists on the sign-in screen. It signs in
one account: this one.

---

## 1. What the account has to be

| | |
| --- | --- |
| Address | Suggested: `review@bingd.app`. It must be a real mailbox only if you want to receive the OTP as well — the password is what review uses, so a routable alias is enough. |
| Password | Fixed, long, and **set in the Supabase dashboard**, never in code, never in this repository, never in a commit message or a PR description. |
| Profile | **Completed.** Username, display name, avatar, and a date of birth over 13 — otherwise the reviewer lands on onboarding rather than on Bingd. |
| Content | Enough to demonstrate the product: see §3. An empty account demonstrates an empty app. |
| Project | The project the submitted binary points at. For the friend beta that is `bingd-nonprod`; for the RC it is production, and the account has to be created **again** there. |

**One account can serve both stores** unless something makes it impossible — parallel
reviews signing in at once are fine, since nothing in Bingd is single-session. Create a
second only if a reviewer reports a conflict.

---

## 2. Creating it — founder actions, in order

1. **Supabase dashboard → Authentication → Users → Add user → Create new user.**
   Set the email, set the password, and tick **Auto Confirm User**. Without that tick the
   account exists and cannot sign in: `signInWithPassword` refuses an unconfirmed address,
   and the app's copy is deliberately generic, so the symptom will be *"we could not sign
   you in with that email and password"* on credentials that are correct.
2. **Sign in on a device with the submitted build**, through *More sign-in options → Sign
   in with password*. This is the only step that proves the thing review will actually do.
3. **Complete the profile** as that user, through onboarding, like any other account.
4. **Seed the activity in §3**, as that user, through the app.
5. **Put the credentials in the store consoles** (§4). Nowhere else. Not in Slack, not in
   an issue, not in this file.

> **`signUp` cannot be used for this and the app cannot create it.** There is no
> create-account-with-a-password path in the client — `supabase.auth.signUp` is not called
> anywhere, and `config/auth-templates.test.mjs` asserts that it stays that way. The
> dashboard is the only door.

---

## 3. What to seed, and why each thing

A reviewer spends a few minutes and forms a judgement about whether the app does what the
listing says. Each of these exists because a screen is empty without it.

| Seed | What it makes reviewable |
| --- | --- |
| **~10 ranked titles** across at least two categories | The ranking comparison, the collection, and the profile's headline numbers. Below about ten the ranked list looks like a stub. |
| **A second account following, and followed by, the review account** | The feed, the follower and following lists, and the match score — all of which are empty on an island. |
| **Two or three feed events from that second account** | The feed itself. An empty feed reads as a broken tab. |
| **One recommendation sent to the review account** | The Recommendations tab and its accept/decline. |
| **A completed first-run flow** | Onboarding does not re-trigger and steal the reviewer's first screen. |

The second account can be a throwaway on the same project; it is not handed to anybody.

---

## 4. Where the credentials go

**Apple — App Store Connect.** *App Review Information* on the version, or *Test
Information* for a TestFlight build going to Beta App Review:

- **Sign-in required:** yes
- **User name** / **Password**: the review account's
- **Notes:** name the path. *"Tap **More sign-in options → Sign in with password** at the
  bottom of the sign-in screen, then use the credentials above. The three primary buttons
  are for real users: email sends a one-time code, and Apple and Google are OAuth."*
  Add whatever else the build needs — for the beta, that it runs on a test backend.

**Google — Play Console.** *App content → App access*: choose **All or some
functionality is restricted**, add an instruction with the same credentials and the same
"More sign-in options" sentence.

**Both need the path spelled out.** The control is deliberately quiet — a `tertiary`,
small, secondary-toned line under a heading that says *More sign-in options* — because it
must not invite ordinary users to hunt for a password they do not have. A reviewer who is
not told where it is will report that the app cannot be signed into, which is the exact
failure this account exists to prevent.

---

## 5. Checks before submitting

| | |
| --- | --- |
| The account signs in on the **submitted binary**, not on a dev build | The lane decides the backend (`config/backends.cjs`); an account on nonprod does not exist on production |
| It lands on the **feed**, not on onboarding | An incomplete profile sends the reviewer into signup |
| Feed, collection, profile and recommendations all show something | §3 |
| The password is in the store console and **not** in the repository | `git log -S` on the password should return nothing, ever |
| Ordinary sign-in still works | The password screen is an addition; email, Apple and Google are what everybody else uses |

---

## 6. Where this is referenced

- [`../architecture/auth.md`](../architecture/auth.md) §8 — the decision and the
  client-side contract.
- [`beta-distribution-readiness.md`](./beta-distribution-readiness.md) §"The metadata Apple
  will ask for" — the TestFlight submission.
- [`production-bootstrap.md`](./production-bootstrap.md) §Auth — the production project has
  to be given its own copy of this account.
- [`store-privacy-inventory.md`](./store-privacy-inventory.md) — the rest of the reviewer
  forms.
