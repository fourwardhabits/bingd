# Bingd — Decision Log

**Version:** v0.6
**Last updated:** 2026-08-12
**Companion documents:** [`PRD.md`](./PRD.md) · [`open-questions.md`](./open-questions.md) · [`change-log-v0.6.md`](./change-log-v0.6.md)

---

## How to read this document

This is the authoritative register of what has been decided, what has not, and on whose authority. If the PRD and this log ever disagree, **this log wins** and the PRD must be corrected.

### Status labels

| Label | Meaning |
|---|---|
| **Decided** | Settled for all stages. Changing it is a product pivot. |
| **Decided for public alpha** | Settled for v1. May legitimately change at a later stage. |
| **Required** | Not a preference. Driven by safety, privacy, platform policy, or law. |
| **Recommended** | Engineering or product best practice. An agent may implement without further approval. |
| **Provisional** | Working answer. Expected to change once real usage data exists. |
| **Open** | Not decided. Must not be silently resolved by an implementation agent. |
| **Deferred** | Deliberately out of scope until a named condition is met. |
| **Hard Gate** | External dependency. Requires a manual founder action and evidence before the gated activity may proceed. |

### Authority labels

| Label | Meaning |
|---|---|
| **Founder** | Explicit founder decision, given directly. |
| **Inferred** | The agent chose this because the founder did not answer. **Flagged for review.** |
| **Best practice** | Resolved by documented engineering or design practice; founder confirmation not required. |
| **Policy** | Imposed by Apple, Google, a provider, or law. Not a preference. |

---

## 1. Inferences requiring founder review

These were **not** explicitly decided by the founder. They are recorded here so they cannot be mistaken for founder decisions. Each should be confirmed or overturned.

| # | Decision | What was inferred | Why it was inferred |
|---|---|---|---|
| ~~INF-1~~ | ~~Letterboxd star ratings auto-map to buckets~~ | **Confirmed by the founder on 2026-08-12.** Now a founder decision — see §4 | — |
| INF-2 | Usernames may be changed once per 30 days; the previous username redirects for 90 days and then **never returns to the available pool** | Question A6 was left blank | Share and invite routes depend on `bingd.app/u/<username>`; reuse is an impersonation vector |
| ~~INF-3~~ | ~~Bucket bands partition the ranking~~ | **Confirmed by the founder on 2026-08-12.** Now a founder decision — see §2 | — |
| ~~INF-4~~ | ~~Five-tab navigation with Rankings and Lists inside Profile~~ | **Revisited during design and changed. Confirmed by the founder on 2026-08-13** — see §12 | — |
| INF-5 | Activation is defined as "ranked 10 titles" with no time bound for attribution, and "ranked 10 titles within 24 hours" for the activation-rate metric | v0.5 used two near-definitions; neither was chosen by the founder | One canonical definition is needed for invite and share attribution to be reportable |
| ~~INF-6~~ | ~~The reaction set is `love`, `like`, `laugh`, `wow`, `agree` — five, all positive~~ | **Resolved by the founder on 2026-08-13, and changed.** Six values including a negative one — see §2 | — |

**INF-2 tightened, 2026-08-13.** The original wording said a released name "can never be *instantly* reused," which left the eventual behaviour undefined. The schema makes reuse **permanent**, and a `before delete` trigger extends that to deleted accounts — previously, deleting an account released its username immediately, which reached the impersonation outcome INF-2 exists to prevent by a shorter route than a username change. Permanent reservation is the safe direction and costs nothing at alpha scale, but it is a divergence from the recorded wording rather than an implementation of it, so it stays flagged.

---

