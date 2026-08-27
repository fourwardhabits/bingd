# bingd. — Product Requirements Document

**Version:** v0.6 (public-alpha final), with **as-built corrections through 2026-08-19**
**Status:** Build-ready for public-alpha architecture. **Product scope re-frozen 2026-08-19.**
**Date:** 2026-08-12, corrected 2026-08-13 after independent review — see [`change-log-v0.6.md`](./change-log-v0.6.md) §7
**Supersedes:** `Bingd_PRD_v0.5_Finalization_Draft_20260812.pdf`

**Companion documents:** [`decision-log.md`](./decision-log.md) · [`open-questions.md`](./open-questions.md) · [`change-log-v0.6.md`](./change-log-v0.6.md) · [`analytics.md`](./analytics.md) · [`deferred-roadmap.md`](./deferred-roadmap.md) · [`growth-instrumentation.md`](./growth-instrumentation.md)

---

> **Precedence.** If this document and the decision log disagree, the **decision log wins** and this document must be corrected. If this document and any source PDF in `docs/reference/` disagree, **this document wins**.
>
> **For implementation agents.** Items marked `Open`, `Provisional`, or listed in `open-questions.md` may **not** be resolved by choosing a plausible answer. Stop and ask. Items marked `Required` are not preferences and may not be traded away for simplicity.

> ### As-built corrections, and how to read them
>
> This document was written before implementation and has since been overtaken in places. Blocks headed **As built** carry a date and describe **what the reviewed code actually does**. Where an As-built block and the surrounding v0.6 specification disagree, **the As-built block wins and the specification text around it is stale** — it is left in place only where it still records the reasoning behind a decision.
>
> A section with no As-built block is either unchanged from the specification or **not built at all**. The one document that says which is [`deferred-roadmap.md`](./deferred-roadmap.md), and the release-blocking half of that list lives in `.agent-workflow/continuation.md` rather than in any roadmap.
>
> **Product scope is re-frozen as of 2026-08-19.** No further product feature ships before the friend beta unless a Preview test exposes a blocker, a hardening requirement forces a product behaviour change, or the founder breaks the freeze deliberately.

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
| **Decided** | Rating happens in two steps: a three-bucket reaction (**I liked it / It was fine / I didn’t like it**), then pairwise comparison within that bucket. |
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
4. User chooses a bucket: **I liked it**, **It was fine**, or **I didn’t like it**.
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
| Profile | Public identity and social standing | Basic stats, top of the ranking, **Watchlist**, match, leaderboard, followers and following, people search, invite entry point, settings |
| Settings | Account, privacy, notifications, offline state | Invite Friends, privacy toggle, notification preferences, data export, cache and sync status, account deletion |

> **Decided 2026-08-13, superseding Provisional INF-4.** Five tabs: **Feed, Collection, +, Recommendations, Profile.** The collection gets a top-level tab rather than sitting inside Profile, because it is the surface a user returns to daily and the artifact the product exists to produce; Profile stays the public-facing identity page. There is no Search tab — searching for a title is how you log one, so the center **+** and title search are the same entry point, with a header affordance on Feed and Collection. People search lives in Profile and the invite flow. Sharing appears contextually on artifacts, never as a tab. Reasoning and evidence in `../design/screens.md` §2.
>
> **Renamed from v0.5.** The area formerly called "Settings / Subscription" is now **Settings**. Plan management and restore are paid-beta-only and do not exist in v1.

> ### As built — 2026-08-19: the centre tab is **Search**
>
> **Five tabs: Feed · Collection · Search · For you · Profile.** The founder renamed the centre tab from **+** to **Search**, and the sentence above beginning "There is no Search tab" is stale.
>
> The reasoning is that the surface is where you *find* something — a title **or a member** — and logging is what happens after you have chosen one. Calling it Log named the second step and hid the first, which is also why member discovery had been sitting behind a chip nobody had a reason to press. The icon moved with the label: a `+` under the word Search describes neither. The route is still `log`; renaming a file to match a label is a deep-link and history change bought for nothing.
>
> **Search returns Titles and Members as grouped sections, not as a filtered list.**
>
> - The three filter chips — **All · Movies · TV** — narrow **titles only**. Members are a different kind of thing and were never narrowed by them, so a fourth "Users" chip made one control mean two things.
> - **Titles stay dominant** (founder addendum, 2026-08-16). Members appear when somebody's handle or display name is actually *started* by the query, three at a time, with **See all** lifting the display cap in place. See all is not a route and cannot fail: everything it reveals is already in hand.
> - **`@` raises Members without suppressing Titles.** Typing `@suraj` means "the member suraj" and passes the relevance gate outright — it is a hint, not a mode, and the title results stay on screen.
>
> **Private accounts are discoverable by identity; their collections stay gated.** `20260819000100` built an identity-only profile surface for exactly this: somebody can be found by handle or name, and can be sent a follow request, without any of their ratings, collection, notes or activity being readable. Being unfindable is not what "private" was ever supposed to mean, and an account nobody can find cannot be followed.
>
> **People and actor search is deferred** — see [`deferred-roadmap.md`](./deferred-roadmap.md) §1. The person detail page exists and is reached only from a cast strip.

> ### As built — 2026-08-26: **For you** holds titles *and* people
>
> Still five tabs. What changed is inside one of them: For you's category selector — the
> dropdown that already chose between Movies and TV shows — offers a third option.
>
> > **Revised the same day, and this is the shipping shape.** People arrived first as a
> > separate **`[ Titles ] [ People ]`** segmented control *above* the category selector,
> > which left the header carrying two stacked controls: the reader had to work out that
> > the top one chose a kind of thing and the bottom one chose a category of whatever the
> > top one had chosen. It is one question — what am I looking at — so it is one control.
> > The segmented control is removed; **no second selector, and no extra tab row.**
>
> **The For you selector, in full: `Movies` · `TV shows` · `People`.** "TV shows" rather
> than Collection's "TV seasons" because this wall holds series — TMDB answers "similar"
> about a show and never about one of its seasons — and it is a label override on the
> shared control rather than a second control. Collection keeps its own two options, its
> own label, and its own remembered preference; For You's selection is per-visit and is
> deliberately not persisted.
>
> Everything the tab already was — the wall, the filters, Sent to you, the
> recommendation-requests alert — is what Movies and TV shows show, unchanged. Those
> controls are title-only and are not drawn under People, where they would mean nothing.
>
> **People is not a sixth tab and not a Feed insertion.** It is the same question the tab
> already asks — what next — whose honest answer is sometimes a film and sometimes a
> person. Five tabs is the width of the bar, and a "people you may know" card interleaved
> with real activity turns the Feed into a place where the app talks about strangers.
>
> This is also where member discovery finally has somewhere to *lead*. Search finds a
> member you can already name; People is for the ones you cannot. The specification is
> PRD §13 As-built; the row is an avatar, a name, a handle, one line of context and a
> Follow control, and nothing else.

> ### As built — 2026-08-27: Search compacts into its header, **People** is a chip, and profile stats open
>
> Three navigation changes from the external-beta polish tranche, all founder-requested
> from physical device use.
>
> **The search field lives in the brand header row.** Search had spent two rows of chrome
> — the bingd. header, then a separate full-width field — above every result. The field
> now sits beside the wordmark in the same compact header treatment the other tabs give
> their controls. Nothing below it changes.
>
> **The filter row is `All · Movies · TV · People`.** The 2026-08-19 block above rules out
> a fourth chip, and the chip it ruled out is not this one: `users` sat among three
> *title* filters while members were interleaved into the same list, so one control meant
> two things. People is not a narrowing of titles — choosing it shows the member section
> alone, and because the press itself is the statement of intent the relevance gate exists
> to infer, the gate is lifted there: every display-name and @handle match shows, no
> three-at-a-time cap. **All** still interleaves as before, members above titles, gate and
> cap intact, so a plain title search looks exactly as it did.
>
> **The section is titled "People", no longer "Members".** The founder spent the word on
> accounts — it is already the For You category — and one surface using it differently
> was the inconsistency. The future actor-and-director search will need its own label;
> recorded against [`deferred-roadmap.md`](./deferred-roadmap.md) §1.
>
> **A profile's Movies and TV seasons counts are controls.** On somebody's profile the two
> collection stats were claims the reader could not check — Top Ranked shows six titles
> and the counts assert the rest. Tapping either opens a sheet listing every title that
> person has **ranked** in that category, most recently added first (`created_at`, not
> rank position). The read is `rankings` under `rankings_read`, the same policy that
> produced the counts, so the sheet can never show a title the counts did not admit;
> logged-but-unranked titles, notes and watch dates stay owner-only (§22).

> ### As built — 2026-08-27 (second pass): Search is one list under its own header row, and the visible category is **TV**
>
> The final visual-polish tranche before the external beta, all founder-requested from
> physical device use. Two of the three paragraphs in the block above are superseded by
> it; the People-chip paragraph stands.
>
> **The search field sits on its own row under the brand row.** The compaction into the
> brand header row crowded the bingd. lockup; the correction is the cross-tab header
> rhythm — row one is the brand, row two is the screen's acting control, the same
> position the category selector holds on For You and Collection. Results begin
> normally underneath.
>
> **Search returns one continuous list, not grouped sections.** The 2026-08-19 "grouped
> sections" shape sectioned People while leaving Movies and TV unsectioned, which was
> the inconsistency. The contract is now: **query → one list → chips narrow it.** Under
> `All` the two sources merge deterministically — people first in the member search's
> own order, then titles in the catalogue's — with no "People", "Movies" or "TV"
> headings anywhere; `Movies` and `TV` are the same surface narrowed to those titles,
> and `People` is the same surface narrowed to members (gate lifted, no cap, as the
> block above decided). The relevance gate, the three-person preview and See all
> survive under `All`; See all is now a row in the list rather than a section action,
> and still is not a route. A row states its own kind — round avatar and @handle
> against poster and metadata — rather than a heading stating it for a block. People
> search continues to match display name and @handle.
>
> **The user-facing category label is "TV", no longer "TV seasons".** Everywhere the
> app names the category — the Collection selector, profile stat and its sheet, Top
> Ranked filter, goals, award breakdown headings, `#N in TV` placements, the Search
> chip that already said it — the word is **TV**. This is display terminology only:
> **individual seasons remain the canonical watched/ranked objects** (§1, §9, §11 are
> unchanged and still govern), `tv_seasons` remains the schema/RPC/analytics word, and
> sentences that *count* the unit still say seasons — "12 of 52 seasons" under a goal,
> "Watch 15 TV seasons" on an award — because seasons are what is being counted. For
> You's selector alone still says "TV shows", for the reason the 2026-08-26 block
> gives: that wall genuinely holds series.

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
- **Notification system**: events, in-app inbox, per-category preferences. Push built and credentialed but **delivery flagged off**. *(As built: there is no delivery flag. Push was built on 2026-08-24 and is gated on a production binary and founder credentials — §15 As-built, §27 items 5–7.)*
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

> ### As built — 2026-08-19: three corrections to the staging above
>
> - **Comments shipped.** They are on feed activity, rate-limited, with their own notification type and category. The Deferred line is stale on that one word; DMs, discussion boards and long-form reviews remain deferred.
> - **Achievements shipped as Bingd Awards** (2026-08-18) and are no longer a backlog item. See §14's As-built block.
> - **An invite is referral and attribution, never permission to create an account.** Recorded here 2026-08-25 because the opposite is a natural thing to assume from a beta whose whole shape is invitations, and assuming it produces engineering work that should not exist. There is **no app-level invite-admission gate today** — `create_profile` requires no token, and nothing in the schema conditions account creation on an invitation. What limits who can sign up during the beta is entirely **distribution**: TestFlight and a Play closed test. Public store availability therefore opens ordinary account creation on its own, with no "remove the invite gate" task to do, because there is no gate to remove. What an invite carries is the connection: who brought you, and the follow that follows from it.
> - **Letterboxd import was listed as a v1 must-have, has not been built, and is no longer a release gate.** No import screen, no CSV parser, no matching pipeline. **Deprioritized 2026-08-23**: it gates neither the friend beta nor either initial store release. The cohort is building collections by hand, which is the behaviour the beta exists to observe and which an importer would erase. §12 keeps the full specification; `deferred-roadmap.md` §20 holds the staging decision.
>
> Everything else this document calls Deferred is still deferred. The canonical register, with the reasoning and the revisit trigger for each, is [`deferred-roadmap.md`](./deferred-roadmap.md).

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
3. Choose a bucket: I liked it / It was fine / I didn’t like it.
4. Optionally capture the watch date, a lightweight note, and **who you watched with**.
5. Either compare now, or stop here and leave the title **Logged**.
6. If comparing: a short sequence of comparisons within the bucket, then the placement reveal.
7. Optionally share the placement.

