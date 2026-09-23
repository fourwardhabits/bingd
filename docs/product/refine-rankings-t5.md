# T5 — Unified Backlog + Refine (as built)

**Status (2026-09-23, stopping point): shipped.** Merged to `main` as PR #203 (`ceb4f14`), on
top of #196 (`30833d5`). Migration **`20261019000100`** is applied to **staging and
production** (production: 168 migrations, head `20261019000100`). The production OTA from
`a17880d` carries the client (Android Play vc12 and iOS TestFlight 1.0.1 builds 8–12; App Store
1.0.0 users get it with the 1.0.1 (13) binary). Production flags, read 2026-09-23:
**`ranking.backlog_enabled = true`**; **`ranking.refine_enabled = false`** until the backlog
smoke passes (cutover phase 8, [`stopping-point-cutover.md`](../release/stopping-point-cutover.md)).
Refine is finished product that is switched off, not unfinished work. #197 (the pre-unified T5
draft branch) is superseded by #203.

This is the one ranking flow for everything already seen and not yet ranked. It **supersedes the
separate "Rank your imports" / standalone T6 concept**: imported titles are simply the backlog's
largest source. The import summary's existing **Rank imported movies** button opens Collection ▸
Unranked, where *Start ranking* is. PR #204 (open, not in the stopping-point release) rewords it
to *Rank imported titles* and shows it only while the backlog has titles. Either way it is a
shortcut into this same flow, not a second product.
**Design:** [`watch-history-and-ranking-calibration.md`](./watch-history-and-ranking-calibration.md)
§G, §H, and §I as amended there; the unified design approved by the founder on 2026-09-21.
This file records what was built, the exact rules, and where the build departs from the design.

---

## 0. The unified design (2026-09-21)

**One ranking session, two sources**, `app/rank-session.tsx?medium=…&start=backlog|refine`:

| Source | What it deals | Opens with | Ends |
|---|---|---|---|
| **Backlog** | titles seen and not yet ranked: incomplete native placements first (an open first-ranking session, then a bucket chosen in bingd), then by most recent watch date, then most recently added | `rank_backlog_start`: resumes the open first-ranking session in that bucket with its answers, or opens a silent `import`-kind placement. *How was it?* first when there is no bingd bucket | a soft checkpoint every 10 placed; *You're caught up.* when empty, offering Refine only if the card rules pass and only on a tap |
| **Refine** | ranked titles whose evidence is thin (§2) | `refine_start` (unchanged) | 5 titles or 12 answers per round, **Keep going** only while card-quality titles remain, at most 3 rounds, 30 a day server-side |

Both run the same comparison view over the same `rank_answer` / `rank_skip` / `rank_back`. There
is no second ranking algorithm.

**Collection (Movies / TV only; never Lists or Watchlist):**

| Where | Card | Shows when | Buttons |
|---|---|---|---|
| Watched (one slot) | *You have titles left to rank* / *Finish placing the movies you've already seen.* — **no count** | the backlog has titles and the card is not dismissed (the 50-ranked rule is dropped while the backlog is on) | View unranked · Dismiss |
| Watched (same slot) | *Fine-tune your rankings* / *A few comparisons could help tighten up N placements.* | nothing to rank in the medium, the server's `cta.show`, and no Not now still holding | Refine rankings · Not now |
| Unranked, top | *Rank your unranked titles* / *Go through them one at a time…* / *18 movies to rank* | the backlog has titles | Start ranking (no dismiss) |

Unranked wins the Watched slot. T5's `Refine rankings ›` line is removed; there is no permanent
manual entry. **Not now** (and Done after a sitting) stores the medium's placement total; the card
may return only after `ranking.refine_resurface_placements` (3) new placements **and** a strong
batch again. No time-based return.