## 2. Core product

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Core mechanic | Decided | Founder | Pairwise "this or that" comparison produces an ordered personal ranking | Never, without a product pivot |
| Rating entry | **Decided (new in v0.6)** | Founder | Three buckets first — **Loved it / It was fine / Not for me** — then pairwise comparison within that bucket | Bucket labels may be reworded after user testing; the three-bucket structure is fixed |
| Bucket semantics | Decided | Founder | Buckets partition the ranking into three ordered bands. A title cannot rank above a title in a higher band. Comparisons therefore only ever run within one band, which is how Beli avoids asking users to compare across reaction levels | If users report the partition feels wrong |
| Media scope | Decided | Founder | Movies and TV seasons. Episodes are never ranked. Whole-series ranking is not the primary TV unit | Never for public alpha |
| TV progress | Decided | Founder | A season may be marked *Watching*, but becomes rankable only when marked completed | — |
| Ranking output | Decided for public alpha | Founder | Exact ordinal position only, e.g. `#18 in Movies`. **No 0–10 score, no 0–100 score, no percentile** | After alpha, only with evidence that a secondary number adds value |
| Ranking separation | Decided | Founder | Separate ordered rankings for Movies and TV Seasons | — |
| Collection model | **Decided (new in v0.6)** | Founder | Two states: **Logged** (watched, optionally bucketed, no position) and **Ranked** (exact position from comparisons). Positions come only from comparisons and are never derived from an imported rating | Never — this protects match-score integrity and the shareable Top 10 |
| Comparison uncertainty | Decided for public alpha | Founder | Skip re-anchors to a different title. After 3 skips on one insertion, place at the midpoint of the remaining range and tell the user it is adjustable | If completion rates suffer |
| Ties | Decided for public alpha | Founder | **No ties.** Two titles never share a position | Would require a tier model; not a v1 change |
| Ranking connectivity | Decided for public alpha | Founder | Pairwise insertion, manual reranking, and recalculation require internet | After alpha, only if offline ranking demand is evidenced |
| Social graph | Decided | Founder | One-way follow. Mutual follow is a state, not a separate connection type | — |
| Feed | Decided | Founder | Chronological structured activity. No algorithmic ranking in v1 | Post-alpha, with volume |
| Feed interaction | **Decided for public alpha (new in v0.6)** | Founder | **Reactions only.** A fixed reaction set on activity items | — |
| Reaction set | **Decided 2026-08-13** | Founder | Six: `love`, `agree`, `disagree`, `funny`, `wow`, `moved`. Stored as meanings, not glyph names, so the symbols stay a copy decision. Supersedes INF-6, which proposed five and no negative | If `disagree` is used to needle rather than to argue |
| Reaction display | **Decided 2026-08-13** | Founder | Distinct glyphs plus at most two names, residual count, press and hold for the full list — the Messenger pattern. **No reaction is ever aggregated onto a profile**, which is what keeps `disagree` banter rather than a scoreboard | — |
| Reaction skin tones | Deferred | Founder | Not in v1. A reactor-level rendering preference, so adding it later is one additive column and no data migration | When the reaction bar is designed, or if asked |
| Comments | **Deferred (reaffirmed in v0.6)** | Founder | Not in v1. Requires moderation tooling, a report-comment flow, and a stated response commitment before it can ship | When moderation capacity exists and reactions prove insufficient |
| Watch tagging | **Decided for public alpha (new in v0.6)** | Founder | Tag Bingd users in a watch. Limited to people you follow or who follow you. Max 10 per watch. Tagging does not modify the tagged user's collection. The tagged user is notified and may remove the tag | — |
| Tagging non-users | Decided for public alpha | Founder | Not supported. Attempting to tag someone not on Bingd offers the invite flow instead | Post-alpha if demand appears |
| Leaderboard | Decided | Founder | Prolific rankers plus match score and overlap count | — |
| AI / LLM | Decided | Founder | Not required for ranking, recommendations, explanations, or sharing in v1 | Only for natural-language query, post-alpha |

---

