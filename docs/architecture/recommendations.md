# Bingd — Recommendation Engine

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) §13 · [`data-model.md`](./data-model.md) §8

No language model. Recommendations are derived from human ranking behavior, content similarity, and curated fallbacks, and every guardrail in PRD §13 is enforced by a specific mechanism named below.

---

## 0. What actually shipped — For You V1, 2026-08-16

**Everything from §1 down describes `recs-builder`, which does not exist.** It is the design this converges on and it is still the design. What ships now is a smaller, on-device subset, and the difference matters enough to state before anything else.

| | `recs-builder` (§1–§7) | For You V1 (shipped) |
|---|---|---|
| Where it runs | Edge Function, on a schedule | On the device, when the tab opens |
| Candidate families | five, including two social ones | `similar` facets for ≤6 anchors, plus the trending week list |
| Bingd cross-user data | `match_scores`, followed users' rankings | **none** |
| Evidence | composed server-side, stored on the row | computed from the viewer's own inputs, returned with the score |
| Storage | `recommendation_generations` / `recommendations` | nothing persisted |

**The client composes the sentence, and that is not a violation of §5.** The rule that the client "has no path to compose a reason of its own" exists to stop **fabricated social proof** — "3 people with similar taste loved this" asserted about people who did not — and it is enforced server-side because the client cannot be trusted with, and must not have, other users' rankings.

V1 uses **no other Bingd user's data**. Its three inputs are the viewer's own rankings (own-only under RLS), TMDB's association between titles (`media_cache` facet `similar`, world-readable), and genre/language/popularity from `media_items`. There is therefore no social claim available to fabricate, and every sentence it can produce is of the form "because of something *you* did".

> **The stronger phrasing — "no cross-user signal at all" — is false, and independent review said so.** TMDB's recommendations are derived from what *their* users did, and popularity is a crowd measure. Both are external, public, about titles rather than about people, and identical for every viewer, so neither can be attributed to a person and neither is something one Bingd account learns about another. That is the claim; the stronger one was overreach.
>
> One residual side channel, recorded rather than closed: `similar` answers `reason: "cached"` faster than it answers a fetch, so an authenticated caller can infer that *some* account caused a given title's facet to be filled within its TTL. That is a weak cross-user signal and should be described as one rather than as nothing: for an obscure enough title, outside knowledge could make one person the likely requester. What it never exposes is an identity, a score, a time, or which of several people it was — and any signed-in user may ask about any title anyway, so the observation is available to everyone equally. Closing it would mean padding the response to a constant latency, which costs more than the channel is worth.

**The moment a social family is added, scoring moves server-side.** That is not a preference; at that point the client would need other people's rankings in order to score, which is the thing the rule protects.

Two further properties are worth recording because they are what keep the sentence honest:

- The headline is derived from `lead`, which is whichever *weighted* term actually carried the score. A title that scored on popularity cannot be described as "because you loved X" — the arithmetic decides the wording, not the author.
- A taste built from fewer than five rankings is not asserted in words. The signal is still used; the sentence falls back to "Popular right now" rather than telling somebody what they like on the evidence of two films.

**Anchors are bounded at six.** Each is one provider request the first time it is used and free for every user afterwards, because the answer lands in `media_cache` under the shared facet TTL. A request per ranked title — the obvious implementation — is four hundred TMDB calls for a user with four hundred rankings.

### Diversity in V1 — what is enforced, exactly

Three hard ceilings, applied by one greedy pass in score order. A candidate that would breach any of them is **dropped**, so a narrow candidate pool yields a short wall rather than a full wall with a relaxed cap.

| Ceiling | Value | Keyed on |
|---|---|---|
| Per anchor | ≤ 4 of 20 | every anchor the candidate is attributed to |
| Per franchise | ≤ 2 of 20 | `franchiseKey(title)`, a documented proxy |
| Per primary genre | ≤ `ceil(limit × 0.4)` | the candidate's first genre |

