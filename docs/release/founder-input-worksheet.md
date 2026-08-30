# Founder input worksheet — public release

**Written 2026-08-29 against `54e32fd`; reconciled 2026-08-30 against `95fd4d7`, and again the same day against `2f27577`.** Only the things that are genuinely unresolved and
that only the founder can settle. Everything already decided lives in the documents this one
links to; nothing is repeated here for completeness.

Fill it in, then work down the runbook.

---

## 1. Addresses and identity

### 1.1 SUPPORT-1 — one canonical support address

**Blocks:** both store listings, the SMTP sender address, App Review contact, and the
privacy/support/terms pages.

The repository does not agree with itself. Both stores publish this address and **Apple
emails it during review**, so it has to be a mailbox somebody reads that week.

| | Address | Where |
|---|---|---|
| Tracked | `hello@bingd.app` | The live site, the app's support page, the release docs, the seed builder's User-Agent — 9 occurrences across 6 files |
| Founder-local | `support@bingd.app` | `store-assets/google-play/store-listing.md`, 3 occurrences |

**Whether either mailbox exists is not something this repository can establish, and neither
was assumed.**

- [ ] **Canonical support address:** `________________________`
- [ ] It is a real mailbox and I read it: ☐ yes

Files to normalise afterwards — the user-facing copy all routes through one constant, so the
web change is a single line:

- `web/build.mjs` — the `SUPPORT_EMAIL` constant (line 691)
- `web/router.test.mjs` — asserts the address into the built support page
- `supabase/seed/fetch-catalogue.mjs` — the TMDB User-Agent
- `docs/release/store-privacy-inventory.md`, `docs/release/beta-distribution-readiness.md`,
  `docs/architecture/web-deployment.md`

### 1.2 Privacy / legal contact address

May be the same as 1.1. It is the address the privacy page names for a request to see or
remove held data — a **GDPR/UK-GDPR subject-access route** if any UK or EU user installs.

- [ ] **Privacy contact:** `________________________` ☐ same as 1.1

### 1.3 Legal owner named on the privacy and terms pages

**Blocks:** the App Store **Copyright** field, and the honesty of `bingd.app/terms`.

Today the privacy page says *"Bingd is made by one independent developer"* and names nobody;
the Terms page carries the literal placeholder
`[LEGAL ENTITY / DEVELOPER NAME — FOUNDER TO CONFIRM]`. The Apple developer account is
registered as **Sai Suraj Kandukuri (Individual), Team `98729PG8GD`** — but what the Apple
account is registered as is not automatically what the privacy page should name, and this
document does not decide it.

- [ ] **Entity as it should appear:** `________________________`
- [ ] **Registered address, if a company:** `________________________`
- [ ] **App Store Copyright field:** `2026 ________________________`

A public launch — particularly for UK/EU users — expects a named data controller and an
address. A friend beta on nonprod did not.

### 1.4 App Review contact — Apple calls this number

Not published on the listing. Apple uses it to reach the founder during review.

- [ ] First / last name: `________________________`
- [ ] Email: `________________________`
- [ ] Phone (with country code): `________________________`

---

## 2. Retention periods — where to read the current value

Each of these is quoted, or should be, on `bingd.app/privacy`, which today says only "under
their own retention settings". Read the number; write it down; then decide whether the page
gets the number or the phrase.

| What | Exact navigation | Current value |
|---|---|---|
| **PostHog event retention** | posthog.com → the **production** project → *Project settings* → **Data management** → *Data retention*. Also check *Settings → Project → Autocapture* is off, which it should be, and *Session replay* is not enabled | `__________` |
| **Sentry event retention** | sentry.io → org `fourward-habits` → the **production** project → *Settings* → **Security & Privacy**, and the org-level *Data retention* / plan setting — retention is largely plan-determined | `__________` |
| **Supabase database backups / PITR** | supabase.com/dashboard → project → *Settings* → **Database** → *Backups*. Free tier has no PITR | `__________` |
| **Supabase log retention (Postgres, PostgREST, Auth)** | supabase.com/dashboard → project → **Logs & Analytics** → *Settings*, or *Project Settings → Logs*. Retention window is plan-determined | `__________` |

