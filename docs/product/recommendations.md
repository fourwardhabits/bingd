# Recommendations — what For You does, and why it repeated itself

**Status:** written 2026-09-06, after the founder's physical pass reported *Jobs* and
*Creed III* recurring across weeks and an external high-history reader reported the same.
Canonical for the recommendation product.

**Companion documents:** [`PRD.md`](./PRD.md) §28 ·
[`../architecture/recommendations.md`](../architecture/recommendations.md) (the engine) ·
[`analytics.md`](./analytics.md) · [`deferred-roadmap.md`](./deferred-roadmap.md)

---

## 1. The doctrine

**Relevance is primary.** Freshness is a preference over *ordering*, never a licence to
show something worse. A wall that rotates by reaching further down the pool has traded
the only thing a recommendation is for.

**Novelty is not randomness.** "Show me something else" means *something else I have not
seen* — not *anything else*.

**Repetition is honest when the pool is small.** A reader with twelve candidates and a
nine-poster wall will see the same films, and padding the wall with titles the engine
does not believe in would be worse than admitting it.

---

## 2. The pipeline, as built

| Stage | Where | What it does |
|---|---|---|
| Anchors | `rank.ts` `anchorsFrom` | Up to 6 of the reader's own top-ranked titles, filtered to the wall's medium |
| Candidates | `use-for-you.ts` | TMDB "similar" per anchor, plus trending, via the adapter; the catalogue is a cache |
| Exclusion | `scoreSlate({ exclude })` | Already-ranked and already-logged titles never appear |
| Scoring | `rank.ts` `scoreCandidate` | Anchor similarity, genre and language taste, popularity prior. `WEIGHTS` is the whole table |
| Dismissals | `useDismissedTitles` overlay | Durable, permanent, applied after scoring — see §5 |
| Rotation | `diversify` + `session-seed.ts` + `use-exposure.ts` | The freshness layer — §3 |
| Diversity | `diversify` ceilings | Per anchor, per franchise, per genre |
| Paging | `diversifyPaged` | Prefix-stable, so growing a wall never reorders what is above |

**The watchlist is not an exclusion.** Wanting to see something is not having seen it.

---

## 3. Freshness, and the defect this pass found

Rotation is two layers over one scoring pass:

- **Session** (`session-seed.ts`) — a seed plus what this process has already shown.
  Module state, so it survives leaving the tab and coming back; a new launch is a new
  arrangement.
- **Durable** (`use-exposure.ts` → `recommendation_exposure()`, migration
  `20260828000500`) — what *previous* launches showed, inside
  `foryou.impression_window_hours`. Read **once per process**, deliberately: a live read
  would loop, because rendering a wall records impressions, which move the exposure,
  which re-derives the wall.

`mergeExposure` takes the higher tier of the two, capped at `EXPOSURE_TIERS = 3`, and
`diversify` demotes accordingly: the current wall hardest, then anything merely seen.

### The defect: an exemption that never expired

`REFRESH_ANCHORS = 2` exempts the two strongest candidates in the pool from **every**
exposure penalty, so that asking for something else cannot throw away the best answer the
engine has. Good intent; the exemption was by **rank in the pool**, and the rank is a pure
function of the reader's own rankings. A collection that is not changing produces the same
order every time — so the *same two titles* were exempt on every refresh, in every
session, in every week.

**That is the founder's Jobs and Creed III**, and `refresh-diagnostic.test.ts` measures
it: over five generations, `c000` and `c001` appeared on five of five walls.

**The fix is expiry, not removal.** A title stays protected until the reader has genuinely
seen it `EXPOSURE_TIERS` times — across sessions, because `seen` spans both halves — and
then it rotates like anything else. Relevance stays primary for the first few looks, which
is what the exemption was for; nothing is pinned for ever, which is what it accidentally
did.

### What is still open, and it is one number

`foryou.impression_window_hours` is **72**. An impression ages out after three days, so the
durable half forgets a title within the week — which is the remaining mechanism behind
"recurs across weeks" once the exemption expires.