All three are absolute counts against the *requested* twenty, never shares of the wall that results.

**The anchor ceiling counts every attribution, not the lead.** Six review rounds landed on the lead-only version, and the seventh found what was wrong with it: it bounded how often a favourite could be *quoted* on the wall, not how much of the wall it *decided*. A title carried mostly by anchor A but recorded against B — because B's list placed it higher — spent B's quota and none of A's, so one rating could sit behind twenty rows while never appearing to lead more than four. Counting every anchor in `explanation.anchors` gives the guarantee the founder decision actually asks for: **no single ranked title lies behind more than four of the twenty, by any route this module can see.** It is strictly stronger and it costs slate length when several anchors point at the same titles — which is the overfitting the ceiling exists for.

**§4's franchise constraint is implemented against a title-derived proxy, not TMDB's collection id.** `belongs_to_collection` appears only on a title's *detail* response, so keying on it would mean one provider request per candidate — several hundred per slate — against an architecture that budgets six. Storing it would mean a column that is null for every catalogue row until something re-enriches it: a ceiling that cannot fire, dressed as one that can.

`franchiseKey(title)` therefore groups on the leading stem of a title: everything before a subtitle separator, minus a leading article, minus a **named** sequel marker — `Part`, `Chapter`, `Volume`, `Vol`, `Episode` — with its number.

**A bare trailing number is never read as a sequel marker**, and getting there cost two review rounds, each with a counterexample:

| Rule | What killed it |
|---|---|
| Strip any trailing number | `Apollo 11`, `Apollo 13`, `Apollo 18` → one franchise |
| Strip one only when the unnumbered original is also present | `Room`, `Room 237`, `Room 203` → one franchise, an unrelated 2015 drama supplying the stem |

A bare number is a sequel index in `Iron Man 2` and part of the name in `Apollo 13`, and nothing available at slate-build time distinguishes them. The second rule reduced the false positives without eliminating them, which is not the same thing — so `Iron Man 2` is a documented **miss**, because a ceiling that drops an unrelated film is worse than one that misses a franchise.

What the proxy misses, all of it under-grouping: the numbered sequel, a shared universe under different names, a renamed entry, a retitled reboot. What it can over-group, stated rather than denied: two unrelated films whose leading *stems* are identical get one key. That is two films with the same title — `Heat` (1995) and `Heat` (2022) — and also the weaker case where one film's whole title is what precedes another's subtitle, which the subtitle split collides. Only the provider's collection id could separate either. At ≤ 2 of 20 that costs a row only when three or more collide. Every case above, in both directions, is held as a test in `rank.test.ts`.

§4's remaining constraints — most-popular band, candidate-family minimum, exploration slots — are **not** implemented in V1, because V1 has no candidate families to count and no exploration slot to reserve. They belong to `recs-builder`.

`src/features/recommendations/rank.ts` is the whole rule and carries the reasoning. `src/features/recommendations/quality.test.ts` measures it against the failures the founder decision names by name, and `npm run report:recommendations` writes `.agent-workflow/recommendation-quality.md` from it. Both diversity assertions there are verified by mutation: removing either ceiling from `diversify` fails the test that names it.

---

## 1. Generation model

Slates are built **ahead of time** by `recs-builder`, not on request. Opening the Recommendations tab reads the most recent generation.

This follows from PRD §13's requirement that the surface "opens directly to useful suggestions." Building on demand would put candidate generation, scoring, and diversity re-ranking in the path of a tab tap. It also makes the impression cooldowns cheap, because the builder already knows what it served last time.

A generation is triggered by a schedule, and additionally when a user's ranking changes materially — roughly every five new rankings, or any change inside their top 20, since those move their taste vector most.

Each generation records its `config_version`, so a slate can be reproduced after tuning values change. Without that, a quality regression can only be guessed at.

---

## 2. Pipeline