### Log and rank TV

1. Search and select the series.
2. The series page lists seasons with progress.
3. Rank the season. **Ranking a season is the claim that it was watched** — the "How was it?" that opens the flow says so, and there is no separate Completed step (decided 2026-08-24, superseding an earlier rule that was never enforced anywhere in the build).
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
| **I liked it** | Top band |
| **It was fine** | Middle band |
| **I didn’t like it** | Bottom band |

**Buckets partition the ranking.** All *I liked it* titles rank above all *It was fine* titles, which rank above all *I didn’t like it* titles. A title cannot cross a band boundary without changing its bucket. Changing a bucket moves the title into the new band and re-runs comparisons there.

**Re-selecting the bucket a title already has re-ranks it inside that band.** It is not a no-op, and the founder's device test on 2026-08-21 is the record of why: a reader who re-opens a rating they have already given is saying the *position* is wrong, and the bucket is the only control they have to say it with. The bucket does not move; the position is discarded and comparisons run again within the same band, so the ordinal and the derived score may both change. Like a bucket change, it is destructive and is confirmed first.

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
| I liked it | 10.0 → 7.0 |
| It was fine | 6.9 → 3.5 |
| I didn’t like it | 3.4 → 0.0 |

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

> ### As built — 2026-08-26: **Rank again** is another watch; **Change your rating** is a correction
>
> The Ranked menu offers two controls that both re-open comparisons, and until this pass
> the product had never said what distinguishes them. It does now, and the distinction is
> load-bearing rather than editorial: one of them is a viewing and the other is not.
>
> | | What the reader is saying | Feed activity |
> |---|---|---|
> | **Rank again** | I watched it again and I am placing it again | **one new** `title_ranked`, at completion |
> | **Change your rating** | the opinion I recorded was wrong | **none** — the original activity stands |
>
> A **band change** — loved to fine — is a Change your rating and writes no activity
> either. Moving a title between bands is a correction to a rating, not a second viewing.
>
> **Starting either one changes nothing anybody can see.** This is the founder's device
> finding and the contract that replaces the behaviour it found: until the new placement
> completes, the title keeps its score, its position, its band, its collection row, its
> review and its private note. Closing the sheet, navigating away, cancelling, losing the
> connection or killing the app leaves the ranking exactly as it was, and no temporary
> unranked state is ever visible in Collection, on a profile or on a title page.
>
> Before `20260826000500` both controls destroyed the old position the instant the sheet
> opened — the server unranked and then opened a session, in one committed transaction —
> so a reader who opened Rank again and changed their mind lost the ranking they had.
>
> **What a second watch does not create, in v1.** One current review and one current
> private note per title, for good. Ranking a title again does not clear either and does
> not create a second review object; the post-rank *Finish your log* offers **Edit
> review** and **Edit private note** where writing already exists. Historical review
> objects — a review per watch — are deferred, not built.
>
> **Retries cannot duplicate.** Every ranking RPC carries an operation id
> (`20260825000200`), so a completion whose reply is lost and is pressed again is
> answered from the ledger: the same position, the same score, and no second activity.

### Open and provisional

| Status | Item |
|---|---|
| Provisional | Whether the three bucket labels read correctly to real users |
| **Decided 2026-08-26** | ~~How rewatches and changed opinions trigger recalibration~~ — Rank again re-runs comparisons and counts as a watch; Change your rating re-runs them and does not. See the As-built block above. |
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

A bucket is real partial ordering, not a placeholder. A *I liked it* title is known to rank above everything in *It was fine*. That is directly usable:

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

> **Stage changed 2026-08-23 — deprioritized.** Import is **not** a requirement for the
> friend beta, for the initial App Store release, or for the initial Google Play production
> release. **The specification below is unchanged and still canonical**; only the stage
> moved. The reasoning, the surviving policy and the revisit trigger are in
> [`deferred-roadmap.md`](./deferred-roadmap.md) §20. Free, permanently, whenever it ships.

### Method — Required by policy

User-uploaded export files only. **No scraping, no live account connection, no credential collection.** Letterboxd's terms prohibit unauthorized automated extraction, and its API is not granted for recommendation or data-analysis projects. The user requests their own export from Letterboxd and uploads the ZIP.

### What the export contains

Separate CSV files for watched titles, ratings, diary entries with watch dates, watchlist, reviews, likes, and each custom list. Ratings are 0.5 to 5.0 in half-star steps.

> **Important technical reality.** The CSVs identify films by title, year, and a Letterboxd URL slug — **not** by TMDB ID. Matching is a fuzzy title-plus-year lookup and will produce ambiguous and unmatched rows on any sizable library. This is why the preview step is mandatory rather than optional.

### Flow

1. **Upload.** The user uploads the ZIP. Limits: 5,000 titles, 25 MB. Processing runs as a background job with visible progress.
2. **Preview — Required.** Before any write, show: cleanly matched count, ambiguous rows needing a tap to resolve, unmatched rows, and duplicates of titles already in Bingd.
3. **Bucket mapping.** Star ratings map to buckets automatically. **No cut-line UI.** One summary line: *"We sorted your 320 rated films into I liked it (118), It was fine (140), I didn’t like it (62). Change any of these anytime."*

   | Letterboxd rating | Bucket |
   |---|---|
   | 4.0 – 5.0 | I liked it |
   | 2.5 – 3.5 | It was fine |
   | 0.5 – 2.0 | I didn’t like it |

   Thresholds are **Provisional** and tunable after observing real imports. Every bucket is editable per title afterward.

4. **Unrated watched titles** import as Logged with no bucket, and are bucketed lazily by the user later.
5. **Watchlist** imports directly.
6. **Watch dates** come from the diary. **Rewatch flags are ignored in v1** — the most recent watch date is used.
7. **Lists import in full.** All lists are created regardless of the three-list limit. See the over-limit rule below.
8. **Confirm and write.** Idempotent — the same file can be re-uploaded safely without duplicating records.
9. **Anchor session.** Immediately after the write, run a guided comparison session over roughly 20 titles from the top of the *I liked it* bucket, so the user finishes onboarding with a genuine Top 20. Skippable at any point and resumable later.
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

> ### As built — 2026-08-19: two scores on a title, named **Bingd** and **Following**
>
> A title page carries the reader's own position and, beside it, exactly **two** aggregate scores. There is no third and no carousel.
>
> | Score | What it averages |
> |---|---|
> | **Bingd** | every rating on Bingd that the reader is allowed to see |
> | **Following** | ratings from **accounts the reader follows** |
>
> **"Following" means followees, not followers**, and the direction is asserted by test rather than by the label: `following_score` joins `f.follower_id = auth.uid()` and `r.user_id = f.followee_id`. Approved follows only, and `can_view_profile` applied from the caller's own perspective — a private followee's rating counts only where the reader may see it. Audited on 2026-08-19 and found correct, so nothing was changed.
>
> **Bingd**, not "Community". The old label described a population where the new one names the product, and it excludes raters who have blocked the reader in either direction — a mean that included them made a blocked rater's score recoverable by subtraction.
>
> **A Followers score is deferred** — see [`deferred-roadmap.md`](./deferred-roadmap.md) §3. In a cohort where almost every follow is mutual, the two numbers would be nearly identical.
>
> **An absent score is not a zero.** A title nobody has ranked, a Following mean with no followee who has seen it, and a read that failed are three different states, and the badge distinguishes them.

> ### As built — 2026-08-26: where Match appears, and what it says when it cannot
>
> **Match sits directly under the handle**, in the identity block of every profile that is
> not the reader's own:
>
> ```
> [avatar]   Anna
>            @anna
>            87% Match
> ```
>
> It was under the avatar, in a column about sixty points wide — room for a figure and a
> word, and none for a sentence. So the states *without* a figure had to render as nothing
> at all, and on a friend beta, where the minimum is five titles **both** accounts have
> ranked, that is almost every profile. The founder's report was simply that Match is
> missing. It was wired, authorised and tested, and had nowhere to explain itself.
>
> Four states, and the two that are not a number are the ones the placement bought:
>
> | State | What the profile shows |
> |---|---|
> | A score | `87% Match` |
> | The **viewer** has ranked too little, and the other account has not | `Rank more to see Match` |
> | The **other account** has too little, or both have plenty and simply have not overlapped | `Not enough shared taste yet` |
> | The reader's own profile, or an answer still in flight | nothing |
>
> **The nudge is only shown where it is true.** Telling somebody to rank more when the
> shortfall is on the other side would be advice that cannot work, so the two insufficient
> states are separated by comparing each account's ranked total against the minimum. And
> **no count is invented**: "rank 3 more titles" would be a lie in every branch, because
> the gap is in *shared* titles and three arbitrary films may share none of them.
>
> **`TBD` and `0%` appear nowhere.** An absence of evidence is not a low score, and a
> placeholder percentage is worse than either.
>
> **Privacy is unchanged.** Match is computed server-side by `taste_match`, which refuses
> any pair `can_view_profile` does not admit — so a private account the reader has not been
> approved for shows no Match at all, and neither the shared titles nor any comparison
> input is ever returned. Whether a private profile should carry a Match while its
> collection stays hidden is **not widened here**; the existing aggregate contract stands.

> ### As built — 2026-08-26: **People**, the discovery surface inside For You
>
> For You's category selector gains a third option — **`Movies` · `TV shows` · `People`**,
> one dropdown and not a second control — and everything the screen already was lives
> under the two title categories, in the same order: the recommendation-requests alert,
> the filters, Sent to you, and the wall. See §5 As-built for why the separate
> `[ Titles ] [ People ]` switch this shipped with for a few hours was withdrawn.
>
> **People** is two sections, drawn only when they have somebody in them:
>
> | Section | Candidate | Shown as |
> |---|---|---|
> | **Mutuals** | people followed by people the reader follows | `3 mutuals` |
> | **Taste matches** | people whose rankings agree, scored by `taste_match` itself | `87% Match` |
>
> Mutuals lead when there are any; with none, taste matches lead rather than sitting under
> an empty heading. Nobody appears in both. A row is an avatar, a name, a handle, one line
> of context and one Follow control — not a second profile page.
>
> **There is one taste algorithm.** The suggestion rows call `taste_match`, the same
> function the profile calls, so a suggestion showing 87% and a profile showing 87% cannot
> disagree. Below the shared-title minimum there is no score and therefore no row.
>
> **~~Mutuals are counted, never named.~~ Superseded 2026-08-27 — the mutuals have names;
> the reversal is recorded in the As-built block below.** The original reasoning, kept for
> the record: every edge counted is one the reader could already select individually —
> both parties must pass `can_view_profile` — so the count discloses nothing new, and
> naming was declined on a fall-back-if-in-doubt instruction. The part that stands: a
> private account the reader cannot view is still not suggested here even though it is
> *findable* by name; surfacing it would mean disclosing who follows it.
>
> **Suggestions exclude** the reader, anyone already followed, anyone already **asked**,
> blocks in either direction, and suspended accounts.
>
> **Not in Feed, and not a sixth tab.** A "people you may know" card interleaved with real
> activity turns the timeline into a place where the app talks about strangers, and five
> tabs is the width of the bar. People is a *mode of the question For You already asks* —
> what next — whose honest answer is sometimes a film and sometimes a person.
>
> **Recommendation requests stay with the titles.** A held recommendation is a title
> recommendation; drawing it under People would make one surface mean two things.
>
> **Contacts are deferred, not built** — see [`deferred-roadmap.md`](./deferred-roadmap.md)
> §21. No permission is requested, no address book is read, and nothing is uploaded.

