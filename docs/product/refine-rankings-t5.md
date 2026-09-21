# T5 — Refine your rankings (as built)

**Status:** built on `feat/refine-rankings-t5`, stacked on PR #196 (`integration/watch-history-lists`).
Migration **`20261013000100`** is not applied anywhere. **`ranking.refine_enabled` ships
`false`**, so nothing is reachable until an operator flips it.
**Design:** [`watch-history-and-ranking-calibration.md`](./watch-history-and-ranking-calibration.md) §G, §H.
This file records what was built, the exact rules, and where the build departs from the design.

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
priority = rank_weight × (0.7·span + 0.3·[conflicts > 0]) × (1 + 0.25·stale + 0.25·fragile)
  rank_weight  1.0 (#1–25), 0.6 (#26–100), 0.3 (below)
  stale        min(1, days since last confirmed / 365)
  fragile      last placement adjustable (skips, dry walk, backfill)
```

**Eligible:**

- band ≥ 2;
- not snoozed;
- not in the current sitting;
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
the list. The drifted titles are the honest limit. Their evidence looks fine, so Refine reaches them
only through the `stale` term, and after a year.

## 4. Why it stops

| Scope            | Rule                                                                                                                                                        | Where                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Per round        | 5 titles, or 12 answers (checked when a title finishes, so a title that is moving is finished, not cut off)                                                 | client, `refine.ts`  |
| Per sitting      | 3 rounds; after the third, the checkpoint offers **Done** only                                                                                              | client               |
| Per day          | `ranking.refine_daily_targets` (30) refine placements per rolling 24 h → `rested`; `refine_start` refuses with `53400` (resuming an open target is allowed) | **server**           |
| Per title        | refined → rests 30 days; `kept` (skipped out) → 90; "I don't remember it" → 180                                                                             | server               |
| Per library      | nothing over the threshold → `nothing_waiting`. **This is the natural stop**                                                                                | server               |
| Small collection | fewer than `ranking.refine_min_ranked` (20) ranked in the category → `too_small`; the entry is not drawn                                                    | server               |
| Entry point      | hidden for 7 days after a sitting that finished at least one title                                                                                          | client (device pref) |

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

## 6. Entry and UX

- **Entry:** `Refine rankings ›`, one line of action text at the top of Collection's **Watched**
  segment. It is drawn only when the server answers `ready` for that medium. It is absent when the
  unranked nudge is showing, when the feature is off, when the medium has fewer than 20 ranked, and
  for 7 days after a finished sitting. There is no badge, no count and no disabled state.
- **Screen:** `app/refine.tsx` is full-screen and headerless. It shows Close, _Refine · Movies_ and
  five round dots. The target stays pinned: _Is this still in the right place?_, then the title,
  `#18 in Movies`, and the reason line (for example _Never compared with the titles around it_ or
  _Last placed when you had 34 movies_). Below that is the existing comparison view (Undo, Too tough,
  Details), then _I don't remember Heat well_.
- **Result:** private, and exact at any depth: `Moved from #21 → #15 ↑`, `Still #21`, `Kept at #57`,
  then **Next**. The checkpoint lists the round and offers **Done**, plus **5 more** while rounds
  remain.
- **No precision theatre.** There is no percentage, no "accuracy" and no count of what is left. A
  test asserts it.

## 7. Deviations from §H, and why

