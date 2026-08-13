# Bingd — Open Questions

**Version:** v0.6
**Last updated:** 2026-08-13
**Companion documents:** [`PRD.md`](./PRD.md) · [`decision-log.md`](./decision-log.md) · [`change-log-v0.6.md`](./change-log-v0.6.md)

---

## Purpose

This document exists so that an implementation agent **cannot silently invent product behavior**. Everything here is deliberately unresolved. Nothing in this file may be resolved by an agent choosing a plausible answer and proceeding.

Items are grouped by who resolves them and when.

| Group | Who resolves | When |
|---|---|---|
| §1 Architecture blockers | Founder | Before architecture. **Currently empty.** |
| §2 Inferences awaiting confirmation | Founder | Any time. Low risk if left. |
| §3 Non-blocking validation questions | Real usage | During and after alpha |
| §4 Engineering-stage decisions | Engineering best practice | At architecture |
| §5 External Hard Gates | Founder, manually | Before the gated activity |
| §6 Provisional tuning values | Measurement | Continuously |

---

## 1. Architecture blockers

**None.**

All six product decisions that blocked architecture as of v0.5 have been resolved:

| Former blocker | Resolution | Where |
|---|---|---|
| Default privacy and follow approval | Public by default; Private toggle; approval only when private | Decision log §3 |
| Invitation acceptance semantics | One-way recipient→inviter follow, explicit tap, follow-back prompt | Decision log §5 |
| Invitation token model | One reusable personal link plus short code | Decision log §5 |
| Notification mechanism | Full system in v1; inbox live; push built but delivery flagged off | Decision log §6 |
| Lists in public alpha | Ship in v1 with the three-list limit enforced | Decision log §8 |
| Letterboxd import stage | Ships in v1 | Decision log §4 |

**READY FOR ARCHITECTURE: YES.** See PRD §31 for the full assessment and the conditions attached.

---

## 2. Inferences awaiting founder confirmation

These are recorded as decisions so work can proceed, but they were **made by the agent, not the founder**. Overturning any of them is cheap now and expensive after implementation.

### ~~INF-1 — Letterboxd rating translation~~ — **RESOLVED 2026-08-12**

Confirmed by the founder. Star ratings auto-map to buckets (4.0+ → *Loved it*, 2.5–3.5 → *It was fine*, ≤2.0 → *Not for me*), shown as a single summary line, with no cut-line UI and every bucket editable per title afterward. This is now a founder decision, recorded in `decision-log.md` §4. The threshold values themselves remain Provisional and tunable after real imports.

### INF-2 — Username change policy

**Recorded as:** Changes allowed once per 30 days; the previous username redirects for 90 days, then stops resolving and **never returns to the available pool**.

**Why it is an inference:** Question A6 was left blank.

**Alternative:** Lock usernames permanently in v1. Simpler, cheaper, and defensible. Say the word and it changes.

**Cost to overturn:** Low before implementation. High after, because share and invite routes depend on `bingd.app/u/<username>`.

**Tightened 2026-08-13, and worth a look.** The original wording said released names "can never be *instantly* reused," which left the end state undefined; the implementation makes reservation **permanent**. Two reasons it went the stricter way. Every previously shared `bingd.app/u/<name>` link keeps pointing at the name, so releasing it hands an impersonator a working URL rather than a dead one — and at alpha scale the namespace cost of never recycling is nil. The same review found that **deleting an account released its username immediately**, reaching the exact outcome this inference exists to prevent by a shorter route than a username change; a `before delete` trigger now reserves it. If you would rather names come back after some period, that is a one-line change now and a migration later.

### ~~INF-6 — The reaction set~~ — resolved by the founder, 2026-08-13

**Resolved.** The set is six: `love`, `agree`, `disagree`, `funny`, `wow`, `moved`. See PRD §14.

The inference proposed five, all positive, on the reasoning that a downvote is a pile-on mechanic. **The founder added a negative reaction, and was right to.** The pile-on argument holds for a public network of strangers; it does not hold for a cohort of friends where disagreeing with someone's ranking is the entire social mechanic. The risk was correctly located in the *display* rather than the reaction: PRD §14 now forbids aggregating any reaction onto a profile, so `disagree` lives on the activity item and never becomes a running total attached to a person.