Seven stages, matching PRD §13.

```
candidates → eligibility → scoring → re-ranking → explanation → delivery → feedback
   ~500         ~300         ~300        20          20          20        ongoing
```

The counts are indicative. What matters is the ordering: **eligibility runs before scoring**, so effort is never spent ranking titles that can never be shown, and **re-ranking runs after scoring**, so diversity constraints operate on a scored pool rather than distorting the scores themselves.

### Stage 1 — Candidates

Five families, each contributing independently. The family is recorded on every candidate, which is what makes the source-diversity constraint checkable later.

| Family | Source |
|---|---|
| `compatible_users` | Highly ranked titles from users with a strong `match_scores` row |
| `followed_users` | Highly ranked titles from people the user follows, regardless of match |
| `content_similarity` | Shared genres, keywords, director, or principal cast with the user's top-band titles |
| `fresh_catalog` | Recent releases passing a minimum quality signal |
| `curated` | Editorial cold-start sets |

### Stage 2 — Eligibility

A hard filter. Removes anything in `user_media` (watched, ranked or not), anything with `recommendation_feedback` of `dismiss` or `already_seen`, anything from a blocked user's contribution, anything whose endorsing user is no longer visible, duplicates, and anything shown within the cooldown window.

Because it precedes scoring, an ineligible title cannot survive by scoring highly — which is the failure mode this ordering exists to prevent.

### Stage 3 — Scoring

A weighted sum over normalized signals, with weights in `app_config`:

| Signal | Contribution |
|---|---|
| Endorser match strength | Weighted by `match_scores.score` |
| Endorser confidence | Weighted by `shared_count`, so a 94%/8-shared endorser counts for little |
| Endorsement position | A title in someone's top 10 counts for more than one at #300 |
| Independent endorsers | Distinct endorsers, with diminishing returns |
| **Bucket signal** | The user's own `loved` titles drive content similarity even with zero rankings |
| Content fit | Genre, keyword, creator, era, language overlap |
| Freshness | Mild recency preference |
| Novelty | Inverse of global popularity |
| Calibrated popularity | Bounded positive contribution, capped by stage 4 |

**Bucket signal is why an importer gets useful recommendations on day one.** A user who imports 400 Letterboxd films and ranks nothing has 118 titles in `loved`, which is ample content-similarity signal. They have no `match_scores` rows yet, so the collaborative families contribute nothing — and the slate is labeled accordingly at stage 5.

### Stage 4 — Re-ranking

> **What of this V1 implements, and how, is §0.** The franchise and genre constraints are enforced today; the family minimum, popular band and exploration slots are not, because V1 has no candidate families. `belongs_to_collection` is unavailable at slate-build time, so franchise identity is a documented title-derived proxy rather than the provider's collection id.

The scored pool is reduced to 20 under hard constraints. Implemented as greedy selection: take the highest remaining score that violates nothing, repeat.

| Constraint | Default |
|---|---|
| Same franchise or primary creator | ≤ 2 per 20 |
| Single primary genre | ≤ ~40% |
| Most-popular band | ≤ ~50% |
| Distinct candidate families | ≥ 3, when data allows |
| Exploration slots | A configurable share reserved for lower-confidence, higher-novelty candidates |

Greedy selection is used rather than optimization because it is inspectable. When a slate looks wrong, you can replay the selection and see exactly which constraint rejected which title — which is not true of a solver.

"When data allows" is doing real work in the family constraint. A brand-new user has only `curated` and `content_similarity` available, and the constraint yields rather than producing a short slate.

### Stage 5 — Explanation

Each row stores structured `evidence`:

```json
{
  "kind": "social",
  "endorsers": [
    { "user_id": "…", "match": 91, "their_position": 4 },
    { "user_id": "…", "match": 88, "their_position": 11 }
  ],
  "endorser_count": 3
}
```

