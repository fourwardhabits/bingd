# Bingd — Change Log v0.5 → v0.6

**Date:** 2026-08-12, with an independent-review addendum on 2026-08-13 (§7)
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
| C10 | Device cache target "persist until logout" for title metadata | Flagged as a **direct conflict** with TMDB's six-month caching restriction | Flagging it was correct; silently keeping either number would have been wrong. **Resolved on 2026-08-13** by complying with the terms rather than seeking an exception — see `../reference/tmdb-integration.md` |
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

Five decisions were made by the agent because the founder did not answer. They are recorded as decisions so work can proceed, and flagged in `open-questions.md` §2 so they cannot be mistaken for founder direction. **Three have since been confirmed by the founder, including both expensive ones.**

| # | Inference | Cost to reverse later |
|---|---|---|
| ~~INF-1~~ | ~~Letterboxd star ratings auto-map to buckets on fixed defaults~~ | **Confirmed by the founder on 2026-08-12.** Now a founder decision |
| INF-2 | Username change policy | Low now, **high after implementation** — share and invite routes depend on usernames |
| ~~INF-3~~ | ~~Bucket bands partition the ranking~~ | **Confirmed by the founder on 2026-08-12.** Now a founder decision |
| ~~INF-4~~ | ~~Five-tab navigation~~ | **Revisited in design and changed. Confirmed by the founder on 2026-08-13** |
| INF-5 | Canonical activation definition | Low, but must settle before attribution reporting is built |

The two that remain are both cheap to reverse. Neither blocks implementation.

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

---

## 7. Independent review, 2026-08-13

An independent review pass read the PRD, the decision log, the open questions, the architecture set, and the migrations against each other. Everything below is either a correction applied, a founder decision recorded, or a gap filled. Nothing here reopens a v0.6 decision.

The findings that mattered most were all the same kind of thing: **a guarantee written in a comment and enforced nowhere.** `date_of_birth` was documented as unreadable and was readable by any signed-in user. A released username was documented as permanently reserved and was claimable by the next account to ask. Reactions were documented as carrying no free-text field and accepted any string.

**One cause sat underneath the security findings, and it was the test suite.** Every query ran as the table owner, and Postgres skips row security for an owner — so no policy was ever evaluated, and the suite would have passed with all of them deleted. The four RLS defects lived in exactly that blind spot. The harness now switches into the real `anon` and `authenticated` roles, which took about thirty lines and no Docker, and the suite grew from 39 tests to 60.

### 7.1 Founder decisions

| Decision | Effect |
|---|---|
| **The Logged collection inherits profile visibility** | Public on a public profile, approved followers only on a private one. PRD §22's table listed neither state, so the behaviour was going to be settled by whoever wrote the view. Notes and watch dates stay private on both; the **watchlist stays private at every visibility level**, which is a separate question if you want it changed |
| **TMDB gate change approved** | HG-1 stays closed, but the justification is rewritten. See 7.6 |
| **The reaction set, with a negative reaction** | Six values, `disagree` included, against an inference that had left it out. See PRD §14 |
| **Moderation lands before public alpha** | Reporting had no schema; it ships on its own branch with its own review rather than riding along with unrelated fixes. See 7.5 |

### 7.2 Row level security defects — `20260813001400_security_fixes.sql`

Each was reproduced by a failing test written from the position of an attacker before being fixed.

| # | Defect | Why it mattered |
|---|---|---|
| 1 | `date_of_birth` readable by anyone who could see the profile | The column promised in a comment that it was "never returned by any API, including the owner's own." **Row level security is row-level:** a policy admits a row, and an admitted row is readable in every column. Any signed-in user could read the exact birth date of every public account. Moved to `profile_private`, which has RLS enabled and no policy at all |
| 2 | `resolve_capabilities` and `is_over_13` callable for any user | Postgres grants `EXECUTE` to `PUBLIC` on every function, Supabase grants it to `anon` and `authenticated` too, and a `SECURITY DEFINER` function bypasses RLS. **So every definer function taking a user argument was an open endpoint.** Also reached `_rank_finalize`, where calling it directly would place a title without answering a single comparison. Revoked by rule, with `my_capabilities()` as the client route |
| 3 | Client roles held `INSERT`, `UPDATE`, and `DELETE` on every table | AD-4 held, but on RLS deny-by-default alone: one carelessly added write policy would have opened a direct path. The schema test meant to catch this **passed because the roles did not exist** in the old harness, so it asserted that an empty set was empty |
| 4 | `link` lists were indistinguishable from `public` | The policy admitted `visibility in ('public','link')`, so a client could enumerate every unlisted list of every visible owner. Possession of a link cannot be expressed as a policy predicate, so retrieval moved to `list_by_id()`, where naming the id *is* the gate |
| 5 | A block did not hide a watch tag from either party | The policy tested `tagger_id = auth.uid()` before consulting the visibility helper, so a block changed nothing. PRD §22 requires a block to reach tagging along with everything else. The fix needed `SECURITY DEFINER`: an inline subquery against `blocks` inherits `blocks_read`, which hides a block from the very person it should be blocking |

