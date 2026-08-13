# Bingd — Change Log v0.5 → v0.6

**Date:** 2026-08-12
**Supersedes:** `Bingd_PRD_v0.5_Finalization_Draft_20260812.pdf`
**Companion documents:** [`PRD.md`](./PRD.md) · [`decision-log.md`](./decision-log.md) · [`open-questions.md`](./open-questions.md)

---

## Summary

v0.6 takes v0.5 from a well-developed draft to a build-ready specification. Three kinds of work were done:

1. **Resolved the six product decisions that blocked architecture** — default privacy, invitation acceptance, invitation token model, notifications, lists in alpha, and import staging.
2. **Reconciled 22 internal contradictions, gaps, and stale references** found in v0.5.
3. **Added the material v0.5 was missing** — acceptance criteria, a notification system, a moderation and safety model, a collection-state model, and a consolidated privacy section.

The net effect: **READY FOR ARCHITECTURE: YES**, with five agent inferences flagged for founder confirmation.

---

## 1. New product decisions incorporated

Founder decisions made during finalization that did not exist in v0.5.

| # | Decision | Where in v0.6 |
|---|---|---|
| 1 | Three-bucket rating (Loved it / It was fine / Not for me) before pairwise comparison | §10 |
| 2 | Letterboxd import moves into v1 | §12, §8 |
| 3 | Watch tagging of Bingd users | §14 |
| 4 | Reactions on feed activity; comments remain deferred | §14 |
| 5 | Full notification system in v1, with push built but delivery flagged off | §15 |
| 6 | Twice-weekly conditional nudge, Friday and Sunday | §15 |
| 7 | One reusable personal invite link plus short code | §17 |
| 8 | Invite counter with no rewards in v1 | §17 |
| 9 | Public profiles by default | §22 |
| 10 | Subscription intent declared; no billing and no Pro display in v1 | §20 |
| 11 | Universal over-limit rule: read-only, never destructive | §20 |
| 12 | All lists import regardless of the three-list limit | §12, §20 |
| 13 | Bundle identifiers `app.bingd` / `.dev` / `.preview` | §24 |
| 14 | Design direction derived from the brand system | §5 |
| 15 | Reference discipline: Apple TV / Wallet / Open for language; Beli / Spotify / Cash App / Strava / Letterboxd for flows only | §5 |

---

## 2. Contradictions and gaps reconciled

Each row states what v0.5 said, what v0.6 says, and why.

### Severity: would have caused wrong code

| # | v0.5 | v0.6 | Why |
|---|---|---|---|
| C1 | §10 stated ordinal-only display, but three passages referenced "a derived display score or percentile" | Ordinal position is the **only** rendered output. A derived value may exist in storage but is never displayed. Tested in §25 and §26.3.6 | An agent reading the score passages would have built and shipped a visible score, contradicting the founder's central differentiator from Beli |
| C2 | Lists deferred past public alpha in §8, while `unlimited_custom_lists` appeared as a v1 Early Access capability in §15 | Lists ship in v1 with the three-list limit enforced for everyone. `unlimited_custom_lists` is defined but not granted | The two statements cannot both be true. Granting unlimited lists in alpha would also destroy the only signal about whether the limit motivates upgrade |
| C3 | Invitation acceptance described as "accepts or follows" in three places, never defined | Explicit tap → one-way recipient→inviter follow → follow request if the inviter is private → inviter prompted, never auto-followed → recipient hidden before acceptance → blocks void the invitation | "Accepts or follows" describes at least four incompatible implementations. This is the single highest-risk ambiguity in v0.5 |
| C4 | Invitation tokens described inconsistently, sometimes personal and reusable, sometimes per-recipient | One reusable personal link plus a short code, revocable and regenerable | The two models imply different schemas, different attribution, and different abuse surfaces |
| C5 | Default profile visibility left **Open** | Public by default, Private toggle in Settings | Nearly every social surface — feed, leaderboard, match, sharing, web pages, RLS — depends on this. It cannot be deferred past architecture |
| C6 | Notifications referenced in the §5 brand voice table, but absent from scope, IA, entities, flows, tests, and metrics | Full §15, plus entities, preferences, acceptance criteria, tests, and metrics | An agent would have either invented a notification system or shipped none. Both are wrong |
| C7 | Sign in with Apple listed as "recommended" | **Required on iOS** | Apple's guidelines require it wherever a third-party social login is offered. Google sign-in is in scope. Listing it as optional risks App Review rejection |
| C8 | Activation defined two different ways in §21 | One canonical definition: ranked 10 titles; the rate metric adds a 24-hour bound | Invite and share attribution cannot reconcile against two definitions |

