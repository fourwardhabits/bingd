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
- **A title's genre term** is its best genre's affinity minus how far its worst genre sits
  *below* neutral (`max(0, best − (0.3 − worst))`). A loved genre still lifts a title, and a
  disliked one now lowers it even when the title also carries another genre: a Horror-Thriller
  scores below a Western for a reader who keeps putting horror in Not for me. Unknown genres
  cost nothing. (Before the 2026-11-11 independent review only the best genre counted, so
  negative evidence reached only titles whose every genre was disliked.)
- **Era:** `0.5 + 0.5 × interest × clamp((mean − readerMean)/0.5, −1, 1)` per decade, films
  and TV separately, each decade lending half its evidence to its neighbours. Watching
  mostly recent titles moves nothing; liking a decade *more than you like things generally*
  does. A decade with no evidence is exactly neutral, so a classic is never pushed down.

### 1.3 Candidate generation, and why the catalogue only fills gaps

`catalogue_candidates(kind, languages[≤5], decades[≤3], per ≤40, seed)` returns, per
requested language or decade, a seeded draw from the top `3 × per` catalogue titles by
popularity, excluding what the caller logged (and, on TV, shows with a logged season). It
answers empty while the caller is on V1. Each window is the first rows of one ordered index
range: `media_items_catalogue_language (kind, original_language, popularity)` and
`media_items_catalogue_decade (kind, decade(release_date), popularity)`, so its cost does
not grow with the size of a language or a decade (measured in the scale benchmark).

The client asks for the reader's source languages (affinity ≥ 0.45, strongest first, equal
quotas — volume-proportional quotas would be the English bias again) and positive-lift
decades, in parallel with the anchor work, then `coverageFill` keeps only what brings each
facet up to its fair share of the pool: `min(20, max(6, ⌈share × pool⌉))`, share being the
facet's share of the reader's positive evidence. An English reader with English-full anchor
lists gets nothing from it, so it is not popularity padding (review of 2026-09-13, M2).
Only candidates that will survive eligibility count as coverage: titles already in the
reader's collection and the anchors themselves are dropped by `scoreSlate`, so they neither
count toward a facet nor are added (independent review, 2026-11-11).

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
| `recommendations.v2_allowlist_engine` | `null` | Optional: the engine the allowlist gets instead of `v2_engine`, so `v2_metadata` can run on a small percentage while `v2_hybrid` is dogfooded on the allowlist. Null or unknown = same as `v2_engine`. |

`v2_engine` is the master switch: while it is `"v1"`, every reader is on V1, allowlisted or
not, whatever the override says.

**Before `db push` on a large production database.** Supabase applies a migration inside a
transaction, so its `create index` statements cannot be `concurrently`, and a plain build
blocks writes to the table for its duration. Build the new indexes by hand first, with the
same definitions, so the migration's `create index if not exists` statements are no-ops:

```sql
create index concurrently if not exists media_items_catalogue_language
  on media_items (kind, original_language, popularity desc nulls last)
  where kind in ('movie', 'series') and poster_path is not null;
create index concurrently if not exists media_items_catalogue_decade
  on media_items (kind, ((extract(year from release_date)::integer / 10) * 10), popularity desc nulls last)
  where kind in ('movie', 'series') and poster_path is not null;
```

A2 adds a third, on `rankings` (§2.6). An operator step, run only with founder approval.

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

## 2. A2 — collaborative evidence from taste-compatible people

Migration `20261111000200_people_whose_taste_you_share.sql`; client in `rank.ts`
(`ENGINES.v2_hybrid`) and `use-for-you.ts` (`collaborative_candidates`). Engine
`v2_hybrid` is everything `v2_metadata` does plus one source and one scoring term.

### 2.1 Who counts as a neighbour

A **public**, active account the reader may discover (`can_discover_profile`: not blocked
either way, not suspended) with a Taste Match on at least `taste.min_common` (5) shared
ranked titles. The Match is `taste_match`'s own arithmetic, run for one reader against many
(`_taste_matches`); equality with `taste_match` is tested on random rankings.

