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
  re-buckets. Refresh does not rotate them. **Superseded 2026-09-13 — see §10:** up to
  eight, coverage-aware and rotated per launch.
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

## 10. Coverage-aware anchors and the TV source fixes (2026-09-13)

The For You repetition audit (2026-09-13) found the §9 truncation was the steady state an
established reader lived in: a reporter with about sixty ranked films had ~27 liked titles,
and the same first six generated the whole ~96-title universe on every launch — while the
other twenty-one, often whole genres of their taste, contributed nothing. Exposure rotation
can only reorder a universe. The founder accepted a bounded fix: wider, coverage-aware,
rotating anchors and the TV correctness fixes. The exposure-engine work is deferred —
`deferred-roadmap.md` §59.

### 10.1 The anchor algorithm (`anchors.ts` `selectAnchors`)

1. `likedFrom` builds the liked band exactly as before: `loved` only, position order,
   seasons collapsed to their show, inside the reader's filters.
2. **Budget eight** (`ANCHOR_BUDGET`). Eight or fewer liked titles: all of them, in order,
   nothing duplicated.
3. **The top two, always** (`STABLE_ANCHORS`).
4. **Coverage.** A liked genre is *meaningful* when at least 10% of the liked band — and at
   least two titles — carry it. While budget remains and a meaningful genre is uncovered,
   one title is drawn from those that add an uncovered genre, weighted by evidence-weighted
   gain × score. A horror-comedy covering two missing genres is strongly preferred over
   spending two anchors, but the draw is seeded rather than greedy, so different launches
   cover a genre with different films. There is no one-per-TMDB-genre rule.
5. **Rotation.** Remaining slots are drawn from the rest of the band by score
   (Efraimidis–Spirakis, key `u^(1/w)`, `u = unitRandom(anchorSeed, id)`).
6. **Cached breadth first.** In steps 4 and 5 a title whose `similar` list is already cached
   (and non-empty) is weighted ×3. The queryFn reads the cached lists for the top hundred
   liked titles before selecting, so breadth comes from facets that cost nothing upstream.
7. **At most six upstream fills per slate** (`MAX_FILLS_PER_SLATE` = the old whole limit),
   strongest first. An anchor past the cap with no cached list contributes nothing that
   launch.
8. `anchorSeed` (`session-seed.ts`) is fixed per process and is part of the query key, and
   the selection is memoised per launch and wall (`use-for-you.ts` `selections`), so the
   cache moving under a refetch cannot re-draw it. A **cold launch** draws a new selection;
   a render, refetch, Refresh or return from the background does not. It is separate from the arrangement seed so pull-to-refresh cannot
   change the key and flash the wall.

Candidate generation is otherwise unchanged: each anchor's own TMDB `/recommendations`
page 1, social and trending. `candidateIdsFrom` is that union and nothing else.

### 10.2 Why eight — the budget comparison

Audit scratch model on the real scorer and real `selectAnchors`: a ~60-ranking account with
~29 liked titles across five taste neighbourhoods, 24 profiles, medians. Quality figures use
a warm cache; calls use a cold cache over 14 daily launches with 168-hour facets and the
six-fill cap.

| | today (first 6) | budget 6 | **budget 8** | budget 10 | budget 12 |
|---|---|---|---|---|---|
| Unique candidate pool | 104 | 106 | **130** | 157 | 178 |
| Meaningful liked genres covered | 5/8 | 8/8 | **8/8** | 8/8 | 8/8 |
| Mean first-20 score | 0.556 | 0.546 | **0.572** | 0.599 | 0.625 |
| #20 / #50 score | 0.525 / 0.433 | 0.508 / 0.423 | **0.535 / 0.455** | 0.551 / 0.473 | 0.569 / 0.489 |
| Upstream fills, launch 1 | 6 | 6 | **6** | 6 | 6 |
| Upstream fills per launch, days 2–14 | 0.46 | 1.54 | **2.15** | 2.54 | 2.85 |
| First-20 overlap, 3 cold sessions 96h apart | 13 / 14 | 7 / 6 | **7 / 7** | 7 / 7 | 8 / 8 |

Coverage saturates at every coverage-aware budget and repetition saturates at about 7 of 20,
so neither improves past eight. Budget six rotated loses a little relevance; eight is above
today's. Ten and twelve score higher — partly the scorer's breadth bonus rewarding agreement
between more anchors — for about 20% more upstream fills each. Eight is the smallest budget
that is broader, fresher and no less relevant, which is the founder's early-stop rule.
The same ordering held with a high-overlap TMDB model. The cached-first weighting cut
budget eight's steady fills from 2.77 to 2.15 per launch at no repetition cost.

### 10.3 What the unit suite pins

