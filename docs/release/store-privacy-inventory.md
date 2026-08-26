# Store privacy disclosures — Apple and Google

What to enter into **App Store Connect → App Privacy** and **Play Console → Data safety**,
derived from what Bingd actually does rather than from what an app like Bingd usually does.

Every answer below is traceable to a table, an allowlist or a scrubber in this repository.
Where a question cannot be answered from the code — because it depends on a contract, a
retention setting or a decision the founder has not taken — it says **FOUNDER** and is
listed again at the end. **Do not guess those.** A wrong Data safety declaration is
grounds for removal from Play, and an inaccurate App Privacy label is a review rejection.

---

## 1. What Bingd actually holds

| Data | Where | Linked to the account? | Why |
|---|---|---|---|
| Email address | `auth.users` | yes | sign-in |
| Apple / Google account identifier | `auth.identities` | yes | sign-in |
| Date of birth | **`profile_private.date_of_birth`** | yes | the 13+ gate today; retained also for future age-based personalisation and aggregate taste analysis (DOB-1). Never returned by any API, including to its owner. It was moved out of `profiles` by `20260813001400_security_fixes.sql` precisely so that no profile read could reach it. **Retention DECIDED 2026-08-24 (DOB-1): the exact date is kept.** The three minimisation options were declined — year precision loses the boundary case that makes the gate honest, and discarding after the comparison forecloses the other two purposes. Retained for **three** purposes: 13+ eligibility; future personalisation of recommendations by age; future aggregate or de-identified analysis of taste by age cohort. Nothing reads it today but the age gate. **The fence:** raw DOB never leaves the database — not to PostHog, Sentry, feed events or ordinary recommendation payloads — and future consumers take derived features (current age, age band) rather than the date. Re-audited 2026-08-25 and pinned by `rls.test.mjs`: unreadable by another user, by its owner and by `anon`, refused by the missing grant rather than by a policy alone; no view in `public` projects the column; the row does not outlive the account. See `../product/open-questions.md` §8 **DOB-1** |
| Handle, display name, bio | `profiles` | yes | the profile |
| Profile picture | Supabase Storage, `avatars/{uuid}/` | yes | the profile |
| Public/private setting | `profiles.visibility` | yes | who can read the account |
| Rankings, comparisons, sessions | `rankings`, `comparisons`, `ranking_sessions` | yes | the product |
| Logged / watchlist / goals | `user_media`, `watchlist`, `watch_goals` | yes | the product |
| Notes, reviews, comments, reactions | `feed_events`, `comments`, `reactions` | yes | the product |
| Follows, requests, blocks | `follows`, `blocks` | yes | the social graph |
| Watch tags ("watched with") | `watch_tags` | yes | the product |
| Notifications | `notifications` | yes | the inbox |
| Invitation tokens and attribution | `invite_tokens`, `invite_attributions` | yes | referral credit |
| Derived scores | `match_scores`, `recommendation_*` | yes | recommendations |
| Product analytics | **PostHog** | yes — carries the account id | one activation funnel |
| Crash and error reports | **Sentry** | yes — carries the account id | diagnostics |
| Image requests | **TMDB CDN**, direct from the device | no | posters load from TMDB's servers |

**Not collected at all**, and worth stating because the store forms ask: no precise or
coarse **location**, no **contacts**, no **health or fitness**, no **financial** data, no
**payment** data, no **advertising identifier**, no **browsing history**, no **audio**, no
**camera**, no **phone number** (the column exists in Supabase's own auth schema and Bingd
never writes it), no **calendar**, no **files**.