The client renders a sentence from the structure — *"3 people with similar taste have this in their top 20"*. It has **no path to compose a reason of its own**, because it never receives the candidate pool, only the selected slate with its evidence.

This is the mechanism behind PRD §13's explanation-integrity requirement. A fabricated reason is not merely forbidden; there is nothing available to fabricate it from.

Evidence kinds map to what is actually true:

| Kind | Rendered as |
|---|---|
| `social` | "N people with similar taste loved this" |
| `following` | "Someone you follow ranked this #4" |
| `content` | "Because you loved *X*" |
| `fresh` | "New this month" |
| `curated` | "A good place to start" |

**A `curated` or `content` reason is never dressed as `social`.** PRD §13 requires sparse-data results to be labeled by their real source rather than implied to be personalized.

### Stage 6 — Delivery

The client reads the latest generation with its timestamp. When served from device cache during an outage, the UI labels it as cached and shows the age. It never implies live recalculation.

### Stage 7 — Feedback

`recommendation_impressions` is written on display, driving cooldowns. `recommendation_feedback` records dismiss, already-seen, save, and open. Later watch and ranking outcomes are the strongest signal and are read from `user_media` and `rankings` at generation time.

*Already seen* is treated differently from *Not interested*: the former marks the title watched, the latter suppresses it without any claim about taste.

---

## 3. Guardrail enforcement

Every guardrail in PRD §13, with the mechanism that enforces it and the assertion that proves it.

| Guardrail | Mechanism | Test asserts |
|---|---|---|
| Eligibility | Stage 2, before scoring | No watched, logged, dismissed, or blocked title appears in any slate |
| Impression history | `recommendation_impressions` cooldown in stage 2 | A title shown today does not reappear within the window |
| Popularity balance | Popularity band cap in stage 4 | ≤50% of a 20-slate from the top popularity band |
| Source diversity | Family minimum in stage 4 | ≥3 families when the user has the data to support them |
| Slate diversity | Franchise, creator, genre caps in stage 4 | No slate breaches any cap |
| Exploration | Reserved slots in stage 4 | Every slate contains the configured exploration share |
| Explanation integrity | Stage 5 evidence structure | Every rendered reason maps to stored evidence; the client cannot produce one otherwise |
| Feedback learning | Stage 7 into stage 2 and 3 | A dismiss changes the next generation |
| Quality evaluation | §5 below | Dashboard exists and is reviewed |
| Graceful degradation | Evidence `kind` reflects the real source | A cold-start slate is labeled curated or content, never social |

---

## 4. Cold start

Three tiers, chosen by what the user actually has:

| User state | Families available | Labeling |
|---|---|---|
| Brand new, onboarding taps only | `curated`, `content_similarity` | Curated or "because you liked X" |
| Imported, bucketed, unranked | `content_similarity` (strong), `curated`, `fresh_catalog` | Content-based |
| Ranked, with match rows | All five | Social where true |

The middle tier is the one the PRD cares most about, because Letterboxd import is a v1 must-have and the whole argument for mapping stars to buckets rather than discarding them is that it makes this tier work.

---

## 5. Evaluation

PRD §13 forbids optimizing on click-through alone. The dashboard tracks, per generation cohort:

| Metric | Why |
|---|---|
| Save rate | Immediate interest |
| Watch-through rate | Real value, measured later |
| **Later positive rank rate** | The strongest signal — did they watch it *and* like it |
| Repeat-impression rate | Cooldowns holding |
| Long-tail exposure | Share of served titles outside the popular band |
| Slate diversity | Distribution of genre, family, era |
| Explanation audit failures | Should be zero |
| Cached-serve share | How often degradation is in play |

Later-positive-rank is the metric that would catch an engine that optimizes for the appealing over the good. A recommender tuned on clicks alone will happily serve well-marketed films people regret watching, and only this metric notices.

---

## 6. Degradation

