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
| Cross-user signal | `match_scores`, followed users' rankings | **none** |
| Evidence | composed server-side, stored on the row | computed from the viewer's own inputs, returned with the score |
| Storage | `recommendation_generations` / `recommendations` | nothing persisted |

**The client composes the sentence, and that is not a violation of §5.** The rule that the client "has no path to compose a reason of its own" exists to stop **fabricated social proof** — "3 people with similar taste loved this" asserted about people who did not — and it is enforced server-side because the client cannot be trusted with, and must not have, other users' rankings.

V1 uses **no other Bingd user's data**. Its three inputs are the viewer's own rankings (own-only under RLS), TMDB's association between titles (`media_cache` facet `similar`, world-readable), and genre/language/popularity from `media_items`. There is therefore no social claim available to fabricate, and every sentence it can produce is of the form "because of something *you* did".

> **The stronger phrasing — "no cross-user signal at all" — is false, and independent review said so.** TMDB's recommendations are derived from what *their* users did, and popularity is a crowd measure. Both are external, public, about titles rather than about people, and identical for every viewer, so neither can be attributed to a person and neither is something one Bingd account learns about another. That is the claim; the stronger one was overreach.
>
> One residual side channel, recorded rather than closed: `similar` answers `reason: "cached"` faster than it answers a fetch, so an authenticated caller can infer that *some* account recently caused a given title's facet to be filled. It names no person, no score and no time, and any signed-in user may ask about any title anyway. Closing it would mean padding the response, which costs more than the channel is worth.

**The moment a social family is added, scoring moves server-side.** That is not a preference; at that point the client would need other people's rankings in order to score, which is the thing the rule protects.

Two further properties are worth recording because they are what keep the sentence honest:

- The headline is derived from `lead`, which is whichever *weighted* term actually carried the score. A title that scored on popularity cannot be described as "because you loved X" — the arithmetic decides the wording, not the author.
- A taste built from fewer than five rankings is not asserted in words. The signal is still used; the sentence falls back to "Popular right now" rather than telling somebody what they like on the evidence of two films.

**Anchors are bounded at six.** Each is one provider request the first time it is used and free for every user afterwards, because the answer lands in `media_cache` under the shared facet TTL. A request per ranked title — the obvious implementation — is four hundred TMDB calls for a user with four hundred rankings.

`src/features/recommendations/rank.ts` is the whole rule and carries the reasoning. `src/features/recommendations/quality.test.ts` measures it against the three failures the founder decision names by name, and writes `.agent-workflow/recommendation-quality.md`.

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
