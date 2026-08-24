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
| Letterboxd import stage | **Deprioritized 2026-08-23** — gates neither the friend beta nor either initial store release | Decision log §4, deferred-roadmap §20 |

**READY FOR ARCHITECTURE: YES.** See PRD §31 for the full assessment and the conditions attached.

---

## 2. Inferences awaiting founder confirmation

These are recorded as decisions so work can proceed, but they were **made by the agent, not the founder**. Overturning any of them is cheap now and expensive after implementation.

### ~~INF-1 — Letterboxd rating translation~~ — **RESOLVED 2026-08-12**

Confirmed by the founder. Star ratings auto-map to buckets (4.0+ → *I liked it*, 2.5–3.5 → *It was fine*, ≤2.0 → *I didn’t like it*), shown as a single summary line, with no cut-line UI and every bucket editable per title afterward. This is now a founder decision, recorded in `decision-log.md` §4. The threshold values themselves remain Provisional and tunable after real imports.

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

Confirmed by the founder. All *I liked it* titles rank above all *It was fine* titles, which rank above all *I didn’t like it* titles. Comparisons run only within a band, which is the mechanism that keeps them short and avoids asking a user to compare titles they placed at different reaction levels. This is now a founder decision, recorded in `decision-log.md` §2 and implemented as invariant **I2** in `../architecture/ranking.md`.

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
| Do the three bucket labels read correctly? | *I liked it / It was fine / I didn’t like it* | Confusion or hesitation in the first cohort |
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
- Note length cap (2000 characters, chosen in `20260813002300`; nothing in the PRD specifies one)

### Known and deferred

Not questions so much as work deliberately not done yet, recorded so it is not rediscovered as a surprise.

- **Bucket desync between `set_bucket` and a concurrent ranking.** `set_bucket` checks that the title is unranked and then upserts, with no lock across the two statements, so one account ranking the same title from a second device in that window leaves `user_media.bucket` disagreeing with `rankings.bucket` — an I3 violation. It needs the same account writing twice in the same instant and costs one desynced bucket, no data loss. Closing it means the seven ranking RPCs and `set_bucket`/`unlog` taking a shared advisory lock on `(user_id, media_item_id)`, which is a change across two migrations and was not worth bundling into the collection writers.
- **`processed_operations` is never pruned.** The index for it exists; the scheduled job does not. A few rows per write per user, so it is an alpha-scale non-problem and a real one later.
- **The client has no outbox.** `offline-sync.md` describes a queue, a SQLite mirror of the user's own collection, and a pending marker on every unsynced row. None of it is built. Collection writes go straight to the RPC and a failure is shown as one, which is honest but means a bucket chosen without signal is lost rather than queued. Everything the server needs is already there — the writers are idempotent and take an operation id — so this is client work, and it should land before anyone tests the app on a train.
- **The watch date can only be recorded by writing a note.** `log_watched` carries both, and the log sheet calls it only when the note field is left with something in it, so a user who buckets a title and writes nothing leaves `watched_on` null. There is no date row in the sheet, though PRD §9.4 lists the date as an optional capture and `screens.md` §4 gives it a row of its own. The consequence is small — a null date, not a wrong one — but "I watched this last night" is a thing people will want to say, and the fix is a date control rather than any change to the writers.
- **Wikidata genre strings are not a browsing vocabulary.** The seed carries 247 distinct genres straight from Wikidata's taxonomy — `huis-clos film`, `flashback film`, `crossover fiction` — and one title carries nineteen of them. Nothing is offensive; it was checked. But they are indexed with GIN and will eventually be surfaced, and mapping them onto a small controlled set at generation time is the moment to do it, before a screen depends on the current strings.
- **Nothing stops a title being logged before it is released.** `user_media.watched_on` is guarded against the future; `media_items.release_date` is not, and the seed contains one unreleased season (Rings of Power S3, dated 2026-11-11). Since seasons are rankable under PRD §10, a tester can rank something nobody has seen. Fine for an alpha, and recorded here so it stays a decision rather than an accident.
- **The PRD contradicts itself about whether seasons are searchable.** §8's v1 scope line says "TMDB-backed movie, series, **and season** search and detail"; §26.2 AC 1 says search returns movies and series, and AC 2 reaches a season from its series page. `search_titles` implements §26.2, because a result list of bare ordinals — "Season 4", "Season 4", "Season 4" — tells a user nothing about which show each belongs to. Making them searchable properly means indexing the series title alongside the season, which is a real change and not a filter. Resolve it in the PRD rather than by continuing to implement one of the two readings.
- **The fold loses a letter on two ligatures.** `æ` becomes `a` and `ß` becomes one `s`, so Æon Flux answers to "aon" rather than "aeon" and Straße folds to "strase". A fixed `translate()` table cannot expand one character into two; `unaccent` can, and is an extension PGlite does not have. Nothing in the catalogue is affected today.
- **A search limit above `int32` is a confusing error.** `search_titles('x', 3000000000)` fails with "function does not exist" rather than clamping, because the argument no longer matches the signature. A JSON client can send that number; the app does not.