Two things carried forward from the inference because they proved useful. Values are stored as **meanings rather than glyph names** — `agree`, not `thumbs_up` — so the symbol set stays a copy decision. And the column is **closed by a check constraint**, because a `text` column accepting any string is the free-text field PRD §14 refused to build.

### Deferred — skin-tone variants on the hand reactions

**Not in v1.** Raised by the founder, 2026-08-13, with the right instinct attached: leave it off if it adds clutter or risk.

**Why it is safe to defer, and cheap to add.** A skin tone is a property of the *reactor*, not of the reaction. So it belongs on the profile as a single rendering preference, not on the reaction row — which means adding it later is one additive nullable column and touches no existing reaction data. Aggregation, counts, and the constraint are all unaffected because `agree` stays `agree` however it renders.

**The real cost is in assets, not data,** and it depends on a design decision not yet made. Native platform emoji get tone modifiers free. Custom brand-drawn icons — which is the likelier direction, since native emoji sit awkwardly against DM Serif Display and Parchment — would need five variants of each hand, for a cohort of thirty to sixty people.

**Worth knowing:** the founder's own alternative sidesteps this entirely. An all-faces set with no hands has no skin tone to vary. A skeptical face reads as "bad take" about as clearly as a thumbs down, and faces are more distinctive than the most generic pair of glyphs on the internet. Since values are stored as meanings, that swap remains free at any point.

**Revisit when:** the reaction bar is designed, or if anyone asks.

### ~~INF-3 — Bucket bands partition the ranking~~ — **RESOLVED 2026-08-12**

Confirmed by the founder. All *Loved it* titles rank above all *It was fine* titles, which rank above all *Not for me* titles. Comparisons run only within a band, which is the mechanism that keeps them short and avoids asking a user to compare titles they placed at different reaction levels. This is now a founder decision, recorded in `decision-log.md` §2 and implemented as invariant **I2** in `../architecture/ranking.md`.

### ~~INF-4 — Navigation structure~~ — **RESOLVED 2026-08-13**

Revisited during design and changed, as anticipated. The tabs are **Feed, Collection, +, Recommendations, Profile**. The collection moves out of Profile to a top-level tab, and the separate Search tab is dropped because the center **+** and title search are the same action.

The evidence is in `../design/screens.md` §2: both reference apps give the user's own collection a top-level tab and neither hides it behind a profile, and in Beli the center button *is* search. Confirmed by the founder and now a founder decision, recorded in `decision-log.md` §12.

### INF-5 — Definition of activation

**Recorded as:** Activation is "the user has ranked 10 titles." The activation-*rate* metric adds a 24-hour bound. Attribution reporting uses the unbounded definition.

**Why it is an inference:** v0.5 contained two near-definitions and the founder chose neither.

**Cost to overturn:** Low, but it must be settled before invite and share attribution reporting is built, or the numbers will not reconcile.

---

## 3. Non-blocking validation questions

Real answers require real users. Each has a working default so nothing is blocked.

| Question | Working default | What would settle it |
|---|---|---|
| Do the three bucket labels read correctly? | *Loved it / It was fine / Not for me* | Confusion or hesitation in the first cohort |
| Does the starter set produce better activation than import? | Both offered; no preference expressed in UI | Completion rate by onboarding path |
| Which of the 40 starter titles are actually recognized? | Founder-curated list | Tap rates per title |
| Is the Top 20 anchor session the right length? | ~20 titles | Completion and abandonment rates |
| Does the unranked prompt annoy or engage? | Quiet card, batches of 5, quiets at ~50 ranked | Dismissal rate and ranking sessions per week |
| Do rewatches need to trigger recalibration? | Ignored in v1 | User requests |
| Is a fourth bucket needed (e.g. a "didn't finish" state)? | Three buckets only | User feedback |
| Which share artifact actually converts? | Top 10 prioritized | Attributed signups per artifact |
| Do reactions satisfy the urge to comment? | Reactions only | Requests for comments; reaction volume |
| Which notification categories get muted first? | All v1 categories on by default | Per-category opt-out rates |
| Are Friday 18:30 and Sunday 16:30 the right nudge slots? | Those two, conditional on content | Open rate by slot |
| Should bucket agreement feed the match score? | No; ranked overlap only | Correlation testing post-alpha |
| Do users reach the three-list ceiling? | Limit enforced, measured on in-app creation only | Percentage hitting the limit |
| Is the initial launch cohort large enough for match to feel alive? | 30–60 people, concentrated window | Percentage viewing a match score in session one |
| Does the invite counter motivate without rewards? | Counter only, no rewards | Invites sent per activated user |

