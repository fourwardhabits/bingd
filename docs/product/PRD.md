# bingd. — Product Requirements Document

**Version:** v0.6 (public-alpha final)
**Status:** Build-ready for public-alpha architecture
**Date:** 2026-08-12, corrected 2026-08-13 after independent review — see [`change-log-v0.6.md`](./change-log-v0.6.md) §7
**Supersedes:** `Bingd_PRD_v0.5_Finalization_Draft_20260812.pdf`

**Companion documents:** [`decision-log.md`](./decision-log.md) · [`open-questions.md`](./open-questions.md) · [`change-log-v0.6.md`](./change-log-v0.6.md)

---

> **Precedence.** If this document and the decision log disagree, the **decision log wins** and this document must be corrected. If this document and any source PDF in `docs/reference/` disagree, **this document wins**.
>
> **For implementation agents.** Items marked `Open`, `Provisional`, or listed in `open-questions.md` may **not** be resolved by choosing a plausible answer. Stop and ask. Items marked `Required` are not preferences and may not be traded away for simplicity.

---

## Table of contents

| § | Section |
|---|---|
| 1 | [Executive summary](#1-executive-summary) |
| 2 | [Target user and jobs to be done](#2-target-user-and-jobs-to-be-done) |
| 3 | [Product principles](#3-product-principles) |
| 4 | [Reference model and evidence boundary](#4-reference-model-and-evidence-boundary) |
| 5 | [Brand, visual identity, and design direction](#5-brand-visual-identity-and-design-direction) |
| 6 | [Core product loops](#6-core-product-loops) |
| 7 | [Information architecture and navigation](#7-information-architecture-and-navigation) |
| 8 | [Scope by product stage](#8-scope-by-product-stage) |
| 9 | [Key user flows](#9-key-user-flows) |
| 10 | [Ranking system](#10-ranking-system) |
| 11 | [Collection model: Logged and Ranked](#11-collection-model-logged-and-ranked) |
| 12 | [Letterboxd import](#12-letterboxd-import) |
| 13 | [Taste match and recommendations](#13-taste-match-and-recommendations) |
| 14 | [Social interaction: feed, reactions, and tagging](#14-social-interaction-feed-reactions-and-tagging) |
| 15 | [Notifications and activity awareness](#15-notifications-and-activity-awareness) |
| 16 | [Sharing, deep links, and web fallback](#16-sharing-deep-links-and-web-fallback) |
| 17 | [Direct friend invitations](#17-direct-friend-invitations) |
| 18 | [Offline and synchronization behavior](#18-offline-and-synchronization-behavior) |
| 19 | [Media metadata: live, cached, and cost model](#19-media-metadata-live-cached-and-cost-model) |
| 20 | [Capabilities, Early Access, and future monetization](#20-capabilities-early-access-and-future-monetization) |
| 21 | [Future paid-beta payments and entitlements](#21-future-paid-beta-payments-and-entitlements) |
| 22 | [Privacy, safety, and moderation](#22-privacy-safety-and-moderation) |
| 23 | [Data and technical architecture](#23-data-and-technical-architecture) |
| 24 | [Environments, builds, and release model](#24-environments-builds-and-release-model) |
| 25 | [Testing and quality gates](#25-testing-and-quality-gates) |
| 26 | [Acceptance criteria for public alpha](#26-acceptance-criteria-for-public-alpha) |
| 27 | [Public-release requirements](#27-public-release-requirements) |
| 28 | [Success metrics](#28-success-metrics) |
| 29 | [Key risks and mitigations](#29-key-risks-and-mitigations) |
| 30 | [Staged implementation plan](#30-staged-implementation-plan) |
| 31 | [Readiness assessment and go/no-go gates](#31-readiness-assessment-and-gono-go-gates) |
| A | [Founder technical primer](#appendix-a--founder-technical-primer) |
| B | [Source documents and evidence boundary](#appendix-b--source-documents-and-evidence-boundary) |

---

## 1. Executive summary

**bingd.** is a social collection and discovery app for movies and TV seasons. Users record what they have watched, sort it into three broad buckets, and then build an exact personal ordering through head-to-head comparisons. That ordering becomes the data layer for taste matching, people discovery, a social feed, recommendations, and shareable identity.

| Status | Statement |
|---|---|
| **Decided** | The rankable units are movies and TV seasons. Episodes are never ranked. Whole-series ranking is not the primary TV unit. |
| **Decided** | Rating happens in two steps: a three-bucket reaction (**Loved it / It was fine / Not for me**), then pairwise comparison within that bucket. |
| **Decided 2026-08-15 (supersedes the ordinal-only rule)** | The ranking output shown to users is a **0–10 score with one decimal**, derived from the title's position inside its bucket band. The exact ordinal remains the stored ground truth and is shown as secondary detail on a title page. There is still no 0–100 score and no percentile. |
| **Decided** | A title is either **Logged** (watched, optionally bucketed) or **Ranked** (has an exact position from comparisons). Positions are never derived from an imported rating. |
| **Decided** | The product is social: profiles, one-way follows, a chronological feed, people discovery, match scores, recommendations, reactions, watch tagging, outward sharing, and direct invitations. |
| **Decided for public alpha** | Public alpha is free. There is no billing code, no store products, no purchase UI, and nobody is displayed as "Pro". |
| **Required** | Recommendation quality is governed by explicit eligibility, repetition, popularity, diversity, explanation, feedback, and evaluation guardrails. Clicks and global popularity alone do not define quality. |
| **Recommended** | The app is offline-resilient, not offline-first. Own collection is readable offline; a narrow set of writes queue; all ranking mutations require connectivity. |
| **Provisional** | TMDB is the media provider, behind a Bingd-owned adapter and cache. Supabase is the application data layer. |
| **Hard Gate** | An external dependency requiring a manual founder action before the gated activity may proceed — Android developer verification, trademark clearance, the legal pack. |

### Product thesis

People can reliably say which of two films they preferred. They cannot reliably calibrate an abstract star score. Comparison turns watching into a durable, ordered personal collection, and that structured taste data becomes far more useful when it can be matched, followed, recommended from, and shared.

### Value proposition

Keep what you watch. Know what you love. Find what's next.

### Business model

Bingd is intended to become a subscription product. The public alpha is free to build the network. Growth behaviors — ranking, following, sharing, inviting, importing, and core recommendations — remain permanently free, because paywalling them would strangle the network the business depends on. A future Pro bundle serves engaged collectors who want deeper insight, unlimited organization, richer recommendation control, recurring recaps, and enhanced presentation.

---

## 2. Target user and jobs to be done

### Beachhead user — Provisional

A frequent movie and TV watcher who enjoys logging, collecting, ranking, and exploring, without needing to write reviews or identify as a cinephile. They already use Letterboxd, IMDb, a notes app, a watchlist, or informal recommendations from friends, but a fixed five-star scale does not capture a true ordered preference. They are interested in what friends and credible high-volume watchers are seeing, and will follow strangers when taste overlap is high. They enjoy the light game of ranking and the identity of a well-developed collection, and they already share taste in group chats and stories.

### Likely paying user — Provisional

Has built a meaningful collection, roughly 25–50+ ranked titles, and returns to maintain it. Creates multiple lists, compares taste with friends, and wants richer statistics or recaps. Wants recommendations tuned for novelty, obscurity, runtime, era, language, or social source rather than a generic popular-title loop. Should never need to pay merely to rank, follow, receive useful core recommendations, or create a standard share.

### Jobs to be done

| Job | User need |
|---|---|
| Remember | Keep a durable record of what I watched and where it sits relative to everything else. |
| Express taste | Show what I actually prefer without writing a review or calibrating a star rating. |
| Discover people | Find active watchers whose taste is meaningfully similar to mine. |
| Decide what to watch | Get immediate recommendations grounded in compatible human taste. |
| Stay socially current | See what people I follow are watching and ranking. |
| Acknowledge | React to a friend's activity without writing a review. |
| Record who I watched with | Capture the social fact of a viewing, not just the title. |
| Share identity | Send a ranking, list, or milestone in a format that makes sense outside the app. |
| Invite friends | Send a direct invitation carrying my identity, without uploading contacts. |
| Bring my history | Move an existing Letterboxd library in without re-entering it. |
| Use it anywhere | See my collection and capture basic changes when connectivity is weak. |
| Understand my taste | See patterns, eras, genres, and changes without doing the analysis myself. |

---

## 3. Product principles

1. **Comparison over calibration.** Relative choices beat arbitrary numeric self-rating.
2. **Structured signals over writing burden.** Logging and ranking are fast. Long reviews are not the product.
3. **A position must be earned.** An exact ordinal position is only ever produced by comparisons. It is never inferred, estimated, or imported. The displayed score is a function of that position and inherits the same rule.
4. **Taste compatibility must be legible.** Match scores show confidence and overlap rather than pretending sparse data is precise.
5. **The social graph improves recommendations.** Following changes discovery value, not just a follower count.
6. **Movies and TV should feel coherent but not identical.** TV is ranked by season.
7. **Recommendations should feel immediate.** Users see useful suggestions, not an algorithm configuration panel.
8. **Sharing and invitation are product loops, not decorative buttons.** Every share leads somewhere useful.
9. **Use the operating system before custom integrations.** The native share sheet is cheaper, more private, and broader than one-off social SDKs.
10. **Offline behavior is explicit and intentionally narrow.** Queued edits never appear safely stored on the server until sync succeeds.
11. **Cache for speed and resilience, not to build an unlicensed mirror.**
12. **The growth loop stays free.** Ranking, following, sharing, inviting, importing, and core recommendations are never paywalled.
13. **Charge for depth only after the product earns it.** Pro makes an already-useful product richer.
14. **Human-derived recommendations first.** No language model is required for the core engine.
15. **Quality over engagement loops.** Repetition, novelty, diversity, and catalog coverage are first-class outcomes, not click-through alone.
16. **Capabilities before billing.** Screens ask whether a user has a named capability. Store-product logic never leaks into feature code.
17. **Honest state over implied success.** Local save, server sync, share-sheet open, invite acceptance, cached recommendations, and completed purchase are distinct states and are never presented as equivalent.
18. **A large unranked library is a normal state, not a backlog.** The interface never implies the collection is incomplete.
19. **Notifications must earn the interruption.** If there is nothing true to say, send nothing.

---

## 4. Reference model and evidence boundary

### Beli as a product-mechanics reference

Beli is the closest product-mechanics and go-to-market reference: log an experience, comparatively rank it, build a collection, see friend activity, inspect match scores, discover high-activity users, receive recommendations, and share output. Bingd borrows the logic of that flywheel and its approachable consumer posture **without copying Beli's visual identity, copy, proprietary data, or interface**.

Publicly documented Beli mechanics that informed this PRD: three-bucket classification before comparison; binary-search comparison within the chosen classification; skip and back affordances during comparison; tagging friends in a log; match scores between users; separate ranking categories by type.

**Score display — reversed 2026-08-15.** This section previously recorded a deliberate divergence: Beli produces a calibrated 0–10 score, and Bingd would show ordinal position only, on the reasoning that Beli's own store reviews cite the automatic score as a recurring complaint — that it makes places "seem worse than they are, or sometimes better."

The founder has decided Bingd shows a 0–10 score, because an ordinal fails at the thing a collection app is for: `#18 in Movies` is unreadable without knowing how long the list is, it changes for reasons the user did not cause, and it cannot be compared between two people at all. A score answers "how much did I like this" in one glance, which is the question a row in a list is actually being asked.

The complaint in those reviews is real and is answered by construction rather than by omission. It is a complaint about *calibration* — a score that claims to measure the film. Bingd's score claims nothing about the film. It is a restatement of where the title sits among the ones this user has already compared it against, so its meaning is bounded by the user's own list, and §10 keeps it honest: the score is derived from comparisons and from nothing else, never from an imported rating, and it is never aggregated across users into a public average.

Mechanically nothing diverges from what this document already specified. Comparisons still produce a position; the score is a presentation of that position.

### Evidence boundary — Required

> Public Beli materials do not establish what works offline, how conflicts are synchronized, which media provider is used, whether images are cached or rehosted, or what any of it costs. The offline, metadata, and infrastructure requirements in this document are **recommended early-stage architecture, not Beli implementation claims**.
>
> Beli's notification set is **not** systematically documented. Two examples are publicly reported: a friend-ranked-something alert and a someone-you-know-joined alert. The notification design in §15 is derived from Bingd's own event list, not from observed Beli behavior.

### Competitive distinction — working hypothesis

| Existing behavior | Gap Bingd targets |
|---|---|
| Letterboxd and star ratings | Strong logging and social culture, but users self-calibrate against a fixed scale rather than build an explicit total ordering. |
| Pairwise-ranking apps | The mechanic exists; the opportunity is combining it with polished social discovery, match confidence, feed, recommendations, and shareable identity. |
| Streaming recommendations | Opaque and platform-constrained. Bingd can recommend across the catalog with transparent taste similarity and social evidence. |
| Friend recommendations | High trust, unstructured, easily forgotten. Ranking and share data make them persistent. |
| Generic premium tiers | Most subscriptions remove ads or hide basics. Bingd Pro should add ongoing insight, control, and presentation. |

---

## 5. Brand, visual identity, and design direction

### Position and name

**Decided.** bingd. is a social entertainment collection for people who love watching things, not analyzing them. The wordmark is lowercase with a period. The clipped spelling should feel deliberate and adjacent to *binge* without forcing branded verb usage.

### Color system

| Color | Hex | Role |
|---|---|---|
| Paper | `#FBF8F4` | Primary background, from 2026-08-15. A warm near-white: same hue family as Parchment, most of the saturation removed |
| Parchment | `#F5EBDD` | Warm accent surface: grouped wells, inputs, chips, selected tabs, poster placeholders, standard share cards. Was the primary background until 2026-08-15 |
| Bingd Maroon | `#773744` | Primary identity and action: wordmark, selected states, rank emphasis |
| Ink | `#242326` | Primary text and structural contrast |
| Antique Amber | `#D4A64C` | Awards, milestones, reveals, exploration prompts, special share moments |
| Muted Sage | `#92A895` | Completion, watched and progress states, calm utility indicators |
| Midnight | `#19242D` | Reserved. Future dark companion for poster-heavy surfaces. **Not built in v1.** |

### Typography

**DM Serif Display** for the wordmark, display moments, ranking reveals, editorial headers, and high-value share cards. **Inter** for navigation, buttons, metadata, feeds, settings, and functional UI.

### Voice

Primary voice **Curious Collector**: warm, simple, observant, personal, lightly playful. Secondary voice **Playful Explorer**, used only for awards, milestones, notifications, recaps, discovery prompts, and share moments where the product has earned more energy.

| Surface | Preferred | Avoid |
|---|---|---|
| Bucket prompt | "How was it?" | "Rate this film" |
| Comparison | "Which did you like more?" | "Which film is objectively better?" |
| Ranking result | "Where does it land?" / "8.7." | Calibration language, and any claim the number describes the film rather than the user's ordering |
| Match | "92% match · 143 shared" | Similarity coefficients |
| Recommendation | "Try this next." | Algorithm terminology |
| Unranked library | "142 ranked · 380 logged" | "380 remaining", progress bars toward 100% |
| Share prompt | "Share your top 10." | "Spam your friends" |
| Offline state | "Saved on this device. We'll sync when you're online." | Silent failure, or implying server completion |
| Coming soon | "Go deeper into your taste." | Any price, urgency, or implication that payment is available |

### Design direction — Recommended

Derived from the brand system above at founder instruction. See decision log §12.

| Area | Direction |
|---|---|
| Density | Airy on onboarding, comparison, reveal, and share surfaces. Efficient rows on Rankings and Search. |
| Emphasis | Poster-dominant on content surfaces; typographic on reveals, milestones, and share cards. |
| Tone | Restrained by default. Playful only where Antique Amber appears. |
| Data display | Minimal in v1. One modest stats block on Profile. |
| Theme | Light only. **Amended 2026-08-15:** the base surface is Paper `#FBF8F4` and Parchment is the warm accent above it, because Parchment is chromatic and left artwork no headroom on a poster-heavy screen. Tokens structured so a Midnight dark theme is purely additive later. |
| Corner radius | 12px cards, 8px inputs, full-round for avatars only. No pill buttons. |
| Motion | Minimal, with one exception: the ranking reveal earns real animation. |

### Reference discipline — Required

**Apple TV, Apple Wallet, and Open** inform visual and design language. **Beli, Spotify, Cash App, Strava, and Letterboxd** inform interaction flows only; their visual language is explicitly not a model. Reference material lives in a git-ignored `design-references/` directory; only the specific screens being designed against are committed, resized, under `docs/design/references/`.

### Brand production — Required

The twelve existing SVGs match the color system but are **not production-ready**: they use live text with a remote Google Fonts `@import`, which fails silently in an app bundle, a locally rendered share card, and a server-rendered Open Graph image. Before any store submission or share-card work: outline the type, remove the font import, and produce a square icon-safe mark. The two-overlapping-film-frames device is the correct starting point.

### Brand clearance — Hard Gate

Domain secured. Before public launch: App Store and Google Play name availability, plus a knockout trademark search. See `open-questions.md` HG-3.

---

## 6. Core product loops

### A. Ranking loop

1. User searches for a movie or TV series.
2. For TV, the user selects a season. The season is the rankable unit.
3. User marks it watched or completed.
4. User chooses a bucket: **Loved it**, **It was fine**, or **Not for me**.
5. The app asks a small number of pairwise comparisons **against already-ranked titles in that same bucket**.
6. The title is inserted at an exact position and the placement is revealed.
7. The activity becomes eligible for the feed and updates match and recommendation inputs.

> A title may stop at step 4. Bucketing without comparing produces a **Logged** title. See §11.

### B. Social discovery loop

1. User opens People or the leaderboard.
2. The app highlights prolific rankers with match score and overlap count.
3. User opens a high-match profile and inspects top titles, recent activity, and unseen favorites.
4. User follows.
5. Future activity appears in the feed and improves recommendation coverage.

### C. Recommendation loop

1. The system identifies users and titles with meaningful overlap.
2. It combines social similarity, content similarity, bucket signal, freshness, and confidence.
3. It filters out watched, dismissed, repetitive, and overly dominant popular titles.
4. Recommendations appear with concise evidence such as "3 high-match users loved this."
5. Watchlist additions, dismissals, and later rankings feed back in.

### D. Social acknowledgment loop

1. A user ranks a title, completes a milestone, or adds to a list.
2. The activity appears in followers' chronological feeds.
3. A follower reacts.
4. The original user is notified that someone reacted.
5. Recognition drives return visits without requiring anyone to write anything.

### E. Watch-tagging loop

1. While logging a watch, the user taps to tag who they watched with.
2. Tagging is limited to people they follow or who follow them.
3. If the person is not on Bingd, the flow offers **Invite them** and drops into the invitation flow.
4. Tagged users are notified and may remove the tag.
5. The social fact of the viewing is captured, and every movie night becomes an invitation moment.

### F. Outward sharing loop

1. A user reaches a meaningful artifact: a rank, top set, list, profile, or milestone.
2. The app shows a branded preview with a privacy check and optional handle visibility.
3. The native share sheet sends an image, a canonical HTTPS link, or both.
4. The recipient opens the installed app through a verified link, or reaches a useful web page.
5. Bingd measures link opens and downstream activation, never claiming a post was published.

### G. Direct invitation loop

1. User taps Invite Friends from onboarding completion, People, Profile, Settings, or the tagging flow.
2. Bingd creates or reuses the user's personal invitation token and prepares a short branded message plus a canonical link.
3. The user opens the share sheet or copies the link or code.
4. An installed recipient opens an invitation screen. A recipient without the app reaches a lightweight web page with public-safe inviter context, store actions, and the short code.
5. After sign-up, the recipient explicitly accepts, which creates a one-way follow to the inviter.
6. The inviter is notified and prompted to follow back.

### H. Monetization loop — Provisional, not active in v1

1. The user builds a meaningful free collection and experiences real value.
2. The user reaches a context where a Pro capability is relevant.
3. **During public alpha**, a clearly labeled non-paid *Coming soon* note may appear, only after core value and never with a price.
4. **During paid beta only**, the same trigger may open a real contextual paywall.

---

## 7. Information architecture and navigation

### Primary areas

| Area | Purpose | Key elements |
|---|---|---|
| Feed | Social activity and lightweight discovery | Ranks, watches, list adds, milestones; chronological; reactions; tags visible |
| Collection | The user's own working surface | Ranked (Movies / TV Seasons), Logged, Watchlist, Lists; title search in the header |
| **+** (center action) | Log and rank | Search, mark watched, choose bucket, tag people, compare |
| Recommendations | Instant personalized suggestions | Guarded slate, explanations, add to watchlist, dismiss |
| Profile | Public identity and social standing | Basic stats, top of the ranking, match, leaderboard, followers and following, people search, invite entry point, settings |
| Settings | Account, privacy, notifications, offline state | Invite Friends, privacy toggle, notification preferences, data export, cache and sync status, account deletion |

> **Decided 2026-08-13, superseding Provisional INF-4.** Five tabs: **Feed, Collection, +, Recommendations, Profile.** The collection gets a top-level tab rather than sitting inside Profile, because it is the surface a user returns to daily and the artifact the product exists to produce; Profile stays the public-facing identity page. There is no Search tab — searching for a title is how you log one, so the center **+** and title search are the same entry point, with a header affordance on Feed and Collection. People search lives in Profile and the invite flow. Sharing appears contextually on artifacts, never as a tab. Reasoning and evidence in `../design/screens.md` §2.
>
> **Renamed from v0.5.** The area formerly called "Settings / Subscription" is now **Settings**. Plan management and restore are paid-beta-only and do not exist in v1.

---

## 8. Scope by product stage

### Must have for public alpha (v1)

- Account creation and sign-in: email one-time code, **Sign in with Apple (required on iOS)**, and Google.
- TMDB-backed movie, series, and season search and detail through the Bingd backend.
- Watched and completed state, watchlist, and separate Movies and TV Seasons rankings.
- **Three-bucket rating** followed by pairwise comparison within the bucket.
- **Logged and Ranked collection states**, with a quiet path from one to the other.
- **Letterboxd import** from uploaded export files, with matching preview, bucket auto-mapping, and a post-import anchor session.
- User profiles, one-way follow and unfollow, chronological feed, people discovery and leaderboard, match score.
- **Reactions** on feed activity.
- **Watch tagging** of Bingd users, with the invite hand-off for non-users.
- **Notification system**: events, in-app inbox, per-category preferences. Push built and credentialed but **delivery flagged off**.
- Automatic recommendations from collaborative, content, and bucket signals with cold-start fallback and the full guardrail set.
- Custom lists with the **three-list limit enforced**.
- A central capability resolver supporting `base_free` and `alpha_early_access`, with backend enforcement and no billing code.
- Recommendation impression history, feedback events, and quality-guardrail tests.
- Native sharing for title rank, top set, profile, and public list, with canonical links and a working web fallback. **Top 10 is the polished artifact.**
- A dedicated Invite Friends flow with a reusable personal token, short code, deep link, no-app landing page, explicit acceptance, and abuse controls.
- Offline read access to own collection plus the narrow queued-write set.
- Privacy controls, blocking, reporting, and account deletion.
- Separate non-production and production environments, source control, automated checks, product analytics, and crash monitoring.

### Should have for early traction

Shareable match cards, recommendation cards, milestone and recap cards. Full share-to-activation attribution reporting. Public web pages for profiles, lists, and titles. Ranking filters and search within personal rankings. Simple taste statistics and richer recommendation explanations. Friend-activity push notifications. The scheduled nudge, once push delivery is enabled. Metadata-cache dashboards.

### Defined now, activated at paid beta

RevenueCat, real store products, contextual paywalls, purchase, restore, manage plan, webhook entitlement sync, backend enforcement of paid capabilities. Monthly and annual products mapping to one logical Pro bundle.

### Mass market

Final pricing and localization. Staged store rollouts. Destination-specific sharing SDKs only where measured usage justifies them. Distribution scaling gated on Free-tier health.

### Deferred

Comments, DMs, discussion boards, and long-form reviews. Destination-specific social SDKs and inbound share extensions. Contact-book and social-network importing. Full offline-first sync and offline ranking replay. Full catalog mirror or image rehosting. LLM-generated recommendations or explanations. Algorithmic feed ranking, collaborative lists, episode-level ratings, whole-series ranking. Lifetime access, multiple tiers, family plans, gifting, web checkout. Dark mode. Invite rewards. Tagging users who are not on Bingd.

---

## 9. Key user flows

### Onboarding

1. Create an account and choose a username and display name. Date of birth is captured for the 13+ gate.
2. One sentence of explanation: "Keep what you watch. Rank what you love. Find what's next."
3. Seed taste by one of three paths, presented without preference:
   - Tap 8–15 titles you have seen from a guided set of ~40.
   - Search directly.
   - **Import a Letterboxd export.**
4. Run enough comparisons to produce a first ranking and demonstrate the payoff. For import, this is the anchor session in §12.
5. Reveal the first ranking. **Only then** prompt the user to inspect a match, follow someone, or invite a friend.
6. Request notification permission only after the first successful invite or follow — never at first launch.

> **Required.** No Early Access label, *Coming soon* note, or premium message may appear before the first ranking reveal.

### Log and rank a title

1. Search and select. Global search requires connectivity; the cached own collection remains searchable offline.
2. Tap Watched.
3. Choose a bucket: Loved it / It was fine / Not for me.
4. Optionally capture the watch date, a lightweight note, and **who you watched with**.
5. Either compare now, or stop here and leave the title **Logged**.
6. If comparing: a short sequence of comparisons within the bucket, then the placement reveal.
7. Optionally share the placement.

### Log and rank TV

1. Search and select the series.
2. The series page lists seasons with progress.
3. Mark a season *Watching* or *Completed*. Only completed seasons are rankable.
4. Bucket and compare the season against other ranked TV seasons in the same bucket.
5. The series page aggregates progress and all ranked seasons.

### Import from Letterboxd

See §12 for the full specification.

### Invite a friend

1. Tap Invite Friends, or attempt to tag someone who is not on Bingd.
2. Bingd creates or reuses the user's personal invitation token. Creating or refreshing requires connectivity.
3. Preview the message and the public-safe inviter context. Private data is never included.
4. Open the share sheet, or copy the invite link or short code.
5. The recipient opens the installed app or a no-install web page. After account creation they explicitly accept.
6. Acceptance creates a one-way follow to the inviter, or a follow request if the inviter is private.
7. The inviter is notified and prompted to follow back.

### Share a ranking or list

1. Tap Share from a rank result, ranking view, list, or profile.
2. Choose an allowed card format and preview exactly what will leave the app.
3. Confirm privacy: include or hide handle; private notes excluded; sharing blocked when the underlying artifact is private.
4. Bingd renders the card locally and attaches a canonical link when the content is synced and permitted.
5. The share sheet opens.
6. On return, Bingd records that the sheet was opened. It does not claim a post was published.

### Open a shared link

1. Recipient taps a `bingd.app` link.
2. If Bingd is installed, a Universal Link or App Link opens the exact destination.
3. If not, a lightweight web page shows permitted content and store actions.
4. A first-party referral token records the origin without exposing private data.
5. After install, the recipient reopens the link or enters the short code.

---

## 10. Ranking system

### Objective

Produce a stable personal ordering with as few comparisons as practical, while keeping the interaction satisfying rather than computational.

### Two-step rating — Decided

Every rating begins with a bucket.

| Bucket | Band |
|---|---|
| **Loved it** | Top band |
| **It was fine** | Middle band |
| **Not for me** | Bottom band |

**Buckets partition the ranking.** All *Loved it* titles rank above all *It was fine* titles, which rank above all *Not for me* titles. A title cannot cross a band boundary without changing its bucket. Changing a bucket moves the title into the new band and re-runs comparisons there.

This is the mechanism that keeps ranking cheap: comparisons only ever search within one band.

### Insertion — Recommended

- Binary insertion within the chosen bucket: compare against a midpoint title, move higher or lower, repeat.
- A band of *k* ranked titles resolves in at most `ceil(log2(k + 1))` comparisons. **A bucket of 64 needs at most 7; 256 needs at most 9.** *(Corrected 2026-08-13: this read "about 6" and "about 8", which were the figures for bands of 63 and 255. Inserting into a list of k items chooses between k + 1 gaps, not k. AC 26.3.4 already said 7 for a bucket of 64, so the two documents disagreed and the acceptance criterion was the one that was right.)*
- Manual reranking and recalibration remain available later without deleting viewing history.
- **Required:** pairwise insertion, manual reranking, and recalculation all require connectivity. No ranking mutation is ever placed in the offline outbox.

### Uncertainty policy — Decided for public alpha

- **Skip** re-anchors the comparison to a different title in the same bucket.
- **Back** returns to the previous comparison and lets the user change the answer.
- After **3 skips** on a single insertion, the title is placed at the midpoint of the remaining uncertainty range, and the user is told the position is adjustable from Rankings.
- **No ties.** Two titles never share a position. They may round to the same displayed score, which is fine and expected in a long band — but the underlying order is always total, because ties would contaminate match calculation, share cards, and every ranking query.

### Display — Decided 2026-08-15

Show a **0–10 score with one decimal**, for example `8.7`. It is the primary ranking output everywhere a title appears: collection rows, the title page, the feed, the ranking reveal, and share cards.

The score is **derived, not stored**. Each bucket owns a fixed range, and a title's score is its position interpolated across the range of the band it sits in:

| Bucket | Range |
|---|---|
| Loved it | 10.0 → 7.0 |
| It was fine | 6.9 → 3.5 |
| Not for me | 3.4 → 0.0 |

```
score = high - (rankInBand - 1) × (high - low) / max(bandSize - 1, 1)
```

A title alone in its band scores that band's high. Ranges do not overlap, so a bucket can always be read back off a score — which is what makes the number mean the same thing to the person who set it and the friend who sees it in a feed.

Three properties this is required to keep:

- **Comparisons are still the only source.** The score is a function of `rankings.position` and the band sizes, and a position is only ever written by a comparison session (§11). No rating, import, or estimate can produce one.
- **A score moves when the list moves.** Ranking a new title reflows the scores around it, because the number was always a statement about relative position. The interface never presents a score as a fixed property of the film.
- **Scores are never aggregated across users.** There is no public average, no community score, and no per-title score on any surface that is not scoped to one person's list. Averaging would turn a personal ordering into the calibrated rating this product exists to avoid.

> **Required.** Do **not** display a 0–100 score or a percentile anywhere. The exact ordinal remains available as secondary detail on a title page, in the form `#18 of 142 in Movies` — with the denominator, because a bare ordinal is unreadable without it.
>
> **History.** Public alpha was specified as ordinal-only, and this section forbade a 0–10 score outright. Reversed by the founder on 2026-08-15; the reasoning is in §4.

### Open and provisional

| Status | Item |
|---|---|
| Provisional | Whether the three bucket labels read correctly to real users |
| Open | How rewatches and changed opinions trigger recalibration |
| Provisional | Anchor-selection strategy within a bucket |
| Deferred | Offline ranking edits and multi-device ranking conflict resolution |

---

## 11. Collection model: Logged and Ranked

**Decided.** This section is new in v0.6 and resolves the central tension created by importing large libraries.

### The two states

| State | Means | Has a position? |
|---|---|---|
| **Logged** | The user has watched it. It may have a bucket, a watch date, a note, and tags. | No |
| **Ranked** | The user has compared it against other titles in its bucket. | Yes — an exact ordinal position, displayed as a 0–10 score (§10) |

A title moves from Logged to Ranked only by comparison. **There is no other path.**

### Why positions are never inferred

A star rating contains no ordering information. Twelve titles rated 4.0 have no order among themselves. Deriving positions from ratings would:

- Corrupt the match score, which is the product's differentiator. Matching people on fabricated orderings produces fabricated compatibility.
- Arbitrarily choose someone's `#1` from among their highest-rated titles — the single most emotionally loaded slot in the product.
- Put that guess on the Top 10 share card, which is the artifact chosen to optimize for recipient activation.

This is Principle 3 and it is not negotiable.

### What a bucket gives you without a position

A bucket is real partial ordering, not a placeholder. A *Loved it* title is known to rank above everything in *It was fine*. That is directly usable:

- **Recommendations use buckets as preference signal.** A user who imports 400 titles and ranks zero still receives meaningfully personalized recommendations on day one. This is the main reason imported ratings are mapped rather than discarded.
- **Exclusion works regardless of state.** Every Logged title is ineligible for recommendation, ranked or not.
- **Bucket agreement is a candidate match signal.** *Provisional* — not part of the v1 headline match number.

### Display rules — Required

- A Logged title displays its **bucket**, not a position and not `#—`.
- The profile and Rankings header read **"142 ranked · 380 logged"**.
- **Never** show a progress bar toward ranking everything, a "remaining" count, or any copy implying the collection is incomplete. A large Logged library is a normal resting state.

### The path from Logged to Ranked

- A quiet, dismissible card at the top of Rankings offering **"Rank 5 more"** with the count.
- The queue is ordered **highest bucket first**, so the part of the list the user cares about gets built first.
- The card goes quiet once the user has roughly **50 ranked titles**. It remains available but stops prompting.
- Any Logged title can be ranked directly from its detail page, in `ceil(log2(k + 1))` comparisons against its own band — five or six for the band sizes a real collection produces.

### Expected effort — informational

| Outcome | Titles ranked | Comparisons | Realistic time |
|---|---|---|---|
| A real Top 20 | 20 | ~60 | 4–5 minutes, at import |
| A credible Top 50 | 50 | ~230 | A week or two, casually |
| A fully ranked 400-title library | 400 | ~3,450 | Never, and that is correct |

The value of a position decays sharply down the list. Users care intensely about the top 20 and not at all whether a title is `#287` or `#291`. The product is designed around that fact.

### Deferred optimization

Once a user has a ranked spine, a single bonus comparison offered after each new ranking could gradually position imported titles as a by-product of normal use. Noted for post-v1; explicitly out of scope now.

---

## 12. Letterboxd import

**Decided for public alpha.** Ships in v1. Free, permanently.

### Method — Required by policy

User-uploaded export files only. **No scraping, no live account connection, no credential collection.** Letterboxd's terms prohibit unauthorized automated extraction, and its API is not granted for recommendation or data-analysis projects. The user requests their own export from Letterboxd and uploads the ZIP.

### What the export contains

Separate CSV files for watched titles, ratings, diary entries with watch dates, watchlist, reviews, likes, and each custom list. Ratings are 0.5 to 5.0 in half-star steps.

> **Important technical reality.** The CSVs identify films by title, year, and a Letterboxd URL slug — **not** by TMDB ID. Matching is a fuzzy title-plus-year lookup and will produce ambiguous and unmatched rows on any sizable library. This is why the preview step is mandatory rather than optional.

### Flow

1. **Upload.** The user uploads the ZIP. Limits: 5,000 titles, 25 MB. Processing runs as a background job with visible progress.
2. **Preview — Required.** Before any write, show: cleanly matched count, ambiguous rows needing a tap to resolve, unmatched rows, and duplicates of titles already in Bingd.
3. **Bucket mapping.** Star ratings map to buckets automatically. **No cut-line UI.** One summary line: *"We sorted your 320 rated films into Loved it (118), It was fine (140), Not for me (62). Change any of these anytime."*

   | Letterboxd rating | Bucket |
   |---|---|
   | 4.0 – 5.0 | Loved it |
   | 2.5 – 3.5 | It was fine |
   | 0.5 – 2.0 | Not for me |

   Thresholds are **Provisional** and tunable after observing real imports. Every bucket is editable per title afterward.

4. **Unrated watched titles** import as Logged with no bucket, and are bucketed lazily by the user later.
5. **Watchlist** imports directly.
6. **Watch dates** come from the diary. **Rewatch flags are ignored in v1** — the most recent watch date is used.
7. **Lists import in full.** All lists are created regardless of the three-list limit. See the over-limit rule below.
8. **Confirm and write.** Idempotent — the same file can be re-uploaded safely without duplicating records.
9. **Anchor session.** Immediately after the write, run a guided comparison session over roughly 20 titles from the top of the *Loved it* bucket, so the user finishes onboarding with a genuine Top 20. Skippable at any point and resumable later.
10. **Cleanup.** Source files are deleted after processing completes.

### Import and the list limit — Decided

**All lists import. Nothing is ever deleted or hidden because of a limit.** A user who imports 15 lists keeps all 15. They simply cannot create new ones until they are under the limit or hold `unlimited_custom_lists`.

This is a specific application of the universal over-limit rule in §20.

**Required analytics distinction:** record whether each list was imported or created in-app. The "did users reach the three-list ceiling" metric counts **in-app creation only**, so heavy importers do not wash out the monetization signal.

### What import does not do

- It does not produce ranking positions. See §11.
- It does not import reviews as public content. Review text, if imported at all, is private.
- It does not connect to Letterboxd, sync continuously, or store Letterboxd credentials.

---

## 13. Taste match and recommendations

### Match score — Decided for public alpha

Match compares the **relative ordering of titles both users have Ranked**. The user-facing output always pairs compatibility with evidence volume.

| Display | Interpretation |
|---|---|
| `94% match · 8 shared` | Interesting but low confidence; visually downweighted |
| `88% match · 126 shared` | Strong, credible signal |
| `71% match · 410 shared` | High confidence that tastes genuinely diverge |

- Computed on **pairwise-ranked overlap only**. Logged-but-unranked titles do not contribute to the headline number.
- Bucket agreement across Logged overlap is a **Provisional** candidate secondary signal, to be tested after alpha.
- Exact mathematics — rank correlation or pairwise agreement, transformed to 0–100 — is an architecture-stage decision.
- A match involving a private user is only displayed to that user's approved followers.

### Recommendation engine — public-alpha design

- Runs behind the scenes. The Recommendations surface opens directly to useful suggestions.
- **Candidate sources:** compatible users, followed users, title and content similarity, directors, cast, genres, keywords, fresh catalog additions, curated cold-start sets.
- **Signals:** user-match strength, overlap confidence, where the candidate sits in an endorsing user's ranking, independent endorsers, **bucket signal**, content fit, freshness, novelty, calibrated popularity. Weights are tunable and versioned. These are internal scoring inputs and are never displayed as a number to users.
- **Exclusions:** watched, already-seen, dismissed, blocked, unavailable, duplicate, privacy-ineligible. Cooldowns on recently shown and repeatedly ignored titles.
- **Cold start:** provider metadata, onboarding selections, and imported bucket signal until meaningful collaborative overlap exists.
- **Feedback:** *Not interested*, *Already seen*, save to watchlist, and later watch or rank outcomes all feed back.
- **Degradation:** the most recent successful set is served from cache during an outage, always labeled as cached, never implying live recalculation.

### Quality guardrails — Required

These apply identically to Free, Early Access, and any future Pro recommendations. Pro may add controls, history, and richer explanations. It never receives permission to repeat watched titles, invent reasons, or ignore diversity and popularity protections.

| Guardrail | Required behavior | Primary signal |
|---|---|---|
| Eligibility | Remove watched, already-seen, dismissed, blocked, duplicate, unavailable, and privacy-ineligible candidates before ranking | Ineligible-title escape rate |
| Impression history | Log every served title. Cooldown after display, stronger cooldown after repeated non-engagement. Ignored is not a permanent dislike | Repeated-impression rate |
| Popularity balance | Popularity may support cold start but cannot dominate. Include credible long-tail candidates when supply exists | Popularity concentration; long-tail exposure |
| Candidate-source diversity | Draw from compatible users, followed users, content similarity, fresh catalog, and curated sources | Source mix and coverage |
| Slate diversity | No screen dominated by one franchise, creator, genre, era, language, or popularity band unless requested | Slate concentration |
| Exploration | Reserve a small configurable portion for plausible less-obvious candidates | Exploration save/watch/rank rate |
| Explanation integrity | Every "why" comes from actual stored signals. **Never invent social proof, similarity, availability, or certainty** | Explanation audit failures |
| Feedback learning | *Already seen* and *Not interested* act immediately; save, detail view, watch, and later rank are progressively stronger | Feedback-to-slate change |
| Quality evaluation | Optimize for later watch, save, and positive personal rank alongside novelty, diversity, coverage, and low repetition. **Not click-through alone** | Later satisfaction dashboard |
| Graceful degradation | When data is sparse, label the result as popular, content-similar, friend-driven, or curated rather than pretending deep personalization | Reason and source accuracy |

### Delivery pipeline

| Stage | Requirement |
|---|---|
| 1. Candidate generation | Broad set from all named sources |
| 2. Eligibility filter | Remove ineligible titles **before** scoring |
| 3. Scoring | Estimate fit and confidence from social, collaborative, content, bucket, freshness, novelty, and calibrated popularity signals |
| 4. Re-ranking | Apply repetition, diversity, source-mix, franchise, creator, popularity, and exploration constraints to the final slate |
| 5. Explanation | Attach one concise truthful reason generated from stored evidence |
| 6. Delivery and cache | Serve a versioned set with a generation timestamp. Offline and outage views are labeled cached |
| 7. Feedback | Record impressions, already-seen, dismiss, save, click, watched, and later rank |

### Provisional tuning targets

Recently shown titles receive at least a 7-day cooldown. In the first 20 results: at most 2 titles from the same franchise or primary creator; no single primary genre above roughly 40%; the most-popular bucket no more than roughly half; at least 3 distinct candidate-source families when data allows. All configurable and versioned.

### Filtered discovery — separate behavior

Filtered search is intentional exploration, not recommendation. It supports combinations such as "90 minutes or less," "1980s," "Korean thriller," "highly ranked by people I follow," or "available on a selected provider." Global discovery requires connectivity.

---

## 14. Social interaction: feed, reactions, and tagging

**New in v0.6.**

### Feed

Chronological, structured activity from people the user follows. No algorithmic ranking in v1.

**Eligible events:** a title was ranked (with its position), a title was logged with a bucket, a season was completed, a list was created or added to, a milestone was reached, a user joined from an invitation.

**Privacy:** feed events inherit the actor's profile visibility. A private account's activity reaches only approved followers. Blocked users never appear in each other's feeds.

> **Corrected 2026-08-13.** This section said unfollowing "removes future events; it does not retroactively rewrite history the user already saw." That describes an inbox written per follower, and the feed is assembled on read (AD-6), so it was not true of the system being built.
>
> **Unfollowing removes that person's events from your feed entirely, past ones included.** The feed is a live query against your current follow set, not a record of what you have seen. Nothing is deleted, and a re-follow restores visibility. This is also the behaviour a user expects: someone who unfollows wants that person gone, not their last three weeks kept in place.

### Reactions — Decided for public alpha

A fixed reaction set of six on feed activity items. One reaction per user per item, changeable and removable.

**The set — founder decision, 2026-08-13** (supersedes INF-6):

| Stored value | Meaning | Working glyph |
|---|---|---|
| `love` | Loved this | Heart |
| `agree` | Good take | Thumbs up |
| `disagree` | Bad take | Thumbs down |
| `funny` | Funny | Laughing face |
| `wow` | Impressive or surprising | Astonished face |
| `moved` | This moved me | Single tear |

**Values are stored as meanings, not as glyph names.** `agree` rather than `thumbs_up`, for the same reason `taste_bucket` stores `loved` rather than "Loved it". Which symbol renders is a design decision, so swapping a thumb for a flame, or replacing the hands with faces entirely, is a copy change and never a data migration.

**A disagree reaction is included, against the earlier inference.** The reasoning that ruled it out — that a downvote is a pile-on mechanic — holds for a public network of strangers. It does not hold here: arguing about a friend's ranking is the point of the product, and the launch cohort is people who know each other. The pile-on risk lives in the *display*, not in the reaction existing, which is what the rule below addresses.

- **No free text.** This is deliberate: reactions carry zero moderation surface.
- Reacting notifies the activity owner.
- **Display — Required.** An activity item shows the distinct glyphs present and at most two names ("Jerry and Beth"), with a residual count. Press and hold opens the full list grouped by reaction. This keeps the feed uncluttered and is the pattern Messenger uses ([`../design/reference-notes.md`](../design/reference-notes.md)).
- **No reaction is ever aggregated onto a profile.** `disagree` in particular never becomes a running total attached to a person or to their Top 10. It is visible on the activity item it belongs to and nowhere else, which is the difference between banter and a scoreboard.
- Skin-tone variants are **not** in v1. They are a per-reactor rendering preference rather than part of the reaction, so adding one later is an additive profile column and touches no reaction data. See [`open-questions.md`](./open-questions.md) §2.
- Rate-limited to prevent notification flooding.

> **Comments are Deferred.** Comments would make Bingd a public user-generated-content platform, requiring a comment-specific report flow, hide and delete tooling, blocked-user filtering, and a stated response commitment. Reactions deliver the acknowledgment loop — which is what drives return visits — at a small fraction of the cost. Revisit when moderation capacity exists.

### Watch tagging — Decided for public alpha

While logging a watch, the user may tag who they watched with.

| Rule | Behavior |
|---|---|
| Who can be tagged | Bingd users the tagger follows or who follow the tagger |
| Non-users | Not taggable. The flow offers **Invite them** and enters the invitation flow |
| Maximum | 10 tags per watch |
| Effect on the tagged user | **None to their collection.** Tagging does not mark them as having watched anything |
| Notification | The tagged user is notified |
| Removal | The tagged user may remove the tag from their side. This hides the tag; it does not alter the tagger's log |
| Privacy | Tags inherit the tagger's profile visibility. A private account's tags are visible only to approved followers |
| Blocking | A block in either direction makes tagging impossible and hides any existing tag |

The invite hand-off is the point of this feature as a growth mechanism: it places an invitation prompt at the exact moment of social context.

---

## 15. Notifications and activity awareness

**New in v0.6.** This resolves a structural absence in v0.5, where the brand system referenced notifications but no notification feature existed anywhere in scope, information architecture, entities, tests, or metrics.

### Build posture — Decided for public alpha

Build the **entire** system in v1: event generation, in-app inbox, per-category preferences, and a delivery abstraction that can route to inbox, push, or both.

**Push is installed but off.** `expo-notifications` and the Apple and Google push credentials are configured in the **first** development build. Push **delivery** is flagged off at launch.

> **Why this specific arrangement.** Push requires native configuration. If the module is absent when the app reaches the stores, enabling push later requires a new native build *and* a new store submission. With it present from v1, enabling push is a server-side flag plus an over-the-air JavaScript update. This is the difference between "add push next month" being an afternoon and being a release cycle.

### v1 event set

| Event | Inbox | Push (when enabled) |
|---|---|---|
| Someone joined from your invite | Yes | Yes |
| New follower | Yes | Yes |
| Follow request received | Yes | Yes |
| Follow request approved | Yes | No |
| You were tagged in a watch | Yes | Yes |
| Someone reacted to your activity | Yes | Yes |
| A queued change needs attention | Yes | **Never** |

### Deliberately excluded from v1

**Friend-activity notifications** ("someone you follow ranked something"). This is publicly reported as one of Beli's strongest retention notifications and is the obvious early-traction addition. It is held back because the launch cohort is small and concentrated: with 30–60 people all ranking heavily in the same two weeks, it would fire constantly and read as spam.

### Scheduled nudge — Decided, ships with push

Maximum twice weekly. **Friday ~18:30 and Sunday ~16:30, local time.**

**Required: conditional on real content.** The nudge reports something true — "3 films landed in your friends' top 20 this week," or "someone you follow ranked something on your watchlist." **If there is nothing to say, it sends nothing.** A static "come back" reminder is not acceptable; it is the notification most likely to cost the push permission that the invite and tag notifications depend on.

**Evidence note.** The 7–10 PM peak-viewing window is evidenced by Nielsen streaming data. The choice of Friday and Sunday specifically is **inference, not data** — Friday catches the "what are we watching tonight" decision before it is made, Sunday catches weekend planning with an evening left. Both slots sit just ahead of the peak window. Days and times are Provisional and should be revised from open-rate data.

### Preferences — Required

A **Notifications** sub-page under Settings with:

- Per-category toggles for every event class.
- A master **Turn all off**.
- Honest reflection of OS-level permission state. If the operating system permission is denied or revoked, the screen must say so and offer a link to system settings rather than showing enabled toggles that do nothing.

### Permission timing — Recommended

Never request push permission at first launch. Request after the user's first successful invite or first follow, when the value is concrete.

---

## 16. Sharing, deep links, and web fallback

### Objective

Make personal taste legible outside Bingd, convert private enthusiasm into distribution, and give every recipient a useful destination. **Standard sharing is permanently Free.**

### Priority artifact — Decided for public alpha

**The Top 10.** Its card, its `bingd.app/u/<username>/top` web page, and its Open Graph preview are built to a high standard. Other artifacts are functional but basic in v1.

Rationale: a Top 10 is self-explanatory to someone who has never heard of Bingd, it is personal enough to be worth posting, it invites disagreement, and it demonstrates the entire product in one image. A single rank placement generates more share events at a far lower conversion rate.

### Shareable artifacts

| Artifact | v1 output | Visibility and tier |
|---|---|---|
| **Top 10 / Top 5** | Ordered poster set, ranking title, profile link | Free; **polished**; configurable handle visibility |
| Single title placement | Poster, title and year, "#18 in my movies", optional handle, link | Free; owner's data only |
| Public custom list | List title, cover grid, item count, owner, link | Free; list must be Public or Link-accessible |
| Profile snapshot | Top titles, basic stats, profile link | Free; public fields only |
| Friend invitation | Short branded message, optional inviter preview, link, short code | Free; never exposes private data or auto-follows |
| Match card | Match %, shared count, comparison link | **Early traction**; both users' visibility rules apply |
| Milestone / recap | Milestone or period summary | Early traction; basic Free, richer templates Pro |

### Card formats — Decided 2026-08-13

Two canvases, because the destinations are shaped differently. Both are **poster-forward**; posters are what make a shared image stop someone mid-scroll, and TMDB's terms permit them (§19).

| Format | Ratio | Destination |
|---|---|---|
| **Feed card** | 4:5 portrait | Instagram and Facebook feed posts, iMessage, WhatsApp, anywhere an image is attached to a message |
| **Story card** | 9:16 full-bleed | Instagram and Facebook Stories, TikTok, Snapchat, Threads |

The story card is the one users will reach for most, and it needs its own layout rather than a scaled feed card. Two constraints specific to it:

- **Content stays inside the middle 80% vertically.** Every story platform overlays its own chrome at the top and bottom, and a Top 10 whose tenth title sits under a reply bar is a broken card.
- **A 9:16 canvas suits a Top 10 well** — a two-column, five-row poster grid, or a single ordered column. It is a better fit for ten ranked items than a square is.

**Sharing route for v1: the operating system share sheet.** The user taps Share, previews the card, and picks Instagram Stories, TikTok, or anything else themselves. This works from the first build, needs no third-party SDK, and needs no Meta app registration.

**Required native declaration.** Direct "share to Instagram Stories" buttons — which skip the share sheet and open the destination composer straight away — require the destination URL schemes to be declared in the native build (`LSApplicationQueriesSchemes` on iOS, `<queries>` intents on Android). **Those declarations ship in the first development build even though v1 does not use them.** Omitting them means a later addition needs a new binary and a store submission, which is the same trap that AD-10 avoids for push notifications. Direct integration also needs a Meta app ID, which is a deferred external dependency and not required for the share-sheet route.

### Share experience — Required

- Show a preview before the share sheet. Never use a raw screenshot as the default artifact.
- Let the user include or hide their handle and choose from a small set of approved formats.
- Render cards locally to PNG or JPEG so sharing works under weak connectivity.
- Attach a canonical HTTPS link when the content is synced and permitted. Always offer Copy Link.
- Expect destination variation: some apps accept an image, some text and a link, some both. The output must remain understandable if either is stripped.
- Use a text-first branded fallback when artwork is unavailable, uncached, or not contractually permitted.
- Do not require an account to view a public title, list, or basic profile. Require one for follow, save, or match.

### Canonical routes

| Object | Route | No-app web behavior |
|---|---|---|
| Invitation | `https://bingd.app/i/<token>` | Public-safe inviter context, store actions, short code, resume instructions |
| Top set | `https://bingd.app/u/<username>/top` | Ordered public top set with Open Graph preview |
| Profile | `https://bingd.app/u/<username>` | Public top titles, lists, basic profile; private profile returns an access-safe page |
| Title | `https://bingd.app/title/movie/<id>` | Poster, metadata permitted by licence, open-or-install actions |
| List | `https://bingd.app/lists/<id>` | Public or link-accessible list; private or deleted returns unavailable |
| Share artifact | `https://bingd.app/s/<token>` | Stable landing page with Open Graph metadata |

### Token semantics — Required, clarified in v0.6

A share or invite token is a **routing and attribution identifier, never authorization**. Every request re-checks the current visibility of the underlying object.

**Link-accessible** is a named visibility level meaning "any bearer of the link may view this object." When a request arrives, the server still authorizes it — against a visibility level that happens to permit link bearers. The token identifies the object; it does not bypass the check. Changing an object to Private or deleting it invalidates public rendering immediately, and old links return a safe unavailable state.

### Sharing privacy — Required

- Private profiles and private lists cannot produce public web pages.
- Private notes, watch dates, import history, email, account identifiers, tags of private users, and capability state never appear in a share payload.
- The owner controls handle display. A neutral "a Bingd ranking" attribution is available.
- Another user's taste data never appears in a share card unless it is already public and the feature has passed privacy review.
- Artwork in share cards is served from the provider CDN and composited on the user's device under the terms in §19, never rehosted. **Open Graph link previews are typographic in v1 and carry no artwork**, because a server-rendered preview image is served from Bingd's own infrastructure and that is rehosting (§19, item 3).
- Initial public pages are `noindex`.

### Analytics — Required

`share_preview_opened`, `share_sheet_opened`, `share_returned`, `share_link_copied`, `share_link_opened`, `share_app_opened`, `share_install_clicked`, `share_signup_attributed`, `share_activated_attributed`.

> **Measurement rule.** `share_sheet_opened` and `share_returned` are **never** recorded as "share completed." Destination feedback is inconsistent across platforms. The meaningful signals are link opens, app opens, attributed signups, and attributed activation.

---

## 17. Direct friend invitations

**Decided for public alpha.** A dedicated flow, not generic content sharing.

### Entry points

Onboarding completion, People, Profile, Settings, and **the tagging flow when a tagged person is not on Bingd**.

### Token model — Decided, resolves v0.5 ambiguity

**One reusable personal invitation link per user**, plus a matching short code.

| Property | Behavior |
|---|---|
| Form | `https://bingd.app/i/<token>` plus a short human-typable code |
| Reuse | Reusable indefinitely by any number of recipients. This is a personal link, not a per-recipient link |
| Expiry | None by default |
| Revocation | The user may revoke and regenerate from Settings. Revoked links show a safe unavailable state |
| Rate limits | On creation, regeneration, and suspicious open volume |
| Scope | Environment-scoped. A non-production token never resolves in production |

Rationale: a reusable personal link matches how people actually invite — pasted once into a group chat. Per-recipient links give cleaner attribution but require knowing the recipient before generating the link, which conflicts directly with the no-contact-upload, use-the-share-sheet decision.

### Acceptance semantics — Decided, resolves v0.5 ambiguity

v0.5 said "accepts or follows" in three places without ever defining the result. The defined behavior is:

1. The recipient must have an account. Acceptance is an **explicit tap**, never automatic.
2. Acceptance **creates a one-way follow from recipient to inviter**.
3. If the inviter's account is **private**, acceptance creates a **follow request** instead, subject to normal approval.
4. The inviter is then **notified and prompted to follow back**. The inviter is never auto-followed.
5. The recipient's identity is **not revealed to the inviter before acceptance**.
6. An active **block** in either direction voids the invitation entirely.
7. Acceptance also records referral attribution, independent of the follow.

### Recipient paths

| Situation | Behavior |
|---|---|
| App installed, signed in | Verified link opens the invitation screen with inviter context and an explicit Accept action |
| App installed, signed out | Sign-in first, then the invitation screen |
| App installed, different account signed in | Clear disclosure of which account will accept, with an option to switch |
| No app | Lightweight web page: public-safe inviter context, store actions, short code |
| After install | Reopen the same link or enter the short code. **No promise of automatic post-install routing** |

A deferred-deep-link vendor is optional later, only if measured install-to-resume drop-off justifies the cost, SDK, privacy review, and QA burden. It is **not** a v1 dependency.

### Rewards — Decided for public alpha

**No rewards in v1.** Track total invites sent and attributed activations only.

However — **Required** — record `invited_by` and `founding_member` on every account from day one. These cost nothing now and are impossible to reconstruct later, and they preserve the option of granting retroactive recognition or capability grants at any future point.

Any future reward must count **activated** invitees only (recipient ranked at least one title), so it cannot be farmed with throwaway accounts.

### Privacy and abuse — Required

- No address-book permission and no contact upload, at any stage.
- Invitation payloads contain only allowlisted public display name and avatar, or neutral Bingd copy. Email, phone numbers, contacts, private notes, and destination message contents are never stored.
- An invitation never bypasses private-account approval, blocking, or privacy.
- Rate limits on token creation and on suspicious open patterns.
- Block, report, and revocation are all available.
- Revoked, expired, malformed, non-production, and rate-limited tokens all show safe states without leaking private data.

### Analytics

`invite_link_created`, `invite_link_opened`, `invite_install_clicked`, `invite_signup_attributed`, `invite_accepted`, `invite_activated`, `invite_revoked`, plus abuse events. Returning from the share sheet is never treated as delivery.

---

## 18. Offline and synchronization behavior

### Product position — Recommended

Bingd is **offline-resilient**, not offline-first. Users can open the app, see their own collection, and capture a narrow set of low-conflict changes without connectivity. Full offline-first synchronization is deliberately deferred: it introduces conflict resolution, merge semantics, and replay complexity that a pre-product-market-fit app should not carry.

### Capability matrix — Decided for public alpha

| Capability | Offline behavior |
|---|---|
| Own rankings, Movies and TV | **Readable** from device cache |
| Own Logged collection and buckets | **Readable** |
| Own watchlist and lists | **Readable** |
| Own basic profile | **Readable** |
| Recent feed snapshot | **Readable**, labeled as of last sync |
| Recent recommendations snapshot | **Readable**, labeled cached |
| Cached title details and posters | **Readable** for recently viewed titles |
| Mark watched or completed | **Queued** |
| Add or remove from watchlist | **Queued** |
| Add or remove from a list | **Queued** |
| Note drafts | **Queued**, never silently overwritten |
| Bucket an **unranked** title | **Queued** |
| Remove an **unranked** title from the collection | **Queued** |
| **Any ranking mutation** | **Online only** — insertion, comparison, manual move, recalculation |
| Bucket assignment that triggers comparison | Online only |
| **Change the bucket of a ranked title** | **Online only.** It moves the title into another band and renumbers, which is a ranking mutation |
| **Remove a ranked title from the collection** | **Online only.** It deletes a position and closes the gap, which is a ranking mutation — and queuing it would discard ranking work silently on reconnect |
| Global search and discovery | Online only |
| Follow, unfollow, approve request | Online only |
| Block and report | Online only, hidden locally on tap, submitted when connected |
| Reactions | Online only |
| Tagging | Online only |
| Invitation token creation and acceptance | Online only |
| Letterboxd import | Online only |
| Live match and recommendation calculation | Online only |
| Account deletion | Online only |

> **Required.** Ranking mutations are never queued. Ranking is a global ordering; replaying stale insertions against a changed ordering produces incoherent results. Comparison also requires anchor titles the client may not hold.
>
> **Required, added 2026-08-13.** Four rows above split on whether the title is **ranked**, because two operations that are perfectly safe to queue for a Logged title are ranking mutations for a Ranked one. Bucketing a ranked title moves it between bands; removing a ranked title deletes a position and closes the gap. Both were queueable without restriction, which put a ranking mutation in the outbox by a route the "no ranking mutation is ever queued" rule did not visibly cover. **Whether an operation may be queued depends on the state of the row, not only on the operation.** Both now refuse a ranked title, and the client offers the online-only path instead.
>
> **Required.** Block and report are never placed in the outbox. Both are safety actions where a stale queued state is dangerous. The user sees the effect locally on tap, but the action is submitted only when connected.

### Outbox model — Recommended

- A durable local queue of small, explicit, **idempotent** operations, each carrying a client-generated `operation_id`.
- Automatic retry with backoff on reconnect, and a visible manual retry.
- Distinct, honest UI states: `Saved on this device` → `Syncing` → `Synced` → `Needs attention`.
- **Required:** local save is never presented as server confirmation.
- Failures surface in Settings with a plain-language explanation and a retry action, and generate an inbox notification. They never generate a push.

### Conflict rules — Recommended

- Membership-style writes (watchlist, list membership, watched state): latest valid operation wins.
- Note drafts: never silently overwritten. Divergence is surfaced to the user.
- Entitlements, privacy state, moderation state, and ranking order: **the server is always authoritative.**
- Operations for deleted or newly inaccessible objects fail safely and inform the user.

### Device cache retention — Provisional

Own collection, rankings, buckets, watchlist, and lists persist until logout. Recent feed: 100 items or 30 days. Recommendations: 50 items plus a generation timestamp. Visited profiles and lists: LRU, roughly 20–50 objects. Images: bounded LRU disk cache.

> **Conflict resolved 2026-08-13.** "Persist until logout" conflicted with TMDB's six-month restriction on retaining TMDB-derived data. Resolved by complying rather than seeking an exception: **Bingd's own data — positions, buckets, list membership, notes — persists without limit.** The TMDB-derived title metadata attached to it carries a fetch timestamp and refreshes on a rolling basis inside six months, or reduces to a TMDB identifier and re-fetches on demand. The client stores the two separately for exactly this reason. See §19.

### Offline sharing

Locally rendered cards remain shareable offline. Canonical links attach only when the underlying content is synced and permitted; otherwise the card is shared without a link and the user is told why. Invitation tokens cannot be created offline; a previously issued personal link may be re-shared from cache.

---

## 19. Media metadata: live, cached, and cost model

### Canonical source — Provisional

**TMDB**, accessed exclusively through a Bingd-owned adapter and normalized into a Bingd schema. Every internal reference uses Bingd identifiers so the provider can be replaced without rewriting the product.

**Required:** no provider credential ever ships inside the mobile app. All provider calls originate from the backend.

### Licensing — Required, no longer a Hard Gate

**Revised 2026-08-13 after research.** This was recorded as a Hard Gate on the assumption that commercial access needed a negotiated agreement with weeks of latency. It does not.

Bingd connects now on a **free developer key**, because it charges nobody and sells nothing, which is non-commercial under TMDB's operative test. When subscriptions ship, the commercial plan is a **self-serve purchase** — reported by TMDB staff at $149/month under $1M revenue — bought before the first payment lands. No correspondence is required in either direction.

**Required regardless:**

1. **Attribution.** The exact notice "This product uses the TMDB API but is not endorsed or certified by TMDB," an approved TMDB logo kept less prominent than Bingd's own mark, placed in an About or Credits section. Built into the first screens, not retrofitted.
2. **Cache TMDB-derived metadata for under six months**, refreshing on a rolling basis. Bingd's own collection data is retained without limit. This is the conservative reading of the terms and it removes the §18 conflict rather than needing it resolved.
3. **Artwork is served from the TMDB CDN, never rehosted on Bingd infrastructure.** Poster use inside the app is unambiguous under the terms and is central to the design. A text-only share layout exists for titles with no artwork, which is a product requirement rather than a licensing one.
4. **Provider-derived metadata is refreshed on a schedule, not only on access.** Title, overview, poster path, and genres sit in `media_items` and were the one place with no expiry — a title in someone's ranking and untouched for seven months would have been retained provider data with nothing to find it. A scheduled job refreshes referenced rows past 150 days and prunes unreferenced ones. **Its provider quota cost scales with total distinct titles the user base has ever touched**, which is a different curve from the cost model below and needs its own line in cost monitoring.

> **Corrected 2026-08-13, under the approved gate change.** Item 3 previously added that "poster-bearing share cards and link previews follow standard practice in the category," which contradicted the sentence in front of it.
>
> The two share paths are not equivalent. An **on-device share card** fetches artwork from the provider CDN and composites it on the user's phone, then the user shares the result — no Bingd server touches the image, and this stays poster-forward as designed. An **Open Graph link preview** is a PNG generated by Bingd's server and served from Bingd's infrastructure to any crawler that requests it, indefinitely, with no user involved. That is rehosting, whatever the surrounding layout does, so "never rehosted" and "poster-bearing link previews" could not both hold.
>
> **v1 Open Graph cards are typographic** — score, title, wordmark, no artwork. The cost is small and arguably negative: the poster is the one element every competitor's preview also has. Revisit once the commercial plan is active and the question has a definite answer.

Details and the triggers for revisiting: [`docs/reference/tmdb-integration.md`](../reference/tmdb-integration.md).

### Access pattern — Recommended

Live-plus-cache through the backend. **Never** a direct per-screen provider call from the client, and **never** a full catalog mirror.

| Data | TTL — Provisional |
|---|---|
| Search results | Minutes to hours |
| Core title metadata | Days to weeks |
| Credits, keywords, similarity inputs | Weeks |
| Availability and provider data | Hours |
| Trending and popular | Hours |
| Artwork paths | Long-lived, subject to licence |

Cache entries carry a source, fetch timestamp, and version so anything can be invalidated after a licensing or schema change. Refresh is staggered to avoid coordinated expiry. Only titles that users actually touch are cached.

### Image delivery — Provisional, licence-gated

Provider CDN with size variants and a bounded device cache. **No rehosting** on Bingd infrastructure. A text-first branded share layout must always exist for titles the catalog has no artwork for, which is common after a Letterboxd import.

### Cost model and failure behavior

Costs scale with unique titles touched, refresh frequency, image traffic, and social amplification, **not** with total catalog size. Required protections: per-user and global rate limits, request coalescing, backoff, and abuse detection on public routes.

On provider failure: serve cached data with an honest staleness indicator, degrade non-critical enrichment first, protect core collection and ranking reads, and never block a user from viewing their own collection.

---

## 20. Capabilities, Early Access, and future monetization

### Objectives

Ship a genuinely free public alpha; build the capability system now so premium features can be added later without rewriting feature code; measure interest without taking money; keep growth loops permanently free.

### Capability model — Decided for public alpha

Feature screens ask **"does this user hold capability X?"** They never ask about plans, products, or purchases.

| Access source | v1 | Meaning |
|---|---|---|
| `base_free` | **Implemented** | Everyone |
| `alpha_early_access` | **Implemented** | Time-boxed grant to selected testers |
| `paid_entitlement` | Defined only | Paid beta |
| `promotional_grant` | Defined only | Later |
| `founding_member` | **Recorded, confers nothing yet** | Accounts created before paid beta |

**Required:** every Early Access grant carries an expiry timestamp so it cannot silently become permanent. Grants are environment-scoped, auditable, and revocable. **All capability checks are enforced on the backend.** Client-side checks are presentation only.

### The universal over-limit rule — Required

> When a user lacks or loses a capability that governs a limit, **existing data is never deleted, hidden, or degraded. It becomes read-only.** No new items may be created until the user is under the limit or holds the capability.

This governs every current and future limit, and it is the answer to "what happens to alpha users with 15 lists when subscriptions launch." They keep all 15. They simply cannot create a sixteenth.

### Tier matrix — Provisional, nothing purchasable in v1

| Area | Free — permanent | Early Access — v1, no payment | Future Pro — paid beta |
|---|---|---|---|
| Ranking and collection | Unlimited | Same | Same |
| Following and feed | Unlimited | Same | Same |
| Match scores | Yes | Same | Same |
| Core recommendations | Yes, fully guarded | Same | Same, plus controls and history |
| **Standard sharing and invitations** | **Yes, permanently free** | Same | Same, plus enhanced templates |
| Letterboxd import | Yes | Same | Same |
| Reactions and tagging | Yes | Same | Same |
| Custom lists | **3** | **3** | Unlimited |
| Taste statistics | Basic | Basic | Advanced |
| Recommendation control | Standard | Standard | Tunable |
| Recaps | None | None | Recurring |
| Card templates | Standard | Standard | Enhanced |

> **Resolves a v0.5 contradiction.** v0.5 simultaneously deferred lists past public alpha and listed unlimited lists as a v1 Early Access capability. **Lists ship in v1 with the three-list limit enforced for everyone.** `unlimited_custom_lists` is defined but not granted. Granting it in alpha would remove the only observable signal about whether the limit motivates upgrade.

> **Clarified 2026-08-13.** Read down the Free and Early Access columns: they are identical in every row. That is correct and intended — but it means **`alpha_early_access` confers no benefit in v1.** It is a resolver path with a live grant behind it and nothing on the other side, kept so that granting a real capability later exercises code that has already run in production rather than code written for the occasion.
>
> Stated plainly because two things downstream assumed otherwise. AC 26.11.2 tests that the capability "resolves correctly," which is a test of the mechanism and not of any user-visible difference, and §28's *"Early Access engagement vs. control"* metric was unmeasurable as written — there is no treatment to compare against a control. That metric is removed; **gate-hit data is the monetization evidence for the alpha**, and it is better evidence, because a gate hit is someone wanting a thing they cannot have rather than someone using a thing they were given.
>
> Deliberately not fixed by giving Early Access a real benefit. A two-tier tester cohort in a 30–60 person alpha splits an already-small sample and contaminates the gate-hit signal that the paid-beta decision actually rests on.

### Alpha intent surfaces — Required constraints

- Nothing is purchasable. No RevenueCat, no store products, no price display, no purchase, restore, renewal, or manage-plan UI.
- **Nobody is shown as "Pro."** No Pro badge, no plan row, no "you are on the free plan" language.
- One shared **gate component** and one **upgrade-prompt surface**. In v1 the prompt renders a non-paid *Coming soon* note. In paid beta the same call site renders a real paywall. **Feature screens do not change between those two states.**
- Intent surfaces never appear before the first ranking reveal, and never imply that payment is currently possible.
- **Required analytics:** every gate hit is recorded with the capability name, the screen, and the user's collection size. This is the primary evidence for what to actually charge for.
- No urgency, countdowns, or scarcity language.

### Pricing hypothesis — Provisional, not shown to users

$4.99/month and $39.99/year US placeholders. One logical Pro bundle. No free trial initially. Lifetime access is **Deferred** and must never be promised to alpha testers.

---

## 21. Future paid-beta payments and entitlements

Defined now so v1 does not paint the product into a corner. **None of this is built in public alpha.**

### Architecture — Recommended

- **RevenueCat** as the subscription abstraction over App Store and Play Billing.
- Purchases occur through native in-app purchase only. **No Stripe or card form inside the app for digital features** — this is a platform policy constraint, not a preference.
- Server-side webhook receipt, verification, and persistence. **The client never grants access.**
- Entitlement is translated into the same named capabilities the app already uses, so feature code is unchanged.

### Purchase flow

Contextual paywall → native purchase sheet → store confirmation → webhook → entitlement stored → capabilities recomputed → gated features unlock → honest confirmation.

### Subscription states — Required

Active, in grace period, in billing retry, expired, refunded, revoked, and paused must each map to explicit capability behavior. Losing entitlement follows the **universal over-limit rule** in §20: nothing is deleted, everything becomes read-only.

### Required flows

Purchase, **Restore Purchases** (required by Apple), upgrade and downgrade between monthly and annual, cancellation, refund and revocation, grace period and retry, and a manage-plan route to the platform's own subscription management. Purchases are online-only; entitlement is cached for a bounded period with an offline grace window, and never extended indefinitely.

---

## 22. Privacy, safety, and moderation

**New as a consolidated section in v0.6.** Previously scattered across §12, §17, and §24 of v0.5, with the default left Open.

### Default visibility — Decided

**Public by default**, with a Private toggle in Settings.

Rationale: a social discovery product whose core loops are leaderboards, match scores, people discovery, and outward sharing does not function if most accounts start invisible. Private-by-default would make the network appear empty to every new user, which is the fastest way to kill an early cohort.

| Always public (public accounts) | Always private (all accounts) |
|---|---|
| Display name, username, avatar | Watch dates |
| Top titles and rankings | Notes |
| **The Logged collection and its buckets** | Watchlist |
| Public lists | Import history |
| Feed activity | Email and account identifiers |
| Reactions given | Capability and Early Access state |

> **Founder decision, 2026-08-13.** The **Logged collection inherits profile visibility**, exactly as rankings do. The collection is part of the profile and follows the same rules; it is not a separate privacy domain. This table previously listed neither state for it, so the behaviour was going to be decided by whoever wrote the view.
>
> Three boundaries this does **not** move, all of which stay as they are:
>
> - **Notes and watch dates remain always-private**, even on a public profile and even on a title whose bucket is public. A visible Logged entry is the title and the bucket, nothing else.
> - **The watchlist remains always-private at every visibility level.** It is intent about things you have not watched, which is a different disclosure from a reaction to something you have — closer to a search history than to an opinion. Say so if you want it public; it is a one-line change and a separate decision.
> - **A private profile's Logged collection is visible to approved followers only**, on the same terms as its rankings.

Rationale, and the reason this needed deciding rather than defaulting: a public Logged collection is what makes a profile worth visiting before someone has ranked much. A new user with 200 imported titles and 12 ranked ones has a profile that is mostly empty if only rankings show, which is the same cold-start problem private-by-default would have caused, applied to the individual profile instead of the network.

### Follow model

Instant follow for public accounts. Private accounts require approval. Switching from public to private does **not** retroactively remove existing followers; it gates new ones. Users can remove followers explicitly.

### Blocking — Required

A block is symmetric in effect and takes effect immediately:

- Removes existing follows in **both** directions.
- Hides each user from the other's feed, leaderboard, people discovery, and match surfaces.
- Voids any pending invitation between them.
- Prevents tagging in either direction and hides existing tags.
- Blocks access to each other's public web pages.
- Is online-only, hidden locally on tap, submitted when connected. **Never queued.**

### Reporting — Required

A report flow with a defined reason taxonomy, covering profiles, lists, list titles, usernames, tags, and reactions. Reports are triaged through a documented process with a stated response commitment, both written before public release.

Bingd carries user-generated content — usernames, display names, list titles, tags — which triggers platform obligations for content filtering, reporting, blocking, and published contact information regardless of the absence of comments.

### Minimum age — Required

**13+.** Date-of-birth gate at signup. No accounts below 13, and no COPPA compliance program in scope.

### Username policy — Decided for public alpha (inferred)

One change per 30 days. The previous username redirects for 90 days, then releases. A released username can never be instantly reused, because share and invite routes depend on `bingd.app/u/<username>` and instant reuse is an impersonation vector. See INF-2.

### Account deletion — Required

A user-initiated deletion path that removes personal data, invalidates tokens, removes public web pages, and is reachable from Settings without contacting support.

---

## 23. Data and technical architecture

### Stack — Recommended

| Layer | Choice |
|---|---|
| Client | Expo, React Native, TypeScript |
| Development client | Expo development build with `expo-dev-client` |
| Backend | Supabase — Postgres, Auth, Edge Functions, Storage |
| Media metadata | TMDB via a Bingd-owned adapter and cache |
| Notifications | `expo-notifications`, delivery behind a feature flag |
| Payments | RevenueCat — **paid beta only** |
| Crash monitoring | Sentry, with release tagging and source maps |
| Analytics | First-party event schema; PostHog is the working recommendation |
| Web surfaces | Static or edge-rendered pages on `bingd.app`; Cloudflare Pages is the working recommendation |
| Source control and CI | GitHub with required checks |
| Builds and OTA | EAS Build, EAS Submit, EAS Update |

### Authentication — Required

Email one-time code, **Sign in with Apple**, and Google. Every account resolves to one stable internal user UUID that is independent of the sign-in method.

> **Sign in with Apple is required on iOS, not optional.** Apple's guidelines require it wherever a third-party social login is offered, and Google sign-in is in scope. v0.5 listed it as "recommended"; that is corrected.

### Core entities

`users` · `profiles` (including `status`) · `username_history` · `follows` (including request state) · `blocks` · `reports` · `moderation_actions` · `titles` · `seasons` · `title_cache` · `user_titles` (watched, bucket, state, dates, notes) · `rankings` (per user, per category, ordinal) · `comparisons` · `watch_tags` · `lists` · `list_items` (with `source: imported | in_app`) · `feed_events` · `reactions` · `notifications` · `notification_preferences` · `device_tokens` · `recommendations` · `recommendation_impressions` · `recommendation_feedback` · `match_scores` · `share_tokens` · `invite_tokens` · `invite_attributions` · `import_jobs` · `import_rows` · `capabilities` · `capability_grants` · `outbox_operations` · `analytics_events`

Recorded on every account from day one: `invited_by`, `founding_member`.

### Security and data constraints — Required

- Row Level Security on every user-owned table. Default deny.
- All capability, privacy, and moderation checks enforced server-side.
- No provider or service credential in the client bundle.
- Share and invite tokens are routing identifiers only; every request re-authorizes against current object visibility.
- Analytics events carry no private content — no note text, no watch dates, no email.
- All destructive or schema-changing operations run as reviewed migrations, never as ad-hoc production edits.

---

## 24. Environments, builds, and release model

### One codebase, three variants

| Variant | Bundle ID | Backend | Purpose |
|---|---|---|---|
| Development | `app.bingd.dev` | `bingd-nonprod` | Daily work on a physical device |
| Preview | `app.bingd.preview` | `bingd-nonprod` | TestFlight and Play internal testing |
| Production | `app.bingd` | `bingd-production` | Public alpha |

All three are installable side by side and **visibly distinct** — name, icon, and an on-screen environment indicator on non-production builds.

> **Bundle identifiers are effectively permanent after store submission.** `app.bingd` is reverse-DNS of the owned domain.

### Build and update model

- A **development build** is a private app containing the native modules the project needs. Required because the project uses `expo-notifications`, Sign in with Apple, and Google sign-in, which Expo Go cannot host.
- **Required:** `expo-notifications` and the Apple and Google push credentials are present in the **first** development build, even though delivery is flagged off. Adding them later forces a new native build and a new store submission.
- **EAS Update** ships JavaScript and asset changes over the air without a store submission. Native changes — new native modules, permissions, icons, splash, or SDK upgrades — always require a new build.
- Every build is traceable to an exact commit. Sentry releases are tagged accordingly.

### Auto-update behavior — founder requirement

The founder's prior distribution used manually installed APKs. That ends here. TestFlight and Play internal testing both notify and update testers automatically, and EAS Update pushes JavaScript changes without any tester action. Testers should never sideload a file again.

### Git and release path

- One coherent change, one branch, one pull request. A release may contain many merged pull requests.
- `main` is protected. Automated checks must pass. No direct pushes.

**Sensitive surfaces** are authentication, row-level security, payments, sharing, invitations, offline sync, database migrations, and moderation.

- **Required:** a change touching a sensitive surface gets an independent review by a fresh agent or conversation before merge. **The implementing agent must request that review itself** rather than wait to be asked, and may never review its own work.
- **Reviewer selection:** the latest Fable for foundational or architectural changes; the latest Codex for feature-specific or contained ones.
- **A reviewing agent reviews. It does not patch.** A reviewer that writes the fix becomes an author, and its fix then has no independent review — which defeats the rule. Findings come back as a report; the implementing agent applies them.
- **An agent may merge** documentation and non-sensitive code, and may merge a sensitive change once an independent review has passed — **in every case only after asking the founder.**
- **Required:** no agent may deploy, run a production migration, delete production data, configure payment products, or access production secrets. There is no approval path for these; they are the founder's alone.

---

## 25. Testing and quality gates

### Layers

Typecheck and lint on every change. Unit tests for ranking insertion, bucket-band logic, match calculation, capability resolution, outbox idempotency, and import mapping. Integration tests for auth, RLS, sharing, invitations, notifications, and sync. End-to-end tests for onboarding, log-and-rank, import, invite, and share. Manual QA on the release checklist. Post-release monitoring in Sentry and analytics.

### Required test matrices

**Ranking:** insertion correctness within a bucket; band partitioning is never violated; bucket change re-runs comparisons in the new band; skip re-anchors; 3 skips places at midpoint; back restores prior state; no two titles ever share a position; no ranking mutation is ever enqueued offline; **no 0–100 or percentile value is rendered anywhere**; **the derived score is within its bucket's range for every band size including one, and the ranges never overlap**.

**Collection state:** a Logged title never displays a position; a bucket alone never produces a position; the header reports ranked and logged counts; no progress-toward-complete UI exists.

**Import:** ambiguous and unmatched rows surface in the preview; star-to-bucket mapping matches the table in §12; unrated titles import unbucketed; re-uploading the same file creates no duplicates; **all lists import regardless of the limit**; imported lists are marked `source: imported`; the anchor session is skippable and resumable; source files are deleted after processing.

**Recommendations:** every guardrail in §13 has a corresponding test. Specifically: no watched or dismissed title is ever served; cooldowns hold; slate diversity and popularity caps hold; **every explanation is reproducible from stored signals**; cached results are labeled; sparse-data results are labeled by their actual source.

**Capabilities:** backend enforcement cannot be bypassed by a modified client; the three-list limit holds; **losing a capability makes data read-only and never deletes it**; Early Access grants expire; no purchase, price, restore, or plan UI exists anywhere in the v1 build; no user is displayed as Pro.

**Invitations:** acceptance requires an explicit tap; acceptance creates a one-way recipient→inviter follow; a private inviter yields a follow request; the inviter is prompted, never auto-followed; recipient identity is hidden before acceptance; a block voids the invitation; revoked, expired, malformed, cross-environment, and rate-limited tokens all show safe states; a token never grants access to private data.

**Sharing:** previews match output; private artifacts cannot produce public pages; private fields never appear in payloads; links resolve correctly installed and uninstalled; deleted and newly private objects return safe unavailable states; `share_sheet_opened` is never recorded as a completed post.

**Notifications:** each v1 event generates exactly one inbox item; per-category preferences suppress correctly; the master off switch suppresses everything; the preference screen reflects denied OS permission honestly; **the conditional nudge sends nothing when there is no qualifying content**; sync-failure notices never push.

**Privacy and safety:** RLS denies by default; a block removes follows in both directions and hides all surfaces; block and report are never enqueued; private accounts are absent from public web pages; the 13+ gate cannot be bypassed; account deletion removes data and invalidates tokens; **a public profile's Logged collection is readable by others while its notes, watch dates, and watchlist are not**; **every view is read from a second user's session and returns exactly what a direct table query would**; a suspended account is invisible everywhere and cannot write; a deleted account's username cannot be re-registered.

**Authentication:** the [`../architecture/auth.md`](../architecture/auth.md) §7 matrix in full. The load-bearing case is a second sign-in method carrying an **unverified** email that matches an existing account — it must be refused, never linked. That is the only test in the suite that fails *open*: a wrong implementation looks entirely correct from the outside, because the user does reach an account.

**Offline and sync:** every row of the §18 matrix is tested in both directions; duplicate `operation_id` values are idempotent; UI states are honest; failures surface with retry; **`set_bucket` and `unlog` against a ranked title are refused in both connectivity states**, since either one queued would be a ranking mutation in the outbox; a queued note edit whose base version is stale surfaces both texts rather than overwriting, tested with a genuine second-device edit between queue and drain.

**Metadata:** no provider credential exists in the client bundle; TTLs behave; degraded mode serves labeled stale data; core collection reads never fail because of a provider outage; **provider-derived rows past the retention window are found and refreshed even when nobody has opened them**; Open Graph images render with embedded fonts and contain no artwork.

### Release gate

No release ships with a known crash-rate regression, a failed privacy or capability test, an unlabeled cached recommendation surface, a broken invitation or share route, a rendering regression on the Top 10 card, or an unresolved sync-failure path.

---

## 26. Acceptance criteria for public alpha

**New in v0.6.** v0.5 contained no acceptance criteria. Every must-have feature in §8 is covered. Each item is objectively verifiable — an implementation is either done or not.

### 26.1 Authentication and account

1. A new user can create an account by email one-time code, Sign in with Apple, or Google, and reach onboarding.
2. Sign in with Apple is present and functional on iOS.
3. All three methods resolve to one stable internal user UUID; signing in again by **the same** method reaches the same account.
4. A second method whose email the provider asserts as **verified** links to the existing account and resolves to the same UUID. A second method whose email is **unverified** is refused, and the refusal names the method the account already has. *(Amended 2026-08-13. Criterion 3 originally read "signing in again by any method reaches the same account," which is only safely achievable for verified emails — linking on an unverified address is an account-takeover vector. See [`../architecture/auth.md`](../architecture/auth.md) §2.)*
5. A signed-in user can add a second sign-in method from Settings, which is the only path available to an Apple private-relay account.
6. Sign in with Apple using **Hide My Email** works on first and subsequent authorizations, and the display name captured at first authorization survives.
7. A date of birth is captured and accounts under 13 are refused, with both the profile attempt and the auth record deleted.
8. A session authenticated but abandoned mid-onboarding returns to onboarding on reopen, not to an empty profile.
9. A username and display name are set during onboarding, with uniqueness enforced and conflicts explained.
10. A user can delete their account from Settings without contacting support, and afterward their public web pages and tokens no longer resolve.
11. **A deleted account's username cannot be claimed by anyone afterward**, and any invite attribution naming that account as inviter survives the deletion without its identity.
12. Signing out clears the local cache and any queued writes.

### 26.2 Search, titles, and seasons

1. A signed-in user can search movies and TV series online and open a detail page with poster, year, and summary.
2. A series page lists seasons, and a season can be marked *Watching* or *Completed*.
3. Only completed seasons can be bucketed and ranked.
4. Episodes are not rankable anywhere in the product.
5. With no connectivity, global search is disabled with an explanation, and the user's own collection remains searchable.
6. No TMDB credential is present in the client bundle.

### 26.3 Three-bucket rating and ranking

1. Marking a title watched offers exactly three buckets: Loved it, It was fine, Not for me.
2. Choosing a bucket with no prior ranked titles in that bucket places the title without comparisons.
3. Choosing a bucket with existing ranked titles runs pairwise comparisons **only against titles in the same bucket**.
4. A bucket of 64 ranked titles resolves in at most 7 comparisons.
5. On completion, the app reveals a 0–10 score with one decimal, derived from the title's position within its bucket band per §10.
6. No 0–100 score or percentile is rendered on any screen or share artifact. No score is ever aggregated across users.
7. Every *Loved it* title ranks above every *It was fine* title, which ranks above every *Not for me* title, at all times.
8. Changing a title's bucket moves it into the new band and re-runs comparisons there.
9. Skip re-anchors to a different title in the same bucket; Back returns to the previous comparison and permits a changed answer.
10. After 3 skips in one insertion, the title is placed at the midpoint of the remaining range and the user is told the position is adjustable.
11. No two titles in the same category ever hold the same position.
12. Movies and TV Seasons maintain separate orderings.
13. A user can manually move a ranked title within its band from the Rankings screen.
14. With no connectivity, every ranking action is unavailable with a clear explanation, and none is enqueued.

### 26.4 Logged and Ranked states

1. A title can be marked watched and bucketed without running any comparison, and is then displayed as Logged.
2. A Logged title displays no score and no position. Where a score would sit it shows an empty, clearly unfilled affordance labelled with the action that would earn one — never `0.0`, `#—`, or a greyed-out number.
3. The Rankings header reports both counts in the form `142 ranked · 380 logged`.
4. No screen displays a progress bar, percentage, or "remaining" count toward ranking the full collection.
5. A Logged title can be ranked from its detail page, and afterward has a position.
6. A dismissible "Rank 5 more" card appears on Rankings when unranked titles exist, draws from the highest bucket first, and stops appearing once the user has ~50 ranked titles.

### 26.5 Letterboxd import

1. A user can upload a Letterboxd export ZIP from onboarding and from Settings.
2. Files above 5,000 titles or 25 MB are refused with a clear message.
3. Processing runs in the background with visible progress, and the user can leave the screen.
4. Before any data is written, a preview shows matched, ambiguous, unmatched, and duplicate counts.
5. Ambiguous rows can be resolved or skipped individually.
6. Star ratings map to buckets per the §12 table, and a single summary line states the resulting counts.
7. No cut-line or threshold-selection UI is presented.
8. Every imported bucket can be changed per title afterward.
9. Watched titles without a rating import as Logged with no bucket.
10. The watchlist imports; watch dates come from the diary; rewatch flags are ignored.
11. **All lists import**, regardless of the three-list limit, and none is deleted or hidden.
12. Imported lists are recorded with `source: imported`.
13. No imported title receives a ranking position.
14. Re-uploading the same export creates no duplicate records.
15. After the write, an anchor session offers ~20 comparisons from the top of the Loved it bucket; it can be skipped at any point and resumed later.
16. Uploaded source files are deleted after processing completes.
17. No Letterboxd credential is requested, and no network call is made to Letterboxd.

### 26.6 Social graph, feed, and match

1. A user can follow and unfollow another user; following a public account is instant.
2. Following a private account creates a request the owner can approve or decline.
3. The feed shows chronological activity from followed users and includes ranks, logs, list adds, and milestones.
4. A profile shows top titles, rankings, public lists, follower and following counts, and a basic stats block.
5. People discovery and a leaderboard surface active rankers with match score and shared count.
6. A match score displays as a percentage **and** a shared count, computed only from pairwise-ranked overlap.
7. A match involving a private user is visible only to that user's approved followers.
8. Blocked users never appear in feed, leaderboard, discovery, or match surfaces.

### 26.7 Reactions and tagging

1. A user can add exactly one reaction to a feed activity item, and can change or remove it.
2. Reaction counts are visible on the activity item.
3. Reacting generates a notification for the activity owner.
4. No free-text input exists on any feed item.
5. While logging a watch, a user can tag up to 10 people, limited to those they follow or who follow them.
6. Attempting to tag someone not on Bingd offers Invite them and enters the invitation flow.
7. A tag does not modify the tagged user's collection, watched state, or rankings.
8. A tagged user is notified and can remove the tag from their side, which hides it without altering the tagger's log.
9. A block in either direction prevents tagging and hides existing tags.

### 26.8 Notifications

1. Each of the seven v1 events in §15 generates exactly one in-app inbox item.
2. An inbox is reachable from the app with read and unread states.
3. A Notifications page under Settings offers a toggle per category plus a master Turn all off.
4. Disabling a category stops new items in that category.
5. `expo-notifications` is present in the production build and Apple and Google push credentials are configured.
6. Push **delivery** is disabled by a server-side flag, and no push is delivered in v1.
7. Enabling the flag requires no new native build and no store submission.
8. Push permission is never requested at first launch; it is requested after the first invite or follow.
9. If OS permission is denied, the preferences screen states this and links to system settings.
10. Sync-failure notices appear in the inbox and never as push.

### 26.9 Recommendations

1. The Recommendations surface opens directly to suggestions with no configuration step.
2. A user who has only imported and bucketed titles, with zero rankings, receives personalized recommendations.
3. No watched, Logged, dismissed, blocked, or previously-dismissed title appears.
4. A title shown once does not reappear within the cooldown window.
5. Every recommendation carries one concise reason traceable to stored signals.
6. In any slate of 20: at most 2 titles share a franchise or primary creator; no single primary genre exceeds ~40%; the most-popular band does not exceed ~50%; at least 3 candidate-source families are represented when data allows.
7. *Not interested*, *Already seen*, and save-to-watchlist each change subsequent slates.
8. During an outage the last successful set is served and visibly labeled as cached.
9. Cold-start results are labeled by their actual source rather than implied to be personalized.

### 26.10 Lists

1. A user can create a custom list, add and remove titles, and set it Public, Private, or Link-accessible.
2. Creating a fourth in-app list is blocked with an explanation and no price.
3. Lists beyond the limit that arrived via import remain fully visible and readable.
4. No list is ever deleted or hidden because of the limit.
5. A public or link-accessible list resolves at `bingd.app/lists/<id>`; a private one returns a safe unavailable page.

### 26.11 Capabilities

1. Feature access is resolved through named capabilities, not plan or product identifiers.
2. `base_free` and `alpha_early_access` both resolve correctly.
3. Every capability check is enforced server-side, and a modified client cannot bypass a limit.
4. Every Early Access grant carries an expiry and stops resolving after it.
5. Every gate hit records the capability name, the screen, and the user's collection size.
6. The build contains no RevenueCat SDK, no store product, and no purchase, restore, renewal, price, or manage-plan UI.
7. No user is displayed as Pro, and no "free plan" language appears anywhere.
8. Any gate message reads as *Coming soon* with no price and no urgency.
9. No intent surface appears before the user's first ranking reveal.

### 26.12 Sharing

1. Share is available from a rank result, the Top 10, a public list, and a profile.
2. A preview shows exactly what will leave the app before the share sheet opens.
3. The user can include or hide their handle.
4. The Top 10 card renders correctly with 10 titles, with fewer than 10, and with missing artwork.
5. Cards render locally and can be shared with no connectivity.
6. A canonical `bingd.app` link is attached when the content is synced and permitted, and Copy Link is always available.
7. Every route in §16 resolves correctly with the app installed and without it.
8. Opening a link with the app installed lands on the exact destination, not the home screen.
9. Private artifacts cannot produce a public page.
10. No private field appears in any share payload.
11. Deleted or newly private objects return a safe unavailable page.
12. Public pages carry `noindex`.
13. Returning from the share sheet is never recorded as a completed share.

### 26.13 Invitations

1. Invite Friends is reachable from onboarding completion, People, Profile, Settings, and the tagging flow.
2. A user has one reusable personal invite link plus a short code, and can revoke and regenerate both.
3. The invite link opens the app when installed, and a web landing page when not, showing public-safe inviter context, store actions, and the short code.
4. A recipient must create an account and then explicitly tap Accept.
5. Acceptance creates a one-way follow from recipient to inviter.
6. If the inviter is private, acceptance creates a follow request instead.
7. The inviter is notified and prompted to follow back, and is never auto-followed.
8. The recipient's identity is not visible to the inviter before acceptance.
9. A block in either direction voids the invitation.
10. Revoked, malformed, cross-environment, and rate-limited tokens all render safe states without leaking private data.
11. `invited_by` and `founding_member` are recorded on every account.
12. Total invites sent and attributed activations are both queryable.
13. No reward, credit, or unlock is granted for inviting.
14. The app never requests contacts permission.

### 26.14 Offline behavior

1. With connectivity disabled, the app opens and displays the user's rankings, Logged collection, buckets, watchlist, and lists.
2. Cached feed and recommendation snapshots display with a visible as-of indicator.
3. Marking watched, changing watchlist membership, changing list membership, and editing a note draft all succeed and enter the outbox.
4. Each queued item shows Saved on this device, and never implies server confirmation.
5. On reconnect, queued operations sync automatically and the state advances to Synced.
6. Replaying a duplicate `operation_id` produces no duplicate record.
7. Every online-only action in the §18 matrix is unavailable offline with a clear explanation.
8. Block and report are never enqueued.
9. A failed operation surfaces in Settings with a plain-language reason and a retry action.

### 26.15 Privacy, safety, and moderation

1. New accounts default to public, and a Private toggle exists in Settings.
2. Switching to private gates new followers without removing existing ones.
3. Watch dates, notes, watchlist, import history, email, and capability state never appear on any public surface.
4. **A public profile's Logged collection and its buckets are visible to other users; a private profile's are visible to approved followers only.** Notes, watch dates, and the watchlist stay hidden on both, including on a title whose bucket is visible.
5. **Every view returns the same rows a direct table query would**, asserted from a second user's session rather than from the view definition. A view created without `security_invoker` bypasses RLS while the table policy still reads correctly, which makes this the one privacy test that cannot be replaced by inspection.
6. A block removes follows in both directions and hides both users across feed, leaderboard, discovery, match, tagging, and public web pages immediately.
7. A report flow exists for profiles, display names, lists, list titles, usernames, tags, and reactions, with a reason taxonomy, and a filed report is visible in the operator queue.
8. A second report on the same subject by the same reporter does not create a second open row.
9. **A suspended account is invisible across feed, leaderboard, discovery, match, tagging, and public web pages, can still load its own profile, and cannot write.** Restoring reverses all of it.
10. Every moderation action is recorded with its subject, action, and rationale.
11. RLS denies by default on every user-owned table, verified by test.
12. A username can be changed once per 30 days; the prior username redirects for 90 days and is never reusable afterward.
13. Unfollowing removes that person's events from the feed, past ones included, and re-following restores them.

### 26.16 Platform and operations

1. Development, preview, and production variants install side by side and are visibly distinct.
2. Non-production builds display an environment indicator.
3. Non-production builds never read or write production data.
4. Every build traces to an exact commit, and Sentry releases are tagged with source maps uploaded.
5. Analytics events fire for onboarding, ranking, import, sharing, invitations, gate hits, and recommendation feedback, and contain no private content.
6. `main` is protected, requires passing checks, and rejects direct pushes.
7. An EAS Update reaches an installed preview build without a new store submission.

---

## 27. Public-release requirements

Public alpha may not ship until every item is true.

- [ ] Reliable account creation and sign-in on both platforms, including Sign in with Apple on iOS.
- [ ] Search, detail, watched state, buckets, and comparison ranking work end to end for movies and TV seasons.
- [ ] Letterboxd import completes end to end, including preview, bucket mapping, full list import, and the anchor session.
- [ ] Profiles, follows, feed, people discovery, match scores, reactions, and tagging are functional.
- [ ] The notification system delivers inbox items for all seven v1 events, with working preferences.
- [ ] Recommendations return useful results for new, imported-only, and established accounts, with every guardrail enforced.
- [ ] Lists work with the three-list limit enforced and the over-limit rule verified.
- [ ] Capability enforcement is server-side and cannot be bypassed.
- [ ] Sharing and invitations work end to end, installed and uninstalled, with the Top 10 card polished.
- [ ] Offline behavior matches the §18 matrix exactly, with honest state labels.
- [ ] Privacy defaults, blocking, reporting, and account deletion all function.
- [ ] **The operator can see a filed report, suspend an account, and reverse it**, and every action is recorded. Reporting without a way to act on a report is a checkbox, not a safety feature.
- [ ] Crash monitoring, analytics, and alerting are live in production.
- [ ] A published contact address reaches the founder, and the data-request path in HG-4 has been exercised once end to end rather than only written down.
- [ ] **HG-2** Android developer verification complete.
- [ ] **HG-3** App Store and Play name availability confirmed; knockout trademark search complete.
- [ ] **HG-4** Privacy policy, terms of use, support contact, 13+ statement, age ratings, and data-request path published.
- [ ] **HG-5** Google Play production access granted.
- [ ] **HG-6** Brand assets outlined, font import removed, square icon mark produced.
- [ ] Store metadata, screenshots, and review notes prepared for both platforms.
- [ ] A documented rollback path and a triage owner for the first 72 hours.

> **TMDB is not a gate.** Connect on a free developer key; buy the self-serve commercial plan before charging anyone. See §19.

---

## 28. Success metrics

Alpha targets are **Provisional** and exist to detect direction, not to be hit precisely.

### Definition of activation — Required

> **Activation = the user has ranked 10 titles.** The activation *rate* metric adds a 24-hour bound. Attribution reporting uses the unbounded definition.

v0.5 used two near-definitions interchangeably; this is the canonical one. See INF-5.

| Area | Metric |
|---|---|
| Activation | % of new users who rank ≥10 titles within 24 hours; onboarding completion by path (starter set / search / import) |
| Import | Import completion rate; anchor-session completion; % of importers with ≥20 ranked within 24 hours |
| Collection | Median ranked and logged counts; ratio of ranked to logged; unranked-card engagement |
| Engagement | Weekly ranking sessions per active user; comparisons per session; return rate at day 7 and day 30 |
| Social | Follows per activated user; % viewing a match score in session one; feed sessions per week; reactions per active user; tags per watch |
| Notifications | Inbox open rate; per-category opt-out rate; (once push is on) open rate by event and by nudge slot |
| Sharing | Shares per active user; link opens per share; attributed signups; attributed activations; share→activation rate by artifact |
| Invitations | Invites sent per activated user; invite link opens; accepted invitations; **invite→activation rate**; median invites per inviter |
| Recommendations | Save, watch, and later-positive-rank rate; repeat-impression rate; long-tail exposure; slate diversity; explanation-audit failures; cached-serve share |
| Offline | Queued operations per user; sync success rate; median time to sync; failed-operation rate |
| Metadata | Cache hit ratio; provider calls per active user; image bandwidth per user; provider error rate |
| Monetization intent | Gate hits by capability and screen; % reaching the three-list ceiling **via in-app creation only**; median collection size at first gate hit |

---

## 29. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Ranking feels tedious | Buckets cap comparison depth; skip and back; 3-skip midpoint; ranking is optional beyond the top of the list |
| Imported library feels like homework | Logged is a valid resting state; no progress UI; batches of 5, highest bucket first; the prompt goes quiet at ~50 |
| Import produces bad matches | Mandatory preview before any write; per-row resolution; idempotent re-upload |
| Cold start feels empty | Starter set, import, content-based and curated fallback, clearly labeled |
| Recommendations feel generic or repetitive | Impression cooldowns, popularity caps, source and slate diversity, exploration budget, evaluated on later satisfaction rather than clicks |
| Explanations feel fabricated | Explanation integrity is a hard test; reasons derive only from stored signals |
| Sparse graph makes match unreliable | Always display shared count; downweight low-overlap matches |
| Concentrated launch cohort floods notifications | Friend-activity push deliberately excluded from v1; nudge is conditional and capped at twice weekly |
| Notification permission burned early | Never prompt at first launch; prompt after the first invite or follow; nudge sends nothing when there is nothing to say |
| Sharing leaks private data | Preview before share; allowlisted payload fields; server re-authorizes every token request; privacy tests in CI |
| Invitations feel spammy or unsafe | No contact upload; explicit acceptance; no auto-follow; block, report, revoke, and rate limits |
| Offline expectations exceed the design | Explicit capability matrix; honest state labels; ranking clearly online-only |
| Sync conflicts corrupt data | Narrow queueable set; idempotent operations; server authoritative for order, entitlement, privacy, and moderation |
| Metadata licensing blocks revenue | **Largely retired 2026-08-13.** The commercial plan is a self-serve purchase, so revenue is never blocked on a negotiation. Provider-agnostic adapter and Bingd identifiers remain, against a change in TMDB's terms or pricing |
| Six-month cache limit conflicts with offline design | **Resolved 2026-08-13** by complying rather than seeking an exception. Bingd's own collection data persists without limit; TMDB metadata expires and re-fetches inside six months. The two live in separate tables |
| Provider outage breaks the app | Cached reads for own collection always succeed; degrade enrichment first |
| Metadata or image cost scales unexpectedly | Cache only touched titles; staggered TTLs; rate limits; bandwidth monitoring |
| Premium messaging damages a free alpha | No prices, no purchases, no Pro badge; nothing before the first ranking reveal; growth loops permanently free |
| Alpha users lose data when subscriptions launch | Universal over-limit rule: read-only, never destructive; all imports preserved; `founding_member` recorded from day one |
| Early Access silently becomes permanent | Every grant carries an expiry |
| UGC moderation obligations underestimated | Reactions carry no free text; report flow and blocking in v1; comments deferred until moderation capacity exists |
| Name or trademark conflict | HG-3 before public launch |
| Android verification deadline missed | HG-2, deadline 2026-09-30 |
| Agent-built code carries invisible defects | Required independent review on sensitive surfaces; automated checks on `main`; no autonomous deploy. Observed 2026-08-13: a review found four RLS defects that the test suite could not have caught, because the harness ran as the table owner and no policy was ever enforced |
| A reviewing agent patches instead of reporting | Its fix then carries no independent review, defeating the control. §24 makes reporting-not-patching explicit. Observed 2026-08-13 |

---

## 30. Staged implementation plan

| Phase | Scope | Exit condition |
|---|---|---|
| **0. Foundations** | Repo, CI, environments, both Supabase projects, Expo project, **development build including `expo-notifications` and push credentials**, Sentry, analytics, brand tokens | A development build runs on a physical device against nonprod; CI is green; the environment indicator is visible |
| **1. Identity** | Auth (email OTP, Apple, Google), **credential linking per [`../architecture/auth.md`](../architecture/auth.md)**, profiles, usernames, 13+ gate, privacy defaults, RLS foundation, account deletion with username reservation | §26.1 passes, including the unverified-email refusal; RLS default-deny verified |
| **2. Collection** | TMDB adapter and cache, search, title and season detail, watched state, watchlist | §26.2 passes; no credential in the bundle |
| **3. Ranking** | Three buckets, band partitioning, binary insertion, skip/back, reveal, manual reorder, Logged/Ranked states | §26.3 and §26.4 pass |
| **4. Import** | Upload, parse, match, preview, bucket mapping, list import, anchor session, unranked card | §26.5 passes |
| **5. Social** | Follows and requests, feed, people discovery, leaderboard, match score, reactions, tagging, blocking, **reporting and the operator moderation surface** | §26.6, §26.7, §26.15 pass |
| **6. Notifications** | Event generation, inbox, preferences, delivery abstraction with push flagged off | §26.8 passes |
| **7. Recommendations** | Candidate generation, eligibility, scoring, re-ranking, explanations, impressions, feedback, guardrail test suite | §26.9 passes; every guardrail has a passing test |
| **8. Lists and capabilities** | Lists with the three-list limit, capability resolver, gate component, *Coming soon* surface, gate analytics | §26.10 and §26.11 pass |
| **9. Sharing and invitations** | Card rendering, canonical routes, web fallback, Open Graph, polished Top 10, invite tokens, acceptance, attribution | §26.12 and §26.13 pass |
| **10. Offline** | Outbox, sync states, conflict handling, failure surfacing, cache retention | §26.14 passes; the full matrix is tested |
| **11. Release readiness** | Store assets, legal pack, Hard Gates, monitoring, rollback plan, manual QA | §27 fully checked |

Phases 0–3 are strictly sequential. Phases 5–9 may overlap once 3 is complete. Phase 10 must not begin before 3 is stable, since the offline matrix depends on final ranking semantics.

### If the plan runs long — Required

Eleven phases is a large v1 for one founder working through agents, and the failure mode to avoid is discovering that in phase 9 and cutting whatever happens to be unfinished. So the order of degradation is decided now, while nothing is at stake:

| Order | What gives | Why it is the cheapest thing to lose |
|---|---|---|
| 1 | The **story card** (9:16), keeping the 4:5 feed card | Two canvases is a doubling of share-card work for a second aspect ratio. One polished card still ships the Top 10 |
| 2 | **Scheduled nudges**, keeping event notifications and the inbox | The nudge is the notification most likely to annoy a 40-person cohort and the least likely to teach anything |
| 3 | **Public web pages**, keeping deep links into the app | An installed-app cohort rarely hits the fallback. This is the largest single scope item with the least alpha signal |
| 4 | **Collaborative-filtering recommendations**, keeping content and bucket signals with cold-start | 40 users produce almost no collaborative signal anyway (§13 acknowledges this) |

Nothing above the line is available: ranking, import, the feed, reporting and its operator surface, capability enforcement, invitations, and the offline matrix all ship. Reporting in particular is a platform obligation rather than a feature, and cutting it is not a scope decision.

---

## 31. Readiness assessment and go/no-go gates

### Architecture readiness

> ## READY FOR ARCHITECTURE: **YES**

All six product decisions that blocked architecture at v0.5 are resolved (see `open-questions.md` §1). Every must-have feature has acceptance criteria in §26. Every remaining Open item is either an engineering-stage decision an agent may resolve by best practice, a validation question with a stated working default, or an external Hard Gate that does not block design.

**Conditions attached:**

1. **Two inferences (INF-2, INF-5)** are recorded as decisions but were made by the agent, not the founder. Both are cheap to reverse; INF-5 only needs settling before attribution reporting is built. INF-1 and INF-3 — the two expensive ones — were confirmed by the founder on 2026-08-12, INF-4 was revisited during design and confirmed on 2026-08-13, and INF-6 was resolved and amended by the founder on 2026-08-13.
2. **HG-1 (TMDB) is closed as of 2026-08-13, with the gate change approved by the founder** and no longer a Hard Gate. Connect on a free developer key now; buy the self-serve commercial plan when subscriptions ship. **The closure does not rest on Bingd being non-commercial** — it rests on the downside being a published price paid on demand rather than a negotiation. See §19 and `decision-log.md` §10.
3. **HG-6 (brand assets)** blocks Phase 9, not Phase 0. Note that `og-render` needs the same outlined fonts as the app, since the remote `@import` fails server-side too.
4. **The moderation operator surface is part of Phase 5, not a later concern.** Reporting had no schema until 2026-08-13, and a report flow with nowhere to act on a report does not satisfy §22. §27 gates the release on the whole loop working, not on the report button existing.
5. **`docs/architecture/auth.md` governs identity.** AC 26.1.3 was amended because its original wording — "signing in again by any method reaches the same account" — describes an account-takeover vector when the matching email is unverified. Credential linking is not an area for an agent to resolve by plausible default.

### Stage gates

**Continue to early traction when:** activation and day-7 return are healthy; ranking and import completion are healthy; the social graph forms without manual intervention; recommendations meet quality guardrails on real data; sharing and invitations produce measurable attributed activation; offline behavior is stable; metadata cost per active user is predictable.

**Continue to paid beta when:** Free-tier quality and retention are established; premium intent is evidenced by gate-hit data rather than assumption; **the TMDB commercial plan is purchased and active**; recommendation quality is stable enough that a paid tier would not be selling a worse experience.

**Stop and reassess if:** ranking completion is poor even after bucketing; imported libraries correlate with abandonment; match scores do not change behavior; recommendations cannot pass the guardrails on real data; sharing produces no attributed activation; metadata cost or licensing makes the model unviable; premium interest concentrates exclusively in features that must remain free.

---

## Appendix A — Founder technical primer

Plain-language definitions of the terms used in this document.

**Adapter** — Bingd's own layer in front of an outside data provider, so the provider can be swapped without rewriting the product.

**Acceptance criteria** — Objectively checkable statements of what "done" means for a feature. See §26.

**Backend enforcement** — Checking a rule on the server, where a user cannot alter the code. Client-side checks are cosmetic.

**Binary insertion** — Placing an item by repeatedly comparing against the midpoint of the remaining range. Doubling the list adds only one comparison.

**Bucket** — One of three broad reactions (Loved it / It was fine / Not for me) captured before comparison. Buckets partition the ranking into ordered bands.

**Bundle identifier** — The permanent unique name of an app on the stores, such as `app.bingd`.

**Cache** — A stored copy kept for speed and resilience, not a permanent replacement copy.

**Capability** — A named permission such as `unlimited_custom_lists`. Screens ask about capabilities, never about plans or products.

**Cold start** — The period before enough data exists to personalize.

**Deep link** — A link that opens a specific place inside an app rather than its home screen.

**Deferred deep link** — Routing someone to the right place *after* they install. Requires a vendor. Not used in v1.

**Development build** — A private version of the app containing the native pieces the project needs. Required here because of push notifications and native sign-in.

**EAS Update** — Shipping JavaScript and asset changes over the air without a new store submission. Native changes still require a new build.

**Entitlement** — Proof of a paid subscription, translated into capabilities. Paid beta only.

**Feature flag** — A server-side switch that turns behavior on or off without shipping new code. Push delivery uses one.

**Guardrail** — A required constraint on recommendation output, such as diversity or a repetition cooldown.

**Hard Gate** — An external dependency requiring a manual founder action before an activity may proceed.

**Idempotent** — Safe to repeat. Running the same operation twice produces the same result as once.

**Link-accessible** — A visibility level meaning "anyone holding the link may view this." The server still authorizes each request.

**Logged vs. Ranked** — Logged means watched, possibly bucketed, with no position. Ranked means an exact position earned through comparisons.

**Match score** — A percentage describing taste similarity, always shown with the number of shared ranked titles.

**Migration** — A reviewed, version-controlled change to the database structure. Never an ad-hoc production edit.

**Offline-resilient vs. offline-first** — Resilient: reads work offline and a narrow set of writes queue. First: nearly everything works offline, at high complexity cost. Bingd is resilient.

**Open Graph** — The metadata that produces a link preview card in messages and social apps.

**Ordinal position** — Exact placement in an ordered list, such as `#18`. The stored ground truth, written only by a comparison session. Displayed as secondary detail; the primary display is the score.

**Score** — A 0–10 value with one decimal, derived from a title's ordinal position within its bucket band (§10). A statement about where a title sits in one person's list, never a rating of the film and never averaged across users.

**Outbox** — The local queue holding changes made offline until they sync.

**Pairwise comparison** — Choosing between two titles. The core ranking mechanic.

**Provisional** — A working answer expected to change once real data exists.

**Row Level Security (RLS)** — Database rules controlling which rows a user can read or write. Bingd denies by default.

**Token (share / invite)** — An identifier that routes to an object and records attribution. It is never permission.

**TTL** — Time to live. How long cached data stays valid before refresh.

**Universal Links / App Links** — Verified HTTPS links that open the installed app directly on iOS and Android.

---

## Appendix B — Source documents and evidence boundary

### Sources

| Document | Role | Status |
|---|---|---|
| `Bingd_PRD_v0.5_Finalization_Draft_20260812.pdf` | Direct predecessor | **Superseded by this document** |
| `Bingd PRD Finalization Kickoff.pdf` | Process instructions for this finalization | Governs v0.5 → v0.6 only |
| `Building and Operating Bingd: A Nontechnical Founder's Guide` | Engineering practice, stack, workflow, and founder operating model | **Written against PRD v0.4.** Sound on engineering practice; out of date on product scope |
| `Brand SVGs/` (12 files) | Wordmark and film-frame explorations | Match the §5 color system; **not production-ready** — see §5 |

> **Handbook staleness — Required note.** The founder's guide predates v0.5 and therefore v0.6. Where it describes product scope, features, or stage boundaries, **this PRD supersedes it**. Where it describes engineering practice — Git workflow, testing layers, environments, review discipline, agent authority limits — it remains authoritative and is reflected in §24 and §25.

### Evidence boundary — Required

Claims in this document fall into four categories, and they must not be conflated:

1. **Founder decisions.** Recorded in `decision-log.md` with authority `Founder`.
2. **Documented external fact.** Platform policies, provider terms, and publicly reported product mechanics. Includes: Apple's Sign in with Apple requirement; Google Play's closed-testing and production-access rules; TMDB's caching restriction; Letterboxd's prohibition on automated extraction and its export format; Nielsen's peak-viewing window; Beli's three-bucket and binary-search mechanics and its two publicly reported notification types.
3. **Engineering and design best practice.** Marked `Recommended`. An agent may implement without further approval.
4. **Inference.** Marked as such, listed in `open-questions.md` §2. **Never presented as fact or as a founder decision.**

Specifically **not** established by any source: Beli's offline behavior, synchronization model, metadata provider, image caching strategy, infrastructure costs, or complete notification set. Everything this document says about offline behavior, metadata, and infrastructure is recommended early-stage architecture, not observed competitor implementation.