## 3. Privacy, safety, and moderation

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Default profile visibility | **Decided (resolves v0.5 Open)** | Founder | **Public by default**, with a Private toggle in Settings | If abuse or discomfort appears in alpha |
| Always-public fields | Decided | Founder | Display name, username, avatar, top titles, rankings, public lists, feed activity | — |
| **Logged collection visibility** | **Decided 2026-08-13** | **Founder** | **The Logged collection and its buckets inherit profile visibility — public on a public profile, approved followers only on a private one.** The collection is part of the profile and follows the same rules. Notes and watch dates stay private on both; the watchlist stays private at every visibility level | If alpha testers treat a bucket as more private than a ranking |
| Always-private fields | Required | Best practice | Watch dates, notes, watchlist, import history, email, account identifiers, capability state | Never |
| Follow approval | Decided | Founder | Instant follow for public accounts. Private accounts require approval | — |
| Feed on unfollow | **Corrected 2026-08-13** | Best practice | The feed is a live query against the current follow set, so unfollowing removes that person's events **including past ones**. Nothing is deleted; re-following restores them. PRD §14 previously promised the opposite, which was untrue of the fan-out-on-read design and the more surprising behaviour anyway | If the feed moves to fan-out-on-write before mass market |
| Blocking | Required | Best practice | A block removes existing follows in both directions, hides each user from the other's feed, leaderboard, and match surfaces, voids pending invitations between them, prevents tagging, and blocks access to each other's public web pages | — |
| Block/report connectivity | Required | Best practice | Online-only. Hidden locally on tap, submitted when connected. Not placed in the offline outbox | — |
| Reporting | **Required (new in v0.6)** | Policy | Report flow with a defined reason taxonomy, covering profiles, display names, lists, list titles, usernames, tags, and reactions. Triage process and response commitment documented before public release | — |
| **Moderation tooling** | **Required 2026-08-13** | Policy | Reporting had no schema and no operator surface. Now: a `reports` table, reversible account **suspension** through `can_view_profile`, an audited `moderation_actions` log, and two SQL-editor views for triage. **No admin application in v1** — 30–60 users do not justify one, and building it before any triage experience is the expensive way to learn what it should contain. No appeals flow and no automated detection, both acceptable only at alpha scale | Before early traction, or on the first report volume that outgrows an SQL editor |
| Username changes | Decided for public alpha | Inferred (INF-2) | Once per 30 days; 90-day redirect; **released names never return to the available pool, including after account deletion** | — |
| Minimum age | **Required (new in v0.6)** | Policy | 13+. Date-of-birth gate at signup. No accounts below 13 | Only with a deliberate COPPA compliance program |
| Match card second party | Provisional | Best practice | A match card may show another user's handle and avatar only if their profile is public and no block exists. Private users appear anonymized | Before match sharing ships in early traction |
| Public web indexing | Decided for public alpha | Founder (v0.5) | Public pages are `noindex` during alpha | After privacy, moderation, and GTM evidence |

---

## 4. Onboarding, import, and cold start

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Cold-start path | Decided for public alpha | Founder | Guided starter set (~40 recognizable titles, tap 8–15) plus direct search, plus Letterboxd import | After measuring completion by path |
| Letterboxd import stage | **Decided for public alpha (changed from v0.5)** | Founder | Ships in v1, not early traction | — |
| Import method | Decided | Policy | User-uploaded export files only. **No scraping and no live account connection** — Letterboxd's terms prohibit automated extraction and its API is not granted for this use case | Only with written Letterboxd permission |
| Rating translation | Decided for public alpha | Founder | Stars auto-map to buckets: **4.0+ → Loved it**, **2.5–3.5 → It was fine**, **≤2.0 → Not for me**. One summary line shown. No cut-line UI. Every bucket editable per title afterward | Thresholds are Provisional and tunable after real imports |
| Unrated watched films | Decided | Founder | Import as Logged with no bucket. Bucketed lazily by the user later | — |
| Post-import anchor session | Decided for public alpha | Founder | Immediately after import, run a guided session over ~20 titles from the top of the *Loved it* bucket so the user finishes onboarding with a real Top 20. Skippable and resumable | If completion is poor |
| Unranked prompt | Decided for public alpha | Founder | A quiet, dismissible card on Rankings offering batches of 5, ordered highest-bucket-first. Goes quiet once the user has ~50 ranked titles. **Never a modal, never a progress bar toward 100%** | — |
| Import list handling | **Decided (new in v0.6)** | Founder | **All lists import regardless of the list limit.** Nothing is ever deleted or hidden because of a limit | — |
| Import provenance | Recommended | Best practice | Record whether each list was imported or created in-app, so limit-ceiling metrics only count in-app creation | — |
| Import limits | Recommended | Best practice | Cap at 5,000 titles and 25 MB. Background processing with progress. Source files deleted after processing | After observing real export sizes |
| Rewatches | Provisional | Founder (v0.5) | Import takes the most recent watch date and ignores rewatch flags in v1 | Post-alpha |

---