### 7.3 Integrity defects — `20260813001500_integrity_fixes.sql`

| # | Defect | Why it mattered |
|---|---|---|
| 1 | A released username was still claimable, by two separate routes | `username_history.profile_id` cascaded on delete, so **deleting an account released its name immediately** and every shared `bingd.app/u/<name>` link pointed at whoever took it next. Worse, the protection this document credited to the history table's primary key **did not exist**: that key is unique within the history and had no connection to `profiles.username`. Now a `before delete` trigger reserves the name and a second trigger enforces the reservation against profile writes |
| 2 | `invite_attributions.inviter_id` cascaded on delete | An inviter deleting their account **destroyed the invitee's attribution row and its `activated_at`**. Decision log §5 marks growth provenance Required, "impossible to reconstruct later," "Never remove." It now detaches instead, keeping the fact and dropping the identity |
| 3 | `updated_at` was never advanced on `user_media` | Made the note-conflict rule in `offline-sync.md` §5 **unimplementable**. There was no server-side version to compare against, so the documented user-visible choice would have been a silent overwrite |
| 4 | `reactions.kind` was unconstrained `text` | The guarantee that reactions carry no moderation surface rests on the column being closed. A column accepting any string *is* a free-text field. The set was first recorded as INF-6 and **resolved by the founder on 2026-08-13** as six values including `disagree` — see PRD §14 |
| 5 | `media_items` had no expiry and no index on `fetched_at` | `media_cache` had one; the larger share of provider data did not. A title in someone's ranking, untouched for seven months, was retained provider data nothing could find — and compliance with the six-month limit is load-bearing in the decision to connect on a free key |

### 7.4 Ranking engine defects — `20260813001600_ranking_session_fixes.sql`

Two of these corrupt a ranking through ordinary documented use, and all three were reproduced against the real migrations before being fixed.

They shared a cause: a session stored its search bounds as **absolute positions**, and a position only means something relative to a ranking that is not moving. Bounds are now offsets within the bucket band, so the band sliding underneath an open session no longer invalidates it.

| # | Defect | Why it mattered |
|---|---|---|
| 1 | Skip displayed a title the answer path then refused | `rank_skip` re-anchored to a new pivot and stored nothing; `rank_answer` recomputed the midpoint and rejected the title it had just shown. **Skip was not imperfect, it was unusable** — every skip led to a dead end. It survived because tests covered skip and answer separately and never in sequence |
| 2 | A title could be placed in the wrong band | Rank one more `loved` title while a `fine` session is open, and every `fine` position shifts down by one while the session's bounds do not. Answering it to completion inserted into the `loved` band. **Invariant I2 broken by using the interface as designed** |
| 3 | Changing bucket mid-session put a title in two buckets at once | `rank_start` resumed any existing session without comparing its bucket to the requested one, so `user_media` said `fine` while the session finalized as `loved`. **Invariant I3.** This is simply what a user does when they reconsider halfway through |

`_rank_finalize` now recomputes the band inside its advisory lock and refuses an out-of-band position outright. I2 cannot be expressed as a constraint, so without a backstop a violation is silent and surfaces weeks later as a ranking the user knows is wrong and cannot explain.

### 7.5 Reporting and moderation — `20260813001700_moderation.sql`

PRD §22 marks reporting **Required** by policy, §23 lists a `reports` entity, AC 26.15.5 requires a report flow, and `api.md` §9 rate-limits a `report` function. **None of it existed.** No table, no function, no operator surface. Blocking shipped and reporting did not, leaving a product with user-generated usernames, display names, and list titles with nowhere for a complaint to arrive — a platform obligation, not a feature.

Built on its own branch with its own review, because a missing subsystem is not a correction and should not ride along with fixes to unrelated tables. The founder confirmed on 2026-08-13 that it lands before public alpha rather than later.

Added: a `reports` table with the §22 taxonomy and one open report per reporter per subject; a `report()` function, since with no insert policy and no client write grant the table alone was a mailbox with no slot; reversible account **suspension** via `profiles.status`, threaded into `can_view_profile` so it reaches all seven surfaces at once; `assert_can_write()`; an audited `moderation_actions` log; and two `security_invoker` views for triage.

**The first draft defined `assert_can_write` and never called it**, so suspension silently stopped nothing while the documentation read as though the account were contained. A safety control that does nothing is worse than an absent one, because it gets relied upon. The guard is now applied by wrapping each ranking RPC, and — more importantly — the wiring is **asserted structurally**: a test reads `pg_proc.prosrc` and fails if any client-facing `rank_*` function omits the call. That is the difference between fixing an instance and closing the class.

Deliberately **not** built: an admin application, an appeals flow, automated detection. For 30–60 users the operator surface is the Supabase SQL editor, and building a console before any triage experience is the expensive way to learn what it should contain. None of the three is acceptable beyond alpha.