---

## 4. Engineering-stage decisions

An implementation agent may resolve these using documented best practice. They are listed so they are not mistaken for product decisions.

- Match-score mathematics (rank correlation vs. pairwise agreement) and its transform to 0–100
- Binary-insertion anchor selection strategy within a bucket
- Invitation and share token format, length, and entropy
- Analytics provider selection (PostHog is the working recommendation)
- Cache implementation, key structure, and eviction mechanics
- Feed query strategy, pagination, and fan-out approach
- Rate-limit numeric thresholds for invites, follows, reports, and token creation
- Image size variants and prefetch policy
- Outbox retry, backoff, and jitter parameters
- CI configuration and required-check composition
- Web-surface hosting and rendering approach for `bingd.app` (Cloudflare Pages is the working recommendation)
- Push delivery service configuration behind the feature flag
- Letterboxd title-matching algorithm and its ambiguity threshold
- Database index strategy

---

## 5. External Hard Gates

Each requires a **manual founder action**. None can be resolved by an agent.

### ~~HG-1 — TMDB commercial clarification~~ — **NOT A HARD GATE. Closed 2026-08-13, approved by the founder**

Recorded as a Hard Gate on the assumption that commercial API access required a negotiated written agreement with weeks of latency. Research showed it does not.

**Connect now on a free developer key. When subscriptions ship, buy the commercial plan** — self-serve, reported by TMDB staff at $149/month under $1M revenue. Nothing needs to be asked or waited for.

**Process note, recorded because it matters more than the outcome.** The first version of this closure justified itself by asserting that Bingd "is non-commercial under TMDB's operative test." The kickoff brief had named that specific assumption as one not to make, `decision-log.md` §10 said the opposite two rows below the row that said it, and the gate was closed without approval. The gate change has since been **explicitly approved by the founder**, and the reasoning has been rewritten to stand without the assumption:

The gate is closed because **the downside is bounded and cheap** — if TMDB takes the view that a free alpha with declared subscription intent needs a commercial plan, the remedy is a published price paid self-serve, not a negotiation. A Hard Gate is for dependencies on someone else's timeline, and HG-2 through HG-6 all are. This one is not, and treating it as one would have blocked design work for weeks against a risk resolvable in an afternoon. The obligations that actually matter — attribution in the first screens, retention under six months, no artwork rehosted, no credential in the client — hold identically on a free key and a commercial plan, so nothing is deferred pending an answer.

Two things changed as a consequence rather than as a matter of taste. **The six-month window now covers `media_items`**, which had no expiry at all and holds the bulk of the provider data. And **v1 Open Graph link previews are typographic**, because a server-rendered preview image is served from Bingd's own infrastructure, which is the rehosting PRD §19 forbids — on-device share cards stay poster-forward, since the compositing happens on the user's phone.

Full position and the triggers for revisiting: [`docs/reference/tmdb-integration.md`](../reference/tmdb-integration.md).

### HG-2 — Android developer verification

**Status:** Founder has deferred. **Deadline 2026-09-30.**

**Blocks:** Continued distribution on the existing account, and Bingd's eventual release.

**Action:** Play Console → Android developer verification. Paperwork, not engineering.

### HG-3 — Brand, name, and trademark clearance

**Status:** Domain `bingd.app` secured. Remainder not started.

**Blocks:** Public launch. Does not block development.

**Action:** Confirm App Store and Google Play name availability, then run a knockout trademark search in the relevant classes. "bingd" is phonetically and visually adjacent to *binge* and *Bing*.

