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
| Date of birth | `profiles.date_of_birth` | yes | the 13+ gate, and nothing else. Never returned by any API, including to its owner |
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
| Sensitive Info → **Other Sensitive Info** *(date of birth)* | Yes | No | App Functionality |

### Do **not** declare these

Location · Health & Fitness · Financial Info · Contacts · Browsing History · Search
History¹ · Purchases · Audio Data · Device ID · Advertising Data · Physical Address ·
Phone Number · Email or Text Messages · Gameplay Content · Customer Support · Other Data
Types.

¹ **Search History is deliberately not declared.** Apple's definition is search history
*stored or transmitted*. Bingd transmits a search query to the server to answer it and
stores nothing, and the analytics allowlist specifically excludes query text.

### Notes for the reviewer form

- **Data is not used for third-party advertising, Bingd's own advertising, or
  personalisation.** Only App Functionality and Analytics.
- **Account deletion:** in-app, Settings › Account & Data. Guideline 5.1.1(v) is met; there
  is no "email us" path.
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
| Personal info → **Other info** *(date of birth)* | Yes | No | Required | App functionality — age eligibility |
| Photos and videos → **Photos** | Yes | No | Optional | App functionality — profile picture |
| App activity → **Other user-generated content** | Yes | No | Optional | App functionality |
| App activity → **App interactions** | Yes | No | Optional | Analytics |
| App info and performance → **Crash logs** | Yes | No | Optional | App functionality — diagnostics |
| App info and performance → **Diagnostics** | Yes | No | Optional | App functionality — diagnostics |

### Do **not** declare these

Location (approximate or precise) · Financial info · Health and fitness · Messages ·
Audio · Files and docs · Calendar · Contacts · App activity → **In-app search history**¹ ·
Web browsing · Installed apps · Device or other IDs.

¹ Same reasoning as Apple: queries are transmitted to be answered and are neither stored
nor sent to analytics.

### Two answers that are easy to get wrong

- **"Processed ephemerally"** is for data that is used in memory and never persisted. It
  is tempting for search queries — but Play's schema has no row for a type you are not
  declaring, so the honest answer is simply not to declare in-app search history at all.
- **"Required"** means the app cannot function without it. Email and user id are required;
  a bio, a photo and a note are optional. Marking everything required is inaccurate and
  reads as boilerplate.

---

## 4. The URLs both stores need

| Field | Value | Status |
|---|---|---|
| Privacy policy | `https://bingd.app/privacy` | **written, deploys with `main`** |
| Support URL | `https://bingd.app/support` | **written, deploys with `main`** |
| Account deletion | `https://bingd.app/account-deletion` | **written, deploys with `main`** |
| Support email | `hello@bingd.app` | **FOUNDER — confirm the mailbox is real** |
| Marketing URL | — | not required; leave blank |

All three returned **HTTP 200 with the wrong page** before 2026-08-20: Cloudflare Pages
served the generic "closed testing" page for any unknown path, so a reviewer following the
privacy link got a success status and no policy. They are real documents now and
`web/router.test.mjs` asserts that each one carries its own content and loads no
JavaScript.

---

## 5. TMDB attribution — a beta blocker, and one part is still open

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
| **The official TMDB logo** | **NOT MET — FOUNDER** | see below |

**The logo must be downloaded from TMDB and used unmodified** — their colours, their aspect
ratio, and less prominent than Bingd's own mark. It has not been added, and **it must not
be drawn, redrawn, approximated, traced, or generated**: producing a lookalike breaches the
same terms the attribution section exists to satisfy.

Get it from <https://www.themoviedb.org/about/logos-attribution> and drop it into
`assets/brand/`, then render it in Settings › About above the notice.

**This is a pre-Beta action, not a pre-Preview one.** It does not block founder acceptance
testing and it should not hold up any other work; it must be done before a friend installs
the app.

---

## 6. FOUNDER actions before either store form is submitted

1. **Confirm `hello@bingd.app` is a mailbox somebody reads.** Both stores publish it and
   Apple emails it during review.
2. **Add the official TMDB logo** (§5). Downloaded, unmodified.
3. **Decide the legal entity named on the privacy page.** It currently says "one
   independent developer" and names no person or company. A public launch — particularly
   for UK/EU users — wants a named data controller and an address. A friend beta on nonprod
   does not.
4. **Confirm the retention settings** on the PostHog project and the Sentry project, and
   put the actual numbers on the privacy page. Both currently say "under their own
   retention settings", which is true and vague.
5. **Answer the age-rating questionnaires honestly** — both stores, both have UGC
   questions, and Bingd has notes, reviews and comments.
6. **Have the privacy page read by a lawyer before public launch.** Not before the friend
   beta. What is there now is an accurate description of behaviour, which is what a beta
   owes its testers; it is not a document that has been reviewed for GDPR/CCPA sufficiency.