| Failure | Behavior |
|---|---|
| `recs-builder` has not run | Serve the last generation, labeled with its age |
| No generation exists | Serve curated cold-start, labeled as such |
| Device offline | Serve the cached slate, labeled cached |
| TMDB unavailable | Serve from `media_items`; suppress enrichment, never the slate |

Under every failure the surface degrades to something honest. It never shows an empty state to a user who has a valid older slate, and it never presents a fallback as personalization.

---

## 7. Freshness — the audit, and what was changed, 2026-08-20

The founder's report after the Android Preview: *"essentially the same recommendations
every visit."*

### The audit

Nothing was broken, and that is the finding. Every stage below was read against the code
rather than assumed:

| | What it did | Verdict |
|---|---|---|
| Candidate generation | `similar` per anchor + `trending.*.week` fallback | Fixed for the life of the provider cache — weeks for `similar`, six hours for trending |
| Scoring | `scoreCandidate`, pure over candidate × anchors × taste | Deterministic |
| Re-ranking | `diversify`, greedy top-k in strict score order | **Deterministic. One input, one answer.** |
| Cache | `staleTime` 30 minutes; key = rankings + watched + filters | Correct, and irrelevant to this |
| Remount | Same key, so the cache is re-read | Changes nothing |
| Filters | Applied to candidates before scoring | Stable candidate set, by design |
| Low-data fallback | Popularity-only | Also deterministic |

So the wall was **not stale — it was correct, and correctness had exactly one answer.**
With the rankings unchanged and the provider cache unchanged, every visit recomputed the
same twenty titles in the same order, and would have done for weeks. No amount of cache
tuning could have moved it, which is why the audit came before the fix.

### What changed

The pipeline was split at the boundary between *which titles are good* and *which
arrangement of them is on screen*.

- **Stage 3 (scoring) is unchanged, and is what the query caches.** `scoreSlate` returns
  every eligible scored candidate. Relevance weighting is untouched — no term was added,
  removed or reweighted.
- **Stage 4 (re-ranking) gained an optional seed.** With no seed, `diversify` is exactly
  what it was: strict score order under the three hard ceilings. With one, the order it
  walks is sampled instead of sorted.
- **The sampling is perturbed top-k over a bounded pool**, also called Gumbel top-k:
  `key = score + T × spread × Gumbel(u)`, over the top `3 × limit` candidates by score,
  with `u` a stable hash of (seed, media item id). Adding a Gumbel draw to a score and
  taking the best is equivalent to sampling in proportion to the exponential of that
  score, so a better title is genuinely more likely to lead — this is not a shuffle.
- **The three ceilings run over the sampled order unchanged.** Anchor, franchise and
  genre caps hold for every seed; only the order they are applied to varies.

`T = 0.12`, measured rather than chosen. Over 3,000 seeds on a sixty-candidate pool, a
reader with one anchor sees their top-scoring title lead about half of all visits and a
title from outside the top ten lead about one visit in a hundred, with roughly six hundred
distinct top-sixes available. The measurement table is in `rank.ts`.

**Those figures are a one-off calibration run, not something the suite maintains** —
review 29e asked for the distinction. The suite holds exactly two weaker bounds over 300
seeds: the best title leads **more than a third** of visits (`> 100/300`), and a title from
outside the top ten leads **less than a tenth** (`< 30/300`). 29f caught this paragraph
saying "well over" and "well under" of assertions that permit 101 and 29. Nothing
reproduces the distinct-top-six count. Re-run the calibration before moving `T`.

**The pool bound is where the relevance guarantee lives — and independent review 29
found this paragraph claiming more than the code delivers.** It said sampling "can never
reach the two-hundredth". The accurate statement is narrower:

> **No draw can promote a title from outside the pool.** Sampling reorders the top sixty
> and nothing else; every candidate below them keeps its strict score order and stays
> behind all sixty.