## 5. Invitations, sharing, and growth

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Invitation flow | Decided for public alpha | Founder | Dedicated Invite Friends action. Entry points: onboarding completion, People, Profile, Settings, and the tagging flow when a person is not on Bingd | — |
| Invitation token model | **Decided (resolves v0.5 ambiguity)** | Founder | **One reusable personal link per user** (`bingd.app/i/<token>`) plus a matching short code. Revocable and regenerable. No expiry by default | If abuse rates require per-recipient tokens |
| Invitation acceptance | **Decided (resolves v0.5 ambiguity)** | Founder | Explicit tap after the recipient has an account. Creates a **one-way follow from recipient to inviter**. If the inviter is private, it creates a follow *request*. The inviter is then prompted to follow back — never automatically. Recipient identity is not revealed to the inviter before acceptance. An active block in either direction voids the invitation | — |
| Contact upload | Decided | Founder | Never. No address-book permission at any stage | — |
| Destination SDKs | Deferred | Founder | Native share sheet only. No Instagram, TikTok, or Snapchat SDKs | Only when measured usage justifies ongoing SDK, policy, and QA cost |
| Deferred deep linking | Deferred | Founder | Not an MVP dependency. Post-install fallback is reopening the link or entering the short code | Only if measured install-to-resume drop-off justifies a vendor |
| Invite rewards | **Decided for public alpha (new in v0.6)** | Founder | **No rewards in v1.** Track total invites and attributed activations only | Rewards may be granted retroactively later |
| Growth provenance | **Required (new in v0.6)** | Best practice | Record `invited_by` and `founding_member` on every account from day one. Cheap now, impossible to reconstruct later | Never remove |
| Token authority | Required | Best practice | Share and invite tokens are routing and attribution identifiers, never authorization. Every request re-checks current object visibility | Never |
| Link-accessible visibility | **Clarified in v0.6** | Best practice | *Link-accessible* is a named visibility level meaning "anyone holding the link may view." The server still authorizes every request against that level; the token does not bypass a check, it identifies an object whose visibility permits it | — |
| Standard sharing tier | Decided | Founder | Standard sharing and direct invitations are permanently **Free** and appear as an explicit row in the tier matrix | Never |
| Priority share artifact | Decided for public alpha | Founder | **Top 10.** Polished card, web page, and Open Graph preview. Other artifacts functional but basic | After share conversion data |
| Share completion claims | Required | Best practice | Share-sheet open and return are never recorded as a completed post | Never |

---

## 6. Notifications

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| System scope | **Decided for public alpha (new in v0.6)** | Founder | Full notification system built in v1: events, in-app inbox, per-category preferences, and a delivery abstraction | — |
| Push in v1 | **Decided for public alpha (new in v0.6)** | Founder | `expo-notifications` installed and Apple/Google push credentials configured in the **first** development build, but push **delivery is flagged off at launch**. Enabling it later must not require a new native build or store submission | Enable when the founder chooses |
| v1 notification events | Decided for public alpha | Founder | Joined-from-your-invite; new follower; follow request received; follow request approved; tagged in a watch; reaction on your activity; sync needs attention (inbox only, never push) | — |
| Excluded from v1 | Decided for public alpha | Founder | Friend-activity push ("someone you follow ranked something"). Strongest candidate for early traction, deliberately held back | Early traction |
| Scheduled nudge | **Decided (new in v0.6)** | Founder | Twice weekly maximum — Friday ~18:30 and Sunday ~16:30 local. **Conditional on having real content to report; sends nothing when there is nothing to say.** Ships only when push delivery is enabled | Times and days are Provisional |
| Nudge timing evidence | Provisional | Best practice | The 7–10 PM peak-viewing window is evidenced (Nielsen). The choice of Friday and Sunday specifically is **inference, not data** | After observing open rates by slot |
| Permission prompt | Recommended | Best practice | Never on first launch. Request after the first successful invite or first follow | — |
| Preference controls | Decided | Founder | Notifications sub-page under Settings with per-category toggles and a master **Turn all off**. Must reflect OS-level permission state honestly and link to system settings when denied | — |

---