`anchor-rotation.test.ts`, over the seeded catalogue on a 60-ranking account: titles beyond
the first six become anchors; every meaningful liked genre is represented on every launch;
candidate membership changes between launches; the first wall's mean score stays within 5%
of the old first-six wall; the wall stays anchor-led; nothing outside the sources can enter;
a cached list is drawn at least 1.5× as often as an uncached neighbour. `for-you-tv.test.tsx`
pins, through the real hook, that selection is stable across render, refetch (with the
cache having moved under it) and Refresh,
changes across launches, and never makes more than six upstream fills. Every one of those
was mutation-checked: removing the coverage step, the cached preference, the fill cap or the
launch seed each fails a test.

### 10.4 TV

- **Social reaches TV.** `social_candidates` returns seasons; the TV wall reads series, so
  it dropped every one. Seasons now roll up to their shows (`socialSeriesFrom`).
- **A show already met is not recommended.** `user_media` holds seasons and the TV wall
  holds series, so a show with a logged or ranked season came back as unseen unless it was
  an anchor. The exclusion now includes every such show (`seriesAlreadyMet`).
- **The day list beside the week list, for an unanchored TV wall only.** A reader with no
  season ranked had one twenty-title list. When no TV anchor has a list, the fallback also
  reads `trending.series.day`; a wall drawn from it is still `popularityOnly` and says
  "Popular right now". An anchored TV wall keeps the week list alone, so the day list never
  pads a taste-led wall.

### 10.5 Telemetry

`for_you_slate_shown` gains `liked_titles`, `anchors_used` and `pool_size` — three counts, no
ids — so whether rotation had anything to rotate, and the pool it produced, can be read
after outreach beside `repeat_count`.

## 11. For You V2 — a quality neighbourhood, decaying exposure, and sessions (2026-09-13)

The founder's physical pass on #145 found the broader anchors structurally better and the
wall still too repetitive. This is the evaluation and the change it led to. Candidate
generation (§10) and the scoring weights are unchanged.

### 11.1 What the evaluation found (production rankings, read-only, aggregates only)

**Cohort.** 31 raters, 596 rankings. Movie rankings per rater: twelve at exactly five (First
Five), then 6–24, three at 52–59, one at 112. Seven raters met a 10-ranking floor for held-out
evaluation on films; three on TV. **Every feature finding below is low-N and is treated as
directional at best.**

**Held-out ranking quality** (5-fold within each rater; pairs the rater separated by ≥ 1.0
score; unwatched titles never used as negatives):

| films, 7 raters, 1,319 pairs | pairwise accuracy | Δ vs current [95% bootstrap CI] | raters better / worse |
|---|---|---|---|
| current (anchor, genre, language, popularity) | 0.444 | — | — |
| + release decade (w 0.06 / 0.12 / 0.18) | 0.405–0.411 | −0.033 to −0.039, CIs cross 0 | 1–2 / 4 |
| + recency band | 0.419 | −0.024 [−0.061, +0.008] | 2 / 3 |
| + genre-pair affinity | 0.448 | +0.005 [−0.043, +0.052] | 4 / 2 |
| − popularity | 0.454 | +0.011 [−0.045, +0.068] | 4 / 3 |

TV (3 raters) leaned the other way for era and genre pairs (+0.02 to +0.04), on too few raters
to mean anything.

**Decision: no feature was added.** Era/decade *lowered* film ordering for most raters, recency
likewise, and nothing cleared its own noise. The simpler model stays.

**The finding that did decide the design.** Among a rater's own watched films the content score
orders loved-versus-disliked **worse than chance** (0.444), and membership of an anchor's TMDB
list is *not* more likely for loved titles (held out: loved 15% in pool, not-loved 33%; lift
0.46). TMDB recommendations predict what someone will watch, not what they will love. A
computed #1 is therefore a neighbourhood, not a certainty — which is the founder's principle,
now with data behind it.

**Candidate recall.** 18% of held-out loved films are present in the product's candidate pool;
29% when every liked title is an anchor. Consistent with §10's direction; no further change here.

**Signals not represented** (audited against stored data): release era/recency, genre
combinations, watchlist saves and dismissals are readable now; Match-weighted social evidence
and impression → rank conversion need a definer RPC; cast/director/creator credits are only
cached for opened titles (sparse on the candidate side); opens are not recorded; keywords are
not stored.

**TMDB `/similar` (Phase C).** Not measured, and the premise needed correcting: the Similar
tab uses the same `similar` facet For You does, which is TMDB **`/recommendations`**. The adapter
has no `/similar` action and no TMDB credential exists outside the Edge runtime, so measuring
its marginal value needs an adapter change and a deploy. Not added.

### 11.2 The selection (`selection.ts`, `FOR_YOU_SELECTION`)

1. **Qualified pool.** Candidates scoring ≥ 0.80 × the score at rank 20 (the first page's
   frontier), clamped to 60–160. When fewer unseen titles remain than the wall being drawn
   needs, the pool extends in score order — never below 0.60 × the frontier.
