# TestFlight, Play closed test, and the invitation that outlives both

Preparation only. **Nothing in this document has been executed**, no external tester has
been invited, nothing has been submitted, and none of it may happen before founder Preview
acceptance.

---

## 1. The distribution contract, which is the thing to preserve

**What a person shares is `https://bingd.app/i/<token>` and nothing else.** Never a
TestFlight URL, never a Play URL, never `bingd://`. That link is permanent: it survives
development, Preview, TestFlight, a Play closed test, an open test, and both public stores.

The destinations *behind* it live in `web/distribution.config.json`, and changing them
changes no invitation anybody has already sent — no app rebuild, no reissued link.

```
bingd.app/i/<token>
  ├── has Bingd            → "I already have Bingd" → bingd:// → the invite flow
  ├── iPhone, no Bingd     → ios.betaUrl        → public TestFlight link
  └── Android, no Bingd    → android.optInUrl   → Play closed-test opt-in page
```

`web/build.mjs` refuses any value that is not an absolute `https://` URL, because these are
the highest-value places in the project to plant a link somewhere else.

> **Both destinations are filled in as of `2fbdc66` (#32), and verified live 2026-08-23.**
> `ios.betaUrl` is a public TestFlight join link and `android.optInUrl` is the Play
> closed-test opt-in page. This paragraph used to say both were `null` and that every
> route answered *"The Bingd beta is not open for this device yet"* — that fallback is now
> unreachable on iOS, Android and desktop, which is the intended state.

### What to tell a tester

> **Invite friends from Bingd. Send the Bingd invite link, not the raw TestFlight link.**
>
> Profile → **Invite friends** → share. That one link installs the app *and* carries the
> invitation; a TestFlight URL sent separately installs the app and loses the inviter.

Verified 2026-08-23: `create_invite_link` is granted to `authenticated` with no allowlist
and no founder check, so **every tester can generate their own** — this is not an
admin-only capability, and nothing in the app asks anybody to contact the founder.

**Two caveats that are the platform's, not the product's.** A Google closed test only
admits accounts on the Play Console tester list, so the founder still adds Android testers
there. And the token does not survive the trip through TestFlight or Play, so the recipient
has to return to the same `bingd.app/i/<token>` page after installing and tap *I already
have Bingd* — the page says so, and it is the manual step that will lose some attributions
until deferred attribution exists (`public-launch-risk-register.md` M7).

### The two values to fill in, when they exist

```jsonc
// web/distribution.config.json
"ios":     { "betaUrl": "https://testflight.apple.com/join/XXXXXXXX" },
"android": { "optInUrl": "https://play.google.com/apps/testing/app.bingd" }
```

Then `npm run build:web`, commit, and merge to `main` — Cloudflare Pages redeploys
bingd.app. **That is the whole of turning the beta on.**

### Two things not to do

- **Do not teach anyone to share a TestFlight or Play link directly.** Those are temporary
  addresses that will outlive their own builds; the invitation URL is the permanent one and
  it is also the only one that carries attribution.
- **Do not put a placeholder URL in that file to "test the flow".** A store button that
  404s is worse than the honest empty state: the visitor concludes Bingd does not exist,
  and the inviter never finds out.

### One limitation, already stated to the person it affects

An invitation does not survive an install. Somebody who taps the link, installs from
TestFlight or Play, and then launches Bingd from their home screen arrives with no token.
The invitation page says so in its second paragraph — *"Come back to this page once Bingd is
installed"* — because the alternative is a silent loss with nothing anywhere to explain it.
Deferred-install attribution needs an SDK and is deliberately not built.

---

## 2. Apple — TestFlight readiness

| | |
|---|---|
| Team | Sai Suraj Kandukuri (Individual), `98729PG8GD` |
| Bundle identifier | `app.bingd` — the production variant, built by the `beta` profile |
| Build profile | `beta` (`distribution: store`, channel `beta`, nonprod backend) |
| Version / build | `0.1.0`, auto-incremented per build |
| Encryption | `ITSAppUsesNonExemptEncryption: false` — already set, no annual report needed |
| Sign in with Apple | entitlement present; required because Google sign-in is offered |
| Distribution intent | **public TestFlight link**, not an email allowlist |

### State today

> **Stale — overtaken by events and kept as the pre-launch record (marked 2026-08-25).**
> Every bullet below described the state *before* the beta shipped. The TestFlight beta
> is live behind a public join link — `web/distribution.config.json` holds it, filled in
> at #32 and verified live 2026-08-23 (§1) — so the ASC record, the credentials and the
> uploaded builds all exist now. §1 and `distribution.config.json` are authoritative for
> current state; the same applies to §3's "State today" for Android, whose closed-test
> opt-in URL is likewise live.

- **No App Store Connect app record exists for `app.bingd`.** It is created by the first
  submission, or by hand in App Store Connect. **FOUNDER.**
- **No iOS credentials exist for `app.bingd`.** The first `beta` build creates the App ID,
  the distribution certificate and the App Store provisioning profile — and, like the
  Preview build, that first run needs an interactive Apple login.
- **No build has been uploaded and none may be** before founder Preview acceptance.

### Why public TestFlight rather than an allowlist

Friend-of-friend is the whole shape of this beta. An email allowlist means the founder is
asked to add an address every time somebody forwards a link, and that moment — waiting for
an approval — is where the invitation stops working. A public TestFlight link works for
anyone who has the URL, up to 10,000 testers.

**A public link requires Beta App Review.** Internal testers (up to 100, on the team) do
not; external testers and the public link do. Budget a day or two for the first one.

### The metadata Apple will ask for

| Field | Prepared answer |
|---|---|
| Beta app description | *"Bingd is where you rank what you have watched and see what your friends really think. This is a closed beta: everything is real, and the data is on a test backend that will not carry over."* |
| What to test | *"Sign up, rank ten titles, follow someone, recommend something. Then tap a bingd.app profile or title link from Messages and check it opens the app on the right screen."* |
| Feedback email | `hello@bingd.app` — **FOUNDER: confirm the mailbox** |
| Marketing URL | leave blank |
| Privacy policy URL | `https://bingd.app/privacy` |
| Sign-in required? | **Yes**, and Bingd signs people in with an emailed code, which a reviewer cannot receive. Provide the password-enabled demo account and **say where the password screen is**: *More sign-in options → Sign in with password*. **FOUNDER: create it on nonprod and put the credentials in App Review notes** — full runbook in [`store-review-access.md`](./store-review-access.md). |
| Review notes | Mention that the app is on a test backend, that notifications are in-app only with no push, and that the TMDB catalogue is third-party metadata. |

### The submission, when it is time — not now

```
npm run build:beta -- --platform ios               # interactive the first time
npx eas submit --platform ios --profile beta       # needs the ASC app record
```

**`npm run build:beta`, not `eas build --profile beta`.** The wrapper is what runs the
clean-tree, branch and exact-commit release-gate checks, and what supplies `BINGD_LANE` and
`APP_VARIANT` — and this document printed the bare command for a round, which is a
documented bypass rather than the residual the other pages acknowledge. Review 28c.

`eas submit` is deliberately still the raw command: it uploads an artifact that has already
been built and gated, and it needs credentials this wrapper does not handle.

---

## 3. Google — Play closed test readiness

| | |
|---|---|
| Package | `app.bingd` |
| Build profile | `beta` → **AAB** (`buildType: app-bundle`) |
| Track | closed testing — `eas.json` `submit.beta.android.track: "alpha"` |
| Release status | `draft`, so a submission cannot go live by itself |
| Signing | Play App Signing; EAS holds the upload key |

### The 14-day rule, and why it does not delay anything

A recent personal developer account must run a closed test with **at least 12 testers
opted in for 14 continuous days** before production access is granted. That clock is a
prerequisite for *production*, not for the closed test itself — the closed test is what
starts it.

So: **do not wait for open testing, and do not wait 14 days to begin.** The friend beta
*is* the closed test, and the 14 days run underneath it while people are using the app.

### State today

- **No Play Console app record exists.** **FOUNDER.**
- **No Play App Signing key exists**, so the Play re-signing fingerprint is unknown — see
  §4.
- **No service account key exists**, so `eas submit --platform android` cannot run. The
  first AAB is uploaded by hand through Play Console; automating later needs a Google Cloud
  service account with the Play Developer API enabled, invited into Play Console, and the
  JSON key path in `eas.json`.
- **No tester list is configured and none may be.**

### The Data safety form

Fully prepared, row by row, in
[`store-privacy-inventory.md`](./store-privacy-inventory.md#3-google--play-console--data-safety).
Do not fill it in from memory — a wrong declaration is grounds for removal.

### Tester configuration, when it is time

Closed testing takes an **email list** or a **Google Group**. A Google Group is the right
choice: adding somebody is one membership change rather than a track edit and a new
rollout. The opt-in URL Play then publishes is
`https://play.google.com/apps/testing/app.bingd`, and that is the value for
`android.optInUrl`.

**Bingd does not run a tester list itself.** Eligibility is administered in Play Console and
is deliberately not modelled anywhere in this repository.

---

## 4. The Android signing fingerprint, and the one that is still missing

`web/deep-links.config.json` currently declares:

| Variant | Package | Fingerprint | Verified by |
|---|---|---|---|
| production | `app.bingd` | `A1:5B:…:B9:00` — **EAS upload key** | the site build |
| preview | `app.bingd.preview` | `BB:CF:…:0B:2D` — EAS keystore | this build, on the phone |
| development | `app.bingd.dev` | *(none)* | — |

**The production entry is not finished, and cannot be yet.** Play App Signing re-signs every
upload with a key Google holds, so a build installed from Play presents a certificate that
is **not** the upload key listed above. A device checks a fingerprint that is not in
`assetlinks.json`, and **every App Link silently fails for every Play tester** — the link
opens Chrome, and nothing anywhere reports why.

So, the moment the Play Console app record exists:

1. Play Console → the app → **Setup › App integrity › App signing**.
2. Copy the **SHA-256 certificate fingerprint** under *App signing key certificate* — not
   the upload key certificate.
3. **Add it alongside** the existing entry — never in place of it. Both are legitimate: the
   upload key signs builds distributed directly, the app-signing key signs builds from Play.

```jsonc
{
  "name": "production",
  "bundleId": "app.bingd",
  "androidSha256": [
    "A1:5B:92:A7:...:B9:00",   // EAS upload key
    "<the Play app-signing SHA-256>"
  ]
}
```

4. `npm run build:web`, commit, merge to `main`, and confirm:

```
curl -s https://bingd.app/.well-known/assetlinks.json | grep -A3 '"app.bingd"'
adb shell pm get-app-links app.bingd     # on a tester's device: expect "verified"
```

**Do not remove the development or preview statements.** They are what makes links work on
the founder's own builds, which is exactly where they get tested.

---

## 5. Order of operations

1. **Preview builds.** The Android one exists. **The iOS one does not** and is one founder
   command — see [`ios-preview-acceptance.md`](./ios-preview-acceptance.md), which opens
   with it.
2. **Founder Preview acceptance** — [Android](./android-preview-acceptance.md),
   [iOS](./ios-preview-acceptance.md). Nothing below starts until this passes on **both**
   platforms.
3. ~~TMDB logo added (`store-privacy-inventory.md` §5).~~ Done 2026-08-21.
4. `hello@bingd.app` confirmed. Demo account created for App Review —
   [`store-review-access.md`](./store-review-access.md), including the seeded activity,
   without which review sees an empty app.
5. Release gate green (`safe-update-runbook.md` §6).
6. `beta` builds made — both platforms, first iOS one interactive.
7. App Store Connect and Play Console records created; privacy forms completed.
8. Uploads. Beta App Review for the public TestFlight link.
9. **Play app-signing fingerprint added to `assetlinks.json`** and deployed. §4.
10. `web/distribution.config.json` filled in; `main` deployed.
11. Only then does an invitation link work for somebody who does not have the app.
