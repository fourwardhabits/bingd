# The behavioural contract of a state-changing action

**Status:** current as of 2026-09-19, against `main` at the Android production audit.
**Scope:** the shipping core loop only — ranking, logging, the Collection and the
Watchlist, the Feed's representation of them, direct recommendations, and reactions and
comments. Watch History T1+, Refine Rankings, Lists, Predicted Score, Watch Next,
release-awareness real sending and Stats are deliberately absent: see
`docs/product/deferred-roadmap.md` and the design documents each one has.

## Why this document exists

A high-volume tester found four defects in a fortnight — an ordering that did not survive
an equal printed score (#171), a resumed session that could contradict itself (#172), a
ranking that invented a watch date (#174), a correction that counted as a ranking act
(#180) — and then a fifth: **rank a film, look at the Feed, rerank it, and the Feed still
shows the first score.**

None of them were crashes and none were caught by a unit test, because each was a
disagreement between two surfaces about one fact rather than a function returning the
wrong value. What was missing was a written statement of what each action changes and
what it must leave alone, against which a surface can be found to be lying.

That statement is the table below. It is a *contract*, not a description: where the code
and this document disagree, one of them is a bug, and this document says which by citing
the migration or the test that settles it.

The convention in every row:

- **Canonical** — the rows that are the truth. Everything else is a projection of them.
- **Must change** / **must not change** — the two halves that make a claim testable.
- **Surfaces that must agree** — every surface that presents *current* state. A surface
  presenting a *historical* fact is listed as such and is exempt by construction.

---

## 1. Ranking and re-ranking

| | |
|---|---|
| **Canonical** | `rankings (user_id, media_item_id, category, bucket, position, created_at)` · `user_media.bucket` |
| **Derived, never stored** | the 0–10 score — `score_for(bucket, band_rank, band_size)` = `src/features/collection/score.ts`. A score is a position *within a band*, so **one insertion re-scores every title in that band**. This is the fact almost every defect in this area comes back to. |

### 1.1 First-time rank (`rank_start` → `_rank_finalize`, `p_replaces` false)

| | |
|---|---|
| Must change | a `rankings` row appears at `position`, stamped `now()`; every position at or below it shifts down one; `user_media.bucket` is asserted; one `title_ranked` feed event; the watchlist entry goes; outstanding delivered recommendations for the title are fulfilled and their senders notified; invite activation is evaluated |
| Must not change | the relative order of every other title (proved by `ordinal-order.test.ts` and `ranking-resume-integrity.test.mjs` §"inserting a title never reorders"); the other category's ranking; `watched_on` |
| Watch-date effect | **none from the ranking itself.** The Log sheet stamps today on a *first* log; ranking a title already seen and undated leaves it undated (#174, `LogSheet.test.tsx` §"ranking a title that was already seen") |
| Feed effect | one new `title_ranked` card |
| Surfaces that must agree | title page · Collection (ranked and unranked) · Profile → Top Ranked · Profile → Recent activity · Feed · goals · streak · awards · Taste Match · community score |

### 1.2 Correction — *Update your rating* (`rank_again` `p_new_watch` false, or `rank_rebucket`)

| | |
|---|---|
| Must change | `rankings.position`, and `bucket` on a band change; `user_media.bucket` follows; the **current score of this title and of every other title in the bands involved** |
| Must not change | `rankings.created_at` — a correction keeps the instant the ranking already had (`20261001000100`) · the weekly streak · *Recently ranked* order · a watchlist entry the reader re-added **after** the ranking's instant · `watched_on` · **the feed: no new event, and the existing one is not re-timed** |
| Feed effect | **none as an event.** The existing `title_ranked` card stays where it is, at the time it already had, and **shows the corrected score** (`20261002000100`) |
| Founder ruling | 2026-09-07 and the T0 tranche of `docs/product/watch-history-and-ranking-calibration.md`: *Update your rating* is a correction, not a watch. A correction is not a thing that happened to anybody else, so it is not an activity |
| Proved by | `supabase/tests/correction-is-not-a-ranking.test.mjs` (21 cases) · `supabase/tests/feed-score-is-current.test.mjs` · `src/features/feed/use-feed.test.ts` |

### 1.3 *Log another watch* (`rank_again` `p_new_watch` true)

| | |
|---|---|
| Must change | everything 1.1 changes except the first placement: stamped `now()`, takes the watchlist entry, re-evaluates the series, posts **one** new `title_ranked` event |
| Must not change | it fulfils no recommendation (`not v_replaced` is false), because the title was already ranked |
| Feed effect | a second card for the same title. Both cards now read the **same** current score, which is correct for a badge that means "what they rate it"; score-at-the-time is placement history and does not exist yet (Watch History T2) |

### 1.4 Unrank (`rank_unrank`, keeping the title logged)

| | |
|---|---|
| Must change | the `rankings` row goes and the gap closes; every band it was in is re-scored |
| Must not change | `user_media` — they still watched it; the watchlist is **not** restored; **the `title_ranked` feed event survives** (`20260818000100` §"rank_unrank is deliberately not touched") |
| Feed effect | the card remains and **loses its score badge**, because there is no rating behind it any more |
| Open, deferred (P2) | the surviving card still says "ranked". See §7 |

---

## 2. Logging, watched state and the watch date

| | |
|---|---|
| **Canonical** | `user_media (bucket, watched_on, progress, note, note_visibility)` |

| Action | Must change | Must not change |
|---|---|---|
| First log of a title (`set_bucket`) | creates the `user_media` row; **stamps today** unless the reader said otherwise; leaves the watchlist; may earn a collection award | nothing about rankings |
| Log with *Earlier* / no date | the row exists with `watched_on` null | today is **not** written; the When session carries the choice to the next title for ~30 min (`when-session.ts`) |
| Ranking a title already seen and undated | position only | `watched_on` stays null (#174) |
| An explicit date | `watched_on` | it is never overwritten by a later default stamp (`LogSheet.test.tsx` §"does not overwrite a date already recorded") |
| *Forget the date* (`clear_watch_date`) | `watched_on` → null | the default stamp must not write it back |
| Surfaces that must agree | title page · Collection row · goals (the year of `watched_on`) · leaderboard month (`coalesce(watched_on, created_at)`) · streak | |

---

## 3. Collection, Watchlist and the unranked queue

| Action | Canonical write | Feed | Must not change |
|---|---|---|---|
| Remove an **unranked** title | `unlog` deletes the `user_media` row | deletes this actor's `title_ranked`, `title_logged` and `season_completed` events for the title, and the notifications about them (`20260818000100`) | `watchlist_added` survives — it is not a claim about the collection |
| Remove a **ranked** title | `rank_unrank` then `unlog`, in that order, one intent | as above | — |
| Add to Watchlist | `watchlist` row; **one durable** `watchlist_added` event, `on conflict do nothing` against a partial unique index | one card, ever | — |
| Remove from Watchlist | the row goes | **the event stays.** "Added it to their watchlist" is past tense and stays true; deleting it would cascade away other people's reactions and comments (`20260820000300` §3) | — |
| Re-add after removing | the row comes back | **no second card** | the first card's reactions and comments are why it is the durable one |
| Ranked, then deliberately re-added | the row stays through a later **correction** (`watchlist.created_at > rankings.created_at`), and goes on a first placement or a rewatch | — | `20261001000100` |
| Surfaces that must agree | title page bookmark · Collection → Watchlist · Profile → Watchlist shelf · the Feed row's bookmark control (reads the live `saved` set, not the event) | | |

---

## 4. The Feed: historical facts versus current state

This is the distinction the fifth report turned on, and it is the rule for every card.

**Historical — fixed at the moment of the event, and never revised:**

- who acted, what they did, and when (`created_at`, drawn as "5m ago")
- the event's own existence, its reactions and its comments
- `causal_at` / `causal_step`, which order a group and may be *adopted* by a later cause
  (`20260902000100`) but are never rewritten to mean a different act

**Current — read live on every page, and must equal what every other surface says:**

| Field | Read from | Since |
|---|---|---|
| score, band, ordinal | `public_scores` | `20261002000100` |
| the actor's public note | `public_notes` | `20260816000100` |
| watched-with companions | `watch_tags` | `20260828…` |
| comment count | `activity_comment_counts` | — |
| reactions and the viewer's own | `reactions` | — |
| the people in a follow story | `follow_activity_people` | `20260912000100` |
| the bookmark control's state | the viewer's own watchlist set | — |

Every one of them is **one call per page**, resolved in a single `Promise.all` in
`hydrate`. A per-row read of any of them is the N+1 the feed's pagination work exists to
prevent, and is a review failure rather than a style preference.

`feed_events.payload` still carries `score`, `bucket` and `position`. It is now a
**fallback**, not the answer: a client whose live read fails — offline, or a bundle newer
than its backend — draws the snapshot rather than a blank badge. Nothing in SQL reads it.

---

## 5. Direct recommendations

| Action | Canonical | Surfaces that must agree |
|---|---|---|
| Send | `title_recommendations (sender, recipient, media_item)` unique per triple, `state = 'delivered'`, optional `note` (`20260929000100`) | recipient's **Sent to you** · the title page's Recommendation card · the unopened dot · the inbox row |
| Resend / update | the same row — the triple is unique, so a second send updates rather than duplicates | as above |
| Open | `opened_at`, set once; the server refuses to move an existing timestamp | Sent to you · the title card · the dot. The **inbox** is deliberately separate: it is marked read all at once by a control the reader presses, and is a record of notices received rather than a mirror of `opened_at` |
| The recipient ranks it | `fulfilled_at` on every outstanding delivered row, once each; the senders the feed would answer get a `recommendation_ranked` notification pointing at the exact event | Sent to you drops it (`withoutRanked`), which is why a ranking invalidates `['sent-to-you', userId]` |
| A **correction** | settles nothing and notifies nobody — `not v_replaced` is false | — |
| The note | read live from the row; never snapshotted | — |

---

## 6. Reactions and comments

No stored counter exists for either, and that is the contract: both are counted from their
rows, per page, through `activity_comment_counts` and a chunked `reactions` read.

| Action | Must change | Must agree |
|---|---|---|
| Add or change a reaction | one `reactions` row per (event, user) | the Feed pill · the reaction detail sheet · the viewer's own selected glyph |
| Remove a reaction | the row goes | as above |
| Add or delete a comment | one `comments` row | the Feed count · the thread · the comment notification |
| The event is deleted | `reactions` and `comments` cascade | which is exactly why a `watchlist_added` event is never deleted |

---

## 7. Known and deferred

| # | Finding | Class | Why it is not fixed here |
|---|---|---|---|
| D1 | An unranked-but-still-logged title keeps a card that says "ranked" (without a score, since `20261002000100`) | P2 | `20260818000100` considered `rank_unrank` and deliberately left it alone: deleting the event would cascade away other people's reactions and comments over a change of mind about an ordering. Fixing it properly needs the founder to choose between deleting the card and re-wording it, which is a product decision |
| D2 | `FeedItem.position` is carried to the client and rendered nowhere | P2 | Harmless, and it now comes from the same live read as the score rather than from a stale snapshot, so it cannot disagree with anything |
| D3 | Two code comments claimed `rankings` is "not readable across users". It has been `can_i_view(user_id)` since `20260813001900` | doc-only | Corrected in place by this tranche |
| D4 | `title_reviews`' comment says "reranking writes a new event" | doc-only | True until `20260826000500`; the behaviour it describes (take the latest event) is still right |

---

## 8. How to run the contract before a release

```
npm run typecheck
npm run lint
npx jest --roots "<rootDir>/src" "<rootDir>/app"
npm run test:db
npm run test:config
npm run test:web
```

The behavioural-invariant suites specifically, and what each one settles:

| Suite | Settles |
|---|---|
| `src/features/collection/ordinal-order.test.ts` | an equal printed score is not a tie; an insertion does not reorder; Movies and TV are independent |
| `src/features/collection/CollectionView.ordinal.test.tsx` | the same, at the rendered list |
| `src/features/collection/LogSheet.test.tsx`, `when-session.test.ts` | every watch-date rule in §2 |
| `supabase/tests/ranking-resume-integrity.test.mjs` | a resumed session cannot contradict an answer it already has, including a 220-step randomised property |
| `supabase/tests/correction-is-not-a-ranking.test.mjs` | every line of §1.2 |
| `supabase/tests/feed-score-is-current.test.mjs` | §4: the score is current, the snapshot is a fallback, and the band is counted under the reader's own visibility |
| `src/features/feed/use-feed.test.ts` | which rows are hydrated, and what a failed read falls back to |