2. **Score-weighted sampling without replacement.** Key = `score / τ − exposure + Gumbel(seed,
   id)`, τ = 0.15 × the pool's score spread. On a realistic pool the best title leads ~22% of
   fresh walls, the tenth <1%.
3. **Exposure decays** from `last_shown_at`: `3 × log2(1 + count) × 0.5^(age / 96 h)`, plus 12
   when shown within the last **18 hours**, plus 24 for a title **on screen when Refresh was
   pressed** (always drawn last). Finite for every title — nothing is blacklisted.
4. **Light diversity per page**: 0.4 per title beyond four of one primary genre, 0.25 per
   repeat of a lead anchor; hard ceilings unchanged (four per anchor, two per franchise). No
   genre quotas — a horror reader still gets a horror wall.
5. **Beyond the pool** the wall continues only in strict score order.
6. **Dismissals** are removed inside the draw, so the frontier and τ do not move: dismissing
   one title replaces it and keeps ≥ 85% of the rest in place.

Scores and explanations are untouched, so every "Because you loved X" is unchanged. Per-title
metadata is computed once per draw; a five-page draw over a full 160-title pool is well under
the 60 ms test bound on desktop.

### 11.3 Sessions and exposure memory

- A **re-render** or a **return within an hour** changes nothing.
- **Refresh** stamps what is on screen as shown now and draws a new arrangement; each wall is
  stamped once, so walls left long ago age normally.
- A **return after an hour away** — or after five minutes, once the session is six hours old
  — is a new session: new seed, the wall that was on screen stamped as shown when the reader
  left, and the screen back at its first page. The durable exposure is not re-read; every wall
  this process drew is already stamped, and a re-read would redraw the wall twice.
- A **cold launch** is a new session and reads the durable exposure once. Impressions are only
  recorded once that read has settled, so a wall redrawn a beat after launch is not recorded
  as seen.
- The subscription to app state starts when the module loads, so a return via another tab
  still counts. Anchors (§10) stay per process.
- **Memory.** V2 reads `recommendation_exposure_within(336)` (`20260918000100`), a fortnight
  — 3.5 half-lives. `recommendation_exposure()` and `foryou.impression_window_hours` (72) are
  **unchanged**: clients that cannot take this update run the old tier engine, which would
  repeat *more* over a longer window (independent review). Until the migration reaches a
  backend, V2 falls back to the 72-hour reader.

### 11.4 Before and after (real production profiles, movies wall, medians)

Relevance is the model's own score; "overlap" is titles shared by consecutive cold sessions
(of 20). Measured with the merged code, not a prototype.

| visits | #145 | V2, 72 h read (before the migration) | V2, fortnight read |
|---|---|---|---|
| 6 h apart — First Five / ~20 / ~60 / 100+ | 5.3 / 1.0 / 1.0 / 0.5 | 5.5 / 0 / 0 / 0.3 | 5.5 / 0 / 0 / 0.3 |
| 24 h apart | 6.8 / 1.5 / 1.3 / 1.0 | 7.8 / 3.0 / 2.0 / 1.3 | 7.0 / 2.5 / 2.0 / 1.0 |
| 96 h apart | 15.3 / 9.0 / 6.3 / 5.3 | 14.0 / 8.0 / 5.5 / 3.8 | 9.0 / 4.3 / 3.5 / 2.3 |
| visible first 9, 6 h apart | 1.0 / 0.8 / 0.5 / 0.5 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| visible first 9, 96 h apart | 5.5 / 3.8 / 2.3 / 1.5 | 4.8 / 2.3 / 2.0 / 1.8 | 2.3 / 1.0 / 0.8 / 0.3 |
| Refresh inside a session | 6 / 2 / 2 / 3 | — | 4 / 0 / 0 / 0 |
| unique titles after 5 sessions, 96 h apart | 30 / 45 / 63 / 66 | 35 / 51 / 69 / 74 | 44 / 57 / 76 / 77 |
| mean first-20 score | 0.500 / 0.568 / 0.532 / 0.545 | 0.500 / 0.559 / 0.524 / 0.540 | same |

Next-day recurrence of a few strong titles is intended (§11.2 step 3). Mean score across all
five walls moves −0% to −3%.

**Provider cost:** none added. Selection runs on the already-fetched pool; anchor fills keep
§10's ≤ 6 per slate. The exposure read is still one per session, over up to a fortnight of the
reader's own rows.

### 11.5 What remains

- First Five walls are pool-limited (~85 eligible): selection cannot manufacture candidates,
  and its 96-hour overlap stays the highest of any cohort.
- Returning within an hour keeps the wall, by design.
- Feature additions wait for a cohort large enough to evaluate them (§11.1).