It is an `app_config` row: a production **data write**, not a migration and not a deploy
(the same shape as the community-score threshold, `PATCH /rest/v1/app_config`). This pass
did not change it — it is a production mutation and needs the service key. **Recommended:
raise to 336 (14 days)**, which covers the interval the founder was actually describing,
and re-read `for_you_slate_shown.repeat_count` afterwards rather than guessing.

A device-local exposure buffer was considered and **rejected for now**: durable exposure
already exists and is already read: a second source of exposure truth to work around an
unset dial is architecture standing in for a config change.

---

## 4. The repeat taxonomy, measured

Against `refresh-diagnostic.test.ts`, on a 120-candidate pool with a real score gradient:

| | Class | Verdict |
|---|---|---|
| A | Duplicate inside one visible set | **Not observed.** `diversify` emits a set |
| B | Duplicate across modules on one screen | **Not applicable.** One wall per medium |
| C | Same titles on immediate refresh | **Fixed 2026-08-28.** ≤3 of 9 kept between consecutive generations |
| D | Same titles across days and weeks | **The founder's report.** Two causes: the anchor exemption (fixed here) and the 72-hour window (§3) |
| E | Dismissed title returns | **Not observed.** Dismissal is durable and permanent — §5 |
| F | Ranked or watched title returns | **Not observed.** `exclude` is applied at scoring |
| G | Candidate pool genuinely too small | **Real, and correct.** A 10-candidate pool repeats, and should |
| H | One source dominates | **Not observed.** Per-anchor, per-franchise and per-genre ceilings hold |

---

## 5. Dismissal

The `X` writes `recommendation_feedback` kind `dismiss` through `dismiss_for_you`
(`20260827000700`) and `useDismissedTitles` overlays the set after scoring.

**It is already durable and already permanent** — no window, no decay. That is stronger
than the brief's minimum ("must not return in the current freshness window") and it is
deliberately left alone: turning an existing permanent veto into a temporary one would be
taking something away from readers who have used it.

Dismissal is not a ranking, not a watchlist change and not the dismissal of a *person's*
recommendation, which is a different act on a different object.

---

## 6. Measurement

`for_you_slate_shown` (new, 2026-09-06) carries `medium`, `size` and **`repeat_count`** —
how many titles on this wall the reader had already been shown inside the impression
window. That last one is the point: a reader shown the same nine films every week and
saving one of them is indistinguishable from a reader shown a fresh wall, if you only
count opens and saves.

Emitted once per genuinely new slate, guarded by `noteImpressions`' own returned set, so
the event and the impression record cannot disagree about what "shown" means. No title id
travels.

Already present: `watchlist_added` with `surface: 'for_you'`, and `recommendation_opened`
for a title sent by a person.

**Still deferred** (`analytics.md`): per-position open attribution, and a dismissal event.
Both want a stable slate-position identifier that the paged wall does not currently carry,
and neither is needed to answer the question this pass was about.

---

## 7. What was deliberately not done

- **No scoring weight was changed.** The complaint was freshness, and the evidence points
  at the rotation layer. Retuning `WEIGHTS` without evidence would have made the two
  indistinguishable.
- **No LLM, no embeddings, no new external service.**
- **No schema.** The one remaining lever is a config value.
- **No device-local exposure store** — see §3.

---

## 8. When to revisit

- After the impression window is raised: read `repeat_count` over a fortnight. If it does
  not fall, the cause is pool depth rather than memory, and §4 class G is the next thing
  to attack — more candidate sources rather than more suppression.
- When per-position attribution is wanted, which is the first thing needed to ask whether
  the *ordering* is good rather than only whether it is fresh.

---

## 9. Breadth audit — does the engine use the whole ranked corpus?

Founder question, 2026-09-07: *are recommendations genuinely informed by the user's broad
ranked corpus, or does candidate generation effectively rely on a small subset?*

Measured against production on 2026-09-07 (read-only) and against the real scorer.
**Nothing was changed by this audit** — no weights, no anchors, no exposure tiers, no
sources, no config.

### 9.1 The answer, in one line