## 7. Recommendations

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Engine approach | Decided | Founder | Human-derived hybrid: compatible users, followed users, content similarity, fresh catalog, curated cold start. No LLM | — |
| Quality guardrails | Required | Founder | All nine guardrails apply to Free, Early Access, and future Pro alike: eligibility, impression history, popularity balance, candidate-source diversity, slate diversity, exploration, explanation integrity, feedback learning, graceful degradation | Never weakened |
| Bucket signal | **Decided (new in v0.6)** | Best practice | Buckets feed the engine directly. A user who imports and ranks nothing still receives personalized recommendations from bucket signal alone | — |
| Explanation integrity | Required | Founder | Every reason is reproducible from stored signals. Fabricated social proof, similarity, availability, or confidence is a test failure | Never |
| Cached/degraded labeling | Required | Founder | Cached or cold-start results are labeled as such and never imply live personalization | Never |
| Tuning values | Provisional | Founder | Cooldowns, franchise and genre caps, popularity caps, source-family minimums, exploration share — all versioned and tunable | Continuously, from real data |
| Match calculation | Decided for public alpha | Best practice | Computed on **pairwise-ranked overlap only**, displayed with a shared count for confidence | — |
| Bucket-based match | Provisional | Best practice | Bucket agreement across Logged-only overlap is a candidate secondary signal. **Not in the v1 headline number** | Test post-alpha |
| Match math | Recommended | Best practice | Rank correlation or pairwise agreement, transformed to 0–100. Exact method is an architecture-stage decision | — |

---

## 8. Capabilities, Early Access, and monetization

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Business intent | **Decided (clarified in v0.6)** | Founder | Bingd is intended to become a subscription product. Public alpha is free to build the user base | — |
| Public alpha billing | Decided for public alpha | Founder | **No billing of any kind.** No RevenueCat, no store products, no purchase, restore, renewal, price display, or manage-plan UI | Paid beta only, after explicit approval |
| "Pro" status display | **Decided (new in v0.6)** | Founder | **Nobody is shown as Pro in v1.** No Pro badge, no plan row, no "you are on the free plan" language. A feature is either available or shows a non-paid *Coming soon* note | Paid beta |
| Capability architecture | Decided for public alpha | Founder | Named capabilities resolved centrally, enforced on the backend. Access sources implemented in v1: `base_free`, `alpha_early_access` | — |
| **`alpha_early_access` confers nothing in v1** | **Clarified 2026-08-13** | Engineering | The tier matrix is identical down the Free and Early Access columns, so the capability is a resolver path with a live grant and nothing behind it — deliberately, so that granting something real later exercises code already proven in production. Stated because two things assumed otherwise: AC 26.11.2 tests the mechanism rather than any user-visible difference, and §28's "Early Access engagement vs. control" metric had no treatment to measure and has been removed. **Not fixed by granting a real benefit** — a two-tier cohort of 30–60 testers splits the sample and contaminates the gate-hit data the paid-beta decision rests on | Paid beta, or a deliberate time-boxed test |
| Upgrade surface | **Decided (new in v0.6)** | Founder | One shared gate component and one upgrade-prompt surface. In v1 it renders *Coming soon*; in paid beta the same call site renders a real paywall. Feature screens never change | — |
| Custom lists in v1 | **Decided (resolves v0.5 contradiction)** | Founder | Lists ship in v1 with the **three-list limit enforced for everyone**. `unlimited_custom_lists` is defined but **not granted** as Early Access | Grant only for a deliberate, time-boxed test |
| Over-limit rule | **Required (new in v0.6, universal)** | Founder | When a capability is absent or lost, **existing data is never deleted or hidden.** It becomes read-only and no new items may be created until the capability is granted. This rule governs every current and future limit | Never |
| Early Access grants | Required | Best practice | Every Early Access grant carries an expiry timestamp so it cannot silently become permanent. Grants are environment-scoped, auditable, and revocable | — |
| Founding members | Decided | Founder | `founding_member` recorded on all accounts created before paid beta. What it eventually confers is deliberately undecided | At paid beta |
| Future packaging | Provisional | Founder | One future Pro bundle. Monthly and annual grant the same capabilities | Paid beta |
| Pricing | Open / Provisional | Founder | $4.99/month and $39.99/year US placeholders | Paid beta, after intent testing |
| Free trial | Provisional | Founder | None initially | Test later |
| Lifetime access | Deferred | Founder | Open only after paid-beta churn, refund, infrastructure, licensing, and support-cost data exist. **Never promised to alpha testers** | Post paid beta |
| Advertising | Provisional | Founder | None. Would trigger a separate commercial metadata review | — |
| Web checkout | Deferred | Policy | No Stripe or card form inside the mobile app for digital features | Post-launch, separate review |