**No advertising and no tracking SDK is installed.** The dependency audit in the security
review confirmed every third-party package is build-time or first-party runtime. There is
no attribution SDK, no ad network, no session replay (PostHog's is off), no autocapture and
no screen tracking.

### What never leaves the device as analytics

Enforced by three layers and asserted by test (`docs/product/analytics.md` §8): a typed
event union, a property allowlist (`ALLOWED_PROPERTY_KEYS`), and scalars-only value
filtering.

> email · username · display name · anyone's real name · title text · **search query
> text** · note or review body · comment text · bio · date of birth · avatar path ·
> invite token · any auth token or key · phone

Media ids, recipient ids and actor ids are excluded too — not because they are free text,
but because an analytics vendor holding a graph of who recommended what to whom is a second
copy of the social graph by another route.

**Sentry is scrubbed on the same reasoning** (`src/lib/monitoring.ts`): `sendDefaultPii`
off, the user object reduced to an id, request bodies and cookies deleted, `extra`
filtered to scalars, console breadcrumbs dropped, **query strings stripped from every URL**
— including on performance transactions, which do not pass through `beforeSend`.

**The one honest residual:** exception messages and stack frames are not redacted, because
a crash reporter that strips the error reports nothing. PostgreSQL echoes rejected input in
constraint errors, so a message *could* in principle carry user input. No call site
currently forwards a Supabase error to Sentry — React Query catches them all and
`reportHandled` has no callers — but that is a property of today's call sites rather than of
the scrubber, and it is written down rather than assumed.

---

## 2. Apple — App Store Connect → App Privacy

Apple asks, per data type: **collected?** → **linked to the user?** → **used for
tracking?** → **purpose**.

**Tracking is NO for every single type.** Apple's definition of tracking is linking data
with third-party data for advertising or sharing with a data broker. Bingd does neither and
has no SDK that could. **Do not enable App Tracking Transparency** — there is nothing to
ask permission for, and asking is itself a rejection risk.

### Declare these as collected

| Apple category → type | Linked | Tracking | Purposes |
|---|---|---|---|
| Contact Info → **Email Address** | Yes | No | App Functionality |
| Contact Info → **Name** | Yes | No | App Functionality — display name, and the name Apple/Google return |
| User Content → **Photos or Videos** | Yes | No | App Functionality — profile picture only |
| User Content → **Other User Content** | Yes | No | App Functionality — rankings, notes, reviews, comments, watchlist |
| Identifiers → **User ID** | Yes | No | App Functionality, Analytics |
| Usage Data → **Product Interaction** | Yes | No | Analytics |
| Diagnostics → **Crash Data** | Yes | No | App Functionality |
| Diagnostics → **Performance Data** | Yes | No | App Functionality |
| Diagnostics → **Other Diagnostic Data** | Yes | No | App Functionality |
| Other Data → **Other Data Types** *(date of birth)*¹ | Yes | No | App Functionality |
| Usage Data → **Search History**² | **FOUNDER — see below** | No | App Functionality |

¹ **Not "Sensitive Info".** Apple's Sensitive Info type covers racial or ethnic data,
sexual orientation, pregnancy, disability, religious belief, trade union membership,
political opinion, genetic and biometric data. An ordinary date of birth is none of those,
so it belongs under Other Data Types. Review 28 corrected an earlier version of this table
that said Sensitive Info. **Verify against the live questionnaire** — Apple's category list
changes.

² **Search History — decide this, do not inherit it.** An earlier version of this document
said "do not declare", and independent review 28 was right to call that inaccurate rather
than merely arguable.

The case for not declaring: Apple defines *collect* as transmitting data off the device in
a way that allows access **for longer than necessary to service the request in real time**.
A Bingd search is answered and discarded — nothing is written to any table, and the
analytics allowlist specifically excludes query text.

The case for declaring: the query does leave the device, and Supabase's own request logging
is a retention surface nobody in this project has actually measured.

**So this is a founder decision with one piece of homework**: check what the nonprod
Supabase project's log retention captures for PostgREST requests. If query text is retained
in logs, declare Search History. If you cannot establish it, **declare it** — the cost of an
over-declaration is a line on a label, and the cost of an under-declaration is a rejected
submission or a removal.

### Do **not** declare these

Location · Health & Fitness · Financial Info · Contacts · Browsing History · Purchases ·
Audio Data · Device ID · Advertising Data · Physical Address · Phone Number · Email or Text
Messages · Gameplay Content · Customer Support.

### Notes for the reviewer form

- **Data is not used for third-party advertising, Bingd's own advertising, or
  personalisation.** Only App Functionality and Analytics.
- **Account deletion:** in-app, Settings › Account & Data. Guideline 5.1.1(v) is met; there
  is no "email us" path.
- **Sign-in for review:** Apple's *App Review Information* and Play's *App access* both need
  the demo account **and the path to the password screen** — Bingd's three primary methods
  are an emailed code, Apple and Google, none of which a reviewer can complete. See
  [`store-review-access.md`](./store-review-access.md). No credential goes in this file.
- **Age rating:** 13+ enforced at sign-up. The catalogue is film and television metadata
  from TMDB and can describe adult themes; user-generated notes and comments exist, and
  there is a report/moderation path. Expect the questionnaire to land at 12+ or 17+
  depending on how the UGC questions are answered — **FOUNDER**, and answer it honestly
  rather than optimising downward.
- **Encryption:** `ITSAppUsesNonExemptEncryption: false` is already in `app.config.ts`. Bingd
  uses HTTPS and the platform keychain and nothing else, which is the standard exemption. No
  annual self-classification report is required.

---

## 3. Google — Play Console → Data safety

Play asks, per type: **collected?** · **shared?** · **processed ephemerally?** ·
**required or optional?** · **purposes** · and separately whether data is **encrypted in
transit** and whether users can **request deletion**.

### The three global answers

- **Encrypted in transit: YES.** Every connection — Supabase, PostHog, Sentry, TMDB
  images, bingd.app — is HTTPS. `.app` is an HSTS-preloaded TLD.
- **Users can request data deletion: YES.** In-app, Settings › Account & Data, plus the web
  page at `https://bingd.app/account-deletion`. Play's "deletion URL" field takes that URL.
- **Committed to Play Families Policy: NO.** Bingd is 13+ and not directed at children.

### "Shared" — read the definition before answering

Play defines **sharing** as transfer to a *third party*, and explicitly excludes transfer to
a **service provider** processing on your behalf. Supabase, PostHog and Sentry are service
providers under contract; they are **not** sharing.

**So every row below is `Shared: No`.** State the reasoning in the console's optional notes
so a reviewer does not have to guess: *"Data is processed by Supabase (hosting), PostHog
(product analytics) and Sentry (crash reporting) as service providers. No data is
transferred to any third party for their own purposes, sold, or used for advertising."*

### The rows

| Play category → type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| Personal info → **Name** | Yes | No | Optional | App functionality |
| Personal info → **Email address** | Yes | No | Required | App functionality, Account management |
| Personal info → **User IDs** | Yes | No | Required | App functionality, Analytics |
| Personal info → **Other info** *(date of birth)* | Yes | No | Required | App functionality — age eligibility. **Not** declared under Personalisation: DOB-1 retains the date for possible future age-based recommendations, but nothing reads it for that today, and a declared purpose has to describe what ships. Revisit this row, not the collection answer, if a recommender ever consumes it |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality — profile picture |
| App activity → **Other user-generated content** | Yes | No | Optional | App functionality |
| App activity → **App interactions** | Yes | No | **Required**² | Analytics |
| App info and performance → **Crash logs** | Yes | No | **Required**² | App functionality — diagnostics |
| App info and performance → **Diagnostics** | Yes | No | **Required**² | App functionality — diagnostics |
| App activity → **In-app search history**¹ | **Yes** | No | Optional³ | App functionality |

² **Required, because nothing in Bingd lets a user turn telemetry off.** See the note under
"Two answers that are easy to get wrong" below.

³ **Optional, and it is the one row where the answer differs from the three above it.**
Telemetry is Required because it happens whether or not the user wants it. A search query
is the opposite: it exists only because somebody typed it, and Bingd is entirely usable
without ever opening search. Google's Optional is exactly that case — the user chooses
whether to provide the data. This row was Required for one round on the reasoning that
applies to telemetry; review 28d separated the two and was right to.

¹ **Declare it. Whether you may mark it "processed ephemerally" depends on the same
homework as Apple's row, and is not settled.**

Three states, and this document has been through all of them. It first omitted the row
entirely — review 28 was right that this is a claim the query never leaves the device, and
it does. It then declared it *and* asserted the ephemeral qualifier — review 28b was right
that this asserts the very thing the Apple note says nobody has established. So:

- **Declare the row.** That part is not conditional. A search query is transmitted, and
  Play's schema has a type for exactly this.
- **Mark it ephemeral only if the Supabase request-log check comes back clean.** Google's
  *processed ephemerally* means used to service the request and **not retained**. If
  Supabase's logging retains PostgREST query parameters, the retention is real and the
  qualifier is wrong on this form for the same reason it would be wrong on Apple's.
- **If it cannot be established, declare it without the qualifier.** Over-declaring costs a
  line on a label; under-declaring is grounds for removal from Play.

### Do **not** declare these

Location (approximate or precise) · Financial info · Health and fitness · Messages ·
Audio · Files and docs · Calendar · Contacts · Web browsing · Installed apps · Device or
other IDs.

### Two answers that are easy to get wrong

- **"Processed ephemerally"** is for data used to service a request and never persisted.
  In-app search history is the one row it could apply to here — and it is a *qualifier on a
  declared type*, never a reason to leave the type off the form. Whether Bingd is entitled
  to it is open; see note 1 above.
- **"Required" is about the user's choice, not about the product's dependencies.** This is
  the one Play definition worth reading twice, and getting it backwards is what review 28c
  caught here. Optional means **the user can decide whether this data is collected**.

  A bio, a profile photo, a note and **a search query** are optional: nobody has to provide
  one, and Bingd works without any of them. **App interactions, crash logs and diagnostics
  are Required**, because `app/_layout.tsx` initialises PostHog and Sentry before the first
  render, `src/lib/analytics.ts` sets `disabled: false`, and **there is no opt-out anywhere
  in the app.** "The app would still work without it" is not the question being asked.

  The line between those two groups is *whether the user decides*, not whether the data is
  telemetry. Search history sits on the optional side for the same reason a bio does.

  If a telemetry opt-out is ever added, the three Required rows move to Optional in the same
  change.

---

## 4. The URLs both stores need

| Field | Value | Status |
|---|---|---|
| Privacy policy | `https://bingd.app/privacy` | **written, deploys with `main`** |
| Support URL | `https://bingd.app/support` | **written, deploys with `main`** |
| Account deletion | `https://bingd.app/account-deletion` | **written, deploys with `main`** |
| **Terms of Use** | `https://bingd.app/terms` | **drafted 2026-08-25, deploys with `main`. Draft — unconfirmed legal entity, no lawyer read. See L-1** |
| Support email | `hello@bingd.app` | **FOUNDER — SUPPORT-1: two addresses are in play. See below** |
| Marketing URL | — | not required; leave blank |

### SUPPORT-1 — one canonical support address, and there are currently two

**Unresolved, and it must be settled before either store form is submitted.** Both stores
publish this address and Apple emails it during review, so it has to be a mailbox somebody
reads rather than a plausible-looking string — and right now the repository does not agree
with itself about which string it is.

| | Address | Occurrences |
|---|---|---|
| **Tracked** — the live site, the app's support page, this document, the release docs, the seed builder's User-Agent | `hello@bingd.app` | 9, across 6 files — 8 literal, plus the escaped copy `web/router.test.mjs` asserts into the built support page |
| **Untracked** — `store-assets/google-play/store-listing.md`, the founder-local Play listing copy | `support@bingd.app` | 3 |

The founder's Play listing therefore publishes an address that appears nowhere in the
product, and the product publishes one that appears nowhere in the listing. **Whether
either mailbox exists is not a thing this repository can establish**, and neither was
assumed.

`store-assets/` is founder-local and was deliberately not modified. Once the founder
picks one address, these are the tracked files to normalise:

- `web/build.mjs` — the `SUPPORT_EMAIL` constant, which every page and both footers read
- `web/router.test.mjs` — asserts the address into the built support page
- `supabase/seed/fetch-catalogue.mjs` — the TMDB User-Agent
- `docs/release/store-privacy-inventory.md` (this file)
- `docs/release/beta-distribution-readiness.md`
- `docs/architecture/web-deployment.md`

Everything user-facing routes through one constant, so the web change is a single line.

All four returned **HTTP 200 with the wrong page** before 2026-08-20: Cloudflare Pages
served the generic "closed testing" page for any unknown path, so a reviewer following the
privacy link got a success status and no policy. They are real documents now and
`web/router.test.mjs` asserts that each one carries its own content and loads no
JavaScript.

---

## 5. TMDB attribution — every part now met

The founder holds written TMDB confirmation permitting zero-revenue testing; a commercial
agreement is required before monetisation. What their terms ask for during testing:

| Obligation | Status | Where |
|---|---|---|
| The exact notice, unparaphrased | **met** | `app/settings/index.tsx` — *"This product uses the TMDB API but is not endorsed or certified by TMDB."* |
| Placed in an About or Credits section | **met** | Settings › About |
| A link to themoviedb.org | **met** | Settings › About |
| Per-screen metadata attribution | **met** | "Metadata from TMDB" on the title screen and the person screen |
| Images served from TMDB, never rehosted | **met** | `src/lib/images.ts` |
| The same notice on the website | **met** | `https://bingd.app/privacy`, final section |
| **The official TMDB logo** | **met** (2026-08-21) | `assets/brand/tmdb-logo.svg` in Settings › About, above the notice |

**The logo is TMDB's own file, used unmodified.** It is the primary short (blue) SVG from
<https://www.themoviedb.org/about/logos-attribution>, committed byte-for-byte, and rendered
contain-fit at a size smaller than Bingd's own mark. It was **not drawn, redrawn,
approximated, traced, or generated**: producing a lookalike breaches the same terms the
attribution section exists to satisfy, which is why the file's provenance is recorded here:

- Downloaded 2026-08-21 from
  `https://themoviedb.org/assets/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg`
- sha256 of the committed file:
  `5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4` — identical to the
  hash TMDB embeds in the filename above, so `sha256sum assets/brand/tmdb-logo.svg` is the
  ongoing proof the asset is theirs and untouched.

---

## 6. FOUNDER actions before either store form is submitted

1. **SUPPORT-1 — choose one canonical support address, and confirm it is a mailbox
   somebody reads.** Both stores publish it and Apple emails it during review. The
   tracked product says `hello@bingd.app`; the Play listing in `store-assets/` says
   `support@bingd.app`. Pick one; the files to normalise afterwards are listed in §4.
2. ~~**Add the official TMDB logo** (§5).~~ Done 2026-08-21 — downloaded, unmodified.
3. **Decide the legal entity named on the privacy page.** It currently says "one
   independent developer" and names no person or company. A public launch — particularly
   for UK/EU users — wants a named data controller and an address. A friend beta on nonprod
   does not.
4. **Confirm the retention settings** on the PostHog project and the Sentry project, and
   put the actual numbers on the privacy page. Both currently say "under their own
   retention settings", which is true and vague.
5. **Check Supabase's request-log retention** for the nonprod project. One fact settles the
   Search History question on **both** forms: whether Apple's row is declared at all, and
   whether Google's — which is declared either way — may carry the *processed ephemerally*
   qualifier. Answer neither from memory.
6. **Answer the age-rating questionnaires honestly** — both stores, both have UGC
   questions, and Bingd has notes, reviews and comments.
7. **Have the privacy page read by a lawyer before public launch.** Not before the friend
   beta. What is there now is an accurate description of behaviour, which is what a beta
   owes its testers; it is not a document that has been reviewed for GDPR/CCPA sufficiency.