> **The log-retention reading is not bookkeeping — it decides an App Store answer.**
> Bingd stores no search query anywhere in its schema, but a search leaves the device as a
> PostgREST request. If request paths are retained in logs, **Search History is collected**
> and must be declared to Apple and to Play. If you cannot establish it, **declare it** —
> see [`app-store-submission-pack.md`](./app-store-submission-pack.md) §4.2.

- [ ] Search History declared to Apple: ☐ yes ☐ no — reason: `________________________`
- [ ] The same answer used on Play's *In-app search history* row: ☐ confirmed

---

## 3. Age-rating judgment calls

Full evidence for each is in
[`app-store-submission-pack.md`](./app-store-submission-pack.md) §5. These are the ones the
repository will not answer for you. **Expected outcome is 13+ regardless of how any of them
falls**, because the Social Media descriptor sets that floor — so there is no incentive to
answer any of them downward.

| Question | Recommended | Your answer |
|---|---|---|
| **Age Assurance** — does a self-declared date of birth count? | **No** — Apple names the Declared Age Range API, age estimation, or ID verification, and Bingd uses none of them | ☐ |
| **Social Media Disabled for Users Under 13** | **No** — the app admits nobody under 13 at all, which is *stricter*, but it does not call the Declared Age Range API that the descriptor requires | ☐ |
| **Messaging and Chat** | **No**, on the reading that comments are public posts and there is no private channel. **If in doubt answer Yes** — it costs nothing, the definition includes "public posting", and the rating does not move | ☐ |
| **Profanity or Crude Humor** | **Infrequent/Mild.** User text is unfiltered. Do not answer None | ☐ |
| **Horror / Alcohol, Tobacco, Drugs / Violence / Weapons** | **Infrequent/Mild** in each. TMDB artwork and synopses are shown unfiltered | ☐ |
| **Mature or Suggestive Themes** | **Yes / Infrequent** — posters and synopses for 15- and 18-rated films are shown as supplied | ☐ |
| **Sexual Content or Nudity** | **None** — but **look at what Search returns for an explicit query on the RC build before answering** | ☐ |
| **Contests** | **Yes / Infrequent** — the monthly leaderboard ranks followed accounts; awards and watch goals are personal targets | ☐ |

---

## 4. Store account and release decisions

- [ ] **Geographic availability** — recommended: one country at launch, widen after the
      first week. Reasons in [`app-store-submission-pack.md`](./app-store-submission-pack.md)
      §7: one person answering support, one English localisation, and a data-controller
      question that a UK/EU launch raises immediately.
      **Chosen:** `________________________`
- [ ] **Manual Release confirmed** — App Store Connect → Version Release → *Manually release
      this version*. Automatic release means going live overnight with nobody watching
      Sentry. ☐ confirmed
- [ ] **Version number** — `0.1.0` today; `1.0.0` recommended. Changing it moves the
      fingerprint, so it belongs in the RC window. **Chosen:** `________`
- [ ] **Secondary category** — Social Networking recommended, or leave blank.
      **Chosen:** `________________________`
- [ ] **Supabase plan** — Free or Pro. Free cannot edit email templates with the default
      provider, which means it cannot send a sign-in code. **Chosen:** `________`
- [ ] **Supabase region** — `us-east-2` recommended, matching nonprod. **Chosen:** `________`

---

## 5. The reviewer demo account

Runbook: [`store-review-access.md`](./store-review-access.md). **No credential goes in this
repository, in a commit message, in a PR description, or into a chat with an agent.**

- [ ] Created on the **production** project, with *Auto Confirm User* ticked
- [ ] Signs in on the **submitted binary** via *More sign-in options → Sign in with password*
- [ ] Lands on the feed, not on onboarding
- [ ] Seeded: ~10 ranked titles across two categories; a second account following and
      followed; two or three feed events; one recommendation received
- [ ] Credentials entered in App Store Connect → *App Review Information*, and in Play
      Console → *App content → App access*
- [ ] Entered nowhere else

---

## 6. Legal review

- [ ] **Will a lawyer read the Terms of Use and the privacy policy before release?**
      ☐ yes ☐ no