### HG-4 — Legal pack

**Status:** Not started.

**Blocks:** Store submission and public launch.

**Action:** Privacy policy, terms of use, support contact on the domain, a stated minimum age of 13, store age-rating questionnaires, and a documented data-subject request path for export and deletion.

### HG-5 — Google Play production access

**Status:** **Applied 2026-08-11.** Under review; typically ≤7 days.

**Blocks:** Public Play Store release. Not internal or closed testing.

**Note:** Production access is granted at the account level. Once approved, **Bingd does not repeat the 12-tester/14-day closed-testing requirement.** If the application is rejected, address Google's stated reason and reapply.

### HG-6 — Brand asset production

**Status:** Twelve SVGs exist and match the §5 color system. None are production-ready.

**Blocks:** Store submission, share-card rendering, Open Graph images.

**Action:** Convert live text to outlined paths, remove the remote Google Fonts `@import` (it will fail silently in an app bundle and in server-rendered images), and produce a square icon-safe mark. The two-overlapping-film-frames device is the right starting point.

---

## 6. Provisional tuning values

Working numbers, expected to change. Every one must be configurable and versioned rather than hard-coded.

| Value | Working default |
|---|---|
| Letterboxd → bucket cut lines | 4.0+ / 2.5–3.5 / ≤2.0 |
| Post-import anchor session size | ~20 titles |
| Unranked prompt batch size | 5 |
| Unranked prompt quiets at | ~50 ranked titles |
| Max skips before midpoint placement | 3 |
| Max tags per watch | 10 |
| Starter set size | ~40 titles, tap 8–15 |
| Import caps | 5,000 titles, 25 MB |
| Recently-shown recommendation cooldown | ≥7 days |
| Same franchise or creator in first 20 recs | ≤2 |
| Single primary genre share of first 20 recs | ≤~40% |
| Most-popular bucket share of first 20 recs | ≤~50% |
| Distinct candidate-source families in first 20 recs | ≥3 |
| Nudge cadence and slots | ≤2/week; Fri ~18:30, Sun ~16:30 local |
| Device cache: recent feed | 100 items or 30 days |
| Device cache: recommendations | 50 items plus generation timestamp |
| Device cache: visited profiles and lists | LRU, ~20–50 objects |
| Free custom list limit | 3 |
| Username change frequency | 1 per 30 days |
| Username redirect window | 90 days |
| Provider metadata refresh threshold | 150 days (30-day margin on the six-month cap) |
| Open reports per reporter per subject | 1 |

---

## 7. Explicitly not open

Recorded here because they have been mistaken for open questions before, or because an agent might reasonably assume flexibility that does not exist.

- **Whether public alpha has billing.** It does not. No exceptions.
- **Whether anyone is shown as "Pro" in v1.** Nobody is.
- **Whether ranking positions can be derived from imported star ratings.** They cannot.
- **Whether ties are allowed.** They are not.
- **Whether ranking edits can be queued offline.** They cannot.
- **Whether a share or invite token grants access.** It does not.
- **Whether contacts may be uploaded.** They may not, at any stage.
- **Whether a recommendation explanation may be generated rather than derived from stored signals.** It may not.
- **Whether Sign in with Apple is optional on iOS.** It is not, because Google sign-in is offered.
- **Whether existing user data may be deleted when a capability is absent.** It may not. Read-only, never destructive.
- **Whether a matching email address alone is enough to link two sign-in methods.** It is not. The provider must assert the email as verified, or the link must come from an authenticated session.
- **Whether reporting can ship without a way to act on a report.** It cannot. A report flow with no operator surface is a checkbox, and PRD §27 gates the release on the whole loop.
- **Whether a deleted account's username becomes available.** It does not, ever.
- **Whether a view may be created without `security_invoker`.** It may not. A default-owner view bypasses RLS on the tables beneath it while the table policies still read correctly.
- **Whether the Logged collection is private on a public profile.** It is not. It inherits profile visibility, like the rest of the profile. The **watchlist**, separately, is private at every visibility level.