---

## 5. External Hard Gates

Each requires a **manual founder action**. None can be resolved by an agent.

Their current status, alongside every other pre-public major, is tracked in
[`../release/public-launch-risk-register.md`](../release/public-launch-risk-register.md) §M9.

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
- **Whether the Logged collection is private on a public profile.** It is not. It inherits profile visibility, like the rest of the profile. **The watchlist does too**, since the founder decision of 2026-08-20 and migration `20260820000200` — this bullet used to say the watchlist was private at every visibility level, which PRD §22 superseded and this document had not caught up with. What stays always-private is **notes and watch dates**, which live in `user_media` and are owner-only.
---

## 8. Semantic contradictions found in the build, 2026-08-23

Opened by the friend-beta follow-up pass. These are not new features and not new risks —
they are places where a **Decided** rule and the shipped app disagree, which is worth
naming precisely so the next semantic pass fixes the right side of the disagreement.

### TV-1 — A season is documented as rankable only when Completed, and nothing enforces it

**Status: OPEN. Verified against HEAD, not inherited from an earlier audit.**

**What the documents say.**

- `decision-log.md` §2, *TV progress*, marked **Decided** by the founder: "A season may be
  marked *Watching*, but becomes rankable only when marked completed."
- PRD §9: "Mark a season *Watching* or *Completed*. Only completed seasons are rankable."
- PRD §26, acceptance criterion 3: "Only completed seasons can be bucketed and ranked."

**What the build does.**

- `set_season_progress(p_operation_id, p_media_item_id, p_progress)` exists, is
  `security definer`, and is granted to `authenticated`. It has **zero call sites** in
  `src/` or `app/`. The client never invokes it and never even selects the column.
- `user_media.progress` is therefore **unreachable by any user**. The enum has only
  `('watching', 'completed')`; absence of a value is the implicit third state, and absence
  is what every row has.
- `set_bucket` gates on `_assert_loggable` (rejects `series`) and `_assert_unranked`.
  It never reads `progress`.
- `rank_start` gates on `rankable_category` (rejects `series`). It never reads `progress`,
  and it *creates* the `user_media` row rather than requiring one to exist.
- The series page lists seasons as **Ranked / Not ranked yet**, which is a deliberate
  design choice recorded in the screen — and is not the *Watching / Completed* control
  PRD §9 specifies.

**So the contradiction is total rather than partial:** the gate is unenforced at every
layer, and the state the gate depends on cannot be entered by any user through any surface.

**A second symptom of the same gap.** `feed_events.type` permits `'season_completed'`, the
client renders it with the verb *finished*, and both deletion paths maintain it — but **no
SQL anywhere inserts one**, because the only writer that could set `progress = 'completed'`
is never called. PRD §14 lists "a season was completed" as an eligible feed event. It can
never fire.

**Not fixed in this pass, deliberately.** Closing it means either building the
Watching/Completed control and adding a guard to two RPCs, or retiring the rule — and which
of those is right is a product decision, not a defect to patch. It is also entangled with
repeat-watch semantics (`deferred-roadmap.md` §19), because "completed" and "watched" are
the same claim about a season and should not end up as two independent records of it.

**The founder decision needed:** is the Completed gate real? If yes, the season UI and the
two guards are the work. If no, the three documents above should stop saying it.

### RW-1 — Repeat-watch semantics: the model is settled, five details are not

**Status: designed, not built.** The canonical design is `deferred-roadmap.md` §19, which
carries the full trace of current behaviour, the data model, the migration and the
rollback. The product model is **Decided** (`decision-log.md` §4, *Rewatches*): watching
again and re-ranking are different acts and neither implies the other.

What remains open is listed in full at §19.14 and is repeated here only as a pointer:
same-day duplicate rule (which decides whether the table gets a unique index), whether a
first watch produces a Feed activity, whether a rewatch gets its own verb, whether
companions become per-watch, and whether the Watchlist control on an already-watched title
is relabelled *Watch again*.

**Not open:** whether a title can hold more than one ranking or more than one score. It
cannot, and §19.2 gives the architectural reason rather than a preference.
### NR-1 — The client and the server disagree about an unspecified new note

