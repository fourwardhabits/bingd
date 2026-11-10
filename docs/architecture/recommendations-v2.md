# Recommendation Engine V2

Founder spec 2026-11-10 (§3, §8 A1–A3). V1 (`recommendations.md`) keeps shipping unchanged
and is what every reader gets until an operator turns V2 on. This document grows one section
per work package; gaps against the spec are in `taste-affinity-v2-gap-analysis.md`.

## 1. A1 — candidate coverage (language, era, negative evidence)

### 1.1 What changes

| Piece | File | V1 | V2 (`v2_metadata`) |
|---|---|---|---|
| Profile | `profile.ts` | `tasteFrom`: volume-normalised, positive-only, rankings only | Saturating interest × shrunk signed opinion; ranked, bucketed and logged titles at different confidence; era per medium relative to the reader's own mean |
| Anchors | `anchors.ts` | Top two, genre coverage, rotation | Same, plus one draw per liked language carried by ≥2 liked titles (at most 3), before genre coverage |
| Sources | `use-for-you.ts`, `coverage.ts` | Anchor lists, `social_candidates`, trending | Anchor lists, trending, and `catalogue_candidates` **only to fill a shortfall**; `social_candidates` is not read |
| Scorer | `rank.ts` `scoreCandidateV2` | `ENGINES.v1` | `ENGINES.v2_metadata`: V1's four weights × 0.93, era 0.07 |
| Engine choice | `recommendation_engine()`, `use-engine.ts` | — | Server-chosen per reader; any failure is V1 |

The anchor term and the popularity prior are V1's, byte for byte (tested). Diversity and the
For You V2 selection (`selection.ts`) are unchanged and apply to both engines.

### 1.2 The profile, precisely

Per title: confidence 1 and valence `(score − 5)/5` when ranked; 0.6 and the band midpoint's
valence when bucketed but unranked (imports); 0.35 and no valence when only logged.

- **Language and genre:** `affinity = neutral + interest × (positivity − neutral)` where
  `interest = 1 − e^(−Σconfidence/3)`, `positivity = (mean + 1)/2`, and `mean` is the facet's
  confidence-weighted valence shrunk toward the reader's own mean by two pseudo-titles.
  Neutral is 0.3: no evidence is neither interest nor rejection. Four loved Japanese films
  reach roughly the same affinity as forty English ones of mixed opinion; Not-for-me
  evidence pulls a facet below 0.3, never to 0.
- **Era:** `0.5 + 0.5 × interest × clamp((mean − readerMean)/0.5, −1, 1)` per decade, films
  and TV separately, each decade lending half its evidence to its neighbours. Watching
  mostly recent titles moves nothing; liking a decade *more than you like things generally*
  does. A decade with no evidence is exactly neutral, so a classic is never pushed down.

### 1.3 Candidate generation, and why the catalogue only fills gaps

`catalogue_candidates(kind, languages[≤5], decades[≤3], per ≤40, seed)` returns, per
requested language or decade, a seeded draw from the top `3 × per` catalogue titles by
popularity, excluding what the caller logged (and, on TV, shows with a logged season). It
answers empty while the caller is on V1.

The client asks for the reader's source languages (affinity ≥ 0.45, strongest first, equal
quotas — volume-proportional quotas would be the English bias again) and positive-lift
decades, in parallel with the anchor work, then `coverageFill` keeps only what brings each
facet up to its fair share of the pool: `min(20, max(6, ⌈share × pool⌉))`, share being the
facet's share of the reader's positive evidence. An English reader with English-full anchor
lists gets nothing from it, so it is not popularity padding (review of 2026-09-13, M2).

**Known limitation:** the catalogue is `media_items` — what bingd's readers have searched,
logged or been shown. A language nobody on bingd has touched has nothing to return.
A TMDB discover-by-language adapter action is the natural follow-up; it was not added
because it spends provider quota and needs an edge-function deploy.

### 1.4 Following has no effect under V2

V2 never calls `social_candidates`, so what the people a reader follows loved cannot enter
the pool by that route, and nothing in the V2 scorer reads the follow graph. Tested at the
hook level (`for-you-engine-v2.test.tsx`). A2 adds collaborative evidence chosen by Taste
compatibility, where a followee counts exactly as much as a stranger with the same Match.

### 1.5 Switch, cohorts, rollback

| Key | Seed | Meaning |
|---|---|---|
| `recommendations.v2_engine` | `"v1"` | The engine under rollout. `"v1"` = off. Unknown values are V1. |
| `recommendations.v2_rollout_percent` | `0` | Deterministic cohort: `md5(user id ‖ ':recommendations.v2')` → 0–99. Raising it only adds accounts. |
| `recommendations.v2_allowlist` | `[]` | Accounts that get the engine regardless of the percentage (staging, dogfood). |

**Rollback:** write `"v1"` to `recommendations.v2_engine`. `recommendation_engine()` then
answers V1 for everybody and `catalogue_candidates` answers empty. Clients pick it up on the
next engine read (30-minute stale time, the same as the slate); the engine is in the slate's
query key, so no V2-scored slate is served from cache after that read. No client release is
needed in either direction. Telemetry: `for_you_slate_shown.engine`, `.wall_languages`.

### 1.6 Validated vs hypothesis

- **Tested (unit, hook, DB):** the properties in §1.2–§1.5 — minority languages can be
  strong, no English assumption, negative evidence lowers without excluding, exposure is not
  era preference, classics stay neutral, films and TV are separate, V1 is unchanged, non-English
  titles enter the pool and are selected for a reader whose evidence is Japanese, following
  has no effect, the switch defaults off and rolls back, inputs are bounded, anon is refused.
- **Hypothesis, not evidence:** that V2 orders titles better for real readers. The weights
  are V1's proportions plus a small era term chosen so a difference can be attributed; A3
  compares engines on held-out data, and only staging/production telemetry can say more.