---

## 9. Offline behavior

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Overall posture | Recommended | Founder | Offline-resilient and read-heavy. **Not** offline-first | If evidence justifies the conflict cost |
| Readable offline | Decided for public alpha | Founder | Own rankings, Logged collection, watchlist, lists, basic profile, recent feed and recommendation snapshots, cached title details | — |
| Queueable offline | Decided for public alpha | Founder | Watched state, watchlist membership, list membership, note drafts | — |
| Online-only | Decided for public alpha | Founder | All ranking mutations, bucket assignment that triggers comparison, global search, follow/unfollow, block/report, invite token creation, acceptance, import, account deletion, live match and recommendation calculation | — |
| Ranking in the outbox | Decided for public alpha | Founder | **Explicitly excluded.** No ranking insert or move is ever queued | Post-alpha only with evidence |
| **Queueable is a row-state property, not a function property** | **Required 2026-08-13** | Engineering | An allowlist of function names could not express this, and two allowlisted functions defeated the rule above. `set_bucket` on a ranked title requires a band move and renumber; `unlog` on a ranked title deletes a position and closes the gap. Both are ranking mutations, both were queueable, and both now refuse a ranked title so the client routes to the online-only path. **A function is queueable only if it is queueable for every state its target row can be in** | Never — the rule generalizes to every RPC added later |
| Conflict model | Recommended | Best practice | Idempotent operations keyed by `operation_id`; latest valid operation wins for membership-style writes; local drafts are never silently overwritten; server is authoritative for entitlements, privacy, and moderation | — |
| **Note conflict mechanism** | **Required 2026-08-13** | Engineering | "Local drafts are never silently overwritten" had no mechanism behind it: nothing in a `save_note` call said which version the edit was based on, and `user_media.updated_at` was never advanced after insert, so the server had nothing to compare. A trigger now maintains it and outbox replays carry the base version. Without both halves the rule above was aspirational | — |
| Full replication | Deferred | Founder | No broad social or catalog replication in v1 | — |

---

## 10. Media data and licensing

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Provider | Provisional | Founder | TMDB, behind a Bingd-owned adapter and normalized schema | If licensing or economics fail |
| Credential custody | Required | Best practice | No provider token ever ships inside the mobile app | Never |
| Access pattern | Recommended | Best practice | Live-plus-cache through the backend. Never a per-screen provider call; never a full catalog mirror | — |
| Commercial rights | **Required (was Hard Gate)** | Policy | **Gate change approved by the founder, 2026-08-13.** Not a gate. Connect on a free developer key now; buy the commercial plan — a self-serve purchase, reported at $149/month under $1M revenue — before the first payment lands. Attribution wording is published and built in from the first screens. The reasoning is below, and it is **not** a claim that Bingd is non-commercial | Buy the plan before charging |
| Six-month cache limit | **Decided 2026-08-13** | Engineering | TMDB restricts retaining TMDB-derived data beyond six months. Resolved by complying: Bingd's own collection data persists without limit; TMDB metadata refreshes on a rolling basis inside six months, **including `media_items`, which had no expiry until 2026-08-13**. The window is a runtime config value, not a constant | Only if TMDB's terms change |
| Free alpha status | Required | Policy | A free alpha for a product with declared subscription intent is **not assumed to be noncommercial.** The position below does not depend on it being so | — |
| Image rights | Required | Policy | CDN sizes plus device cache. **No rehosting on Bingd infrastructure**, which means v1 Open Graph link previews are typographic and carry no artwork — a server-rendered preview image is served from Bingd's own infrastructure, and that is rehosting. On-device share cards stay poster-forward: the compositing happens on the user's phone and the user shares the result | When the commercial plan is active and the question has a definite answer |

### Why the TMDB gate was closed — Required reading before reopening it

The earlier version of the row above justified closing the gate by asserting that "Bingd is non-commercial while it charges nobody." That contradicted the Free alpha status row two lines below it, and the kickoff brief had named that exact assumption as one not to make. Both statements sat in this document at the same time, and the decision log is the tie-breaker for everything else — so it was the one place a contradiction could not be left.