**Status: OPEN, and deliberately not closed in the privacy-contract pass.**

**What each side does.** The column default is safe: `user_media.note_visibility` is
`not null default 'private'`, so anything created outside the two writers is private by
omission. But both writers override it *forward* when the caller passes no visibility:

- `log_watched`, insert branch — `coalesce(p_note_visibility, 'public')` for a non-empty
  note.
- `save_note` — `when v_new then 'public'`, where `v_new` is a note that has never been
  written before.

So a caller that omits the argument publishes. The client, since 2026-08-23, always sends
an explicit value and now sends `private` for a new note unless the reader asked to write
a review — **so nothing in the app reaches this path**, and no stored row is affected
either way.

**Why it is still worth closing.** Two defaults that disagree are a trap for the next
writer of a client, an importer, or a backfill: the safe-looking thing (omit the
argument) is the publishing thing. The asymmetry is also now the opposite of the stated
product contract, which is that a note is private until its author publishes it.

**Why it was not closed here.** Changing it means editing two SECURITY DEFINER functions,
which is a migration. The privacy pass deliberately changed no SQL — every other defect
it found was a document or a piece of copy describing correct behaviour wrongly — and
turning it into a schema tranche on the way past is how a narrow change stops being one.

**The founder decision needed:** should `log_watched` and `save_note` treat a null
`p_note_visibility` on a brand-new note as `private` rather than `public`?

- **Recommended: yes.** It makes the server agree with the product contract and with its
  own column default, and it is a one-line change in each function.
- **Blast radius: none observable today.** The app never omits the argument, and existing
  rows are untouched — the branch only fires for a note that does not yet exist.
- **Not urgent, and not a privacy exposure.** It can only be reached by a caller that is
  not this app.

Related: PRD §22's Notes and Reviews block, `decision-log.md` §3 *Note and Review
visibility*, and **M5** in `../release/public-launch-risk-register.md`.
### DOB-1 — The birthday is collected for one comparison and then never read again

**Status: OPEN as a data-minimisation question. No change made, and none should be made
without a founder decision.**

Opened 2026-08-23 after a beta tester asked, reasonably, why Bingd wants their birthday.
The screen answered it nowhere, which is now fixed in copy — this entry is about the
thing the copy revealed.

**What is true today, audited rather than assumed.**

- **The minimum age is 13**, enforced in exactly one place: `create_profile`
  (`20260813002200_signup.sql`) compares `p_date_of_birth > current_date - interval
  '13 years'` and, on failure, **deletes the `auth.users` row** and returns
  `under_13`. There is no client-side age check — only a real-calendar-date check.
- **A refused date is written nowhere.** Not to `profiles`, not to `profile_private`,
  not to a log. The only trace is the absence of an account.
- **An accepted date goes to `profile_private.date_of_birth`**, a table with RLS
  enabled and **no policy at all**, with `select` revoked from `anon` and
  `authenticated`. No API returns it — **including to the person who typed it.**
- **Nothing else consumes it.** It is absent from `public_profiles`,
  `profile_identity` and `search_users`; it is on the analytics denylist
  (`FORBIDDEN_PROPERTY_KEYS`) and `identify()` sends the UUID and nothing else; no
  recommendation, taste-match or award code references it.
- **`is_over_13` — the one function that reads the column — has zero production
  callers.** It exists, it is revoked from client roles, and nothing invokes it.

**So the collection is justified and the retention is the open question.** The rule
being enforced is a boolean evaluated once, at signup. After that the stored date is
never read by anything, by anyone, ever. Bingd is holding a date of birth for every
account in order to answer a question it has already answered and will not ask again.

**The smallest privacy-minimising alternatives**, in increasing order of change:

1. **Keep collecting the full date, store only the outcome.** `create_profile` compares
   and discards, exactly as the refusal path already does. Day precision is preserved
   for the comparison — the boundary case at somebody's thirteenth birthday still
   resolves correctly — and the retained-data story becomes identical for accepted and
   refused accounts. **This is the recommendation.**
2. Store birth *year* only. Loses the boundary case and needs a "turns 13 this year"
   decision. Cheaper to explain, worse to reason about.
3. Collect an age confirmation rather than a date. Weakest of the three as an
   eligibility signal, and a change to the signup flow rather than to storage.

**Why it is not being changed here.** It is a schema change with a declared-data
consequence, not an implementation detail: **the store declarations say Bingd stores a
date of birth.** Apple's App Privacy answer (Other Data Types), Google Play's Data
safety answer (Personal info → Other info) and the public privacy page all assert it.
Changing what is retained means revisiting all three, and the Apple classification is
already carrying a note to verify against the live questionnaire.