> ### As built — 2026-08-27: **Mutuals · Matches** are chips, and the mutuals have names
>
> Two revisions to the People surface from the external-beta polish tranche.
>
> **The two stacked sections became two filter chips** — `Mutuals` and `Matches` — the
> same compact selector treatment the title categories already use, because two lists
> answering different questions read better chosen than scrolled. Each mode has its own
> empty state naming its own cure (follow people / rank more titles); with both sources
> empty the chips are not drawn at all and the single quiet sentence remains. The
> taste-match scoring and the shared-title minimum are untouched: `taste_match` is still
> the one algorithm, and below the minimum there is no score and no row.
>
> **The founder reversed the count-only decision** (`20260827000100`): a card saying
> "1 mutual" without saying *who* asks the reader to follow a stranger on the strength of
> a number, and on the physical device that read as broken rather than careful. The
> privacy argument is completed rather than changed — every edge counted was always one
> the reader could select individually (both parties pass `can_view_profile`, blocks and
> suspension excluded by `can_discover_profile` on both ends); what had been withheld was
> only the aggregation.
>
> - The card's context line names the connection: **`Mutual: Abisola`** for one,
>   **`Abisola + 2 more`** for several. The server caps the inline list at three names;
>   the line stays one line.
> - The line is its own press target and opens a lightweight sheet listing the full set —
>   `mutuals_with`, the same predicates as the count, so the sheet can never show a name
>   the count did not include. Rows are informational (no follow control) and open the
>   person's profile.
> - The suggestion cards keep their shape: avatar, name, handle, one line, one control.

> ### As built — 2026-08-26: who a recommendation may be sent to
>
> **Following somebody is enough to recommend a title to them.** The rule is one-way and
> outbound: `sender → recipient, approved` authorises the send. Being followed *by*
> somebody grants nothing, because that is the direction an unwanted sender controls.
>
> | Relationship | Outcome |
> |---|---|
> | The sender follows the recipient, who follows back | delivered to their list |
> | The sender follows the recipient, who does not follow back | held as a **pending request** — never lost |
> | The recipient's follow is still pending (a private account) | not eligible until approved |
> | A block in either direction | refused, and nothing is stored |
>
> The sender is deliberately not told which of the first two happened, and never learns
> whether a request was added or thrown away.
>
> **A new follow is recommendable immediately.** The founder followed a public account on
> the device and the person was absent from *Send to* — the server would have accepted them
> and the picker was answering from a list it had assembled before the follow existed. The
> recipient list is now invalidated by every follow, unfollow, block, unblock and request
> response, so it is current by the time the sheet next opens. Caching is unchanged
> otherwise; nothing was globally disabled to fix it.
>
> **Added 2026-08-27: the picker is searchable.** *Send to* had a search field only past a
> hidden list-length threshold, which on the device read as a missing feature; the field
> now appears whenever there is anybody to filter, matching display name and @handle.
> Search narrows the list and nothing else — eligibility, the one-way follow rule, the
> delivered-versus-pending split and the pending cap of 5 per sender→recipient pair are
> exactly as specified above.

> ### As built — 2026-08-27: choose your people, then send once
>
> **Send to is a multi-select picker.** Each person row is a checkbox — the mark sits at
> the far right, exactly where the per-row send icon used to be, and tapping anywhere on
> the row toggles it. The sheet ends in two actions pinned under the list: **Recommend**
> (filled Maroon, the primary act, disabled at zero) beside **Share off bingd.**
> (outlined — the same native share carrying the reader's invite link, which needs no
> selection because whether the somebody has the app is a detail of the address).
>
> **The Recommend label is static, and the footer stacks rather than crushes** (founder
> device pass, 2026-08-27). It read `Recommend to N` and renamed itself on every tap,
> which made the widest control on the sheet a moving target; how many people are chosen
> is already said by the checkboxes above, so the button says what pressing it does and
> nothing else. The two actions take **equal halves** where the viewport has room for
> both at their natural width, and become **two full-width rows — Recommend first —**
> where it does not. Neither label may wrap or shrink to fit a column: the founder's
> Android screenshot showed `Share off bi / ngd.`, a word broken in half by a button
> squeezed below its own content width.
>
> **Multi-select changes the interface, not the semantics.** Each chosen person is their
> own `recommend_title` call under their own held operation id, so everything specified
> above is asked per recipient exactly as it was when every tap sent alone: eligibility,
> the delivered-versus-pending split, the pending cap of 5 per sender→recipient pair,
> and the rate ceilings. A retry replays an unanswered send under the id the first
> attempt spent, so one intent cannot become two recommendations however many times the
> button is pressed.
>
> **A batch that half-succeeds says so in full and loses nothing.** The people whose
> sends stored leave the selection — a retry must not spend another attempt on them —
> while the refused stay selected under a line naming them and the reason, so "try
> again" means exactly the failed half. The sheet closes only when everybody chosen has
> been sent, and the confirmation underneath then names the whole batch.

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

> ### As built — 2026-08-20: what **Refresh** promises, and what it does not
>
> For You ships with an explicit **Refresh** control in the filter row. It is the only thing that rearranges the wall: not a bookmark, not a reaction, not a navigation, not a cache invalidation. The founder's Preview pass found it failing its own promise — two consecutive presses kept **eight of the nine visible posters** and changed their order — so the semantics are stated here rather than left to the algorithm.
>
> **Refresh changes membership, not arrangement.** With a candidate pool deep enough to support it, roughly **65–80% of the first visible nine change**; measured, it is seven of nine. Up to **two** posters may survive, and only ones that are genuinely the two strongest candidates the engine has for this reader — relevance stays primary, and a Refresh that discarded the single best recommendation would be a reset rather than a refresh. A wall whose head is weak keeps nothing.
>
> **Session exposure, in memory, with no schema behind it.** The app remembers which titles it has already put on screen this session and prefers ones it has not. There is no exposure ledger in the database, no analytics dependency, and **no persistence across launches** — a genuinely fresh process starts with a clean slate. Durable cross-session impression history is the *Impression history* guardrail above and remains deferred: [`deferred-roadmap.md`](./deferred-roadmap.md).
>
> **Replacements stay inside the bounded, relevant pool.** Rotation reorders within the best `3 × slate` candidates by score and cannot promote anything from below it. Novelty never buys a weak title: where the pool genuinely runs out of strong unseen candidates, **overlap increases gracefully** and the wall stays full, rather than the wall getting shorter or the engine reaching further down to hit a turnover number. That target is a UX goal conditional on candidate depth, not an invariant.
>
> **Repeated Refresh keeps working.** #2 and #3 keep introducing session-unseen titles; the pool is three walls deep, so by the third press novelty is exhausted and the exposure penalty relaxes progressively. Even fully exhausted, the visible wall still turns over rather than settling into two alternating arrangements.
>
> **It costs no network request and produces no loading state.** Which titles are good is cached for half an hour; which arrangement is on screen is derived from that cache. So a Refresh is a sort: no skeleton, no white flash, no scroll jump, no new cache key. The same split is what stops a watchlist change from disturbing the wall at all.

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

**Eligible events:** a title was ranked (with its position), a title was logged with a bucket, a season was completed, **a title was added to a watchlist**, a list was created or added to, a milestone was reached, a user joined from an invitation.

**Privacy:** feed events inherit the actor's profile visibility. A private account's activity reaches only approved followers. Blocked users never appear in each other's feeds.

### As built — 2026-08-20: the activity sentence, watchlist activity, and the metadata line

Three founder decisions from the physical Android preview, taken together because they are one row.

#### An activity is one sentence

The row set the actor on one line and the title on the next, unconditionally:

```
[avatar] Suraj Kandukuri ranked
         21 (2008)
```

which made the title read as a *field of the row* rather than as the object of the verb — and on a short title it left half a line empty to do it. **The actor, the verb and the title are now one text block that the layout wraps where the width runs out.** There is no explicit line break anywhere in the row.

```
[avatar] Suraj Kandukuri ranked 21 (2008)
[avatar] Suraj Kandukuri ranked INVINCIBLE, S1 (2021)
[avatar] Suraj Kandukuri added Dune (2021) to their watchlist
```

- **Weight carries the structure, not size.** One type size for the whole sentence, the actor and the title in semibold Ink, the connective words muted, the year lighter still. Not every word is bold.
- **The year lives inside the title's run**, so a wrap can never orphan `(2008)` onto a line away from what it dates.
- **A sentence may need words after the title.** "Added Dune (2021) **to their watchlist**" does; forcing every type through one template gives "added to their watchlist Dune (2021)". Grammatical beats uniform.
- **Companions moved after the title** for the same reason: "Suraj watched Dune (2021) with Anna", not "Suraj watched with Anna Dune (2021)".
- Three lines is where truncation starts, and it truncates the tail rather than breaking the row. The score circle, the poster and the action row keep their positions.

The vocabulary is shared by the Feed tab, your own profile and somebody else's. It previously was not: the profile read `type === 'title_logged' ? 'watched' : 'ranked'`, so a finished season said "ranked" there and "finished" in the feed.

#### Adding to a watchlist is activity — founder decision, 2026-08-20