| §H says                                                                                                | Built                                                                                                                                                         | Why                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Priority from stale / growth / fragile / newer_neighbours (ledger only); `direct_gap` deferred to v1.1 | **Pairwise evidence first** (the gaps, from the latest answer per pair, legacy answers only when they agree with the order), with stale and fragile as boosts | The brief asks for "sparse comparison evidence" and "inferred placement spans a broad range". The gap measures exactly that, and it gives a crisp "refined enough" rule, which the ledger terms cannot |
| Exclude titles first placed < 14 days or confirmed < 60 days ago                                       | Evidence rule plus a 30-day refine cooldown                                                                                                                   | A fresh bisection is already fully evidenced, and an import from yesterday has no evidence, so it should not wait two weeks                                                                            |
| Band ≥ 3                                                                                               | Band ≥ 2                                                                                                                                                      | Two titles that were never compared are a real, one-question uncertainty                                                                                                                               |
| First target from the top 50                                                                           | `rank_weight`                                                                                                                                                 | Same effect without a special case                                                                                                                                                                     |
| `kept` → 30-day snooze                                                                                 | 90 days (three times the cooldown)                                                                                                                            | A title the reader skipped out of should not return monthly                                                                                                                                            |
| Dismissible card plus a permanent overflow row                                                         | One conditional line and a 7-day rest after a sitting                                                                                                         | Collection has no overflow menu, and a card would sit beside the unranked nudge                                                                                                                        |
| _I don't remember_ opens `TitleRecallSheet` first                                                      | Snoozes directly; **Details** is already on both cards                                                                                                        | One sheet fewer, and the recall sheet is one tap away                                                                                                                                                  |
| Undo this move (a compensating correction)                                                             | Not built                                                                                                                                                     | §H.6 assigns it to T7                                                                                                                                                                                  |
| (not in §H)                                                                                            | Server daily ceiling; 90-day pair memory                                                                                                                      | The brief: no infinite engagement; do not repeat recently answered pairs                                                                                                                               |

## 8. Gating, rollout, rollback

- **Flag:** `ranking.refine_enabled` (`app_config`, default `false`). While it is false,
  `refine_candidates` answers `disabled`, `refine_start` refuses `0A000`, and the client draws no
  entry.
- **Kill switch:** Refine is also off whenever `ranking.prior_search_enabled` is false.
- **Tunables (no deploy):** `ranking.refine_min_ranked`, `refine_min_priority`,
  `refine_daily_targets` and `refine_cooldown_days`.
- **Client ahead of the backend:** a backend without the function (`PGRST202`/`42883`) reads as
  `disabled`.
- **Order, after #196 is on the target:**
  1. Apply `20261013000100` with `db push`.
  2. Publish the client.
  3. Flip the flag for the QA account's environment.

  Rollback is the flag set to `false`. Nothing Refine wrote needs undoing: moves are ordinary
  placements in the ledger.

## 9. OTA compatibility

Client-only JS/TS. There are no new native modules, no `app.config.ts` or `package.json` change, and
no new assets. The route is a new file under `app/`, which expo-router resolves at runtime. **It is
OTA-deliverable on a runtime that already carries #196's client.** The binary constraint is the same
one #196 has, since this branch includes #196: the installed preview builds predate main's runtime
change, so no preview OTA reaches them until the new preview build #196 already needs.

## 10. Manual QA (after #196, on staging, flag on for the QA account)

1. **Gate off:** with the flag false, Collection shows no _Refine rankings_, and `/refine` opened by
   hand says _Not available_.
2. **Too small:** an account with fewer than 20 ranked movies has no entry. With 20 or more on
   Movies and fewer than 20 on TV, the entry is on Movies only.
3. **Imported account:** Letterboxd-import about 100 films, then rank them from the Unranked tab (the T6 queue is not built). Refine
   should offer top-list titles first, each with a reason line.
4. **Unchanged:** answer both comparisons in line with the list. The result reads _Still #N_, with
   no score change, no feed post and no Watch History date.
5. **Moved:** answer against the list twice. The result reads _Moved from #X → #Y_ with an arrow.
   Collection's order and scores update, the title page shows the new score, the streak does not
   change, and the feed shows nothing.
6. **Kept:** press Too tough three times. The result reads _Kept at #N_.
7. **Undo** in the middle of a target: the pair goes back. **Undo** at a target's first comparison
   moves to the next title.
8. **I don't remember it:** the title goes and the next one loads. It is not offered again.
9. **Checkpoint:** after 5 titles, the list shows outcomes and **Done / 5 more**. After round 3, it
   shows **Done** only.
10. **Interrupt:** kill the app mid-target and reopen Refine. The same title comes first, on the same
    comparison.
11. **Close** mid-target: nothing moves. The entry is still shown if nothing was finished, and rests
    for 7 days if something was.
12. **Heavily compared account:** _Nothing needs a look right now_.
13. **Two devices:** the same title opened on both resumes one session. Answering on one updates the
    other's next step.
14. **Watch History** for a refined title lists _Refined · Still #N_ or _Refined · Moved from #X → #Y_ (this branch fixes a #196 line that printed _Still_ for every refine), and no new viewing.