### Severity: would have caused rework or a policy problem

| # | v0.5 | v0.6 | Why |
|---|---|---|---|
| C9 | IA listed a "Settings / Subscription" area while v1 has no billing | Renamed to **Settings**. Plan management and restore are paid-beta only | Prevents an agent from building plan UI that must not exist in v1 |
| C10 | Device cache target "persist until logout" for title metadata | Flagged as a **direct conflict** with TMDB's six-month caching restriction; raised explicitly in the licensing inquiry | Not resolvable internally. Flagging it is the correct action; silently keeping either number would be wrong |
| C11 | Block and report had no stated offline behavior | **Online-only, never queued.** Hidden locally on tap, submitted when connected | Safety actions with stale queued state are dangerous. The outbox list would otherwise have absorbed them by default |
| C12 | Token semantics ambiguous — tokens described as non-authorizing, but "link-accessible" implied bearer access | **Link-accessible is a visibility level**, not a token capability. The server authorizes every request against current visibility | The ambiguity invites a bearer-token implementation, which is an access-control defect |
| C13 | Tier matrix omitted standard sharing and invitations | Explicit permanently-Free row | Principle 12 says growth loops are never paywalled. The matrix must state it or a future packaging exercise will quietly break it |
| C14 | Ties never addressed | **No ties**, tested | Exact ordinal display makes ties incoherent, and they would contaminate match calculation and share cards |
| C15 | No minimum age stated | **13+** with a date-of-birth gate | Required for store age ratings and to stay out of COPPA scope |
| C16 | No moderation, reporting, or blocking specification, despite user-generated usernames, display names, and list titles | Full §22 with a report taxonomy and blocking semantics | Platform UGC obligations apply even without comments |
| C17 | No username change policy, though share and invite routes use `/u/<username>` | One change per 30 days; 90-day redirect; never instantly reusable (INF-2) | Instant reuse of a released username is an impersonation vector against every previously shared link |
| C18 | Match card privacy for the second party unspecified | Handle and avatar shown only if that user is public and no block exists; private users anonymized | Sharing another person's data without a rule is a privacy defect waiting to ship |

### Severity: clarity and traceability

| # | v0.5 | v0.6 | Why |
|---|---|---|---|
| C19 | Founder's guide treated as current | Marked in Appendix B as **written against v0.4**; authoritative on engineering practice, superseded on product scope | Prevents an agent from resolving a conflict in favor of the older document |
| C20 | Brand SVGs assumed usable | Marked **not production-ready**: live text, remote Google Fonts `@import`, no square icon mark. HG-6 added | The font import fails silently in an app bundle and in server-rendered Open Graph images. Discovering this during store submission is expensive |
| C21 | `founding_member` mentioned without definition | Recorded on all pre-paid-beta accounts; **confers nothing yet**, deliberately | Keeps the option open without creating an implied promise to alpha testers |
| C22 | No acceptance criteria anywhere | **§26**, covering all 16 must-have feature areas | The kickoff requires them, and without them "done" is a matter of opinion |

---

## 3. Structural changes

### New sections

| § | Section | Reason |
|---|---|---|
| 11 | Collection model: Logged and Ranked | Three buckets plus large imports create a state v0.5 had no vocabulary for |
| 12 | Letterboxd import | Was three lines in a v0.5 flow list; now a v1 must-have needing full specification |
| 14 | Social interaction: feed, reactions, and tagging | Both features are new |
| 15 | Notifications and activity awareness | Closes C6 |
| 17 | Direct friend invitations | Split out of v0.5 §12, which conflated outward sharing with direct invitation. They have different privacy models, different tokens, and different metrics |
| 22 | Privacy, safety, and moderation | v0.5 scattered this across three sections and left the central default Open |
| 26 | Acceptance criteria for public alpha | Closes C22 |
| 31 | Readiness assessment and go/no-go gates | Kickoff requirement |
| B | Source documents and evidence boundary | Closes C19; makes the four claim categories explicit |

### Section mapping