The gate is closed, and the founder has approved it, but on different grounds:

1. **The downside is bounded and cheap.** If TMDB takes the view that a free alpha with declared subscription intent needs a commercial plan, the remedy is a self-serve purchase at a published price. No negotiation, no correspondence, no waiting.
2. **A Hard Gate is for things with unbounded latency.** HG-2 through HG-6 all involve someone else's timeline. This one does not, and treating it as a gate would have blocked design work for weeks against a risk resolvable in an afternoon with a credit card.
3. **The obligations that actually matter are met regardless of classification** — attribution in the first screens, retention under six months, no artwork rehosted, no credential in the client. These are required on a free key and on a commercial plan alike, so none of them is deferred pending an answer.

What this is *not*: a determination that Bingd is non-commercial. Nothing in this document should be cited for that, and an agent finding an apparently favourable classification claim elsewhere should treat this row as the authority.

**Revisit immediately if** TMDB contacts Bingd about the account, the terms change, or anything is charged to a user — the last being the trigger for the purchase rather than for a reassessment.

---

## 11. Platform, brand, and legal gates

| Area | Status | Authority | Direction | Revisit when |
|---|---|---|---|---|
| Bundle identifiers | **Decided (new in v0.6)** | Founder | `app.bingd` (production), `app.bingd.dev`, `app.bingd.preview`. Reverse-DNS of the owned domain. Effectively permanent after store submission | Never after submission |
| Domain | Decided | Founder | `bingd.app`, registered, DNS on Cloudflare. `.app` is HSTS-preloaded, so HTTPS is mandatory from the first deploy | — |
| Authentication | **Required (strengthened in v0.6)** | Policy | Email one-time code, Sign in with Apple, and Google. **Sign in with Apple is required on iOS**, not optional, because Google sign-in is offered | Never while Google login exists on iOS |
| **Credential linking** | **Required 2026-08-13** | Best practice | Two credentials link **only on a provider-asserted verified email**, or explicitly from an authenticated session. An unverified match is refused, naming the method the account already has. AC 26.1.3 previously read "signing in again by any method reaches the same account," which is an account-takeover vector if taken literally: anyone can create an account at a third-party provider claiming a victim's address. Apple private-relay accounts can never match by address, so the Settings link flow is their only path to a second method. Full rules in [`../architecture/auth.md`](../architecture/auth.md) | Never — this is the security-relevant half of the identity model |
| Apple Developer Program | Satisfied | Founder | Account exists | — |
| Google Play production access | **In progress** | Founder | Applied 2026-08-11 via the existing `com.fourward.app` closed test. Review typically ≤7 days. Production access is account-level, so **Bingd will not repeat the 12-tester/14-day gate** once granted | If the application is rejected |
| Android developer verification | **Hard Gate** | Policy | Deadline 2026-09-30. Affects the existing account and app. Founder has deferred it | Must complete before the deadline |
| Brand and trademark clearance | **Hard Gate (new in v0.6)** | Policy | Domain secured. Still required before public launch: App Store and Play name availability, and a knockout trademark search. "bingd" is adjacent to *binge* and *Bing* | Before public launch |
| Brand asset production | **Required (new in v0.6)** | Best practice | Current SVGs use live text with a remote Google Fonts `@import` and will not render reliably in an app bundle, share card, or Open Graph image. Type must be outlined and the import removed. A square icon-safe mark does not yet exist | Before any store submission |
| Legal pack | **Hard Gate (new in v0.6)** | Policy | Privacy policy, terms of use, support contact, minimum-age statement, store age ratings, and a documented data-subject request path | Before public launch |
| UGC obligations | **Required (new in v0.6)** | Policy | Bingd carries user-generated content (usernames, display names, list titles, tags). Platform requirements include content filtering, reporting, blocking, and published contact information | Before public launch |

---

## 12. Design direction

Derived from the brand system in PRD §5 at founder instruction, not separately directed. All are **Recommended** unless noted.