**Backend (`20261019000100`):** `ranking_backlog` (read) and
`rank_backlog_start` (write, calls the write guard), `refine_candidates` amended (§2, the `cta`
block, `placements_total`), and `rank_start` gains one branch: an open backlog session in the same
bucket is resumed as itself rather than restarted, so + on a row and Rank on the title page keep its
answers (#196's contract). No new tables. The legacy `unranked_queue` RPC (20260813000700, bucketed
titles only, both media, unused by the client) is left as it is.

**Reused from #196, not duplicated:** the Letterboxd star correction (`20261018000100`: a star is
never a bucket; the guarded backfill), `rankingStateOf`, the binary ranked/unranked UI, and the
first-placement session that survives a close.

**Feed:** a backlog placement posts nothing (founder decision 2). Finishing an abandoned **native**
ranking — resumed from the backlog or anywhere else — keeps its native kind, so it posts as it
would have. `ranking-backlog.test.mjs` asserts both.

---

## 1. What it is

A finite calibration flow for titles that **already hold a position**. It picks the ranked titles
whose place has the weakest direct evidence and re-checks each one where it sits, through the same
comparison engine a correction uses. Only an explicit answer can move a title.

It is not an unranked queue, a watch, a correction, a feed event, decay or an automatic reorder.

| Refine writes                                                                       | Refine never writes                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `comparisons` (the answers)                                                         | `watch_events`, `user_media`                             |
| one `ranking_placements` row, `kind = 'refine'`, per finished title                 | `feed_events`, `notifications`                           |
| when an answer moved it: `_rank_finalize`'s delete + insert, `created_at` preserved | `list_items`, `watchlist`                                |
| `ranking_snoozes` ("I don't remember it")                                           | any change to `rankings.created_at` (the streak's clock) |

**One ranking algorithm.** No existing function was rebuilt. `refine_start` opens a `_rank_start_impl`
session with `kind = 'refine'`, `strategy = 'prior'` and the §H.5 tolerance, all of which T2
(`20261004000100`) already supports. Every answer then goes through `rank_answer`, `rank_skip`,
`rank_back` or `rank_cancel`, unchanged. `refine.test.mjs` asserts each item in the "never" column
against a collection seeded with the full trigger stack.

## 2. Target selection (exact)

`_refine_support(user, category)` is one set-based statement over the category: its rankings, the
latest non-withdrawn answer per pair inside a band, and the ledger. It is derived and never stored.
For each ranked title _t_ at category position _p_ in a band:

- **gap_above**: the number of titles between _t_ and the nearest title above it that beat _t_ in the
  latest answer for that pair. When no title above it did, it counts every title above _t_ in its band
  (0 at the band's top).
- **gap_below**: the same thing downward, for titles _t_ beat.
- **conflicts**: pairs whose latest answer contradicts the current order and is newer than _t_'s last
  confirmed placement.
- **w** (tolerance, §H.5): 0 for #1–25, 1 for #26–100, 3 for #101–300, 7 beyond.

A fresh bisection leaves both gaps at 0, because `lo` moves only on a loss to item `lo-1` and `hi`
only on a win over item `hi`. A gap opens when:

- titles were later inserted around _t_ without being compared with it,
- _t_ was placed by skips or a dry walk,
- or _t_ has no answers at all (a band's first title, or legacy/backfilled rankings).

That covers sparse evidence, growth, imports and early sessions.

**Refined enough (per title):** `gap_above ≤ w`, `gap_below ≤ w`, and no conflicts. An unchanged
refine leaves exactly this state behind, because it tests the item just outside each edge of the ±w
window. So a refined title drops out of the pool by construction.

**Priority**, for titles that are not refined enough:

```
excess   = max(gap_above − w, 0) + max(gap_below − w, 0)
span     = min(1, ln(1 + excess) / ln 32)
shifted  = min(1, crossed / (2 · crossed_min))
priority = rank_weight × (0.7·span + 0.3·max([conflicts > 0], shifted)) × (1 + 0.25·fragile)
  rank_weight  1.0 (#1–25), 0.6 (#26–100), 0.3 (below)
  crossed      titles an EXPLICIT rerank (correction / rewatch re-check / manual) carried past
               t since t was last confirmed — "its local section shifted"
  fragile      last placement adjustable (skips, dry walk, backfill)
```

**No age term (founder, 2026-09-21).** T5's draft multiplied by `1 + 0.25·stale` and had a
`placed_long_ago` reason. Both are gone: how long ago a title was placed is not evidence that it is
misplaced. `refine.test.mjs` pins that the same evidence gives the same candidates whether it is a
day or three years old. `crossed` reads positions as they are now against the ordinals each move
recorded, so it is an approximation that can only raise a priority; first rankings, backlog/import
placements, backfill and refines never count (Refine must not feed itself).

**Eligible:**

- band ≥ 2;
- not snoozed;
- not in the current sitting;
- **evidence:** a gap beyond `w`, a conflict, or `crossed ≥ ranking.refine_crossed_min` (2);
- priority ≥ `ranking.refine_min_priority` (0.08);
- not refined in the last `ranking.refine_cooldown_days` (30), or 90 days if the last refine was `kept`.

In practice the threshold means any gap in the top 100 qualifies, but below #100 a title needs at
least three titles beyond its tolerance.

**Order:**

1. A refine session left open comes first (`resume`).
2. Then priority, in 0.05 steps.
3. Ties break on `hashtextextended(title, seed)`, where the seed is chosen per sitting. That is the
   only randomness: it varies which of several equally useful titles comes first.
4. The ±3 neighbours of titles already done in this sitting are discounted ×0.3.

**Pairs.** These come from T2's `next_pivot`, unchanged. The engine first asks the item just above
the window, then the item just below it. It gallops outward only when an answer shows the title has
moved, then bisects. The first questions are always neighbours; a distant title is asked only when
the search needs it.

**One addition: `_refine_seed`.** A pair answered in the last 90 days is not asked again. On a fresh
session, the latest answer per pair, when it is recent and agrees with the current order, opens the
bounds where that answer already puts them. This is exactly the `lo`/`hi` the same answer would
produce inside the session. The seed never moves a title, because the prior stays inside `[lo, hi]`.
It is skipped when it would confirm the window on its own, so every refine asks at least one fresh
question.

## 3. Why not random

Measured with `supabase/tests/perf/refine-scale.mjs` on real PostgreSQL 17:

- **Library:** 200 titles whose stored order differs from a known true order. 30 titles are
  displaced 5–40 places with no answers of their own (imported). 10 are displaced with answers that
  agree with where they sit (drifted, which no evidence can detect).
- **Protocol:** each strategy spends the same budget of about 120 answers through the real RPCs.
  5 trials.

| Strategy                   | Inversions fixed per answer | Targets that were actually misplaced                                                                                  |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Evidence (what ships)**  | **1.81**                    | **73 / 79 (92%)**                                                                                                     |
| Random target, same engine | 1.00                        | 57 / 182 (31%)                                                                                                        |
| Random pair                | —                           | a random pair disagrees with the list **3.5–4.2%** of the time, and in this engine one answer to a pair moves nothing |

Evidence-driven selection fixes 1.8× as much disorder per answer. Almost every title it offers
actually needed a look, so a sitting spends the reader's attention where it changes something.
Random pairs are worse still: about 96% of them ask a question whose answer is already implied by
the list. The drifted titles are the honest limit. Their evidence looks fine, and since the unified
design removed the `stale` age term (§2), Refine reaches them only if a later answer contradicts
them or an explicit rerank carries titles past them. That is deliberate: time alone is not
evidence of a misplacement.

## 4. Why it stops

| Scope            | Rule                                                                                                                                                        | Where                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Per round        | 5 titles, or 12 answers (checked when a title finishes, so a title that is moving is finished, not cut off)                                                 | client, `refine.ts`  |
| Per sitting      | 3 rounds; after the third, the checkpoint offers **Done** only                                                                                              | client               |
| Per day          | `ranking.refine_daily_targets` (30) refine placements per rolling 24 h → `rested`; `refine_start` refuses with `53400` (resuming an open target is allowed) | **server**           |
| Per title        | refined → rests 30 days; `kept` (skipped out) → 90; "I don't remember it" → 180                                                                             | server               |
| Per library      | nothing over the threshold → `nothing_waiting`. **This is the natural stop**                                                                                | server               |
| Small collection | fewer than `ranking.refine_min_ranked` (20) ranked in the category → `too_small`; the entry is not drawn                                                    | server               |
| Entry point      | the card rests after Not now or a finished sitting until 3 new placements **and** a strong batch again; never on a timer (unified design §6)                 | client (device pref) + server counts |

- **Minimum useful session:** one title, one or two answers. An unchanged top-25 title costs 2
  answers, or 1 when a recent answer already covers one side.
- **10 ranked titles:** `too_small`. With ten titles, every ranking already compared against a large
  share of the list, and _Update your rating_ is the right tool.
- **1,000+ ranked titles:** the same rules. The tolerance widens with depth (±7 below #300), the rank
  weight favours the top, and the daily ceiling bounds a huge imported library, which would otherwise
  have a large pool.
- **Convergence:** `refine.test.mjs` drives a 30-title library to `nothing_waiting` with cooldowns
  disabled. No title is refined twice, and every title ends refined enough.

## 5. Performance

`refine-scale.mjs`, loopback. "Server" is EXPLAIN ANALYZE of the evidence statement. One call per
target, never per answer.

| Library        | Answers | `refine_candidates` p50 / max | Server    | `refine_start` p50 |
| -------------- | ------- | ----------------------------- | --------- | ------------------ |
| 100 compared   | 573     | 5.4 / 7.0 ms                  | 10 ms     | –                  |
| 100 imported   | 0       | 6.9 / 11.2 ms                 | 6 ms      | 4.0 ms             |
| 1,000 compared | 8,977   | 22.7 / 44.2 ms                | 26 ms     | –                  |
| 1,000 imported | 0       | 29.1 / 42.4 ms                | 11 ms     | 6.3 ms             |
| 2,500 compared | 25,905  | 89.7 / 99.1 ms                | 76–142 ms | –                  |
| 2,500 imported | 0       | 55.8 / 70.3 ms                | 18 ms     | 8.8 ms             |

**Two defects this measurement found, both fixed before commit:**

1. The in-sitting diversity check probed a CTE per row, which made it quadratic: **1.8 s** for 2,500
   imported titles. The recent positions and open sessions are now resolved into arrays first.
2. Keying the per-pair work on positions rather than uuids halved the dense case. Splitting it into
   three separate joins then went quadratic without statistics (18 s in PGlite), so it stays one
   aggregate and one join.

The dense 2,500 case is above §G.3's 50 ms target on this machine. It is still one read per title
refined, bounded by the rolling 24-hour ceiling, and nobody near that size exists yet.

### 5a. The dense 2,500 case, investigated (2026-09-21)

**Setup.** A scratch benchmark on real PostgreSQL 17 (not committed). 2,500 ranked titles and 27,201
answers: bisection-shaped evidence plus a 5% re-answer set, with 259 and then 699 live conflicts.
Analysed tables. Variants were interleaved over 15 rounds, because the machine was under about 50%
load from another session and back-to-back runs varied 84–192 ms.

| Variant of `_refine_support` | Median | Min | Output |
|---|---|---|---|
| **current** (as committed) | **101 ms** | 92 ms | — |
| A: latest-per-pair via grouped `max` + join back (instead of sort + `distinct on`) | 127 ms | 116 ms | identical, **rejected (slower)** |
| **B: `max(created_at)` for conflicts instead of `array_agg(created_at)`** | **70 ms** | 60 ms | identical on named columns at 259 and 699 conflicts |
| C: `set work_mem = '16MB'` on the function | 70 ms | 61 ms | identical |
| B + C | 68 ms | 55 ms | identical |

**Where the time goes.** The sort for "latest answer per pair" is about 15 ms and cannot be avoided,
because every answer must be read once. The per-title aggregate is the hotspot. The planner estimates
200 groups against 2,500 actual. The `array_agg` of conflict timestamps gives every group a memory
context, so the hash aggregate **spills to disk** (`temp written=329`). B removes the spill; C removes
it by giving the aggregate more memory.

**B preserves semantics.** Every consumer reads only `conflicts > 0`. That is the same as "the latest
contradicting answer is newer than the last confirmation", which one `max()` answers. Only the internal
`conflicts` column changes, from a count to 0/1. It is a two-line change.

**Applied at restack (2026-09-21).** B is folded into `20261019000100` (renumbered from `20261013000100` when #196 froze at `b9b07c2`), which had never been applied anywhere, so no second migration was needed. C (a function-level `work_mem`) was not added: it gains nothing over B.

**Why 50 ms is not worth chasing further.** After B, what remains is reading and joining every answer
once, about 45 ms of scans, joins and the per-pair sort at 27,000 answers. Getting under it would need
a persisted evidence table, which the design rejects (§G.2: it would be stale after every insertion).
The call runs once per title refined, at most 30 a day. 2,500 ranked titles with 27,000 answers is
also an extreme shape; no real account's size was checked for this note.

**Patch B, as applied** (in `_refine_support`):

```diff
-           array_agg(e.created_at) filter (where e.side = 3) as conflict_at
+           max(e.created_at) filter (where e.side = 3) as conflict_last
 …
-         coalesce((
-           select count(*)::integer from unnest(pi.conflict_at) as ca(at)
-            where ld.confirmed_at is null or ca.at > ld.confirmed_at
-         ), 0),
+         (case when pi.conflict_last is not null
+                and (ld.confirmed_at is null or pi.conflict_last > ld.confirmed_at)
+               then 1 else 0 end),
```

`refine.test.mjs`'s contradiction tests cover it: one contradiction is offered with reason
`contradicted`, and it stops being offered once a refine confirms it.

## 6. Entry and UX

- **Entry:** the Watched card *Fine-tune your rankings* (§0), drawn only on the server's `cta.show`:
  Refine on, at least 20 ranked, nothing left to rank in the medium, at least
  `ranking.refine_cta_min_candidates` (3) titles at priority ≥ `ranking.refine_cta_min_priority`
  (0.25, about three times the candidate threshold), the day's ceiling not reached — and no Not now
  still holding. The number it names is `min(5, strong)`. **Candidate exists ≠ show the card**:
  once somebody opts in, the session still uses the looser 0.08 threshold.
- **Instrumented to tune, not redesign:** the `cta` block returns the counts at both thresholds and
  why the strong titles qualified (`gap` / `contradicted` / `crossed`); each candidate carries
  `signals`; `refine_card_shown` and `refine_target_outcome` report them (analytics.md).
- **Screen:** `app/rank-session.tsx?start=refine` is full-screen and headerless. It shows Close,
  _Refine · Movies_ and a progress count (`refine-progress`, pinned when the round is dealt —
  the draft's five dots are gone). The body is vertically centred, like the backlog's. The target
  stays pinned: _Is this still in the right place?_, then the title, `#18 in Movies`, and the
  reason line (for example _Never compared with the titles around it_, _One of your answers
  disagrees with where it sits_, _Titles near it have moved past it since_, or _Last placed when
  you had 34 movies_ — a growth signal, never an age). Below that is the shared, spacious
  comparison view (it sizes its cards from the window, so the pair does not drift between rounds):
  Undo, **Can't decide**, Details, and **Skip title (left)**, then _I don't remember Heat well_.
- **No per-title result screen** (founder, 2026-09-22): a later target in the same round can move
  this one again, so the count goes up and the next target opens. The **round summary** at the
  checkpoint lists each title as poster, name, a muted `#21 → #15` and its current score. There is
  no previous score anywhere in the session, so none is shown. The checkpoint offers **Done**, plus
  **Keep going** only while rounds remain **and** a fresh server read (`probeAfterRound`) still
  finds card-quality titles. Done quiets the **card** until the resurface rule passes. It does not
  claim the server has nothing left.
- **No precision theatre.** There is no percentage, no "accuracy" and no count of what is left. A
  test asserts it.

## 7. Deviations from §H, and why

| §H says                                                                                                | Built                                                                                                                                                         | Why                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Priority from stale / growth / fragile / newer_neighbours (ledger only); `direct_gap` deferred to v1.1 | **Pairwise evidence first** (the gaps, from the latest answer per pair, legacy answers only when they agree with the order), with fragile as a boost (the draft's `stale` boost was removed by the unified design: no age term) | The brief asks for "sparse comparison evidence" and "inferred placement spans a broad range". The gap measures exactly that, and it gives a crisp "refined enough" rule, which the ledger terms cannot |
| Exclude titles first placed < 14 days or confirmed < 60 days ago                                       | Evidence rule plus a 30-day refine cooldown                                                                                                                   | A fresh bisection is already fully evidenced, and an import from yesterday has no evidence, so it should not wait two weeks                                                                            |
| Band ≥ 3                                                                                               | Band ≥ 2                                                                                                                                                      | Two titles that were never compared are a real, one-question uncertainty                                                                                                                               |
| First target from the top 50                                                                           | `rank_weight`                                                                                                                                                 | Same effect without a special case                                                                                                                                                                     |
| `kept` → 30-day snooze                                                                                 | 90 days (three times the cooldown)                                                                                                                            | A title the reader skipped out of should not return monthly                                                                                                                                            |
| Dismissible card plus a permanent overflow row                                                         | **The card, in the unranked card's slot** (unified design): unranked wins the slot; Not now and Done rest it until 3 new placements and a strong batch       | Collection has no overflow menu; one slot means the two never compete; a time-based rest re-offered Refine to people who had not ranked anything since                                               |
| _I don't remember_ opens `TitleRecallSheet` first                                                      | Snoozes directly; **Details** is already on both cards                                                                                                        | One sheet fewer, and the recall sheet is one tap away                                                                                                                                                  |
| Undo this move (a compensating correction)                                                             | Not built                                                                                                                                                     | §H.6 assigns it to T7                                                                                                                                                                                  |
| (not in §H)                                                                                            | Server daily ceiling; 90-day pair memory                                                                                                                      | The brief: no infinite engagement; do not repeat recently answered pairs                                                                                                                               |

## 8. Gating, rollout, rollback

- **Flags:** `ranking.refine_enabled` and `ranking.backlog_enabled` (`app_config`, both default
  `false`). While Refine's is false, `refine_candidates` answers `disabled`, `refine_start`
  refuses `0A000`, and the client draws no card. While the backlog's is false, `ranking_backlog`
  answers `disabled`, `rank_backlog_start` refuses `0A000`, and Collection is exactly as before
  (the old unranked card, its 50-ranked rule, no Start ranking).
- **Kill switch:** Refine is also off whenever `ranking.prior_search_enabled` is false.
- **Tunables (no deploy):** `ranking.refine_min_ranked`, `refine_min_priority`,
  `refine_daily_targets`, `refine_cooldown_days`, and the unified design's
  `refine_crossed_min` (2), `refine_cta_min_priority` (0.25), `refine_cta_min_candidates` (3),
  `refine_resurface_placements` (3) and `backlog_checkpoint` (10).
- **Client ahead of the backend:** a backend without the function (`PGRST202`/`42883`) reads as
  `disabled`.
- **Order, after #196 is on the target:**
  1. Apply `20261019000100` with `db push` (staging: 2026-09-21; production: 2026-09-23).
  2. Publish the client (production OTA from `a17880d`, 2026-09-23).
  3. Flip the flags for the environment under test (`backlog_enabled` first; Refine after).
     Production: backlog on 2026-09-23; Refine still off, waiting on the backlog smoke.

  Rollback is the flag set to `false`. Nothing Refine wrote needs undoing: moves are ordinary
  placements in the ledger.

## 9. OTA compatibility

Client-only JS/TS. There are no new native modules, no `app.config.ts` or `package.json` change, and
no new assets. The route is a file under `app/` (`rank-session.tsx`, replacing T5's
`refine.tsx`), which expo-router resolves at runtime. **It is
OTA-deliverable on a runtime that already carries #196's client.** The binary constraint is the same
one #196 has, since this branch includes #196: the installed preview builds predate main's runtime
change, so no preview OTA reaches them until the new preview build #196 already needs.

## 10. Founder QA (staging, flags on for the QA session only)

Both flags ship false. For QA an operator sets `ranking.backlog_enabled` (and later
`ranking.refine_enabled`) to `true` on **staging**, and back to `false` afterwards. One account with
imported, unranked Letterboxd titles and 20+ ranked movies covers every step.

**Backlog**
1. **Flags off:** Collection is exactly as in #196 (old *You have unranked titles* card; no Start
   ranking).
2. **Watched card:** *You have titles left to rank* — no number anywhere on Watched. **View
   unranked** opens Unranked.
3. **Unranked:** *Rank your unranked titles*, the exact count (*N movies to rank*) and **Start
   ranking**; individual rows below still work (+ / Rank).
4. **Order:** a film you started ranking in bingd and abandoned comes first, straight into its
   comparisons at the pair you left (no *How was it?*). Then imports by most recent watch date. An
   import asks *How was it?* first.
5. **Progress:** *7 of 18 ranked* counts up toward a fixed total. **Skip title (left)** on the
   comparison (**Skip title** on *How was it?*) moves on; the skipped title is still in Unranked
   afterwards. **Can't decide** is different: it declines that one comparison and keeps placing
   the same title.
6. **Checkpoint:** after 10 placed, *10 titles ranked.* — **Keep going** continues, **Done** leaves.
7. **Close mid-comparison**, then tap + on that title in Search (or Rank on its title page): it
   resumes at the same pair, with no *How was it?* and no restart.
8. **Feed:** nothing from the backlog titles you placed. (Finishing a film you had abandoned
   natively may post, as it always would have.)
9. **Caught up:** *You're caught up.* — with *Refine a few rankings?* only if step 11's card would
   show; otherwise just Done.

**Refine**
10. **Card rules:** with anything left to rank, no Refine card (the unranked card holds the slot).
11. With nothing to rank and a strong batch: *Fine-tune your rankings — …tighten up N
    placements* (N ≤ 5). **Refine rankings** opens the session; **Not now** hides it.
12. **Not now:** stays hidden however long you wait; returns only after 3 new rankings in that
    medium (if the batch is still strong).
13. **Session:** reason lines never mention age. There is no per-title result page. After 5 titles
    (or 12 answers) the round summary lists what moved (`#X → #Y` beside the current score);
    **Keep going** appears only while strong titles remain; round 3 offers Done only.
14. **Only answers move a title:** an unchanged title keeps its place; an answer against the list
    moves it; repeated **Can't decide** or running out of eligible opponents leaves it at its
    uncertainty-safe placement, marked `adjustable` in the ledger (never a guessed winner). No
    feed post, no new viewing, streak unchanged.
15. **Movies and TV are separate:** each medium has its own backlog, card and session.
16. **Lists:** no ranking or refinement cards.