| v0.5 | v0.6 |
|---|---|
| 1–4 | 1–4 |
| 5 Brand | 5 Brand, visual identity, **and design direction** |
| 6–7 | 6–7 |
| 8 Scope | 8 Scope |
| 9 Flows | 9 Flows (import extracted to 12) |
| 10 Ranking | 10 Ranking (**+ buckets**), 11 Collection model |
| 11 Match and recommendations | 13 |
| 12 Sharing, deep links, referral | 16 Sharing **and** 17 Invitations |
| 13 Offline | 18 |
| 14 Metadata | 19 |
| 15 Capabilities | 20 |
| 16 Payments | 21 |
| 17 Data and architecture | 23 |
| 18 Environments | 24 |
| 19 Testing | 25 |
| 20 Public release | 27 |
| 21 Metrics | 28 |
| 22 Risks | 29 |
| 23 Decision log | Extracted to `decision-log.md` |
| 24 Validation questions | Extracted to `open-questions.md` |
| 25 Implementation plan | 30 |
| 26 Go/no-go | 31 |
| Appendix A | Appendix A, expanded |
| — | 12, 14, 15, 22, 26, Appendix B (new) |

### Extracted to separate files

v0.5 §23 and §24 became `decision-log.md` and `open-questions.md`. They change on a different cadence than the PRD, they are the documents an implementation agent must check most often, and keeping them inline made both harder to scan and easier to leave stale.

---

## 4. Wording not preserved, and why

Kickoff requirement: state any v0.5 wording not carried forward.

| v0.5 wording | Status | Reason |
|---|---|---|
| "a derived display score or percentile" (3 occurrences) | **Removed** | Contradicts the ordinal-only decision. See C1 |
| "Settings / Subscription" | **Renamed** to "Settings" | No billing exists in v1. See C9 |
| "accepts or follows" (3 occurrences) | **Replaced** with the seven-step definition in §17 | Ambiguous to the point of being unimplementable. See C3 |
| "Sign in with Apple (recommended)" | **Changed** to Required on iOS | Platform policy, not preference. See C7 |
| "unlimited custom lists" as a v1 Early Access grant | **Removed as a grant**; retained as a defined capability | See C2 |
| "Letterboxd import — early traction" | **Moved** to public alpha | Founder decision |
| Two competing activation definitions | **Replaced** by one | See C8 |
| "persist until logout" for cached title metadata | **Retained but flagged** | Conflicts with provider terms. Resolution is external. See C10 |
| Open question "Should profiles be public or private by default?" | **Removed** | Decided. See C5 |
| Open question "Should invitations create a follow?" | **Removed** | Decided. See C3 |
| Open question "Which sharing artifact should be prioritized?" | **Removed** | Decided: Top 10 |
| Open question "Should custom lists ship in public alpha?" | **Removed** | Decided: yes, limited to 3 |

Everything else from v0.5 is preserved in substance. Where phrasing changed, it changed for concision or to match the voice table in §5, not to alter meaning. All status labels from v0.5 are preserved, and the label set is unchanged.

---

## 5. Inferences introduced in v0.6

Five decisions were made by the agent because the founder did not answer. They are recorded as decisions so work can proceed, and flagged in `open-questions.md` §2 so they cannot be mistaken for founder direction. **One has since been confirmed.**

| # | Inference | Cost to reverse later |
|---|---|---|
| ~~INF-1~~ | ~~Letterboxd star ratings auto-map to buckets on fixed defaults~~ | **Confirmed by the founder on 2026-08-12.** Now a founder decision |
| INF-2 | Username change policy | Low now, **high after implementation** — share and invite routes depend on usernames |
| INF-3 | Bucket bands partition the ranking | **High** — this is the ranking data model |
| INF-4 | Five-tab navigation | Low — marked Provisional, expected to change in design |
| INF-5 | Canonical activation definition | Low, but must settle before attribution reporting is built |

INF-3 should be confirmed before Phase 3 of the implementation plan.

---

## 6. What did not change

Recorded so it is clear these were reviewed and deliberately kept.

- The core mechanic, the ordinal-only display decision, and the movie/TV-season scope.
- The full recommendation guardrail set, unchanged in substance and still applying equally to Free, Early Access, and future Pro.
- The offline posture as resilient rather than offline-first, and the narrow queueable write set.
- The metadata approach: provider-agnostic adapter, live-plus-cache, no mirror, no client credentials.
- The capability model and the decision to build capabilities without billing.
- The no-contact-upload rule and the share-sheet-over-SDKs decision.
- Every status label and the meaning of each.
- The engineering practices from the founder's guide: branching, review discipline, agent authority limits, testing layers, environment separation.