**Whether it should change before public release: probably yes, and it is cheap.**
Option 1 is a handful of lines in one function plus a `drop table`, and it removes a
category of personal data from the declarations rather than adding one. But it is a
founder decision about declared data collection, and it should be taken deliberately
alongside the store forms rather than folded into an unrelated tranche.

**Do not delete `profile_private` or its data without that decision.**
### UN-1 — What "Unranked" means, recorded because it was asked

**Not open. Written down because a founder observation needed checking and the answer
should not have to be re-derived.**

**Unranked = logged AND not ranked.** `useLoggedCollection` reads `user_media` and
`rankings`, and returns as unranked every logged row whose `media_item_id` has no
`rankings` row. **The watchlist is not consulted** — it is a different query against a
different table, and nothing in the derivation touches it.

So a title appearing under Collection → Unranked while absent from the Watchlist is the
**expected state**, not a defect. It is in fact the *designed* one: `_leave_watchlist`
(`20260815040000`) deletes the watchlist row the moment a title is logged, because a
watchlist entry is an intention to watch and watching it ends the intention. A logged,
unranked, un-watchlisted title with a watch date and a Rank control on its title page is
exactly what the three tables say it is.

The card that surfaces this is scoped to the side of the Movies/TV selector being looked
at, which is a separate fix from 2026-08-21 and is unchanged.

---

### NR-2 — Reading a notification is seeing it

**Settled 2026-08-23.** This screen has now had three behaviours and it is worth
recording why it landed here.

1. It began by marking the whole inbox read on first render. That made `read_at` a
   column with exactly one observable value: by the time anybody could look, nothing
   was unread.
2. That was replaced by nothing-marks-it-but-you, plus a `Mark all read` control.
3. Beta feedback: pressing a button to say "yes, I looked" is friction with nothing on
   the other side of it.

**Final semantics: a notification is read once it has been shown.** The marking happens
*after* the rows are on screen, so the first paint of the inbox is always the unread one
— tinted rows and dots, the state the reader came to see — and the refetch that follows
settles it. What is gone is the requirement to press anything.

That answers (1)'s objection rather than reintroducing it: the value is observable,
because it is observed before it changes.

**`Mark all read` is gone**, along with the "N unread" strip it sat in. It could not be
reached once opening the screen cleared the state, and a control that can never appear
is the dead control this repo keeps out.

**If the inbox ever gains pagination this has to change.** `my_notifications` returns
the whole inbox — 100 rows, no cursor — so "displayed" and "fetched" are the same set
today and there is no later page being marked read unseen. A paginated inbox would have
to mark per-row visibility instead.

---

### FEED-1 — Historical activity from a new follow already works

**Checked 2026-08-23 for the next social-density tranche. No implementation performed,
and none is needed for the stated goal.**

The Feed is a **query-time** read over `feed_events`, not a fan-out inbox: the client
reads the current approved-follow set, then reads events by those actors, and RLS
authorises each row with `can_i_view(actor_id)`. **There is no `follows.created_at` or
`approved_at` cutoff anywhere** — `approved_at` is written and never read by any query.

So following somebody surfaces their whole eligible back catalogue in normal
chronological position immediately, and unfollowing retracts it. That symmetry is
deliberate and documented at the policy: *"the feed is a live query, not a historical
record."*

**Verdict: SIMPLE NEXT TRANCHE — in fact already true.**

**The real constraint is the window, not the cutoff.** The feed reads a flat 30 rows
with no cursor and no pagination. Following somebody with a large back catalogue will
push other people's recent activity off the bottom with no way to page past it. That is
pre-existing and affects every follow today; it is the thing that will actually be
noticed as follow counts grow, and it is what a social-density tranche should budget for.

**Re-checked 2026-08-24 and unchanged.** `useFeed` still reads the approved follow set
at query time and still passes it to a `feed_events` read with `.limit(30)` and no
cursor. Confirmed while diagnosing TREND-1 below, which is a different query against a
different table — the flat window was not implicated in it and was left alone.

---

### TREND-1 — Trending Now disappeared because nothing refreshes the cache

**Diagnosed and fixed 2026-08-24, on a founder report that the shelf had vanished from
the top of the Feed and would not come back on a restart.**

**Not a code regression.** The four `provider_list_cache` rows were last written at
`2026-08-17T02:33Z` and were 172.6 hours old when the report came in —
`TRENDING_MAX_AGE_MS` is 168. `isTooOldToShow` therefore dropped every row,
`useTrending` returned no items, and `TrendingShelf` correctly rendered nothing, because
"Trending now" over a week-old list is a claim the screen cannot support. Classification:
**client filtered all**, with an operational cause upstream.