This is the active half of the [§22](#22-privacy-and-data-handling) decision that made the watchlist profile content. A shelf somebody has to go looking for is passive; **"Suraj added Dune to their watchlist" arriving in a follower's feed is an opening for "I want to watch that too"**, which is the product's core virality metric ([§28](#28-analytics-and-instrumentation)).

- **Server-owned, in the same transaction as the watchlist row.** The event is written inside `set_watchlist`, not by the client. `feed_events` has no insert policy and never has; every event in the schema is written by a `security definer` function that has already authorised the caller. Migration `20260820000300`.
- **One durable event per person and title**, enforced by a partial unique index rather than by convention. A retry of the same operation is absorbed by the operation ledger; a *second genuine call* — a double tap on two devices, a reconciliation that re-issues — is refused by the index.
- **The event outlives the row.** Removing the title from the watchlist, watching it, ranking it, or unlogging it all leave the activity in place. "Added" is a past-tense fact and stays true; deleting it would take other people's reactions and comments with it through the cascade, destroying a conversation because its subject changed their mind. This is deliberately the opposite rule from `title_ranked`, which *is* a claim about current collection state and is deleted on removal (`20260818000100`).
- **A re-add after a remove restores the row and inherits the original activity.** One event per pair for beta.
- **Privacy is inherited, not restated.** Nothing was added to the read path: `feed_events_read` is `can_view_profile(auth.uid(), actor_id)`, which resolves the same visibility as the `watchlist` table's own `can_i_view(user_id)`. A blocked, private-and-unapproved, suspended or deleted actor discloses nothing new. *The one asymmetry:* after a remove or a watch the event outlives the row, so a viewer may learn somebody once added a title whose entry is now gone — a past-tense fact about an act, disclosed only to the audience already entitled to that person's activity.
- **Reactions and comments work on it generically.** Neither `add_comment` nor `set_reaction` reads `feed_events.type`; both resolve existence and visibility from the event id alone. Recommend is offered except on a whole series, which cannot be ranked ([§10](#10-ranking-system)) — a guard that used to be theoretical and is now load-bearing, because `set_watchlist` is the one collection write that accepts a series.
- **A watchlist add carries no note and no companions.** Both are matched on (actor, title) rather than on the event, so without an explicit gate a watchlist row for a film its actor later watched would render "added Dune to their watchlist with Anna" under a verdict on the film. An intention is not a viewing.

#### The metadata line is standardised

```
movie    PG-13 · 148m · Science Fiction · Adventure
season   TV-MA · 8 episodes · Action · Animation
series   TV-MA · Drama · Thriller
```

- **Rating first**, which is what somebody scans before deciding whether to put a thing on, and the order the title page already prints.
- **A season is counted in episodes and never in minutes.** A season has no runtime, and the only minutes near it are the parent series' `episode_run_time[0]` — *one episode*. Rendered where a reader scans for "how long is this", `50m` for a twenty-hour season is worse than a blank. A series shows no length for the same reason.
- **A series-level episode total is never shown for a season.** The exact ranked or logged season is the canonical unit.
- **Two genres maximum.** The line is the subordinate element on a row whose sentence column is about 192pt on the narrowest supported device.
- **A season inherits its rating and genres from its series**, which is where TMDB publishes both — the same own-then-parent rule the genre resolution already used. Without it half the catalogue's feed rows carry a bare episode count.
- **Absent parts vanish with their separator.** No `Unknown · 148m`, no leading or trailing `·`, no `· ·`. A row with nothing to say renders no line at all rather than holding space open.
- **Sources.** The rating is `media_items.certification`, the US content certification TMDB publishes, stored since `20260817000900` and never fabricated. The episode count is `media_items.episode_count`, added by `20260820000400` from the per-season `episode_count` TMDB already returns on the series detail the adapter already fetches; a season enriched through its own route counts the episodes that route returns. Both are null until a title is next enriched, and both degrade to an omitted segment.

> **Corrected 2026-08-13.** This section said unfollowing "removes future events; it does not retroactively rewrite history the user already saw." That describes an inbox written per follower, and the feed is assembled on read (AD-6), so it was not true of the system being built.
>
> **Unfollowing removes that person's events from your feed entirely, past ones included.** The feed is a live query against your current follow set, not a record of what you have seen. Nothing is deleted, and a re-follow restores visibility. This is also the behaviour a user expects: someone who unfollows wants that person gone, not their last three weeks kept in place.

> ### As built — 2026-08-27: Profile → Recent activity is *their* most recent, however old
>
> **The contract.** Recent activity on a profile shows the target user's most recent
> eligible activities — five of them, newest first — **regardless of how old they are**.
> "Recent" means *their* most recent, not "recent enough for the feed": a person whose
> last ranking is years old still shows it, and an account with history never reads
> "Nothing here yet" merely because its owner has been quiet. The same target user shows
> the same Recent activity to themselves and to any authorised viewer, subject only to
> visibility — `feed_events_read` authorises the read on both paths, so a private
> account's activity still reaches only approved followers, and deleted events are
> simply absent.
>
> **The defect this names.** The own profile derived the section by filtering the
> viewer's *feed* — the newest ~30 events across the whole follow set — down to the
> viewer's own rows. Anybody who follows people more active than themselves had their
> history pushed out of that window before the filter ran, so the founder's own profile
> said "Nothing here yet" over a substantial collection on both platforms, while the
> same profile viewed by somebody else (which always asked about the actor directly)
> rendered fine — and ranking one new title "fixed" it, because the new event sat
> inside the window. Both profile screens now run the same one-actor query, newest
> first, limit applied *after* the actor filter. The Feed's own windowing is unchanged:
> it is a different surface making a different claim.

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

**Values are stored as meanings, not as glyph names.** `agree` rather than `thumbs_up`, for the same reason `taste_bucket` stores `loved` rather than "I liked it". Which symbol renders is a design decision, so swapping a thumb for a flame, or replacing the hands with faces entirely, is a copy change and never a data migration.

**A disagree reaction is included, against the earlier inference.** The reasoning that ruled it out — that a downvote is a pile-on mechanic — holds for a public network of strangers. It does not hold here: arguing about a friend's ranking is the point of the product, and the launch cohort is people who know each other. The pile-on risk lives in the *display*, not in the reaction existing, which is what the rule below addresses.

- **No free text.** This is deliberate: reactions carry zero moderation surface.
- Reacting notifies the activity owner.
- **Display — Required.** An activity item shows the distinct glyphs present and at most two names ("Jerry and Beth"), with a residual count. Press and hold opens the full list grouped by reaction. This keeps the feed uncluttered and is the pattern Messenger uses ([`../design/reference-notes.md`](../design/reference-notes.md)).
- **No reaction is ever aggregated onto a profile.** `disagree` in particular never becomes a running total attached to a person or to their Top 10. It is visible on the activity item it belongs to and nowhere else, which is the difference between banter and a scoreboard.
- Skin-tone variants are **not** in v1. They are a per-reactor rendering preference rather than part of the reaction, so adding one later is an additive profile column and touches no reaction data. See [`open-questions.md`](./open-questions.md) §2.
- Rate-limited to prevent notification flooding.

> **Comments are Deferred.** Comments would make Bingd a public user-generated-content platform, requiring a comment-specific report flow, hide and delete tooling, blocked-user filtering, and a stated response commitment. Reactions deliver the acknowledgment loop — which is what drives return visits — at a small fraction of the cost. Revisit when moderation capacity exists.

> ### As built — 2026-08-27: one reaction, wherever it is attached
>
> **A reaction is the same interaction on an activity and on a comment.** The six
> meanings above, the same glyphs, the same gestures: a plain tap toggles the default
> `love` on or off, and a **long press opens the same picker** — the six as one row,
> anchored inside the row it belongs to. A tap on a row already carrying some *other*
> reaction replaces it with `love` rather than clearing it: the gesture means "react",
> and the way to remove a reaction you can see is to tap the one you chose.
>
> **Display is the same grammar at a comment's scale.** The distinct meanings present,
> most common first and capped at three, beside the total. No count at all at zero. The
> control itself stays a heart — filled Maroon when the reaction is mine, outline when
> it is not — rather than showing my own glyph, because the cluster beside it already
> does: one emoji twice in one row reads as a duplicate rather than as two statements.
>
> **This overturns a narrower decision, deliberately.** Comments shipped (2026-08-26)
> with a boolean like, on the reasoning that the six meanings were about a whole activity
> and a single remark deserved a toggle and a count. The founder overturned it on a
> device: holding the control offered six on a feed row and nothing on a comment one
> swipe away, and the same gesture doing different things in two places is the
> inconsistency, whatever the smaller surface deserved on its own. **Every like that
> already existed is preserved as `love`.**
>
> **Replies take reactions exactly as roots do.** A retracted comment takes none — a
> tombstone is a place in the conversation, not a comment.
>
> **What is deliberately *not* shared: notifications.** Reacting to an **activity**
> notifies its actor (above). Reacting to a **comment** notifies nobody, and that
> difference is intentional rather than pending. A remark on somebody's remark is the
> densest thing in the product, and six meanings on it would multiply an inbox that has
> not been asked to grow. The interaction is unified; the notification volume is not.
>
> **Privacy is unchanged and is resolved once.** The count, the glyphs and "mine" all
> come from a single visibility-filtered set, so a reaction from an account the reader
> may not see is absent from all three — never counted anonymously.

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

### As built — Bingd Awards, shipped 2026-08-18

v0.6 listed Achievements under §8 **Deferred** and specified them in [`backlog.md`](./backlog.md) §1. They shipped. This block is the record of what shipped, and the specification in the backlog is now historical.

**Twenty tracks, thirty badges, and no table behind any of it.**

- Reached from **Profile → Awards**, as a sheet. A grid where locked and unlocked sit together, because the locked slots are the reason to come back and they only read that way beside the unlocked ones.
- **Every award is derived from canonical tables** — `user_media`, `rankings`, `watchlist`, `follows`, `title_recommendations`, `invite_attributions`, notes. There is no award table, no event log and no stored progress. An achievement system with its own event log is a second source of truth about somebody's collection, free to disagree with the first.
- Tiered, with progress shown on anything countable, and each track states what earns it.
- **No social surface**: no comparison, no leaderboard, and nothing is told to anybody else. *(Since the profile unification, another person's sheet is viewable from their profile — see the visibility note below — which is still not a comparison: it is their sheet, read under the viewer's ordinary visibility.)*
- **Ten of the twenty tracks still render an emoji placeholder** rather than drawn art, asserted by test so the number cannot drift silently. [`deferred-roadmap.md`](./deferred-roadmap.md) §14.

**What a watch-based award counts, and what a visitor sees (clarified 2026-08-27).** "Watch 50 movies" counts **unique logged titles** — rows of `user_media`, one per `(account, title)`, which ranking also writes because ranking is the watch claim ([§10](#10-ranking-system), decided 2026-08-24). A rewatch or a corrected date never mints a second unit. Opening somebody else's Awards computes **their** progress from the same canonical rows: the collection-based tracks read the `logged_collection` projection (20260827000400), which is §22 applied — the logged *titles* inherit profile visibility exactly as rankings do, while the watch date and note text stay private at every visibility level, so a visitor's Movie Muncher equals the owner's own and their drill-down simply carries no dates. The two facts with no cross-user read by design — sent recommendations and activated invites, both two-party — are shown as **withheld** ("Only they can see this one"), never as a zero the database did not assert. This paragraph exists because a real device showed `Movie Muncher 0 / 50` on a profile whose header said 34 movies: the award was reading a table whose policy answers a visitor with zero rows and no error.

**Genre Gremlin is 14 / 16 / 17 distinct genres, rebalanced 2026-08-20.** It was 12 / 14 / 16, and the founder's Preview verdict was that the whole ladder was too easy and too compressed rather than that one number was wrong. Measured over the loggable catalogue by `scripts/awards/genre-ladder-report.mjs` — which is reproducible, unlike the calibration the previous thresholds rested on — the old ladder cost a median of **15 / 27 / 62** logged titles, against 250–300 for every other Gold in the set. The new one costs **27 / 62 / 116**, roughly doubling at each step.

**Gold is 17 of 18 and deliberately not 18.** Seventeen lets a reader miss any one genre; eighteen names the rarest row in the catalogue and demands it. Documentary is carried by 6 of 1,814 loggable rows and Animation by 10, and the last genre costs a median of **126** further titles against 45 for the seventeenth — so 18 would convert breadth into a scavenger hunt, which is the one thing the award is not for.

**Moving a threshold un-earns a tier, and that was accepted rather than mitigated.** Awards are derived live with no unlock ledger, so a tier is recomputed rather than held: Dabbler goes back from anybody on 12 or 13 genres, Mixer from 14 or 15, Chaos Collector from exactly 16. The population that can affect is the founder's account and test users — there is no external tester — and grandfathering would need the durable ledger that award *notifications* are already waiting on. **This is the last threshold change that can be made for free.**

**Invite Instigator counts activated invitees and therefore reads zero.** It counts `invite_attributions.activated_at is not null`, which nothing writes — see §17's As-built block. It previously counted link creations, which made it a badge for pressing a button, and the founder's instruction was that the award is for bringing people to Bingd. So the metric was moved to the honest one immediately and the number left at zero rather than the semantic left wrong until the backend caught up. It renders **0 / 3**, not an error: the read succeeded, the table is real, and the answer is genuinely none.

**Award notifications are deferred**, and this is a disposition rather than an oversight. Tiers are computed entirely on the device from raw reads, so **no durable state records which tier an account has reached** — and notifying only on a *crossing* needs exactly that. The `award_earned` type, the `awards` category defaulting off, its preference row and its route to this sheet all exist; only the writer is missing. §15's As-built block and [`deferred-roadmap.md`](./deferred-roadmap.md) §5.

---

## 15. Notifications and activity awareness

**New in v0.6.** This resolves a structural absence in v0.5, where the brand system referenced notifications but no notification feature existed anywhere in scope, information architecture, entities, tests, or metrics.

### Build posture — Decided for public alpha

Build the **entire** system in v1: event generation, in-app inbox, per-category preferences, and a delivery abstraction that can route to inbox, push, or both.

**Push is installed but off.** `expo-notifications` and the Apple and Google push credentials are configured in the **first** development build. Push **delivery** is flagged off at launch. *(As built: the module shipped, the credentials and the native configuration did not, and no delivery flag was ever built. See the two notes below.)*

> **As built:** the module is in every build and the credentials are not. See the As-built block at the end of this section.
>
> **Corrected 2026-08-24.** This note previously ended "the distinction decides whether enabling push needs a new binary, and it does not." That was wrong. The module being present decides whether a new native *dependency* is needed, which is a smaller thing. Push notifications ship in `public/push-v1`, and turning them on **does** require a new production binary and a store submission — because the production *native configuration* changes: the iOS APNs environment and the Android `googleServicesFile`. See [`deferred-roadmap.md`](./deferred-roadmap.md) §4 and [`docs/architecture/push.md`](../architecture/push.md).

> **Why this specific arrangement.** Push requires native configuration. If the module is absent when the app reaches the stores, enabling push later requires a new native build *and* a new store submission — plus a dependency change, autolinking and a native module graph that all move together.
>
> **What this actually bought, stated correctly (2026-08-24).** Having `expo-notifications` present from v1 removed the *dependency* half, not the *binary* half. The native configuration it needs — `aps-environment: production` on iOS, `googleServicesFile` on Android — was never declared, and neither can be changed over the air. So enabling push is three lines of native configuration and a new production binary, not "a server-side flag plus an over-the-air JavaScript update" as this paragraph originally claimed. That is still meaningfully cheaper than adding the dependency late, and it is not an afternoon.

### v1 event set

| Event | Inbox | Push (when enabled) |
|---|---|---|
| Someone joined from your invite | Yes | Yes |
| You joined from someone's invite | Yes *(added 2026-08-23)* | Yes |
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

### As built — 2026-08-19: taxonomy, categories, and what a preference actually governs

Reviewed at 23f PASS. Where this block and the v1 event set above disagree, this block is what ships.

**Twelve notification types.** The canonical names are `follow`, `follow_request`, `follow_approved`, `comment`, `reaction`, `watch_tag`, `recommendation`, `recommendation_ranked`, `invite_activated`, `invite_welcome`, `friendship`, `award_earned`.

> **`recommendation_ranked` added 2026-08-27** (`20260827000600`). The other end of a recommendation: when the recipient first reaches a completed **ranking** for the title, each outstanding delivered recommendation is fulfilled and its sender is told — "Suraj ranked The Martian from your recommendation" — with the notification pointing at the recipient's exact `title_ranked` feed event. See the second 2026-08-27 As-built block below for the lifecycle and the once-only semantics.

> **`friendship` added 2026-08-27** (`20260827000200`). The accepter's own durable record of approving a follow request — see the 2026-08-27 As-built block below. Deliberately in **no category** (the unmapped-type rule delivers it unconditionally: a record of your own action is not a preference axis) and **not push-eligible** (a phone buzzing about the reader's own tap is noise).

> **`invite_welcome` added 2026-08-23** (`20260823000100`). The only type whose recipient is a *brand-new* account: it is filed for the **invitee** by `redeem_invite`, names the inviter, and is the first thing anybody sees in Bingd. It exists because the invitee was the one party to an invitation being told nothing — §17 already creates their follow and already notifies the inviter, so a person who joined through a friend's link arrived to a follow they never watched happen and an empty inbox. A beta tester reported it as a Feed that starts empty.
>
> **Exempt from the category gate, like `follow_request`**, and for a related reason: it fires once, at account creation, for somebody who has never opened the settings screen and has nothing there to have chosen. A preference that could silence it could only ever be silenced by accident.
>
> **Exactly one per account, for ever.** The mechanism is the insert's position inside `redeem_invite` — it is reachable only when the `invite_attributions` row was genuinely new, and `invitee_id` is that table's primary key. A partial unique index backs it up. **It is an inbox row.** As of 2026-08-24 it is also a push: `invite_welcome` is one of the eight eligible types, and like every other it is pushed only because the inbox row was written first.

**Eight categories, one per kind, each with its own default.** `recommendation` had been in no category at all, so the trigger's `case` returned null, the unmapped-type rule delivered the row unconditionally, and **a recommendation could not be switched off** — by accident rather than by decision. That is the defect the settings screen would otherwise have shipped on top of.

| Category | Types | Default |
|---|---|---|
| `follows` | `follow` | **on** |
| `follow_accepted` | `follow_approved` | **on** |
| `comments` | `comment` | **on** |
| `reactions` | `reaction` | **off** |
| `watch_tags` | `watch_tag` | **on** |
| `recommendations` | `recommendation`, `recommendation_ranked` | **on** |
| `invites` | `invite_activated` | **on** |
| `awards` | `award_earned` | **off** |

`reactions` defaults off because it is the only event whose median notification carries nothing beyond "somebody saw this". `awards` defaults off because **nothing writes one**.

**Absence means the default, not "enabled".** There is no preference row per category per signup and no backfill when a category is added; absence resolves to the category's own default. The data migration therefore expanded only `enabled = false` rows — under the old semantics a `true` row was indistinguishable from no row, so expanding one would have manufactured a deliberate opt-in out of silence.

**A preference governs creation, not delivery.** The gate is a **before-insert trigger that returns null**: off means the row was never written.

> **Decided 2026-08-24, when push arrived: one axis, and it is structural.** These switches govern push too, and not because anything consults them a second time. `_apply_notification_preference` is a `BEFORE INSERT` trigger returning null, and a row skipped by a before-row trigger fires no after-row trigger — so the `AFTER INSERT` trigger that writes `push_outbox` is unreachable for a suppressed notification. **No notification row, no push**, by construction rather than by a check that could be forgotten. No per-channel settings were added. See [`docs/architecture/push.md`](../architecture/push.md) and [`deferred-roadmap.md`](./deferred-roadmap.md) §4.

**`follow_request` is unsilenceable**, stated as its own condition in the trigger. It is a task rather than news: somebody is waiting on an answer.

**Settings offers a switch per category plus two master groups** — everything social, and everything about you — over a **Turn all off**, and it reflects the OS permission state honestly.

#### Routing

Each type has an ordered chain whose last link always resolves. Staleness is read from the holes `my_notifications` already leaves — a null actor handle, a null media item — rather than from a second existence query, which would be a second authorisation surface and the one most likely to get it wrong.

| Type | Target | Fallback |
|---|---|---|
| `follow_request` | requester's profile | unavailable notice |
| `follow` | follower's profile | unavailable notice |
| `follow_approved` | approver's profile | unavailable notice |
| `friendship` | requester's profile | unavailable notice |
| `comment` | the exact feed activity | the title, then unavailable |
| `reaction` | the exact feed activity | the title, then unavailable |
| `watch_tag` | the Movie or Season | unavailable notice |
| `recommendation` | the Movie or Season | recommender's profile, then unavailable |
| `recommendation_ranked` | the recipient's exact ranking activity | the title, then unavailable |
| `invite_activated` | the joined user's profile | unavailable notice |
| `invite_welcome` | the inviter's profile | unavailable notice |
| `award_earned` | the Awards sheet | — |

~~**Comment and reaction route to the title rather than to the exact feed event, deliberately.**~~ **Superseded 2026-08-26**: the per-event route exists (`app/activity/[id].tsx`, reading one event by id through `feed_events_read`), and comment, reaction and — since `20260827000600` — `recommendation_ranked` all open the exact activity, with the title as the surviving parent when the event is gone. The deferral in [`deferred-roadmap.md`](./deferred-roadmap.md) §6 is closed.

#### What is **not** built

- ~~**Push is dark.**~~ **Built 2026-08-24 (`public/push-v1`); delivery is pending a production binary.** Registration, delivery, permission timing and deep-link routing all exist: `register_device_token` / `revoke_device_token`, a `push_outbox` fed by an `AFTER INSERT` trigger on `notifications`, and a `push-sender` Edge Function that talks to Expo Push. What is **not** yet true is delivery to a phone, and the reason is native rather than server-side — the production APNs environment and the Android `googleServicesFile` are new native configuration, so a **new production binary** is required. The friend-beta binary is deliberately unaffected: its fingerprint does not move and it keeps receiving over-the-air updates. See [`deferred-roadmap.md`](./deferred-roadmap.md) §4 and [`docs/architecture/push.md`](../architecture/push.md).
- **Re-verified 2026-08-23**, after a real follow produced an inbox row and no phone notification. Every stage after the native module is absent: zero calls to `requestPermissionsAsync`, `getExpoPushTokenAsync` or any notification listener; no import of `expo-notifications` anywhere in `src/` or `app/`; `device_tokens` present with no writer and no `register_device_token` RPC; `tmdb-adapter` the only Edge Function; nothing anywhere calls Expo Push, FCM or APNs. **The founder received no push because nothing in this repository has ever been able to send one.** That is an unbuilt feature behaving as expected rather than a defect — but §15's build posture above and the §27 checklist both read as though push credentials were configured, and both now carry corrections. **Superseded 2026-08-24:** every stage listed here now exists. The paragraph is kept because it is the record of how the gap was found, and because the conclusion drawn from it at the time — that no new binary would be needed — was itself wrong and is corrected above.
- **The scheduled nudge** does not exist. It was deferred with push and stays deferred: nothing drains `push_outbox` on a timer, so it is the scheduler that is missing rather than the delivery path. [`deferred-roadmap.md`](./deferred-roadmap.md) §4.
- **`invite_activated` gained its writer on 2026-08-19** (`20260819000500`) and is no longer in this list. It is filed by `_maybe_activate_invite` at the activation transition — server-side, once, and not from a client observing a column. It respects the `invites` category, is not written across a block, and is not written when the inviter has gone. §17 As built.
- **`award_earned` has no writer**, and this is a disposition rather than an omission. Award tiers are computed entirely on the device from raw table reads; **no durable state records which tier an account has reached**, so a *crossing* cannot be distinguished from a *state*, and exactly-once delivery is impossible without an unlock ledger. An award notification that fires twice is worse than one that never fires. [`deferred-roadmap.md`](./deferred-roadmap.md) §5.

### As built — 2026-08-27: acceptance leaves a record, and a comment push carries the comment

Two founder corrections from physical beta use, shipped in the external-beta polish tranche.

**Accepting a follow request files a durable `friendship` record** (`20260827000200`). Before this, approval deleted the actionable `follow_request` row and nothing replaced it — the Bell kept every social fact except the one where two people connected. The shape chosen is **resolve-and-create**, not transform:

- The `follow_request` row is still cleared exactly as before; an Accept control must never be drawable twice. The requester's own `follow_approved` notification is untouched.
- Approval additionally inserts one `friendship` row to the **accepter**, actor the requester, born **pre-read** — it reports the reader's own tap, and a row born unread would badge an action they just took.
- **Exactly once, with no new machinery**: the insert rides the same operation-id claim and consumption of the pending `follows` row, under the same pair lock, that has always made approval single-shot. A retried operation returns `already_applied` before touching anything; a second approval finds no pending row and raises before the insert commits.
- `payload.mutual` freezes whether the accepter also followed the requester **at the moment of acceptance** — a later unfollow does not rewrite what the row said. The Bell renders the mutual case as **"You and Abisola are now friends"** and the one-way case as the ordinary "Abisola now follows you", with a follow-back control offered exactly when the relationship gate would show one.
- Routing: the requester's profile, same chain as the follow family.

**A comment push leads with the comment** (`20260827000300`). The founder's report: the visible line was all metadata — who, that they commented, a long title — and the thing the person wrote was nowhere. Comment pushes are now **title: "Abisola commented" · body: "“That ending was wild” · Spider-Man: Far From Home"**.

This deliberately relaxes exactly one cell of the no-free-text-in-push rule, on three conditions enforced server-side in `claim_push_batch`:

1. **Already authorised** — the recipient is the activity's owner or a replied-to commenter; the comment is content written *to* them, readable in full one tap away.
2. **Never a spoiler** — a spoiler-marked comment ships no excerpt (the author asked for a tap between reader and text; a lock screen has no tap) and falls back to the metadata sentence.
3. **Resolved at claim time** — a comment deleted before the drain yields no excerpt and the copy falls back rather than quoting something retracted.

The server carries at most 180 characters; the sender tidies to one line and elides at 120. Reviews, notes, bios and search terms remain structurally excluded — `claim_push_batch` has no column for them.

### As built — 2026-08-27, second tranche: a recommendation that hears back, and an inbox with rhythm

Two founder requests, shipped together (`20260827000600`).

**The recommendation lifecycle now closes.**

> recommendation sent → recipient **ranks** the title → recommender receives **one** fulfilment notification → the notification opens the recipient's **exact ranking Feed activity**.

- **What fulfils**: the recipient's *first* completed ranking of the title — the `rankings` insert inside `_rank_finalize`, the one place a ranking is created. It is the same `not v_replaced` fact that gates the `title_ranked` feed event, so a fulfilling rank always has a post to point at. Opening the sheet, picking a bucket, logging, watchlisting or abandoning a session fulfils nothing.
- **Once, ever, per recommendation**: `title_recommendations.fulfilled_at`, written in the ranking's own transaction and guarded by `is null`. A Rank Again, a bucket change, a lost-response retry (the operation ledger returns the prior answer without re-entering the body) and a concurrent second device (serialised by the media lock; raced in `concurrency/races/recommendation.mjs` C5) all notify nobody twice. A partial unique index on `payload.recommendation_id` backs the guard the way the welcome's index backs `redeem_invite`. The column is granted to **no client role** — the sender hears through the notification or not at all.
- **Several recommenders**: each outstanding delivered recommendation is its own row, so each sender receives their own single notification, all pointing at the same event.
- **Only delivered recommendations that preceded the rank**: a *pending* (held) request does not fulfil, and accepting one after the title was ranked delivers a recommendation that simply never fulfils. Recommending an already-ranked title remains allowed — the current contract has never prevented it — and earns no retroactive credit; the row can only fulfil if the recipient unranks and later ranks afresh, at which point the recommendation did precede the qualifying rank. Nothing was backfilled at migration time.
- **Privacy is the feed's own rule**: fulfilment and notification are decided separately. Every matching row is consumed; only senders passing `can_view_profile(sender, ranker)` — no block either way, sender active, ranker public or followed — are told. A sender refused at rank time is refused for ever, so lifting a block later cannot fire a stale notification. `pending`-state rows, the recommendation's own privacy posture, and the note-free payload are all unchanged.
- **Copy**: inbox and push both say **"Suraj ranked The Martian from your recommendation"** (seasons through the standard compact form: "…ranked The Legend of Vox Machina, S1 from your recommendation"). Push rides the existing pipeline — `recommendation_ranked` is push-eligible, shares the `recommendations` preference category (two ends of one exchange, one switch), and carries the same five-field tap payload every push carries; the tap lands where the inbox tap lands.

**The inbox gained hierarchy without furniture.** The founder's screenshot: every kind of event running together as one undifferentiated column. What shipped, deliberately short of a redesign:

- A hairline rule between rows, inset to the text edge so the avatar column stays unbroken — the house divider (`border.hairline`, double hairline width), never a card per row.
- Three age shelves in the existing small-caps maroon heading voice — **Today**, **This week**, **Earlier** — using the same rounding as the relative timestamps so a row never sits under a heading its label contradicts. Headings render only when they separate something: at least two shelves, or a Follow-requests section above. No tabs, no per-type categories, no filters.
- Everything else held: parchment ground, unread as tint + maroon dot + spoken "Unread", timestamps secondary, row actions (Approve / Decline / Follow back) inset to their row's own text edge, the bell + gear settings control untouched.

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

> ### As built — 2026-08-19: none of those nine events exists
>
> The measurement rule above is right and has been kept; the event list is a specification for a share funnel that was never instrumented, and **six of the nine describe states this app cannot observe at all** — there is no web property, so a link open, an app open from a link, an install click, an attributed signup and an attributed activation have nothing to record them.
>
> The friend-beta event set is thirteen events and is defined in [`analytics.md`](./analytics.md). The growth events are **`invite_link_created`**, which follows the `invite_link_creations` row rather than the tap, and — since 2026-08-19 — **`invite_redeemed`** and **`invite_activated`**, which follow the attribution row and the activation transition. Sharing is otherwise uninstrumented, deliberately: **opening an OS share sheet is not a share completed**, which is the same rule this section already states.

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

Any future reward must count **activated** invitees only, so it cannot be farmed with throwaway accounts.

> **Corrected 2026-08-19.** This clause read "recipient ranked at least one title", which contradicts §28's canonical definition — **activation is ten ranked titles** — and would have handed the future resolver two incompatible contracts to write `invite_attributions.activated_at` against. §28 wins, here and everywhere: one ranked title is a tap, and the whole point of gating a reward on activation is that it is not farmable.

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

> ### As built — 2026-08-19 (second pass): the resolver exists, deferred install does not
>
> This block replaces "the link exists, the resolver does not". `20260819000500` gave `accepted_at` and `activated_at` their first writers, and `bingd.app` gained a router. What is still missing is named at the bottom, and it is one thing.
>
> **The invitation contract, and it is permanent.** What a person shares is `https://bingd.app/i/<token>` and nothing else. Not a TestFlight URL, not a Play URL, not a `bingd://` URL — those are *destinations behind* the link, configured in `web/distribution.config.json`, and changing them changes no invitation anybody has already sent. The same URL is valid across development, Preview, TestFlight, a Play closed test, an open test, and both public stores.
>
> **What is now built:**
>
> - **`record_invite_open(token, platform)`** — anonymous, and **returns void in every case**, so an unknown, revoked or cross-environment token is indistinguishable from a live one. It is not a token oracle. Capped per token per hour, because an anonymous caller has no identity to rate-limit. Writes to `invite_link_opens`, which no client may read.
> - **`redeem_invite(operation_id, token)`** — authenticated, after profile creation. Writes `invite_attributions (invitee_id, inviter_id, token_id, accepted_at)` and `profiles.invited_by`. Unknown, revoked and cross-environment are **one refusal**. Self-invitation, blocks in either direction, and a suspended or deleted inviter are all refused. The primary key on `invitee_id` is what makes it idempotent: **no replay, no second token and no second device can move an attribution once written.**
> - **Activation** — `_maybe_activate_invite`, called from `_rank_finalize`, the single place a `rankings` row is created. The criterion is §28's: **ten ranked titles**, across both categories. The transition is once, from the row lock on a guarded `UPDATE ... WHERE activated_at IS NULL` rather than from any ordering assumption.
> - **The `invite_activated` notification** now has its writer. One row, to the inviter, at the activation transition — not from a client observing a column. Respects the `invites` preference category, and is not written across a block or to an account that has gone.
> - **`invite_redeemed` and `invite_activated` analytics**, both emitted from a server outcome. `acquisition_source: 'invite'` has its first honest writer.
> - **The web router at `bingd.app`** — `/i/*`, `/u/*`, `/title/*`, `/lists/*`, plus the two `.well-known` files. Static, no server, no third-party SDK. Platform routing offers iPhone or Android their own destination and offers a desktop browser both, never guessing.
>
> **Acceptance semantics above are implemented in full.** Redemption writes the attribution, creates the one-way follow of clause 2, files a **request** instead when the inviter is private (clause 3), and notifies the inviter (clause 4) — who is never auto-followed. Clauses 1, 5, 6 and 7 were already met: the tap is explicit, the recipient is unnamed until it commits, a block voids the invitation, and the attribution is written independently of the follow.
>
> The screen also carries clause "an option to switch": it names the account that will be attributed *before* the tap and offers to sign out. The switch first makes **the invitation on screen** the pending one, then signs out — so the invitation survives the switch, and it is the invitation the person was actually looking at. Merely *opening* a second link still does not move anything, because a link tapped is not a decision.
>
> **The first version of this run shipped the attribution and no follow**, recorded here as a deliberate narrowing. Independent review 26 rejected that and was right to: a specification is not amended by a note saying it was not implemented. The reasons offered — a smaller concurrency surface, a stricter reading of the privacy clauses — were arguments for an implementation convenience, not authorisation to change what acceptance means.
>
> **Revocation is now real, and it is here rather than in a later run for a specific reason.** The token model above has promised "revoke and regenerate from Settings" since v0.6, and `invite_tokens.revoked_at` has existed since `20260813001300` with no writer. Until this migration a leaked link resolved to nothing, so the gap cost nothing; this migration makes a leaked link a live attribution vector, so the same change owes the control that takes it back. `revoke_invite_link` revokes and mints the replacement in one transaction — `invite_tokens_one_live` permits exactly one live token, and an account with none is a state the Share control cannot answer — and Settings › Privacy has the confirmed control. Attributions already accepted against the old link are untouched: revoking withdraws the invitation, it does not un-invite anybody.
>
> **An invitation refused because the inviter was momentarily unreachable is retried, up to a point.** A block in either direction and a suspended inviter both produce the same refusal, and both get lifted — so the device keeps the invitation and tries again on later launches, with a fresh operation id each time, up to five refusals in total. It gives up after that because the same refusal also covers a *deleted* inviter, which never recovers. Independent review 26 found the first version discarding these permanently, and 26b found the retry inert because it reused a spent operation id.
>
> **Deferred install attribution is NOT built, and this is stated plainly rather than approximated.** Universal Links and App Links carry a token only when the app is **already installed**. There is no Play Install Referrer path and no attribution SDK, and there will not be one built on fingerprinting, probabilistic matching, clipboard reading or any hidden identifier. The honest mechanism is: the landing page keeps the token in the address bar, and after installing, the visitor **returns to the same page** and taps *I already have Bingd*. If they instead launch Bingd from TestFlight or from Play, **attribution is lost** — silently, and permanently for that person. The page says so before they leave it. Analytics under-counts accordingly and no number anywhere is adjusted for it.
>
> **Invite Instigator counts real people now.** The query is unchanged — `count(*) where inviter_id = auth.uid() and activated_at is not null` — and it has stopped being structurally zero. Links created do not count, links opened do not count, and a redemption without activation does not count.
>
> **What is still not built, and it is one thing:** a **live `bingd.app` deployment**. The site builds, its tests pass, and the two `.well-known` files are generated from one config — but nothing is hosted yet, so **Universal Links and App Links cannot verify and have never been tested on a physical device**. Until that happens the invitation link opens a browser that 404s. This is the one remaining gap between the resolver being written and the resolver working, and it is a founder action rather than an engineering one.
>
> The **Required** half of Rewards above still stands: any future reward must count activated invitees only, which is now a number that exists.

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
| Display name, username, avatar | **Watch dates** |
| Top titles and rankings | **Notes, unless the author shares one as a review** — moved 2026-08-23, see below |
| **The Logged collection and its buckets** | Import history |
| **The watchlist** — moved 2026-08-20, see below | Email and account identifiers |
| Public lists | Capability and Early Access state |
| Feed activity | |
| Reactions given | |
| **Reviews** — notes the author chose to publish | |

**Identity is discoverable at every visibility level, and content is not.** Handle,
display name and avatar are findable by anyone signed in, including for a private
account, so that somebody can be found and sent a follow request — see §8's As-built
note. Being unfindable was never what private was meant to mean. What private gates is
everything in the left column above.

> **As built — 2026-08-23: the Logged collection is stricter than this table says.** The
> left column promises "The Logged collection and its buckets", and the founder decision
> below is what that promise came from — but the view that would implement it,
> `visible_collection`, was never created. `user_media` has one owner-only policy and no
> second path, so what another reader can actually see is **ranked titles, through
> `rankings`**. A title that is logged but not yet ranked is visible to nobody but its
> owner. That is *less* exposure than promised, not more, so it is a gap in the feature
> rather than in the privacy contract — and the copy in Settings says "ranked titles"
> for exactly this reason. Recorded in `architecture/data-model.md`.

> **Founder decision, 2026-08-13.** The **Logged collection inherits profile visibility**, exactly as rankings do. The collection is part of the profile and follows the same rules; it is not a separate privacy domain. This table previously listed neither state for it, so the behaviour was going to be decided by whoever wrote the view.
>
> Three boundaries this does **not** move, all of which stay as they are:
>
> - ~~**Notes and watch dates remain always-private**, even on a public profile and even on a title whose bucket is public. A visible Logged entry is the title and the bucket, nothing else.~~ **Half superseded 2026-08-23 — see the Notes and Reviews block below.** **Watch dates remain always-private and that has not moved**, on any profile, at any visibility, to anybody. **Notes did move**: a note can be published by its author as a Bingd Review. An unpublished note is still exactly as private as this line says.
> - ~~**The watchlist remains always-private at every visibility level.**~~ **Superseded by the founder decision of 2026-08-20 — see the block immediately below.** The original reasoning stands as written: it is intent about things you have not watched, which is a different disclosure from a reaction to something you have, and it was left private pending an explicit decision.
> - **A private profile's Logged collection is visible to approved followers only**, on the same terms as its rankings.

> **Founder decision, 2026-08-20.** **The watchlist now inherits profile visibility**, on the same terms as rankings and the Logged collection. This is the separate decision the 2026-08-13 note invited, and it was taken for a product reason: Top Ranked says what somebody loves, and the watchlist says what they want to watch next. The second is the socially actionable half — "I want to watch that too" is a reason to message somebody, and a private watchlist cannot produce one.
>
> Implemented as one line of RLS. `watchlist_own` (`user_id = auth.uid()`) became `watchlist_read` (`can_i_view(user_id)`), which is the oracle `rankings_read` already uses — migration `20260820000200`. No new table, no new column, no client-side visibility check. So:
>
> - a public account's watchlist is readable;
> - a private account's is readable by **approved followers only**;
> - a block in either direction hides it;
> - an account the viewer may not see returns **zero rows**, and the section renders nothing — no titles, no count, and no "nothing saved yet", because a placeholder is itself a statement about an account the reader is not entitled to.
>
> **Writes were not widened and could not have been.** `watchlist` has never had an insert, update or delete policy; `set_watchlist` is `security definer` and checks the caller. **Watch dates are unaffected** and remain always-private on every profile. This moves one row of the table above and nothing adjacent to it. *(Notes were named here too, and moved separately on 2026-08-23 — see below.)*
>
> `created_at` becomes visible to a viewer who can see the row, which is intended: the shelf is ordered most-recently-added first. It is a *save* time, not a watch date.

Rationale, and the reason this needed deciding rather than defaulting: a public Logged collection is what makes a profile worth visiting before someone has ranked much. A new user with 200 imported titles and 12 ranked ones has a profile that is mostly empty if only rankings show, which is the same cold-start problem private-by-default would have caused, applied to the individual profile instead of the network.

> **Founder decision, 2026-08-23 — Notes and Reviews.** **A note is private until its
> author publishes it as a review.** This supersedes "Notes are always private", which
> the v0.6 table above asserted and which stopped being true when public notes shipped
> as Bingd Reviews (`20260816000000`, and the Reviews tab decision recorded in
> `reference/tmdb-integration.md`). Both statements were in this document at once and
> could not both hold.
>
> The contract, in full:
>
> - **A note has its own visibility**, `private` or `public`, stored per title on the
>   author's own row. It is the author's choice and nothing else sets it.
> - **A public note is a Review.** It appears on the title's Reviews tab and on the
>   author's profile, attributed, beside their score. That is the whole of what
>   publishing means — there is no separate review object and no second piece of text.
> - **A private note is visible to its author and to nobody else**, on either account
>   setting, with no exception for followers.
> - **Account visibility gates a published note as well.** Publishing does not escape
>   the profile: a review by a private account is readable by approved followers only,
>   and a block hides it in both directions. Publishing widens a note as far as the
>   account allows and never further.
> - **Watch dates are not part of this and never become visible.** The read paths that
>   serve reviews (`public_notes`, `title_reviews`) project the note columns alone,
>   deliberately, because the row they come from also carries `watched_on`.
>
> **New notes are private by default** *(client, 2026-08-23)*. They used to open public
> on the reasoning that a new note is the forward-facing social case. The field a reader
> types into is called *Notes*, it saves on blur with no Done button, and free text
> should not be published because somebody did not notice a chip. Writing a review is
> still one tap — the control now names that act, *Share as a review*, rather than
> naming its absence — and the Reviews tab's own "Write a review" opens ready to
> publish, because arriving through that door is the request.
>
> **A note that already exists always opens on the visibility it was saved with**,
> whichever door the reader came through. Nothing about this decision changes a stored
> row: notes written under the private-only promise were force-set private by
> `20260816000000` and stay that way, and published reviews stay published.
>
> **One thing is deliberately left open.** The server's own forward default is still
> `public` when a caller passes no visibility — the app never does, so nothing today
> relies on it, but the client and the server now disagree about what an unspecified
> new note means. Closing that is a migration and a founder decision, recorded in
> `open-questions.md` §8.
> **Founder decision, 2026-08-23 — Ranking, Review and Private note.**
>
> Three things a person can produce about a title, and the app now names them the way
> this section does. **No schema changed to make this true**: the storage was already
> correct and the words were not.
>
> **1. A ranking is the opinion.** It is Bingd's core signal and it needs no writing at
> all. A ranking with nothing written is complete: it sets the bucket, the position, the
> personalized score and the Collection place, and it contributes on the existing terms
> to the aggregate `bingd.` score, the Following score, Taste Match, recommendations and
> Feed activity. **A ranking with no writing is never shown as an empty review** — the
> Reviews tab requires `note is not null` and always has.
>
> **2. A Review is optional social writing.** Published deliberately, by the author, and
> visible to whoever may already see that account. It is called a *Review* everywhere a
> reader meets it: the title page tab, the profile section, the compose control.
>
> **3. A Private note is optional personal writing.** Owner-only, with no exception for
> approved followers, and it appears in no social surface at all — not the Reviews tab,
> not a profile, not the Feed, not a notification, not search, not the aggregate score's
> explanation. A private note **does not affect scoring**; the ranking underneath it
> still counts, because the ranking and the writing are separate things.
>
> **One field stores both**, and `note_visibility` is the whole difference. That was
> already true — `20260817001100` says in as many words that *"a review is a public Note,
> which is the same text the Feed shows"*. What changed on 2026-08-23 is that the
> interface stopped using three names for it. The composer row is now headed **Private
> note** or **Review** according to what it currently is, the profile section is headed
> **Reviews** rather than Notes, and the spoiler control names what it is revealing.
>
> **Publishing never escapes the account.** A Review by a private account is readable by
> approved followers only; a block hides it both ways; a suspended author's writing
> disappears. `title_reviews` and `public_notes` share one predicate —
> `note_visibility = 'public' and can_view_profile(...)` — so "public" means *social
> within the audience the account already permits* and never more than that.
>
> **Existing content was not touched.** Nothing was migrated, nothing changed visibility
> in either direction, and no second content model was introduced. A note written under
> the private-only promise is still private; a published review is still published.

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

Bingd carries user-generated content — usernames, display names, list titles, tags — which triggers platform obligations for content filtering, reporting, blocking, and published contact information.

> **As built — 2026-08-25: the report path now covers the whole UGC surface.** The two
> free-text surfaces that shipped after the taxonomy above was written are both
> reportable:
>
> - **Feed comments**, readable by anyone who can see the activity they sit on. Subject
>   `comment`; the owner resolves from `comments.author_id`, which is the author rather
>   than the actor whose activity it was written under.
> - **Reviews** — a public note — on a title page and on a profile. Subject `review`; the
>   owner resolves from the `user_media` row named by `user_media.id`, a surrogate added
>   by `20260825000100` because `reports.subject_id` is one uuid and the row's key is a
>   pair. Reporting by title instead would have made two people's reviews of one film
>   collide on `reports_one_open_per_reporter` and silently dropped the second complaint.
>
> **A Private note has no subject and must not get one.** It has exactly one reader, so
> there is nobody it could harm and nobody who could report it; a subject for it would
> exist only to be probed — a way to ask the server whether a row carries private
> writing. `report()` resolves a `review` only while the note is public, which keeps that
> true rather than merely intended.
>
> The client offers Report on a **comment**, a **review** and a **profile**, through one
> compact reason sheet using the existing eight-value taxonomy. Reporting does **not**
> block: they are separate acts and the app keeps them separate, which also means the
> control stays present on a profile the viewer has already blocked — the database
> deliberately checks that a subject *exists* and not that the caller can still see it,
> so that blocking somebody cannot suppress the complaint about them.
>
> The operator half is [`../release/moderation-runbook.md`](../release/moderation-runbook.md):
> queue, inspect, act, record, close, run from the Supabase SQL editor. **No admin
> console, no automated detection, no appeals, no notification on a new report** — all
> four are stated as absent there and none is claimed in the Terms.
>
> **What remains open is legal, not engineering.** A Terms of Use now exists at
> [`/terms`](https://bingd.app/terms) and is acknowledged at account creation, but it is
> a **draft**: it names `[LEGAL ENTITY / DEVELOPER NAME — FOUNDER TO CONFIRM]`, states no
> governing law, venue or arbitration clause, and no lawyer has read it. **M1** in
> [`../release/public-launch-risk-register.md`](../release/public-launch-risk-register.md)
> tracks the remainder.
>
> **No acceptance state is stored, deliberately.** A persisted accepted-version stamp is
> what a product needs in order to *re-prompt* on a change, and nothing re-prompts: there
> is no versioned Terms table, no launch gate and no blocking Agree screen, so the column
> would be a legal data model with no reader. The account's creation timestamp already
> records when somebody agreed to the Terms as they stood that day.
>
> **Nothing here implies these surfaces are private.** They are public by the author's own
> choice and are described as such above.

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
| Crash monitoring | Sentry, with release tagging and source maps — **source-map upload is disabled for `development` *and* `preview` in `eas.json`, so a Preview build's stack traces are minified.** Right for a dev client, a decision outstanding for Preview: it needs `SENTRY_AUTH_TOKEN` as an EAS secret, and it is a release-hardening gate rather than a founder nicety |
| Analytics | First-party event schema, PostHog. **Implemented** — [`analytics.md`](./analytics.md) |
| Web surfaces | Static or edge-rendered pages on `bingd.app`; Cloudflare Pages is the working recommendation |
| Source control and CI | GitHub with required checks |
| Builds and OTA | EAS Build, EAS Submit, EAS Update |

### Authentication — Required

**Email one-time code**, **Sign in with Apple**, and Google. Every account resolves to one stable internal user UUID that is independent of the sign-in method.

> **Sign in with Apple is required on iOS, not optional.** Apple's guidelines require it wherever a third-party social login is offered, and Google sign-in is in scope. v0.5 listed it as "recommended"; that is corrected.

#### The final email contract — founder decision, 2026-08-26

An amendment earlier the same day made email-and-password the primary method, on the reasoning that a password is the only email method that sends no mail. It is reverted. Ordinary users do not create or manage passwords in v1, and the sign-in screen is three peers and nothing else.

| | |
| --- | --- |
| **Primary** | *Continue with email* · *Continue with Apple* · *Continue with Google* |
| **Email method** | One field, then a six-digit code typed into Bingd. `signInWithOtp` with `shouldCreateUser: true`, verified with `verifyOtp({ type: 'email' })`. |
| **Account creation** | **The same flow.** No sign-up screen, and nobody is asked to declare whether they are new before typing an address. A verified address with no profile lands on profile creation, exactly as Apple and Google do. |
| **Passwords, ordinary users** | **None.** Not created, not set, not changed, not reset, and never asked for. |
| **Passwords, retained** | `signInWithPassword`, behind *More sign-in options → Sign in with password*, for the store-review account. It cannot create an account. |
| **Email confirmation** | Stays **on**. `mailer_autoconfirm` is `false` and must remain so: possession of the code is the verification. |
| **Never a browser** | Both email templates carry `{{ .Token }}` and no link of any kind. A confirmation URL completes the sign-in in Safari and produces a session the app never sees — the friend-beta bug of 2026-08-25. |

**One flow for both populations.** GoTrue chooses the email by the address — **Confirm signup** for one it has never seen, **Magic Link** for one it has — and both arrive as six digits for the same screen. The app never learns which was sent, which is also the anti-enumeration property: the same success, the same copy, and two templates whose rendered bodies are asserted identical.

**Nobody is locked out by this.** Every account that exists today is passwordless and *Continue with email* is exactly its path; Google accounts keep using Google and Apple accounts keep using Apple. No user is ever required to invent a password.

**No account linking is implied.** Nothing here merges identities, and nothing asks somebody to.

**No password reset is required, because no ordinary user has a password.** There is no forgot-password screen and no password field in Settings, and their absence is the design rather than a deferral. The review account's password is set in the Supabase dashboard by whoever provisions it.

**A dedicated store-review account is a release requirement.** App Review and Play review cannot receive a one-time code, so they are given an account with a fixed password, a completed profile, and enough seeded activity to demonstrate the product. No credential for it lives in this repository. See `docs/release/store-review-access.md`.

**Custom SMTP is a launch prerequisite.** Every sign-in that is not Apple or Google sends mail, so it is a gate rather than a polish step; `docs/release/production-bootstrap.md` carries it as one.
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
- **Required:** `expo-notifications` and the Apple and Google push credentials are present in the **first** development build, even though delivery is flagged off. Adding them later forces a new native build and a new store submission. *(As built: only the module shipped. The credentials and the production native configuration did not, so this requirement's own warning came true — push needed a new native build after all. §27 item 5.)*
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

**Privacy and safety:** RLS denies by default; a block removes follows in both directions and hides all surfaces; block and report are never enqueued; private accounts are absent from public web pages; the 13+ gate cannot be bypassed; account deletion removes data and invalidates tokens; **a public profile's Logged collection and watchlist are readable by others while its notes and watch dates are not**; **every view is read from a second user's session and returns exactly what a direct table query would**; a suspended account is invisible everywhere and cannot write; a deleted account's username cannot be re-registered.

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
2. A series page lists seasons, marked *Ranked* or *Not ranked yet*.
3. A season can be bucketed and ranked with no prior step: ranking it is the watch claim (decided 2026-08-24). A whole series still cannot be ranked.
4. Episodes are not rankable anywhere in the product.
5. With no connectivity, global search is disabled with an explanation, and the user's own collection remains searchable.
6. No TMDB credential is present in the client bundle.

### 26.3 Three-bucket rating and ranking

1. Marking a title watched offers exactly three buckets: I liked it, It was fine, I didn’t like it.
2. Choosing a bucket with no prior ranked titles in that bucket places the title without comparisons.
3. Choosing a bucket with existing ranked titles runs pairwise comparisons **only against titles in the same bucket**.
4. A bucket of 64 ranked titles resolves in at most 7 comparisons.
5. On completion, the app reveals a 0–10 score with one decimal, derived from the title's position within its bucket band per §10.
6. No 0–100 score or percentile is rendered on any screen or share artifact. No score is ever aggregated across users.
7. Every *I liked it* title ranks above every *It was fine* title, which ranks above every *I didn’t like it* title, at all times.
8. Changing a title's bucket moves it into the new band and re-runs comparisons there. Re-selecting the bucket it already has keeps the band and re-runs comparisons within it — the ordinal and the score may change, the bucket may not.
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
15. After the write, an anchor session offers ~20 comparisons from the top of the I liked it bucket; it can be skipped at any point and resumed later.
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
5. ~~`expo-notifications` is present in the production build and Apple and Google push credentials are configured.~~ **Restated 2026-08-24.** Three items, not two:
   - **The module** — done, and in every build since the first.
   - **The native configuration** — done in `public/push-v1`, production-only: `aps-environment: production` on iOS and `googleServicesFile` on Android. The 2026-08-23 version of this line said the native side was covered and that enabling push "will not force a new binary". Both halves were wrong: the configuration was absent, and it is native, so it **does** force a new production binary and a store submission.
   - **The credentials** — open, and a founder task. APNs `.p8` / Key ID / Team ID on Apple; a Firebase project, `google-services.json` and an FCM V1 service account on Google. The checklist is in [`push-sender/README.md`](../../supabase/functions/push-sender/README.md).
6. ~~Push **delivery** is disabled by a server-side flag, and no push is delivered in v1.~~ **Restated 2026-08-24.** There is no server-side delivery flag and there never was one. What gates delivery is the absence of a production binary carrying the native push configuration, and — until the founder supplies them — the absence of APNs and FCM credentials. The friend beta is on a binary that predates that configuration, deliberately, so no push is delivered there either.
7. ~~Enabling the flag requires no new native build and no store submission.~~ **False, corrected 2026-08-24.** It requires both. The native configuration — `aps-environment: production` and `googleServicesFile` — cannot be changed over the air. See item 5 above and [`deferred-roadmap.md`](./deferred-roadmap.md) §4.
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
3. Watch dates, notes, import history, email, and capability state never appear on any public surface. The watchlist does, on the same terms as the rankings — §22, founder decision 2026-08-20.
4. **A public profile's Logged collection, its buckets and its watchlist are visible to other users; a private profile's are visible to approved followers only.** Notes and watch dates stay hidden on both, including on a title whose bucket is visible. An unviewable profile leaks neither the watchlist's titles nor its count: the read returns nothing and the section is absent.
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

> ### As built — 2026-08-19: two of these seven are not met, and one is met differently
>
> **4 is not met for Preview.** `eas.json` sets `SENTRY_DISABLE_AUTO_UPLOAD=true` for `development` **and** `preview`, so a Preview build's stack traces are minified. Correct for a dev client, wrong for the build the friend beta will run on, and it needs `SENTRY_AUTH_TOKEN` as an EAS secret. **This is an unmet release-hardening gate**, not a founder nicety, and it is carried as such. Every build does trace to a commit, and Sentry now also carries `environment`, `app_version`, `build_number`, `runtime_version`, `eas_channel`, `eas_update_id` and `build_kind` as tags (see [`analytics.md`](./analytics.md) §6).
>
> **5 is met for four of its seven, and the others describe features that do not exist.** Onboarding, ranking and invitations (link creation only) fire; sharing, import, gate hits and recommendation feedback do not, because there is no share funnel, no import, no capability gate instrumentation and no feedback event. The criterion's second half — **contains no private content** — is met and is enforced three ways rather than asserted: a typed union, a property allowlist, and scalar-only values. See §28's As-built block.
>
> **1, 2, 3, 6 and 7 stand as written.** The three variants install side by side with distinct names, bundle ids and schemes; non-production shows the environment badge; non-production points at `bingd-nonprod` and **there is no production Supabase project to read at all**; and the `fingerprint` runtime policy is what makes 7 safe rather than merely true.

---

## 27. Public-release requirements

Public alpha may not ship until every item is true.

- [ ] Reliable account creation and sign-in on both platforms, including Sign in with Apple on iOS.
- [ ] Search, detail, watched state, buckets, and comparison ranking work end to end for movies and TV seasons.
- ~~Letterboxd import completes end to end, including preview, bucket mapping, full list import, and the anchor session.~~ **Struck 2026-08-25. Not a gate on either initial store release.** §11's As-built block deprioritized it on 2026-08-23 and this line was left behind, so §11 and §27 disagreed about whether the same unbuilt feature blocked launch. It does not: the cohort is building collections by hand, which is the behaviour the beta exists to observe. §12 keeps the full specification and `deferred-roadmap.md` §20 holds the staging decision.
- [ ] Profiles, follows, feed, people discovery, match scores, reactions, and tagging are functional.
- [ ] The notification system delivers inbox items for all seven v1 events, with working preferences.
- [ ] Recommendations return useful results for new, imported-only, and established accounts, with every guardrail enforced.
- [ ] Lists work with the three-list limit enforced and the over-limit rule verified.
- [ ] Capability enforcement is server-side and cannot be bypassed.
- [ ] Sharing and invitations work end to end, installed and uninstalled, with the Top 10 card polished.
- [ ] Offline behavior matches the §18 matrix exactly, with honest state labels.
- [x] Privacy defaults, blocking, reporting, and account deletion all function. **Reporting closed 2026-08-25**: `report_subject` gained `comment` and `review`, `report()` resolves both owners server-side, and the app has Report on a comment, a review and a profile. A **Private note** deliberately has no subject and no path — it has one reader, so there is nobody to report it and nothing a subject would be for but probing.
- [x] **The operator can see a filed report, suspend an account, and reverse it**, and every action is recorded. Reporting without a way to act on a report is a checkbox, not a safety feature. The procedure is [`../release/moderation-runbook.md`](../release/moderation-runbook.md), run from the Supabase SQL editor. **No admin console, no automated detection, no appeals, and no notification when a report arrives** — the runbook says so in those words, and the Terms of Use claims none of them.
- [ ] Crash monitoring, analytics, and alerting are live in production.
- [ ] A published contact address reaches the founder, and the data-request path in HG-4 has been exercised once end to end rather than only written down.
- [ ] **HG-2** Android developer verification complete.
- [ ] **HG-3** App Store and Play name availability confirmed; knockout trademark search complete.
- [ ] **HG-4** Privacy policy, terms of use, support contact, 13+ statement, age ratings, and data-request path published. **Terms of Use drafted and routed 2026-08-25** at `/terms`, generated by the same `web/build.mjs` as the privacy, support and deletion pages, linked from Settings and acknowledged at account creation. **It is a draft and this item stays open**: it names `[LEGAL ENTITY / DEVELOPER NAME — FOUNDER TO CONFIRM]`, states no governing law, venue or arbitration clause, and no lawyer has read it. Age ratings and the data-request path are untouched by that tranche.
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

> ### As built — 2026-08-19: what is actually measured before the friend beta
>
> The table above is the metric practice for a public alpha. **Almost none of it is instrumented, on purpose.** The friend beta is thirty to sixty people on four different builds, and the failure mode there is not too little data — it is a hundred event types nobody has agreed the meaning of, half of them counting taps instead of outcomes.
>
> So the implemented set is **thirteen events**, sized to one question: *do people activate, run the core loop, use the social side — and which build were they on when they did it.* The canonical definitions, the exact once-per semantics of each, the privacy exclusions and the release-identity fields are in **[`analytics.md`](./analytics.md)**, which is the document to read rather than this table.
>
> | Area of the table above | Status |
> |---|---|
> | Activation | **partly** — `signup_completed` → `onboarding_completed` → `ranking_completed`. No 24-hour bound, no funnel infrastructure |
> | Collection, Engagement | **partly** — `title_logged`, `ranking_completed` with its comparison count, `watchlist_added` |
> | Social | **partly** — `follow_created` (approved vs pending), `recommendation_sent`, `recommendation_opened`, `member_search_result_opened` |
> | Invitations | **created, opened, redeemed, activated** — the whole funnel has writers as of `20260819000500`, with one honest gap: a token does not survive a store install, so redemptions from a fresh install are under-counted (§17 As built) |
> | Import | **not measured** — import is not built |
> | Notifications, Recommendations quality, Offline, Metadata, Monetization intent | **not measured** |
> | Retention at day 7 / day 30, cohorts | **not built** — [`deferred-roadmap.md`](./deferred-roadmap.md) §9 |
>
> **Activation stays defined as ten ranked titles.** Nothing about the thin instrumentation changes the definition; `ranking_completed` is what will count toward it.
>
> Two rules from that document are product decisions rather than implementation details, and belong here:
>
> - **No free text, ever.** No event carries a title, a username, a note, a search query, a bio or a date of birth. Autocapture and session replay are off and stay off, because in a mobile app they record whatever was on screen — which here is somebody's private collection (§22).
> - **An event follows a server outcome, never a tap.** A write that commits and loses its reply is deliberately **under-counted**; a retry is never counted twice. Undercounting a lost reply is a small bias in a known direction, and double-counting a retry is a number that looks like growth and is not.

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
| **6. Notifications** | Event generation, inbox, preferences, delivery abstraction with push flagged off *(as built: no delivery flag; push built 2026-08-24 and gated on a production binary)* | §26.8 passes |
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

**Bucket** — One of three broad reactions (I liked it / It was fine / I didn’t like it) captured before comparison. Buckets partition the ranking into ordered bands.

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