Deliberately **not** built: an admin application, an appeals flow, automated detection. For 30–60 users the operator surface is the Supabase SQL editor, and building a console before any triage experience is the expensive way to learn what it should contain. None of the three is acceptable beyond alpha.

### 7.6 The TMDB gate change

HG-1 was closed on 2026-08-13 by asserting that Bingd "is non-commercial under TMDB's operative test." Three problems: the kickoff brief named that specific assumption as one not to make, `decision-log.md` §10 contradicted it two rows below the row that stated it, and the gate was closed without approval.

The gate change is now **approved**, and the reasoning stands without the assumption: the downside is bounded and cheap. If TMDB takes the other view, the remedy is a published price paid self-serve rather than a negotiation. A Hard Gate is for dependencies on someone else's timeline; this is not one, and the obligations that matter — attribution, retention, no rehosting, no client credential — hold either way.

Two consequences followed as corrections rather than preferences. The six-month window now covers `media_items` (7.2, #6). And **v1 Open Graph link previews are typographic**, because §19 says artwork is never rehosted on Bingd infrastructure while §19 and §16 also promised poster-bearing link previews — a server-rendered preview image *is* served from Bingd's infrastructure. On-device share cards stay poster-forward; the compositing happens on the user's phone.

### 7.5 Specification corrections

| Where | Was | Now |
|---|---|---|
| `api.md` §1, `offline-sync.md` §3 | `set_bucket` and `unlog` queueable without restriction | **Both refuse a ranked title.** Each was a queueable ranking mutation, straight through PRD §18's prohibition — `set_bucket` needs a band move and renumber, `unlog` deletes a position and closes the gap. The outbox allowlist could not catch it, because it reasons about function names while the danger is in the row's state. General rule recorded: **a function is queueable only if it is queueable for every state its target row can be in** |
| `api.md` §5 | `accept_invite` rejects if "already accepted" | Attribution and acceptance separated. **First inviter wins the attribution; every later accept still creates the follow.** As written, a second friend's genuine invite would have collided on a primary key and failed, for a reason living in a row about someone else |
| PRD §10 | "64 titles needs about 6 comparisons; 256 about 8" | **7 and 9.** Inserting into *k* items chooses between *k* + 1 gaps. AC 26.3.4 already said 7 for a bucket of 64, so the PRD disagreed with its own acceptance criterion and the criterion was right |
| PRD §14 | Unfollowing "does not retroactively rewrite history" | **Unfollowing removes that person's events entirely, past included.** True of a fan-out-on-write inbox, untrue of AD-6's read-time assembly — and the less surprising behaviour anyway |
| PRD §20, §28 | Early Access implemented; "Early Access engagement vs. control" tracked | **`alpha_early_access` confers nothing in v1**, deliberately. Stated because the metric had no treatment to measure. Removed; gate-hit data is the monetization evidence. Not fixed by granting a benefit, which would split a 40-person sample |
| All views | Unspecified | **Every view is `security_invoker`.** A default-owner view bypasses RLS on the tables beneath it. `visible_collection` exists *because* `user_media` is owner-only, so a default-owner view over it would have published every user's notes while the table policy still read correctly |

### 7.6 New documents

- **[`../architecture/auth.md`](../architecture/auth.md).** Authentication had three sign-in methods, one sentence, and no architecture document while every other v1 subsystem had one. The sentence described the hard problem without solving it, and **AC 26.1.3 was unsafe read literally**: "signing in again by any method reaches the same account" means linking credentials on a matching email, which is account takeover wherever that email is unverified. The document sets the linking rules, covers Apple private relay — where no address can ever match, making the Settings link flow the only path to a second method — and the authenticated-but-not-onboarded state that the 13+ gate creates.

### 7.7 Two review claims that were wrong

Recorded so neither gets "fixed" later.

**`match_scores` was reported as having no read policy.** It has one, and it is correct — a caller may read a row only if they are one of the two parties *and* can view the other, which satisfies PRD §13's two-party rule and settles the leaderboard case without needing a second rule. The policy was simply absent from `data-model.md`. Documentation gap, not a defect. Now shown.

**`feed_events.list_id` was reported as missing a foreign key.** The feed migration declares it as a bare `uuid`, but `20260813000800` adds the constraint once `lists` exists, which is the only order the dependency permits. Adding it again would have created a duplicate constraint on the same column, which Postgres permits and nobody wants.

Both were caught by reading the migrations rather than the documents, which is the general lesson: `data-model.md` explains reasoning and the migrations are what runs, so a claim about the schema has to be checked against the schema.

### 7.8 Scope

PRD §30 gains a **degradation order** — story card, then scheduled nudges, then public web pages, then collaborative filtering. Eleven phases is a large v1 for one founder working through agents, and the failure mode worth avoiding is discovering that in phase 9 and cutting whatever happens to be unfinished. Deciding the order now, while nothing is at stake, costs nothing. Ranking, import, feed, reporting, capability enforcement, invitations, and the offline matrix are above the line.