The cause is that **nothing schedules `npm run trending:refresh`**. The seed script's own
docstring says exactly what would happen — "one not refreshed within the week
disappears" — and names running it on a cron as the intended arrangement and running it
by hand as the current one. So the shelf worked for a week and then stopped, on a clock
nobody was watching.

The 168-hour cutoff was **not** relaxed. Widening it would be inventing stale content to
keep a section visible, which is the failure the cutoff exists to prevent.

Three things changed instead:

1. **It is observable.** `remote-smoke.mjs` now reads `fetched_at` on both `.day` lists
   and fails when either is past the cutoff, naming the command that fixes it. The shelf
   fails silently by design, so a shelf that has stopped rendering is invisible to
   everyone including whoever runs the project; this puts the condition where an
   operator already looks.
2. **Pull-to-refresh reaches it.** The Feed's `RefreshControl` refreshed the feed,
   reactions, comment counts and the bell, and not the shelf above them — so "Trending is
   gone, let me pull to refresh" was the obvious recovery and the one gesture that could
   not perform it. It now refetches by key, since the shelf owns its own query.
3. **A transient failure can no longer become permanent.** `useTrending` opts into
   `refetchOnWindowFocus`. The Feed tab stays mounted for the life of the app, so a
   failed read had no observer remounting against it and `staleTime` does not apply to a
   query with no data; one dropped connection removed the shelf until the process was
   restarted. The 30-minute `staleTime` bounds the cost — a healthy shelf is not
   refetched on focus at all.

**The residual is operational and stated rather than closed:** the lists still have no
scheduler, so they still need `npm run trending:refresh` at least weekly. The smoke test
is what makes that a check rather than a surprise.

**Checked and cleared:** the `focusManager`/`AppState` wiring added with the notification
tranche was not implicated. It gates retry continuation (`retryer.js`), which pauses
while backgrounded and resumes on focus; it cannot produce a permanent disappearance,
and the cache ages recorded above are a complete explanation on their own.

---

### LOG-1 — Can a passive action mark a title as watched?

**Bounded scan, 2026-08-24. Verdict: NO OBVIOUS BUG.** Recorded so the next person does
not repeat it, and so the semantics it relies on are written down rather than inferred.

Every writer that can create collection state was enumerated from its call site, not from
its name. There are six, and all six sit behind a tap:

| Call site | Trigger |
|---|---|
| `LogSheet` → `setBucket` | tapping a bucket chip under **"How was it?"** |
| `LogSheet` → `logWatched` (date stamp) | the same tap, and only when no date is stored |
| `LogSheet` → `logWatched` / `saveNote` | saving a note or a date the reader edited |
| `LogSheet` → `clearWatchDate` | tapping **"Don't remember"** |
| `LogSheet` → `logWatched` (row for a tag) | ticking a companion on a watch |
| `TasteBucketSheet` → `setBucket` | tapping a bucket during onboarding |

`LogSheet` contains no `useEffect` at all, so opening it writes nothing. The passive paths
named in the scan were each checked and each writes nothing: opening a title page,
`set_watchlist` (which touches only the `watchlist` table), opening and dismissing the log
sheet, opening the review composer or the private note, Recommend, and feed interaction.

**The ranking sheet cannot start a session that a bucket tap did not authorise.** All three
of its mount points — the Log tab, the title page and taste onboarding — set their subject
from an `onRank`/`onChosen` callback that fires after the bucket is chosen. Abandoning a
session calls `rank_cancel` and writes nothing else, which leaves the title Logged and not
Ranked: the canonical **Unranked** state, and what the unranked reminder is for.

**The semantics this rests on, stated plainly:** *choosing a bucket is the watch claim.*
The prompt is "How was it?" in the past tense over three chips, which is unambiguous, and
the stamp that follows it is the sheet making true the "Today" it was already displaying.
Regression coverage for the passive half is in `LogSheet.test.tsx` and
`RankingSheet.test.tsx`.

---

### FS-1 — The Following-score drilldown

**Deferred, recorded so it is not lost.** Tapping the Following score on a title page
should show the eligible people the reader follows who rated it, and their scores.

Not built and deliberately out of scope for the Reviews tranche. It is a read over
`rankings` filtered by the follow set — the same shape the Following score already
computes — so it is a surface rather than an architecture. The privacy question it has
to answer first: the aggregate deliberately does not name anybody, and a drilldown does,
so it needs the same `can_view_profile` gate every other identity surface uses and it
must not become a way to learn that a private account rated something.