- **Following plays no part.** A followed account with the same rankings gets the same Match,
  the same weight and the same effect as a stranger (tested). A **private** account is never
  a neighbour, followed or not — otherwise following would decide whose evidence counts, and
  a private account's rankings would reach somebody it never approved.
- **Re-checked on every read.** A cached neighbour who goes private, blocks or is blocked,
  or is suspended stops counting on the next read without waiting for a refresh (tested).
- **Low compatibility is not opposite taste.** Below `recommendations.neighbour_min_match`
  (55) the weight is zero, never negative; a poor match's dislikes are never read as the
  reader's likes (tested).

### 2.2 Weights: a weak high Match cannot dominate

`weight = (match − 55)/45 × common/(common + 10)`, in 0–1.

The Match is already shrunk toward 50 by `n/(n + 5)`, so a five-title "100%" is at most 75.
The second factor is a stricter reliability term on top: a five-title 75 weighs
`(20/45)(5/15) ≈ 0.15`; a forty-title 70 weighs `(15/45)(40/50) ≈ 0.27`; a forty-title 85
weighs `≈ 0.53`. One thin, high Match therefore moves a title less than an established
cohort does. The constants are starting values; A3 sweeps them on synthetic readers.

### 2.3 Bounded retrieval (no all-pairs)

`_refresh_taste_neighbours(reader)`:

1. **Probe** the reader's 40 most opinionated ranked titles (`|score − 5|`, less popular first
   among equals — a shared love of an obscure film says more than a shared love of a hit).
2. **Sample** at most 50 raters per probe title from a daily-rotating point in the new
   `rankings (media_item_id, user_id)` index, wrapping around. A title ranked by a million
   people costs 50 index rows, not a million (a test shows the cap binding).