**Scoring is broad; candidate *generation* is narrow, deliberately and by a fixed cap.**
Every ranked title feeds the taste vector, which carries 30% of the score. The candidate
pool itself is generated from at most **six** anchors, and they are the same six until the
reader re-ranks.

### 9.2 Measured, for the three highest-history accounts

| | user A | user B | user C |
|---|---|---|---|
| Ranked titles | 111 (56 film / 55 TV) | 75 (47 / 28) | 52 (52 / 0) |
| Buckets | 97 loved · 12 fine · 2 not for me | 69 · 4 · 2 | 48 · 4 · 0 |
| **Eligible** anchors (films) | 47 | 43 | 48 |
| **Eligible** anchors (TV, series-deduped) | 28 from 50 seasons | 26 from 26 | 0 |
| **Used** per slate | 6 | 6 | 6 |
| Distinct genres in the corpus | 13 | 16 | 15 |

So for user A a Movies slate reasons from **6 of 47** eligible titles — 13% — and a TV
slate from 6 of 28 series.

### 9.3 Where the rest of the corpus does count

`tasteFrom` is built from **every** ranked title across *both* media, weighted
`max(0.1, score/10)` so even a disliked title is evidence. That vector supplies
`genre` (0.18) and `language` (0.12) of the score: **30% of the ranking of every
candidate is informed by the whole corpus**, and it is what re-scores the pool that the
six anchors produced.

`WEIGHTS`: anchor 0.60, genre 0.18, language 0.12, popularity 0.10.

### 9.4 The truncation, named

- `ANCHOR_LIMIT = 6` in `rank.ts`, applied in `anchorsFrom`.
- Anchors are `loved` only, walked in **ranked position order**, so they are the reader's
  top six loved titles — deterministic, and unchanged until the reader re-ranks or
  re-buckets. Refresh does not rotate them.
- A season anchors on its **series**, deduplicated, so a five-season favourite is one
  anchor rather than five.
- Filters narrow the anchor scope too, so a filtered wall is anchored on filtered titles.

### 9.5 Candidate pool, before and after exclusions

| source | ceiling | measured |
|---|---|---|
| Similar-to-anchor | 6 × 20 | exactly 20 ids per anchor (min/median/max all 20 across 97 cached facets) |
| Social (`social_candidates`) | 40 | RPC limit |
| Trending fallback | 20 | 20 ids per list |
| **Raw ceiling** | **180** | before dedupe |

Then: deduplicated, narrowed to the requested medium, and excluded against the reader's
collection (`user_media`), watchlist and dismissals. For a high-history account the
exclusions are the binding constraint — user A has logged 111 titles, most of them the
popular ones these sources return.

### 9.6 Concentration

Diversity ceilings are absolute counts against a 20-item slate, not shares:
`MAX_PER_ANCHOR = 4`, `MAX_PER_FRANCHISE = 2`, `MAX_GENRE_SHARE = 0.4` (8 slots).
So one anchor can supply at most a fifth of a wall, and a full wall must draw on **at
least five** distinct anchors. Within that, a few high-weight titles do dominate
*generation*: anchor score is 60% of the total and 100% of the anchor-derived pool comes
from those six.

### 9.7 Source diversity

Three sources, and two of them are the same for everybody: trending is global, and social
is the follow graph rather than the corpus. Only the similar-to-anchor source is about
this reader's taste, and it is the one capped at six. **The candidate sources are narrow
even when the history is broad** — which is the founder's second question, and the answer
is yes.

### 9.8 Freshness, and the A/B/A/B question

`refresh-diagnostic.test.ts` now measures cycling as well as turnover. Over six
generations: no return to an earlier wall two refreshes later, no orbit around the first
wall, and more than 18 distinct titles visited — so the wall is **not** alternating
between two arrangements. The `REFRESH_ANCHORS` exemption expiring (#112) holds.

### 9.9 No deterministic bug found

Everything above is the design behaving as written. Nothing here is a defect, so nothing
was changed and no founder decision is being forced.

The lever, if breadth is wanted, is `ANCHOR_LIMIT` — but it is one provider request per
anchor per slate, so raising it is a cost decision rather than a code one, and it should
wait for the 336-hour impression window to produce data (§8).