| Area | Direction | Rationale |
|---|---|---|
| Density | Airy on onboarding, comparison, reveal, and share surfaces. Efficient on Rankings and Search | "Poster artwork carries most visual color; the interface frames it" |
| Emphasis | Poster-dominant for content surfaces; typographic (DM Serif Display) for reveals, milestones, and share cards | The two-typeface split in §5 |
| Tone | Restrained by default. Playful only where Antique Amber appears — awards, milestones, reveals | The two-voice system |
| Data display | Minimal in v1. One modest stats block on Profile. Rich insight is a later capability | Free tier is "basic taste statistics" |
| Theme | Parchment light only in v1. Tokens structured so Midnight dark mode is purely additive later | §5 frames Midnight as optional |
| Corner radius | 12px cards, 8px inputs, full-round for avatars only. No pill buttons | Serif type and pill shapes conflict |
| Motion | Minimal, with one exception: the ranking reveal earns real animation | "Every surface should earn its place" |
| Navigation | **Decided 2026-08-13.** Five tabs: Feed, Collection, center **+** to log, Recommendations, Profile. No Search tab — the **+** and title search are the same action | Reference evidence, `../design/screens.md` §2 |
| Reference discipline | Apple TV, Apple Wallet, and Open inform **design language**. Spotify, Cash App, Strava, and Beli inform **flows only** | Founder instruction |
| Comparison context | **Decided 2026-08-13.** A comparison card never shows the opponent's current rank | An ordinal is an anchor that invites agreement instead of a real judgment |
| Amber and Sage | **Decided 2026-08-13.** Fill colors only, never text. Both measure below 2.2:1 on Parchment and fail WCAG at every size | Measured, `../design/design-system.md` §1 |
| Artwork on Parchment | **Decided 2026-08-13.** Posters are printed objects on a page — hairline border, soft shadow, real margins — and are the only color on any surface where they appear | Apple Wallet precedent, `../design/design-system.md` §1 |

---

## 13. Engineering and workflow

| Area | Status | Authority | Direction |
|---|---|---|---|
| Stack | Recommended | Founder | Expo, React Native, TypeScript, EAS, Supabase, GitHub |
| Development app | Recommended | Founder | Expo development build with `expo-dev-client`. Expo Go is not the primary test environment |
| Environments | Recommended | Founder | `bingd-nonprod` and `bingd-production` Supabase projects. Development, preview, and production builds visibly distinct |
| Branching | Recommended | Founder | One coherent change, one branch, one pull request. A release may contain many merged PRs |
| Independent review | Required | Founder | A fresh agent reviews sensitive surfaces before merge: auth, RLS, payments, sharing, invitations, offline sync, migrations, moderation. The implementing agent requests it. A reviewer reports and does not patch |
| Reviewer selection | Decided 2026-08-13 | Founder | Latest Fable for foundational or architectural review; latest Codex for feature-specific or contained review |
| Agent merge authority | Decided 2026-08-13 | Founder | Agents may merge documentation and non-sensitive code, and sensitive changes once independently reviewed — in all cases only after asking the founder. Supersedes the blanket no-autonomous-merge rule |
| Agent authority — hard limits | Required | Founder | No agent may deploy, run a production migration, delete production data, configure payment products, or access production secrets. No approval path exists |
| Crash monitoring | Recommended | Founder | Sentry with release tagging and source maps |
| Analytics | Recommended | Best practice | First-party event schema. Provider selection is an architecture-stage decision; PostHog is the working recommendation |

---

## 14. Deferred

Not in v1, by explicit decision. Each names its unblocking condition.

| Item | Unblocked by |
|---|---|
| Comments, DMs, discussion boards, long-form reviews | Moderation tooling and evidence that reactions are insufficient |
| Friend-activity push notifications | Early traction, once feed volume justifies it |
| Destination-specific social SDKs | Measured per-destination usage |
| Deferred-deep-link or attribution vendor | Measured install-to-resume drop-off |
| Contact-book and social-network import | Not planned |
| Full offline-first sync; offline ranking replay | Evidence that offline ranking matters more than its conflict cost |
| Full catalog mirror or image rehosting | A licence that specifically permits it |
| LLM recommendations or explanations | Post-alpha, for natural-language query only |
| Algorithmic feed ranking | Feed volume |
| Collaborative lists, episode ratings, whole-series ranking | Not planned for alpha |
| Lifetime access, multiple tiers, family plans, gifting, web checkout | Post paid beta |
| Dark mode | Post-alpha |
| Bonus-comparison ranking of imported titles as a by-product of normal use | Post-v1 optimization |