3. **Shortlist** the 200 most frequent co-raters who are public and discoverable.
4. **Score** those 200 with `_taste_matches` and cache the best 40 with weight > 0 in
   `taste_neighbours`, for 24 hours (`taste_neighbour_refresh` records "computed, nobody
   qualified" too, so an isolated reader is not recomputed per read; that empty result is
   retried after 3 hours rather than 24, so a new reader's first rankings count the same day).
   `_taste_matches` scores only the shortlisted people's rankings **of titles the reader
   ranked**, read through the new index; their band sizes are aggregate counts. Scoring each
   one's whole history first made the refresh grow with how much they had ever ranked
   (independent review, 2026-11-11).

Worst case per refresh: 40 × 50 = 2,000 index probes, 200 users' band counts, and at most
200 × (the reader's ranked titles) scored rows. Nothing runs on a write path and nothing
compares a reader with every account. The refresh happens inside the first stale read;
concurrent stale reads by one reader refresh once (a per-reader advisory lock plus a
re-check, observed with real sessions in `concurrency/races/taste-neighbours.mjs`), and
different readers do not contend. Capacity is **measured**, not asserted, on real
PostgreSQL with up to 1M synthetic accounts, in A3's scale benchmark
([`recommendations-v2-scale-benchmark.md`](./recommendations-v2-scale-benchmark.md), PR #253).

**Sampling trade-off:** a rotating sample means a reader may not find their single best
neighbour on a given day if a probe title has thousands of raters. Rotation finds different
ones on different days; the cache keeps the best 40 of each pass. Exact top-k would need
all-pairs work, which §7 rules out.

### 2.4 What the client receives

`collaborative_candidates(kind, limit ≤ 100)` returns `(media_item_id, support, endorsers)`:

- `support` = Σ weight × (score − 5)/5 over neighbours who ranked the title, divided by
  Σ weight + 1 (one full-weight neutral opinion as a prior). Neighbours' dislikes count
  against a title.
- **Endorsed rows** (support > 0) need at least two neighbours who scored it 7 or more
  (`endorsers`), up to `limit`, strongest first. These are a candidate source.
- **Disputed rows** (support < 0) need at least two neighbours who put it in Not for me
  (≤ 3.4), up to `limit / 2`, most disliked first. These are **evidence only**: the client
  never adds them to the pool, but a title that arrived from another source (an anchor's
  list, trending) is scored down by them. Added after the 2026-11-11 independent review,
  which found that the reader's taste neighbours' dislikes never reached a title from any
  other source.
- Either way it takes two people, so no single person's ranking is ever why a row exists.
- Each read scores the neighbours' rankings in the requested category only (a film wall
  never scores their seasons).
- Never a person, a neighbour id, one person's score, or a Match. Every neighbour is a public
  account whose rankings the reader could already open, so the aggregate reveals nothing the
  reader could not already see; it only saves them the search.
- On TV, a neighbour's seasons count once per show, at their best season.
- Excludes whatever the reader has logged or ranked, and shows with a logged season.

### 2.5 Scoring

`ENGINES.v2_hybrid` = `v2_metadata`'s weights × 0.85 (rounded) + `collaborative` 0.15.
The term is `clamp(support / 0.5, −1, 1)`: full strength at a cohort mean of about 7.5, and
the same bound the other way for a disputed title. It is one term among six, so it lifts a
title but cannot by itself outrank a strong anchor match (tested). Endorsed ids take the
slot `social_candidates` had in V1's source order; disputed ids are never a source. Only a
positive term can lead or be named.

Headline: "Loved by people with taste like yours", only when the collaborative term leads,
at least three neighbours endorsed it, and the reader has five or more rankings. No name, no
count, no Match.

### 2.6 Flags and rollback

| Key | Seed | Meaning |
|---|---|---|
| `recommendations.v2_engine` = `"v2_hybrid"` | (`"v1"`) | Turns A2 on for the cohort/allowlist in §1.5. |
| `recommendations.neighbour_probe_titles` | `40` | Probe titles per refresh (clamped 5–100). |
| `recommendations.neighbour_raters_per_title` | `50` | Raters sampled per probe title (5–200). |
| `recommendations.neighbour_limit` | `40` | Neighbours kept (1–100). |
| `recommendations.neighbour_ttl_hours` | `24` | Cache lifetime (1–336). |
| `recommendations.neighbour_min_match` | `55` | Zero-weight floor (50–95). |
| `recommendations.v2_allowlist_engine` | (`null`, A1) | Set to `"v2_hybrid"` to dogfood the hybrid on the allowlist while `v2_engine = "v2_metadata"` runs on the percentage cohort. |

**Before `db push` on a large production database:** build A2's index by hand first, as A1's
(§1.5): `create index concurrently if not exists rankings_by_media_user on rankings
(media_item_id, user_id);`. A plain build inside the migration blocks every ranking write
for its duration (1.4 s per 1.5M rankings in the scale benchmark, roughly linear). Once it exists, the older single-column
`rankings_by_media (media_item_id)` is redundant — every lookup it serves is a prefix of the
new one — but it is **not** dropped here: dropping a production index is a change outside the
engine switch, and it is left as a follow-up once V2's fate is decided.

**Known risk (accepted for an experimental engine):** neighbours are public accounts with
no age or reputation gate, so two new public accounts that copy a public reader's rankings
(which anyone can read) could become that reader's neighbours and push a title. Two-person
minimums and the reliability weight limit how far; a reputation gate is a prerequisite for
any rollout beyond the allowlist.

**Rollback:** write `"v2_metadata"` (keep A1) or `"v1"` to `recommendations.v2_engine`.
`collaborative_candidates` then answers empty and never refreshes; the cache is inert and can
be truncated at leisure (`truncate taste_neighbours, taste_neighbour_refresh`). No client
release is needed.

### 2.7 Validated vs hypothesis

- **Tested (DB, hook, unit, race):** Match arithmetic equals `taste_match`; following has no
  effect; private, blocked and suspended accounts never count, including from cache; low
  Match gives zero weight; one lover is not enough; negatives lower support; the rater cap
  binds; TV rolls up per show; anon and internals are refused; the engine switch gates it;
  concurrent refreshes deduplicate.
- **Hypothesis:** that taste neighbours' loves are good recommendations for real readers, and
  every constant in §2.2–§2.5. A3 evaluates on labelled-synthetic data only.
