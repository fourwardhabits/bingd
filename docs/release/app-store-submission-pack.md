# App Store submission pack — bingd.

**Written 2026-08-29 against `54e32fd`; reconciled 2026-08-30 against `95fd4d7`, then `2f27577`, and again the same day against `37e8584`.** Everything App Store Connect will ask for, drafted
from the application and the canonical documents, with the answers that cannot be derived
marked `FOUNDER INPUT REQUIRED` or `FOUNDER CONFIRM`.

**Nothing here has been entered anywhere.** App Store Connect was not opened, read, or
modified in the pass that produced this document. No build exists for the production lane.
See [`production-bootstrap-runbook.md`](./production-bootstrap-runbook.md) for why a
production binary is required before most of §8 can begin.

**Scope note.** This is the **Apple** pack. Google Play's Data safety form and listing are
covered by [`store-privacy-inventory.md`](./store-privacy-inventory.md) §3 and the
founder-local `store-assets/google-play/store-listing.md`; the two must be kept consistent,
and §4 below is the shared evidence base for both.

---

## Contents

| § | |
|---|---|
| 1 | [App information and version metadata](#1-app-information-and-version-metadata) |
| 2 | [The copy drafts](#2-the-copy-drafts) |
| 3 | [App Review information](#3-app-review-information) |
| 4 | [App privacy answer matrix](#4-app-privacy-answer-matrix) |
| 5 | [Age rating draft](#5-age-rating-draft) |
| 6 | [Export compliance, ads, purchases](#6-export-compliance-ads-purchases) |
| 7 | [Pricing and availability](#7-pricing-and-availability) |
| 8 | [App Store Connect click list](#8-app-store-connect-click-list) |

Companion pages: [`founder-input-worksheet.md`](./founder-input-worksheet.md) ·
[`app-store-screenshot-plan.md`](./app-store-screenshot-plan.md) ·
[`final-physical-acceptance.md`](./final-physical-acceptance.md) ·
[`store-review-access.md`](./store-review-access.md)

---

## 1. App information and version metadata

| Field | Draft | Status |
|---|---|---|
| **App Name** (2–30 chars) | `bingd.` — 6 characters | Matches the Play listing and the app itself, lowercase with the period. **Blocked on HG-3** (PRD §27): App Store name availability and a knockout trademark search have not been done. A six-character brand name is exactly the kind that collides. |
| **Subtitle** (≤30) | `Rank what you watch` — 19 characters | Derived from the positioning line the founder already approved. Alternatives in §2.1. |
| **Bundle ID** | `app.bingd` | `app.config.ts`, production variant |
| **SKU** | `bingd-ios` recommended | FOUNDER — internal, never shown |
| **Primary Language** | English (U.S.) | The only localisation that exists |
| **Primary Category** | **Entertainment** | Matches the Play listing (`Apps → Entertainment`). |
| **Secondary Category** | **Social Networking** — `FOUNDER CONFIRM` | The feed, follows, comments and reactions are real, not decorative, so the category is honest. The alternative reading is that Bingd is a collection tool with a social layer and the secondary should be left blank. Either is defensible; **Social Networking is recommended** because it is what the app's UGC surface actually is, and consistency with the Social Media age-rating answer (§5) matters more than category optimisation. |
| **Version Number** | **`1.0.0` recommended** — `FOUNDER CONFIRM` | `app.config.ts` says `0.1.0` today. Shipping `0.1.0` publicly is permitted and honest. Changing it is a one-line edit that **moves the fingerprint**, so it belongs in the RC window, not after — see the runbook §25. |
| **Support URL** | `https://bingd.app/support` | **Verified live, HTTP 200**, real document. |
| **Marketing URL** | **leave blank until launch day** | `https://bingd.app` renders the closed-testing page while `web/distribution.config.json` says `mode: "beta"`. Set it to `https://bingd.app` in the same change that flips the mode to `public` — and not before, since that flag is the launch switch and the build refuses `public` while either `storeUrl` is null. |
| **Privacy Policy URL** | `https://bingd.app/privacy` | **Verified live, HTTP 200.** |
| **Copyright** | `2026 [LEGAL ENTITY]` | `FOUNDER INPUT REQUIRED`. The Terms page carries the placeholder `[LEGAL ENTITY / DEVELOPER NAME — FOUNDER TO CONFIRM]` and the privacy page says only "one independent developer". No entity is invented here. |
| **Release option** | **Manually release this version** | `FOUNDER CONFIRM` — recommended and expected. Automatic release means the app goes live the moment review approves, possibly overnight, with nobody watching Sentry. |
| **Phased Release for automatic updates** | Not applicable to a first release | Consider it for the first update after launch |

---

## 2. The copy drafts

Character counts below are exact and were measured on the strings as written.

### 2.1 Subtitle candidates (≤30)

| Candidate | Chars | Note |
|---|---|---|
| **`Rank what you watch`** | 19 | **Recommended.** The founder-approved positioning line's first half; stands alone under the name. |
| `Rank what you watch` + a second clause | — | Does not fit; the second sentence belongs in Promotional Text. |
| `Your taste, ranked` | 18 | Prettier, less concrete. Says nothing about movies or TV. |
| `Rank movies and TV seasons` | 26 | Most literal. Spends the whole subtitle on the nouns and none of it on the verb. |

### 2.2 Promotional text (≤170)

Editable without a new build, so it is where a launch-week message goes.

> Rating a film out of five stars is hard. Choosing between two you have actually seen is
> easy. bingd builds your ranking out of those small decisions.

**149 characters.**

### 2.3 Full description (≤4000)

Adapted from the founder-approved Candidate 1 in
`store-assets/google-play/store-listing.md`, corrected to what `54e32fd` actually ships.
**Every claim below maps to shipped behaviour.**

> bingd. is a home for what you watch.
>
> Rating a film out of five stars is hard. Deciding between two films you have actually
> seen is easy. bingd builds your rankings from those small decisions: pick a reaction,
> answer a few head-to-head comparisons, and every title lands in its exact place in your
> list with a score out of 10.
>
> RANK IT
> Movies and TV seasons each get their own ranked list. Seasons are ranked on their own,
> because season 1 and season 4 are rarely the same show. If a comparison is one you cannot
> call, say so — bingd will not ask you the same pair twice.
>
> KEEP IT
> Log what you have watched, keep a watchlist, and set watch goals. Filter your collection
> by genre, by decade, by how you felt about it. Your collection stays yours, and stays
> readable when you are offline.
>
> SHARE IT
> Follow friends and see what they rank in a simple chronological feed. Write a review,
> leave a comment, react, and tag the people you watched something with. A match score
> shows how much your taste overlaps with theirs, and it shows you the titles it is built
> from.
>
> FIND WHAT'S NEXT
> The For you tab suggests what to watch next, drawn from your rankings, from people with
> similar taste, and from the people you follow. Get personalized suggestions shaped by what
> you have ranked and the people you follow. Send one to a friend and you will know when they
> watch it.
>
> KEEP SCORE
> Awards mark the things you have actually done — twenty comments, a hundred titles ranked —
> and say what each one was for. A monthly leaderboard among the people you follow, if you
> want it.
>
> Your account is public or private, entirely your choice. You can block anyone, report
> anything, and delete your account yourself, from inside the app, permanently.
>
> bingd is built for people who like their opinions organised.
>
> This product uses the TMDB API but is not endorsed or certified by TMDB.

**1,814 characters** as written — well inside the 4000 limit, and deliberately so: the App
Store truncates after about three lines and a reader who taps *more* is not rewarded by
padding. (The line breaks inside each paragraph above are this document's wrapping, not the
copy's; unwrapping them when pasting makes it slightly shorter, never longer.)

> **One line to check before submitting.** *"Send one to a friend and you will know when
> they watch it"* describes the recommendation-fulfilment loop shipped in PR #65. Confirm on
> the RC build that the sender is still notified; if that changed, this sentence goes.

### 2.4 Keywords (≤100 bytes, comma-separated, **no spaces**)

Do not repeat the app name or the category name — Apple indexes both already, and repeating
them wastes the field.

```
movies,tv,seasons,ranking,watchlist,film,series,tracker,friends,taste,recommend,binge
```

**85 bytes**, measured with `Buffer.byteLength`. Fifteen bytes spare for a founder addition after the trademark search.

Rejected on purpose: `letterboxd` and any other product name (Apple rejects competitor
names); `imdb`; `bingd` (the name is indexed already); `entertainment` (the category is
indexed already).

### 2.5 What's New in This Version (≤4000)

For a first release Apple accepts a placeholder, but this reads better:

> First public release of bingd.

`FOUNDER CONFIRM` — and if the version ships as `0.1.0` rather than `1.0.0`, say so here
rather than leaving a reviewer to notice.

---

## 3. App Review information

### 3.1 Contact

| Field | Value |
|---|---|
| First name / Last name | `FOUNDER INPUT REQUIRED` |
| Phone number | `FOUNDER INPUT REQUIRED` — Apple calls this number. It is not published on the listing. |
| Email address | `FOUNDER INPUT REQUIRED` — see SUPPORT-1 in [`founder-input-worksheet.md`](./founder-input-worksheet.md). Apple emails this address during review, so it has to be a mailbox somebody reads that week. |

No name, number or address is invented here. The repository does not establish any of the
three.

### 3.2 Sign-in required

**Yes.** And the reason it must be spelled out is that Bingd's three primary sign-in
methods are all unavailable to a reviewer: an emailed six-digit code goes to a mailbox they
do not have, and Apple and Google are OAuth against accounts they will not attach to a test
device. An OTP-only app is an app whose sign-in screen review cannot get past, and the
rejection reads *"we were unable to sign in"*.

| Field | Value |
|---|---|
| User name | `FOUNDER INPUT REQUIRED` — the production review account, suggested `review@bingd.app` |
| Password | `FOUNDER INPUT REQUIRED` — **entered directly in App Store Connect. It does not go in this repository, in a commit message, in a PR description, or in a message to anyone.** |

Creation runbook: [`store-review-access.md`](./store-review-access.md). The account must be
created **on the production project** — an account on nonprod does not exist on production,
and the lane decides the backend.

### 3.3 Review notes — draft

> Thank you for reviewing bingd.
>
> SIGNING IN — PLEASE READ FIRST
> The three buttons on the sign-in screen are for ordinary users: "Continue with email"
> sends a one-time code to the address entered, and Apple and Google are OAuth. None of
> those will work for you.
>
> Instead, tap "More sign-in options" at the bottom of the sign-in screen, then "Sign in
> with password", and use the credentials in the App Review Information fields above. There
> is no MFA and no code to enter.
>
> WHAT THE APP DOES
> bingd is a place to rank the films and TV seasons you have watched. Instead of asking for
> a star rating, it asks which of two titles you preferred; a handful of those comparisons
> places a title in your ranked list with a score out of 10. From the sign-in above you will
> land on the Feed. The Collection tab is the ranked list, Search is the middle tab, and For
> you is the recommendation slate.
>
> RANKING
> To see the core loop: Search, pick any film, tap Rank, choose a reaction, then answer the
> head-to-head comparisons. Scores are computed only from the account holder's own
> comparisons. Nothing is averaged from other users and there is no external rating source.
>
> USER-GENERATED CONTENT, REPORTING AND BLOCKING
> Users write reviews and comments and react to each other's activity. Every review,
> comment and profile can be reported from a menu on the item itself, with eight reasons
> including harassment, hate speech and sexual content. Any account can be blocked from the
> menu on their profile; a block is a barrier in both directions and removes any follow
> between the two accounts. Reports reach an operator who can suspend an account and reverse
> the suspension, and every action is recorded. There is no automated moderation and the app
> does not claim any.
>
> ACCOUNT DELETION
> Settings > Account & Data > Delete my account. It is in-app, immediate and irreversible;
> the user types their own handle to confirm. No email to support is required. What is
> deleted, what is anonymised and the one category that is retained (safety records) are all
> listed at https://bingd.app/account-deletion.
>
> AGE
> Accounts are 13+. A date of birth is collected at sign-up and an account under 13 is
> refused; the date of birth is never returned by any part of the app, including to its
> owner.
>
> INVITATIONS AND DEEP LINKS
> A user can share an invitation link of the form https://bingd.app/i/<token>. Opening it on
> a device without the app shows a web page describing bingd with a link to the store;
> opening it with the app installed opens the app and credits the inviter. Profile, title
> and list links (https://bingd.app/u/..., /title/..., /lists/...) open the corresponding
> screen. A link never bypasses a private account's privacy setting.
>
> THIRD-PARTY CONTENT
> Film and television metadata and artwork come from TMDB. The attribution TMDB's terms
> require is in Settings > About, with their logo and a link to themoviedb.org, and the same
> notice is at the foot of https://bingd.app/privacy. Artwork is loaded from TMDB's own
> servers and never rehosted.
>
> NO PURCHASES
> There are no in-app purchases, no subscriptions and no advertising of any kind in this
> version.
>
> Anything else, please contact us at the address above — thank you.

`FOUNDER CONFIRM` on two sentences before this is pasted: that Search is still the middle
tab on the RC build, and that the reason list still has eight entries.

### 3.4 Attachment

Optional. Not needed — nothing in the flow requires a video to be understood.

---

## 4. App privacy answer matrix

**Path:** App Store Connect → the app → **App Privacy** → *Data Types*.

Apple's definition of *collect* is the one that matters: transmitting data off the device
in a way that allows access **for longer than necessary to service the request in real
time**. *Linked to you* means associated with the user's identity. *Tracking* means linking
with third-party data for advertising, or sharing with a data broker.

**The three global answers**

| Question | Answer | Evidence |
|---|---|---|
| Does the app collect data? | **Yes** | The whole product is an account |
| Is any data used to track you? | **No** | No advertising SDK, no attribution SDK, no IDFA, no `AppTrackingTransparency` prompt, no data broker. `package.json` contains none; `src/lib/analytics.ts` autocapture is off and session replay is not enabled |
| Third-party partners | Supabase (hosting), PostHog (analytics), Sentry (diagnostics), TMDB (image CDN, direct from device), Apple and Google (sign-in), Cloudflare (website only) | `bingd.app/privacy`, "Who else sees it" |

> **"Data Not Collected" is not available to this app, and switching off autocapture does
> not earn it.** PostHog receives an account identifier with every event and Sentry receives
> one with every crash. Both are collection, both are linked, and both must be declared.

### 4.1 The matrix

Legend: **S** = stored by bingd. in Supabase · **P** = sent to PostHog · **Y** = sent to
Sentry · — = not sent.

| Apple data type | Collected | Linked | Tracking | Purpose | S | P | Y | Retention evidence | Source |
|---|---|---|---|---|---|---|---|---|---|
| Contact Info → **Email Address** | Yes | Yes | No | App Functionality (sign-in) | ✔ | — | — | Until account deletion; removed with the `auth.users` row | `auth.users`; `bingd.app/account-deletion` |
| Contact Info → **Name** | Yes | Yes | No | App Functionality (display name, and the name Apple/Google return) | ✔ | — | — | Until account deletion | `profiles`; `20260813*` |
| Contact Info → **Physical Address** | **No** | — | — | — | — | — | — | No column exists | schema |
| Contact Info → **Phone Number** | **No** | — | — | — | — | — | — | Not requested; deletion copy mentions it only as "if present" via the auth provider | `auth.users` |
| Contact Info → **Other Contact Info** | **No** | — | — | — | — | — | — | — | — |
| Health & Fitness (both types) | **No** | — | — | — | — | — | — | — | — |
| Financial Info (all types) | **No** | — | — | — | — | — | — | No payments exist. PRD §20: nothing purchasable in v1 | PRD §20 |
| Location → **Precise / Coarse** | **No** | — | — | — | — | — | — | `expo-location` is not a dependency; no `getCurrentPosition` call exists anywhere in `app/` or `src/`; no `NSLocation*` key in `app.config.ts` | `package.json`, grep |
| Sensitive Info | **No** | — | — | — | — | — | — | Date of birth is **not** Apple's Sensitive Info — that type covers race, sexual orientation, pregnancy, disability, religion, union membership, political opinion, genetic and biometric data. DOB goes under Other Data | Apple's definition; `store-privacy-inventory.md` §2 note 1 |
| **Contacts** | **No** | — | — | — | — | — | — | No contacts permission, no address-book read, no contact upload. The invite flow is a share sheet handing out a URL | `app.config.ts` has no contacts permission string |
| User Content → **Photos or Videos** | Yes | Yes | No | App Functionality (profile picture only) | ✔ | — | — | Deleted with the account; one honest residual documented — an orphaned storage object if the delete request does not complete | Supabase Storage `avatars/{uuid}/`; `src/features/profile/avatar.ts`; `bingd.app/account-deletion` |
| User Content → **Other User Content** | Yes | Yes | No | App Functionality (rankings, notes, reviews, comments, reactions, watchlist, goals, watch tags, lists) | ✔ | — | — | Deleted with the account, **except** content attached to a filed report or a moderator action, which is retained with its account identifier | `rankings`, `comments`, `feed_events`, `reactions`, `watch_tags`; `moderation-runbook.md` |
| User Content → **Customer Support** | **No** | — | — | — | — | — | — | Support is an email address, not an in-app channel | `bingd.app/support` |
| User Content → **Emails or Text Messages** | **No** | — | — | — | — | — | — | No messaging feature; comments are public posts under an activity, not private messages | `src/features/feed` |
| User Content → **Gameplay Content** | **No** | — | — | — | — | — | — | Not a game | — |
| Browsing History | **No** | — | — | — | — | — | — | No browser, no history store | grep: only fixed `Linking.openURL` destinations |
| Search History | **FOUNDER — see 4.2** | Yes if declared | No | App Functionality | — | — | — | **Nothing in the schema stores a query.** The open question is Supabase request-log retention | grep over `supabase/migrations/` and `src/`: no `search_history`, no `recent_search` |
| Identifiers → **User ID** | Yes | Yes | No | App Functionality, Analytics | ✔ | ✔ | ✔ | The internal UUID and nothing else. PostHog `identify(userId)`; Sentry `setUser({ id })` | `src/lib/analytics.ts`; `src/lib/monitoring.ts:212` |
| Identifiers → **Device ID** | **No** | — | — | — | — | — | — | No IDFA, no IDFV read, no advertising identifier. The Expo push token is not a device identifier Apple lists here — see 4.3 | `package.json`; grep |
| Purchases | **No** | — | — | — | — | — | — | Nothing purchasable | PRD §20 |
| Usage Data → **Product Interaction** | Yes | Yes | No | Analytics | — | ✔ | — | Eleven declared events, closed vocabulary. **Retention is PostHog's project setting — FOUNDER must read the number** | `src/lib/analytics.ts`; `docs/product/analytics.md` |
| Usage Data → **Advertising Data** | **No** | — | — | — | — | — | — | No ads anywhere | — |
| Usage Data → **Other Usage Data** | **No** | — | — | — | — | — | — | The eleven events are all Product Interaction | `docs/product/analytics.md` |
| Diagnostics → **Crash Data** | Yes | Yes | No | App Functionality | — | — | ✔ | Sentry project retention — **FOUNDER must read the number** | `src/lib/monitoring.ts` |
| Diagnostics → **Performance Data** | Yes | Yes | No | App Functionality | — | — | ✔ | `tracesSampleRate` 0.2 in production, transactions scrubbed by `beforeSendTransaction` | `src/lib/monitoring.ts:63,74` |
| Diagnostics → **Other Diagnostic Data** | Yes | Yes | No | App Functionality | — | — | ✔ | Error messages and stack traces are kept deliberately, because a crash report without them reports nothing | `src/lib/monitoring.ts`; `bingd.app/privacy` |
| Other Data → **Other Data Types** *(date of birth)* | Yes | Yes | No | App Functionality (13+ eligibility) | ✔ | — | — | **Retained as an exact date — decided 2026-08-24, DOB-1.** Never returned by any API, including to its owner; pinned by `rls.test.mjs` against another user, its owner and `anon`; does not outlive the account | `profile_private.date_of_birth`; `20260813001400`; `open-questions.md` §8 |

### 4.2 Search History — the one row the founder has to decide

**The case for not declaring.** A Bingd search is answered and discarded. Nothing in
`supabase/migrations/` writes a query — there is no `search_history` table, no
`recent_searches` column, and no client-side store. The analytics allowlist forbids it
twice over: `query` and `search` are both in `FORBIDDEN_PROPERTY_KEYS`, and
`member_search_result_opened` carries `position` and a surface and nothing else.

**The case for declaring.** The query does leave the device, as a PostgREST request. If the
Supabase project retains request paths in its logs, the query text is retained off-device
for longer than the request needs — which is Apple's definition.

**Recommendation: read the retention setting (runbook §20); if you cannot establish it,
declare Search History.** An over-declaration costs a line on a label. An under-declaration
costs a rejected submission or a removal.

`FOUNDER CONFIRM` — and record the answer here once it is known, because Play's *In-app
search history* row must match it.

### 4.3 The push token, and why it is not a row above

`device_tokens` holds an **Expo push token** — an opaque routing address issued by Expo
Push Service, revoked on sign-out, and with **no read policy at all** (`20260813000900`:
*"A push token is an operational secret with no read policy"*). It is not an advertising
identifier, it is not stable across reinstalls, and it identifies a delivery channel rather
than a device across apps.

Apple has no "push token" data type. The honest placement is that it is covered by
**Identifiers → User ID** — it is stored against the account and used only to deliver that
account's own notifications. It is **not** Device ID: declaring it there would assert an
advertising or cross-app identifier that this app does not have.

`FOUNDER CONFIRM`, and if Apple's questionnaire has gained a push-token type since this was
written, use it.

### 4.4 Invite attribution

`invite_tokens` and `invite_attributions` record which account invited which. That is
**User Content → Other User Content** and **Identifiers → User ID**, already declared. It
is **not** tracking: nothing is linked with third-party data and nothing is shared with a
broker. The analytics event `invite_redeemed` carries **no properties at all** —
deliberately, because the inviter is another person and the token is in
`FORBIDDEN_PROPERTY_KEYS`.

On deletion the attribution row survives with the pointer to the deleted account removed,
so the person who is still here keeps their credit. That is stated on
`bingd.app/account-deletion` under *What is kept without pointing at you*.

### 4.5 Third-party SDK behaviour

| SDK | What it sends | Configured how |
|---|---|---|
| `posthog-react-native` | The eleven declared events, plus account id, app version and build | **Autocapture off** — in a film app it would record the titles in somebody's collection. Property values must be scalars; non-scalar values are refused outright. Session replay not enabled. `identify()` receives the UUID and nothing else — no email, username or display name |
| `@sentry/react-native` | Crashes, errors, and a 20% trace sample in production | `sendDefaultPii: false`; `setUser({ id })` only; `beforeSend` scrubs; **`beforeSendTransaction` scrubs too**, because transactions never pass through `beforeSend` — a hole review 24 found and closed |
| `@supabase/supabase-js` | Everything the product stores | First-party backend |
| `expo-notifications` | Registers for a push token | No content leaves through it |
| TMDB image CDN | **Image requests direct from the device** | TMDB sees the request the way any image host does. `src/lib/images.ts`; artwork is never rehosted |
| Apple / Google sign-in | Only if the user chooses them | `expo-apple-authentication`, OAuth |

**No advertising SDK, no attribution SDK, no analytics partner beyond the two named.**

---

## 5. Age rating draft

**Path:** App Store Connect → the app → **Age Rating** → *Edit*.

Apple replaced the old questionnaire with five bands — **4+, 9+, 13+, 16+, 18+** — and, as
of 9 July 2026, added questions about social-media capability; **answers to those are
required from September 2026**, which is before this app can plausibly submit. Read the
live wording in the console: the categories below are Apple's published descriptor set, but
the exact question text is not published outside App Store Connect.

**Expected outcome: 13+.** It is forced by the Social Media descriptor and it is also what
the app already enforces at sign-up, so nothing has to be argued into place.

### 5.1 In-app controls

| Descriptor | Recommended | Evidence | Why |
|---|---|---|---|
| **Parental Controls** | **No** | No parental-control surface exists in `app/settings/` | The privacy setting is the user's own, not a guardian's. `FOUNDER CONFIRM` |
| **Age Assurance** | **No** — `FOUNDER CONFIRM` | Sign-up collects a self-declared date of birth (`app/(auth)/create-profile.tsx:274` — *"bingd. is for ages 13 and over"*) and refuses under-13 | Apple's definition names the Declared Age Range API, age estimation, or government-ID verification. **A self-declared date of birth is none of those.** Answering "Yes" on the strength of a birthday field would overstate what the app does. If the founder judges self-declaration to qualify as "other means of age assurance", answer Yes — but decide it, do not inherit it |

### 5.2 Capabilities

| Descriptor | Recommended | Evidence | Why |
|---|---|---|---|
| **User-Generated Content** | **Yes** | Reviews, notes, comments, reactions, profile bios, avatars, watch tags | Broadly distributed content created by users is the product. Minimum rating 4+ on its own |
| **Social Media** | **Yes** — forces **13+** | A chronological feed of followed accounts; reactions; comments; a "For you" discovery slate; member search; a monthly leaderboard | Apple's definition is *"redistribution, amplification, or interaction with user-generated content through a social feed or similar discovery method"*. Bingd has all three. **Do not try to answer No here** — this is the descriptor Apple switched on in July 2026 and it is what any app with a UGC feed now gets |
| **Social Media Disabled for Users Under 13** | **No** — `FOUNDER CONFIRM` | Under-13 accounts are refused **entirely** at sign-up; there is no under-13 mode with social switched off | The descriptor's own definition requires that *"at a minimum, the Declared Age Range API is called"*. Bingd does not call it. **The app is stricter than the descriptor describes — it admits nobody under 13 rather than admitting them without social — but it does not implement the mechanism named.** Answering Yes would claim an API call that does not happen. If the founder wants the descriptor, the honest route is to adopt the Declared Age Range API, which is a product change and out of the current freeze |
| **Messaging and Chat** | **No** — `FOUNDER CONFIRM` | There is no direct-message feature. Comments are public posts under an activity, readable by whoever can read the activity | The definition includes *"public posting"*, which a comment is. **The conservative answer is Yes.** The recommendation is No because Bingd has no private channel at all — but this is a genuine judgment call, the minimum rating is 4+ either way, and answering Yes costs nothing except accuracy. If in doubt, answer Yes |
| **Advertising** | **No** | No ad SDK, no ad surface | §6 |
| **Unrestricted Web Access** | **No** | No in-app browser and no address bar. `expo-web-browser` is used **only** for the Apple/Google OAuth session (`src/features/auth/methods.ts:346`). `Linking.openURL` is called with exactly four kinds of destination: `themoviedb.org`, `bingd.app/terms`, `bingd.app/privacy`, and a title's official homepage URL supplied by TMDB — all handed to the system browser, outside the app | This is the descriptor that forces **16+**, so it is worth being precise. A user cannot navigate to an arbitrary page inside bingd. The TMDB homepage link is an outbound handoff to Safari, not embedded browsing. `FOUNDER CONFIRM` |

### 5.3 Mature themes

| Descriptor | Recommended | Evidence | Why |
|---|---|---|---|
| **Profanity or Crude Humor** | **Infrequent/Mild** — `FOUNDER CONFIRM` | Bingd writes none. Two sources exist: TMDB overviews and titles shown verbatim, and user-written reviews and comments with no profanity filter | The app cannot honestly answer "None" while it displays free text it does not filter. **Do not answer None.** Whether Infrequent or Frequent is a judgment about the beta corpus the founder has actually read |
| **Horror/Fear Themes** | **Infrequent/Mild** — `FOUNDER CONFIRM` | The catalogue includes horror films with their posters and synopses; a Horror genre filter exists | Artwork and descriptions, not the app's own content |
| **Alcohol, Tobacco, or Drug Use** | **Infrequent/Mild** — `FOUNDER CONFIRM` | Same: third-party film metadata may reference it | Bingd depicts none itself |

### 5.4 Medical or wellness

| Descriptor | Recommended | Evidence |
|---|---|---|
| **Medical or Treatment Information** | **None** | No medical content, no health claims |
| **Health or Wellness Topics** | **No** | Watch goals are a viewing count, not a wellness feature |

### 5.5 Sexuality or nudity

| Descriptor | Recommended | Evidence | Why |
|---|---|---|---|
| **Mature or Suggestive Themes** | **Yes / Infrequent** — `FOUNDER CONFIRM` | TMDB posters and synopses for films rated 15/18 are shown as supplied. There is no adult-content filter on the catalogue | Answering "None" would be a claim about a third-party catalogue this app does not curate |
| **Sexual Content or Nudity** | **None** — `FOUNDER CONFIRM` | TMDB poster artwork is the theatrical marketing image and TMDB moderates its own primary artwork | The honest question is whether the founder has seen a poster in the app that would qualify. **Check the catalogue before answering**, particularly what the Search tab returns for an explicit query |
| **Graphic Sexual Content and Nudity** | **None** | — | — |

### 5.6 Violence

| Descriptor | Recommended | Evidence |
|---|---|---|
| **Cartoon or Fantasy Violence** | **Infrequent/Mild** — `FOUNDER CONFIRM` | Film artwork and descriptions only |
| **Realistic Violence** | **Infrequent/Mild** — `FOUNDER CONFIRM` | Same |
| **Prolonged Graphic or Sadistic Realistic Violence** | **None** | The app depicts nothing; a poster is not prolonged |
| **Guns or Other Weapons** | **Infrequent/Mild** — `FOUNDER CONFIRM` | Film artwork |

> **The whole 5.3–5.6 block is one judgment, made once.** Bingd creates no mature content of
> any kind. It displays (a) third-party film and television artwork and synopses, unfiltered,
> and (b) user-written text, unfiltered. Answering "None" everywhere would be optimising
> downward, which is what gets a rating overridden after launch. Answering the mild tier
> everywhere is honest and does not move the rating, because Social Media has already set
> the floor at 13+.

### 5.7 Chance-based activities

| Descriptor | Recommended | Evidence | Why |
|---|---|---|---|
| **Gambling** | **No** | No real money anywhere | — |
| **Simulated Gambling** | **No** | No wagering mechanic | — |
| **Contests** | **Yes / Infrequent** — `FOUNDER CONFIRM` | A **monthly leaderboard** ranks the people you follow by titles, movies, TV or reviews (`20260828000300`, `20260829000100`); **awards** mark achievements with named tiers; **watch goals** are personal targets | Apple's definition is *"events that allow users to compete with one another for rankings, rewards, or the achievement of personal goals"*. The leaderboard is literally that. **Frequent** would also force 13+, which the rating already is, so there is no downward incentive here — answer whichever is true |
| **Loot Boxes** | **No** | Nothing randomised, nothing purchasable | — |

### 5.8 Moderation controls — the questions the July 2026 update added

Apple now asks whether the app has moderation systems, content filtering, reporting tools,
blocking and parental controls. Bingd's honest answers:

| | Answer | Evidence |
|---|---|---|
| **Reporting** | **Yes** | `src/features/moderation/report.ts` — three reportable subjects (profile, comment, review) and eight reasons: harassment, hate speech, self-harm, sexual content, impersonation, illegal content, spam, other. Rate-limited; a self-report is refused; the receipt is deliberately uninformative so a reporter cannot learn the state of the queue |
| **Blocking** | **Yes** | `block` / `unblock` from a profile menu and from Settings → Privacy. A barrier in both directions, not a filter; any follow between the two accounts is removed and unblocking does not restore it |
| **Operator action on reports** | **Yes, manual** | An operator can see a filed report, suspend an account and reverse it, and every action is recorded — [`moderation-runbook.md`](./moderation-runbook.md), run from the SQL editor |
| **Automated moderation / content filtering** | **No** | There is none, and the Terms of Use claims none. **Do not answer Yes** |
| **Appeals process** | **No** | Explicitly absent, and documented as absent |
| **Notification when a report arrives** | **No** | Also documented as absent |
| **Parental controls** | **No** | §5.1 |

> Answering these truthfully is not a weakness in the submission. The runbook exists, it has
> been exercised, and PRD §27 marks *"the operator can see a filed report, suspend an
> account, and reverse it"* as **closed**. Claiming an automated system that does not exist
> is the thing that fails.

---

## 6. Export compliance, ads, purchases

| Question | Answer | Evidence |
|---|---|---|
| Does your app use encryption? | **Uses exempt encryption only** → `ITSAppUsesNonExemptEncryption: false` | Already set in `app.config.ts` → `ios.infoPlist`. Bingd uses HTTPS and the platform keychain (`expo-secure-store`) and nothing else, which is the standard exemption. **No annual self-classification report is required and no CCATS is needed.** Because the key is in the built `Info.plist`, App Store Connect should not ask the question at upload; if it does, the answer is the same |
| Does the app contain **ads**? | **No** | No ad SDK in `package.json`; no ad surface in the app |
| **In-app purchases**? | **No** | PRD §20: nothing is purchasable in v1. `alpha_early_access` is a time-boxed grant, not a product |
| **Subscriptions**? | **No** | Same |
| **Third-party content**? | **Yes** — TMDB metadata and artwork | Attribution complete: the exact unparaphrased notice in Settings → About, TMDB's own logo used unmodified (sha256 `5bdc75aa…`, matching the hash TMDB embeds in their filename), a link to themoviedb.org, per-screen "Metadata from TMDB", images never rehosted, and the same notice at the foot of `bingd.app/privacy` |
| **Account creation required**? | **Yes**, and **account deletion is in-app** | Guideline 5.1.1(v) met: Settings → Account & Data → Delete my account. No "email us to delete" path |
| **Sign in with Apple offered**? | **Yes**, iOS | Required because Google sign-in is offered (4.8). `usesAppleSignIn: true` |

> **TMDB commercial terms.** The founder holds written TMDB confirmation permitting
> zero-revenue testing; **a commercial agreement is required before monetisation**. That is
> not a blocker for a free release, and it becomes one the day anything is charged for.

---

## 7. Pricing and availability

| Field | Recommendation | Note |
|---|---|---|
| Price | **Free** | Nothing is purchasable |
| Availability | **`FOUNDER INPUT REQUIRED`** | See below |
| Pre-orders | **No** | — |
| Distribution on Apple Vision Pro | **No** | `supportsTablet: false`; nothing has been tested there |

### The availability recommendation, and its one real constraint

**Recommended: start with a single country — the founder's own — and widen after the first
week.** Not for caution's sake, but because of what the product actually promises:

- **Support is one person and one mailbox.** `bingd.app/support` says so in those words.
  Worldwide availability at launch means support requests in timezones and languages nobody
  can answer.
- **The app is English-only.** There is one localisation.
- **A UK or EU launch raises the data-controller question immediately.** The privacy page
  names no entity and no address (§1, Copyright). A named controller is expected for those
  users; a friend beta on nonprod did not need one and a public release does.
- **The catalogue is TMDB's, which is global**, so there is no content reason to restrict.

`FOUNDER INPUT REQUIRED` — and note that widening availability later is a metadata change
with no review round, while pulling countries back after launch is visible to anyone who had
already installed.

---

## 8. App Store Connect click list

The order matters: several sections cannot be completed until a production build has
finished processing, and one of them (**Build**) is what unlocks *Add for Review*.

### Phase A — before any build exists

Everything here can be entered today against the existing app record (`ascAppId 6803954532`),
and none of it is submitted by entering it.

| # | Where | What | Blocked on |
|---|---|---|---|
| 1 | **App Information** | Name, Subtitle, Privacy Policy URL, Primary/Secondary Category, Content Rights (does your app contain third-party content? **Yes**, TMDB) | HG-3 name availability; the Copyright entity |
| 2 | **Age Rating** → Edit | The whole questionnaire, §5. Read the live wording; the social-media questions are new since July 2026 | The §5 `FOUNDER CONFIRM` calls |
| 3 | **App Privacy** | Every row in §4, then *Publish* | The Search History decision (§4.2), which needs the Supabase log-retention reading (runbook §20) |
| 4 | **Pricing and Availability** | Free; territories per §7 | The availability decision |
| 5 | **Version → Promotional Text, Description, Keywords, What's New, Support URL, Marketing URL, Copyright** | §2 | Copyright entity; leave Marketing URL blank until launch day |
| 6 | **Version → App Review Information** | Contact name/email/phone; Sign-in required **Yes** with the production review account; the notes from §3.3 | The production project must exist first, because the account lives on it (runbook §21) |
| 7 | **Version → Version Release** | **Manually release this version** | — |

### Phase B — once the production build has processed

| # | Where | What | Note |
|---|---|---|---|
| 8 | **TestFlight** | Validate the build against the twelve checks in the runbook §26 | **Do this before touching anything below.** It is the last point at which a build pointed at the wrong database can be caught |
| 9 | **Version → Screenshots** | Upload the 6.9" set per [`app-store-screenshot-plan.md`](./app-store-screenshot-plan.md) | Captured on the RC build, on the demo account. Cannot be done earlier without shipping a screenshot of a beta pointed at nonprod |
| 10 | **Version → Build** | Select the processed production build | Requires export-compliance answered (§6) — usually skipped because the `Info.plist` key is present |
| 11 | **Version → App Review Information** | Re-read it against the build you actually selected | The notes in §3.3 name surfaces; confirm they are still where the notes say |
| 12 | **Add for Review** | — | **FOUNDER PRESSES THIS. Not Claude.** |
| 13 | Review the summary screen | Apple lists everything about to be submitted | Last chance |
| 14 | **Submit for Review** | — | **FOUNDER PRESSES THIS** |
| 15 | On approval: **Release This Version** | — | **FOUNDER PRESSES THIS.** Manual release (§1) is what makes step 15 a separate, deliberate act |

### What must wait for the production build, in one list

- Screenshots (step 9) — they must come from the RC, on production, with the demo account
- Build selection (step 10)
- *Add for Review* and *Submit for Review* (steps 12, 14) — App Store Connect will not
  accept a version with no build attached
- The review account credentials (step 6) — the account has to exist **on production**, and
  production does not exist yet

### What must happen outside App Store Connect, in the same window

- `web/distribution.config.json` → `mode: "public"` and the iOS `storeUrl` filled in. **The
  build refuses `public` while either `storeUrl` is null**, so this happens after the App
  Store URL exists — on release day, not before.
- ~~`bingd.app/support` states *"Bingd sends no push notifications"*~~ — **fixed in the
  tracked source on 2026-08-30** (`95fd4d7`). The page now says notifications may be sent
  when enabled, that everything also appears in the in-app inbox, and where to change or
  turn them off. **The deployed site still carries the old wording**: the fix ships with
  the next site deployment, which is a launch-day step and was not taken.
- HG-2 (Android developer verification), HG-3 (name and trademark), HG-5 (Play production
  access) — PRD §27.

---

## What was **not** done in the pass that wrote this

App Store Connect was not opened, queried, or modified. Nothing was uploaded. No build was
created. No production environment was created or configured. No secret was read, written,
printed or committed. Every state claim in §0 of
[`production-bootstrap-runbook.md`](./production-bootstrap-runbook.md) came from a read-only
command, and every store requirement here came from Apple's published documentation or from
this repository.

---

## Reconciled again 2026-08-30 — `2f27577`

One product tranche landed after the previous reconciliation. Nothing in it changes a
store answer, and this section exists so the *absence* of change is a recorded check
rather than an assumption.

| Change in `2f27577` | Effect on this pack |
|---|---|
| Monthly leaderboard counts a logged title with no watch date | **None.** The metric is still one aggregate — how many titles — and §4's data-collection answers describe the same fields. No new data is collected, transmitted or linked. |
| Anime is drawn first and replaces Animation in search as well as on a title page | **None.** A read-time label over provider metadata Bingd already receives. §3's description copy names no genre. |
| Season lists are re-read, and episode counts now populate | **None.** TMDB attribution (§4.5) is unchanged and already covers seasons; no new provider or SDK. |
| Awards sheet has one fixed order | **None.** No new capability, no chance-based element (§5.7 stands). |
| Recommendations audited, no code changed | **None.** |

**One screenshot consequence.** Season rows now show an episode count ("9 episodes"), so
any TV screenshot taken before 2026-08-30 shows a metadata line the shipped app no longer
draws that way. [`app-store-screenshot-plan.md`](./app-store-screenshot-plan.md) shot 3 is
the affected one; retake it after taking the OTA rather than reusing an earlier capture.

---

## Reconciled again 2026-08-30 — `37e8584`

PR #78 fixed a sort control that named a fact it did not order by, made a collection-derived
award tier reversible, restored an award push that had silently never been sent, and let a
re-tap of the Feed tab leave the Leaderboard.

| Change in `37e8584` | Effect on this pack |
|---|---|
| The Collection sort control is one label per axis with a direction arrow; the watch-date axis is replaced by **Recently added** | **None on the answers.** §3's description copy names no sort order. But see the screenshot note below — a Collection capture taken before 2026-08-30 shows a chip that no longer exists. |
| A collection-derived award tier is revoked when the collection stops supporting it, and can be re-earned | **None.** No new capability, no new data, no chance-based element (§5.7 stands). It is a correction to what an already-declared feature asserts about the user's own data. |
| `claim_push_batch` sends the actorless award congratulations again | **None on the declarations.** Push is already declared and already described in §4; this restores a notification the app always said it would send. Worth knowing for §5's *does the app use push?* answer only in that the answer was already yes. |
| `live_push_jobs` — the sender drops a claimed push whose notification was deleted | **None.** Server-side, no new data collected or transmitted, no new endpoint reachable by a client. |
| Re-tapping the Feed tab leaves the Leaderboard | **None.** |

**No answer in §4's data-collection matrix moves**, and no new SDK, provider, permission or
tracking domain is introduced. Nothing in this tranche touches age rating, encryption
export, or the account-deletion declaration.

**Two screenshot consequences**, both in
[`app-store-screenshot-plan.md`](./app-store-screenshot-plan.md):

1. **Any Collection shot showing the sort chip must be retaken.** The chip's label and its
   icon both changed — it now reads an axis name with a direction arrow rather than an order
   name with a two-headed glyph, and *Recently watched* is gone from the menu entirely. A
   screenshot showing the old chip shows a control the shipped app does not have.
2. **The See-all sheet's chip changed the same way** — *Rank · Highest first* is now **Rank**
   with a down arrow. Retake if that sheet appears in any submitted shot.

Take both after applying the `37e8584` OTA, not from an earlier capture.