The greedy ceiling pass then walks that whole sequence, so a wall whose top sixty are
mostly rejected by the genre, franchise and anchor caps *can* be filled from position 61
and beyond. **That is not something the seed introduced.** `diversify` has always been one
greedy pass over every scored candidate with hard ceilings; reaching the tail is a property
of the candidates and the caps rather than of the arrangement.

**Seeding changes which titles are chosen and how many**, and it took two further rounds
to say that. The ceilings intersect and are spent in the order they are met, so a different
arrangement of the pool leaves different quota for what follows.

**There is exactly one guarantee:**

| Holds, every seed | Does not hold — and each was claimed here once |
|---|---|
| No draw promotes a title from outside the pool | The same titles are chosen *(found 29b)* |
| | The wall never gets shorter *(found 29c)* |
| | The tail is reached under identical conditions *(found 29c)* |

The counterexample to the second row is small and real: six candidates over two genres and
two franchises at `limit: 5` give a wall of four in strict order and **three** under seed
76. It is in `rank.test.ts`.

**That cost is accepted.** The excuse offered for it in one round — that it needs a pool
which could not fill the wall anyway — was **disproved by 29d** and is also in the suite: add
a seventh candidate with its own genre and franchise and strict order fills all five slots
while seed 76 still returns four, in about one seed in fifty. What the shortening actually
requires is that the intersecting ceilings be near-binding.

What holds, and now runs as a test rather than sitting in prose: **on the five pool shapes
the suite tests, the length does not move.** Those five are 60 and 200 candidates across
the eighteen-genre vocabulary, a five-genre wall, a franchise-heavy wall, and 25 candidates
for a wall of 20 — over 200 seeds each, twenty every time. Five fixtures are evidence about
five fixtures and not a proof about every pool with slack in its caps; 29f was right that
the previous sentence here read as the second. It is a test at all because 29d could not
reproduce the claim from the paragraph that made it.

Topping the wall back up would mean relaxing a ceiling, which §4 already refused: a cap that
yields when it is inconvenient is not a cap.

Truncating the input to the pool would make the top-60 bound literal, and was rejected for
the same reason twice over: it shortens the wall *more*, and unconditionally.

`rank.test.ts`, `what the exploration pool bounds`, asserts every row of that table —
**including the false ones**, so no later round can restore them.

On a popularity-only wall the same setting behaves close to uniform sampling inside the
pool, which is the right answer rather than a defect: those scores differ by thousandths,
so there is no distinctly best title to protect. Where the spread is exactly zero,
`explore` returns strict order for every seed and Refresh is honestly a no-op — there is
no near-tie to break when everything is one tie.

### Where the seed lives

`src/features/recommendations/session-seed.ts`, a module rather than component state, so
that:

- **A visit is stable.** Nothing reshuffles on a bookmark, a reaction, a re-render, a
  navigation, or a cache invalidation. The only writer is the Refresh control.
- **Leaving the tab and coming back does not reshuffle**, which component state could not
  have given us.
- **A new launch is a new seed**, because the module is evaluated again — and a new seed
  is *almost always* a new arrangement rather than necessarily one, for the two reasons
  Refresh carries: a zero-spread pool returns strict order for every seed, and two seeds
  can survive the ceilings to the same wall.

It enters the query through `select`, never through the key. A seed in the key would make
Refresh a different cache entry with no data in it — the screen would fall to `isPending`,
swap the wall for a skeleton and mount a fresh `ScrollView`, which is the same
flash-and-jump defect fixed in the same pass for bookmarks. Through `select`, a refresh is
one sort over data already in the cache: no network, no pending state, no remount.

Filters are unaffected: sampling runs over the already-filtered scored pool, so a
refreshed wall is still Comedy if Comedy was chosen.

### What this does not do

No memory of what was already shown, no novelty or recency term in the score, no learning
from what an explored title did, and no widening of the candidate pool itself. Those are
`docs/product/deferred-roadmap.md` §17, with the reasoning for each.
