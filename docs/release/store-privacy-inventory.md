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
| Image requests | **YouTube image host** (`i.ytimg.com`), direct from the device | no | trailer still images on the Cinematic title page. **Currently deployed (production OTA 2026-11-07):** opt-in — production shows plain frames until the reader taps Show previews. **Prepared change (PR #239, pending F-6):** automatic on Cinematic pages in all lanes once the production OTA ships. See below. |

**Trailer stills (added 2026-11-07, corrected 2026-11-07).** What the app actually requests,
from the code rather than from intent:

- **The request.** `src/features/title/TrailerRail.tsx` draws one `expo-image` per trailer
  from `https://i.ytimg.com/vi/<video id>/hqdefault.jpg`. Nothing else in the app loads from
  a YouTube host; `www.youtube.com/watch?v=…` is only ever opened through `Linking` when the
  reader taps a card, which leaves the app. Google sees the device's IP address, its user
  agent and which video's image was asked for — the same kind of request as the TMDB poster
  loads above. No account identifier, cookie or Bingd header goes with it, and Bingd's
  servers neither receive nor store anything from it. `expo-image` keeps the still in its
  disk cache, so a revisit may make no request at all.
- **Which videos.** The TMDB adapter (`videosFacet`) keeps only `site === 'YouTube'`
  Trailers and Teasers, at most six per title, so every still is on `i.ytimg.com`.
- **Movie and TV alike.** The adapter writes that facet for films, series and seasons, and
  the Trailers section on the title page is not conditioned on the kind of title, so a
  movie page and a series page behave identically.
- **Cinematic only.** The Original layout's Videos tab is text rows and loads no still. The
  Cinematic page (the default in every lane since 2026-11-07, Original one switch away in
  Settings › Labs) holds the stills back until the stored layout choice has been read, so a
  reader who chose Original never sends one.
- **When, by lane.** `trailerPreviewsByDefault()` (`src/features/title/trailer-previews.ts`)
  returns `true` for all lanes as of the prepared production change (PR #239, 2026-11-09).
  Preview, Beta, development, and **production (once the OTA ships)** all load stills with
  the page. **Production stills are not yet live**: the production OTA must not be published
  until the founder confirms F-6 (Play Console "No data shared with third parties" for
  automatic loads). Until that OTA runs, production builds still compiled from an earlier
  bundle show the old opt-in behaviour. See `privacy-decision-matrix.md` §16 and the gate
  table at the bottom of that file.

**Disclosure status.** The live policy at <https://bingd.app/privacy/> (fetched 2026-11-07,
"Last updated 7 November 2026") already says, under "Who else sees it", that **YouTube
(Google)** supplies trailer still images, that "when a title page shows its trailers, your
device loads each trailer's still image directly from YouTube's image servers", and that
Google sees the IP address and which video's image was asked for. That sentence describes
both the opt-in and the automatic behaviour, for any title page, so the published policy does
not need to change to enable automatic stills in production.

This document's reasoning is that no declared user-data row is transferred to Google or
TMDB in either case: the request carries no account ID, no bingd-collected data, and IP is
not a Play data type bingd uses. **No new data type is declared** in §2 or §3. TMDB posters
already load the same way undeclared; whatever rule applies to YouTube stills must apply
consistently to TMDB too. Note: the Play service-provider exemption (§3 "Shared" section)
covers Supabase, PostHog and Sentry only — Google/YouTube and TMDB process image requests
under their own terms, not on bingd's instructions. The production gate change is prepared
(PR #239). Before the production OTA, the founder must complete **F-6**: choose Option A
(no form change, record rationale in Play console notes) or Option B (add a sharing row and
publish the form first). See `privacy-decision-matrix.md` §16 and §6 item 8 below.

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
— including on performance transactions, which do not pass through `beforeSend`, and on
their HTTP spans, which is where the SDK puts them. The span half arrived on 2026-11-01
(audit M-5): a build older than that sends them unless the server-side rule in
`security-remediation-2026-11-01.md` is in place.

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
| User Content → **Other User Content** | Yes | No | App Functionality — rankings, notes, reviews, comments, watchlist; **also Product Personalization** — rankings drive recommendations (corrected 2026-11-09; see `privacy-decision-matrix.md` §5) |
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

### Declare these (corrections vs. earlier inventory versions)

> **2026-11-09 correction:** Three rows in this section previously said "do not declare".
> The public Apple App Privacy label (fetched 2026-11-08, no App Store Connect sign-in)
> shows all three as declared. The analysis in `privacy-decision-matrix.md` concludes the
> public label is correct and the earlier inventory was wrong. Summary:
>
> - **Location → Coarse Location (Analytics):** The public label declares this. Source is
>   first-party `account_context` (timezone + locale region stored for release-notification
>   send-window logic) and/or PostHog GeoIP if enabled. **FOUNDER (F-1):** correct the
>   declared purpose from Analytics to App Functionality in App Store Connect for
>   first-party data; Analytics is additionally justified if PostHog GeoIP is on (F-3).
> - **Identifiers → Device ID (Analytics and App Functionality):** The public label
>   declares this. Source is PostHog's persisted DeviceId UUID (app-generated, not IDFV
>   or advertising ID) and the Expo push token in `device_tokens`. Both qualify as
>   device-scoped identifiers under Apple's definition. **No console change needed** — the
>   declaration is accurate.
> - **User Content → Other User Content, Product Personalization:** The public label
>   declares this purpose. Rankings and comparisons drive `match_scores` and
>   `recommendation_*` tables. Product Personalization is accurate. **No console change
>   needed** — the declaration is accurate.

### Do **not** declare these

Health & Fitness · Financial Info · Contacts · Browsing History · Purchases ·
Audio Data · Advertising Data · Physical Address · Phone Number · Email or Text
Messages · Gameplay Content · Customer Support.

> **Location**: Coarse Location is declared (see correction above). Precise Location
> is not declared and should not be. There is no GPS, no `NSLocation*`, no
> `expo-location` in the codebase.

### Notes for the reviewer form

- **No advertising, no third-party personalisation, no data broker.** Bingd shows no
  advertising and runs no advertising or attribution SDK. Data is never shared with a
  third party for their own purposes or sold. Tracking is No for every declared type.
  **First-party Product Personalization is declared** for Other User Content (rankings
  and comparisons) because they drive Bingd's own recommendation engine
  (`match_scores`, `recommendation_*`). That is App functionality by another name — the
  feature that produces the For You and Similar screens. It is not advertising
  personalization and it is not third-party personalization. Apple's form has a
  "Product Personalization" purpose; this is what it is for.
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
  images, YouTube trailer stills (`i.ytimg.com`), bingd.app — is HTTPS. `.app` is an HSTS-preloaded TLD.
- **Users can request data deletion: YES.** In-app, Settings › Account & Data, plus the web
  page at `https://bingd.app/account-deletion`. Play's "deletion URL" field takes that URL.
- **Committed to Play Families Policy: NO.** Bingd is 13+ and not directed at children.

### "Shared" — read the definition before answering

Play defines **sharing** as transfer to a *third party*, and explicitly excludes transfer to
a **service provider** processing on your behalf under contract. Supabase, PostHog and Sentry
are service providers in this sense; they are **not** sharing for the rows below.

**Every declared row below is `Shared: No`** for data held by Supabase/PostHog/Sentry.
State the reasoning in the console's optional notes: *"Data is processed by Supabase
(hosting), PostHog (product analytics) and Sentry (crash reporting) as service providers.
No declared user data is transferred to any third party for their own purposes, sold, or
used for advertising."*

> **Note — image CDN requests (TMDB, YouTube):** The service-provider exemption above
> does not extend to TMDB or Google/YouTube. Those hosts process image requests under their
> own terms, not on bingd's instructions, so they are not service providers in Play's sense.
> However, no declared user-data row from this form is transferred in those requests — the
> request carries only device IP (not a bingd-collected type) and a resource identifier.
> Whether automatic YouTube still loads require a form change is the open F-6 question;
> see §6 item 8 and `privacy-decision-matrix.md` §16.

### The rows

| Play category → type | Collected | Shared | Required | Purposes |
|---|---|---|---|---|
| Personal info → **Name** | Yes | No | Optional | App functionality |
| Personal info → **Email address** | Yes | No | Required | App functionality, Account management |
| Personal info → **User IDs** | Yes | No | Required | App functionality, Analytics |
| Personal info → **Other info** *(date of birth)* | Yes | No | Required | App functionality — age eligibility. **Not** declared under Personalisation: DOB-1 retains the date for possible future age-based recommendations, but nothing reads it for that today, and a declared purpose has to describe what ships. Revisit this row, not the collection answer, if a recommender ever consumes it |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality — profile picture |
| App activity → **Other user-generated content** | Yes | No | Optional | App functionality, **Personalisation** — rankings drive Bingd's own recommendation engine (corrected 2026-11-09; see `privacy-decision-matrix.md` §5). Not advertising personalisation. |
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

### Declare these (corrections vs. earlier inventory versions)

> **2026-11-09 correction:** The earlier inventory said "do not declare Device or other IDs".
> The public Play Data safety page (fetched 2026-11-08) shows Device or other IDs declared
> for App functionality and Analytics. The analysis in `privacy-decision-matrix.md` concludes
> the public declaration is correct. Source: PostHog DeviceId UUID and Expo push token.
> **FOUNDER (F-2):** open Play Console → Data safety → Device or other IDs and confirm the
> declared purposes (App functionality, Analytics) are current.

### Do **not** declare these

Approximate or Precise Location · Financial info · Health and fitness · Messages ·
Audio · Files and docs · Calendar · Contacts · Web browsing · Installed apps.

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
| **Terms of Use** | `https://bingd.app/terms` | **drafted 2026-08-25, operator named 2026-09-04, deploys with `main`. Still a draft — no governing law, no lawyer read. See L-1** |
| Support email | `support@bingd.app` | **SETTLED 2026-09-04 — SUPPORT-1 closed. See below** |
| General contact | `hello@bingd.app` | kept for the privacy policy, the Terms and the site's front page |
| Marketing URL | — | not required; leave blank |

### SUPPORT-1 — one canonical support address ~~and there are currently two~~

> **Settled by the founder on 2026-09-04: `support@bingd.app` is the support address,
> and `hello@bingd.app` stays as general contact.** That is the way the app already
> behaved — `src/lib/support.ts` has drafted to `support@bingd.app` since Settings grew
> its Help & Support section, and the Play listing publishes the same — so what changed
> is the website, which said `hello@bingd.app` everywhere.
>
> **What the split means, so it is not mistaken for the drift it replaces.** Support is
> where somebody goes when they need something: the support page and every action on it,
> and the deletion page's line for a person locked out of the app. General contact is
> what the published policy documents and the site's front page already carry, and
> rewriting a contact line inside a privacy policy is a change to a legal document rather
> than a tidy-up. Both forward to the same person. The subject line, not the mailbox, is
> what does the sorting.
>
> **Both store forms take `support@bingd.app`.** Apple emails it during review, so it
> has to be a mailbox somebody reads. **Whether it is one is still not something this
> repository can establish.** `src/lib/support.ts` records that it forwards through
> Cloudflare to the founder's inbox; that is a comment in the code, not a check, and
> sending a message to it and watching it arrive remains a founder action before either
> form is submitted.
>
> **Pinned by a test, not by care.** `web/router.test.mjs` now reads
> `SUPPORT_EMAIL` out of `src/lib/support.ts` and asserts the built page writes to that
> and nothing else, which is what stops the two halves drifting apart again.
>
> Files normalised: `web/build.mjs` (now two constants), `web/router.test.mjs`, this
> document. `supabase/seed/fetch-catalogue.mjs` keeps `hello@bingd.app` in its TMDB
> User-Agent, which is a general contact for an operator rather than a support route.

The record of the problem, kept because the shape of it is what the test now guards:

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

1. ~~**SUPPORT-1 — choose one canonical support address.**~~ **Done 2026-09-04:**
   `support@bingd.app` for support, `hello@bingd.app` for general contact. Both store
   forms take the support address. See §4.
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
8. **Before automatic trailer stills go to production** (§1, "Trailer stills"), open both
   consoles and confirm the submitted answers still hold for the device loading
   images from YouTube's image host on every Cinematic title page, movie and TV, without a tap:
   - **App Store Connect → the app → App Privacy:** the *Privacy Policy URL* is
     `https://bingd.app/privacy`; under *Data Collection*, the declared data types and,
     for each, *Linked to the user* and *Used for tracking* match §2 (no type added for
     third-party image loading, tracking No everywhere). Note whether the published label
     differs from what is in the editor.
   - **Play Console → Policy and programs → App content → Data safety:** choose
     **Option A** or **Option B** (see `privacy-decision-matrix.md` §16 for the full
     analysis and beta-lane open fact).
     - **Option A (no form change):** confirm that no declared user-data row from the
       current form is transferred to Google in an image request — the request carries
       only device IP (not a bingd-collected data type) and a video ID. Record this
       rationale in the console's optional Data safety notes field. Also confirm whether
       any beta binary is currently live on Play's alpha/beta track; if so, automatic
       stills already cover that audience and the current form applies. Note: do not rely
       on the Play service-provider exemption for Google/YouTube — those hosts process
       requests under their own terms, not as bingd's service providers.
     - **Option B (proactive declaration):** add App interactions as Shared with Google
       for App functionality (covering the implicit signal from an image request for a
       specific video ID), publish the updated Data safety form, then ship the production
       OTA. Confirm **App content → Privacy policy** is `https://bingd.app/privacy`.

   For Apple: no form change required. Confirm the Privacy Policy URL and that no
   declared type's Linked or Tracking answer changes for automatic image loads.

   Whichever Play option is chosen, record the decision before triggering the OTA
   workflow. If Option B, the form must be published before the OTA.