`bingd.app/terms` is a **draft** and says so on the page. It names no legal entity, states no
governing law, no venue and no arbitration clause, and no lawyer has read it. `web/build.mjs`
carries a `TERMS_STATUS` constant, and the build **refuses** to publish `mode: "public"`
while the terms are still marked draft and the store URLs are null — so this is enforced,
not merely recommended.

- [ ] Blocker HG-4 (PRD §27) closed: privacy policy, terms, support contact, 13+ statement,
      age ratings, and the data-request path all published **and the data-request path
      exercised once end to end**, rather than only written down.

---

## 7. Two live-site corrections, before launch

Neither is a founder *decision* — both are facts the site currently states that stopped being
true. They are here because they are easy to miss and a reviewer reads them.

- [x] **~~`bingd.app/support` says "Bingd sends no push notifications."~~** Rewritten in
      `web/build.mjs` on 2026-08-30 (`95fd4d7`) and pinned by a test that fails if the old
      sentence returns. It now says Bingd *may* send a notification when the reader allowed
      them, that everything also appears in the in-app inbox, and where to change the
      categories or turn them off. **The deployed site still shows the old copy** — the fix
      reaches it with the next site deployment, which is a launch-day step.
- [ ] **The deployed site is dated "20 August 2026"** and still says "Bingd is in closed
      testing" — it predates `main`. Redeploy with the launch change, and check the date
      stamp afterwards.
- [ ] *(Cosmetic, no action necessarily needed.)* Cloudflare's email obfuscation renders the
      support address as `[email protected]` in the raw HTML and fills it in with
      JavaScript. The pages were built to need no JavaScript. Reviewers use a real browser so
      this is not a submission risk; it is worth knowing if anyone reports a missing address.

---

## 8. Still open elsewhere, and pointed at from here

| | Owner | Where it lives |
|---|---|---|
| HG-2 Android developer verification | Founder | PRD §27 |
| HG-3 App Store / Play name availability, knockout trademark search | Founder | PRD §27 — **blocks the App Name field** |
| HG-5 Google Play production access | Founder | PRD §27 |
| Production Supabase project, plan, region, password | Founder | [`production-bootstrap-runbook.md`](./production-bootstrap-runbook.md) §1 |
| Production Auth providers, SMTP, both email templates | Founder | runbook §9–10 |
| APNs key, Firebase project, `GOOGLE_SERVICES_JSON` | Founder | runbook §19.1 |
| Production PostHog and Sentry projects | Founder | runbook §19.2–19.3 |
| TMDB commercial agreement | Founder | Not needed while free; required before monetisation |

---

## 9. Added 2026-08-30 (`2f27577`) — two operational items and one thing to know

Neither of the first two blocks the RC. Both are things nothing in this repository will do
on its own.

- [ ] **Schedule the trending refresh, or accept a dark Trending shelf.** The four
      `provider_list_cache` lists expired on **2026-08-25** and nothing runs
      `npm run trending:refresh`. The Feed's Trending shelf disappears silently once they
      pass their window, and For You's popularity fallback is currently serving that same
      five-day-old snapshot — it reads the cache *without* checking `expires_at`, which is
      the only reason the cold-start half of the wall still draws anything at all.
      **Do not "fix" that expiry check before the refresh is scheduled**, or the fallback
      goes from stale to empty. `trending-refresh.yml` exists; the decision is whether to
      put it on a schedule. TREND-1 in `open-questions.md`.

- [ ] **Add "is the deployed edge function current?" to the release ritual.** On
      2026-08-30 the running `tmdb-adapter` turned out to be thirteen days behind the
      repository, and the consequence was that every season row in the catalogue had a null
      episode count — silently, with CI green throughout. Neither the OTA, nor `ci.yml`,
      nor the release gate, nor `scripts/release.mjs` deploys or checks a function.
      `production-bootstrap-runbook.md` §15.1 has the two commands.

**And one thing to know rather than do.** *Jujutsu Kaisen has no Season 2 at TMDB.* The
provider publishes the show as a single 59-episode Season 1 under `/tv/95479`; what is
elsewhere called season 2 is episodes 25–47 of it. The missing row in the acceptance report
was the provider's answer, not a Bingd defect, and no ingestion rule can produce a season
the provider does not have. The two real defects found underneath it — a season list that
was written once and never revisited, and the null episode counts — are fixed.
