# CLI: client networking, caching and data propagation (audit, 2026-11-24)

Investigator: CLI. Code at `origin/main` `72a10764` (= `32790c48` + docs), in a disposable worktree. Nothing in the repo was changed. The harnesses ran from a temporary `src/__audit__/` in the worktree, which was then deleted (`git status` clean). Their sources are kept in `scratchpad/audit/client/harness/`, and their raw output is in `scratchpad/audit/client/journeys.json` and `journeys-E.json`.

## Method and evidence labels

- **[local-bench]**: jest with the real screens and hooks, the real `createQueryClient()` (production defaults), and a recording Supabase stand-in (`harness/net.ts`).
  - The stand-in logs every `from`/`rpc`/`functions.invoke`, with its shape (select, filters and args) and the time it was enqueued.
  - Seed data: one film, a series with 2 seasons, 1 follow and 20 `title_ranked` feed events. The collection is empty.
  - **Counts are therefore a lower bound** for a real account. A real account adds mounted Feed rails (`feed-group-previews`/`-reviews`), more title pages on the stack, and so on. On the device, the prior report counted 45 and ~60 refetches per log [edge-log].
- **Depth/waves [local-bench]**: every request answers after a fixed 100 ms with no concurrency cap, so a request's wave is `round(enqueued_ms / 100)`. That is its serial dependency depth.
- **[sim]**: the same harness, with an OkHttp-like FIFO dispatcher in the stand-in. It caps one host at 5 concurrent requests, and every request takes a uniform 165 ms. 165 ms is the device round trip derived in `docs/perf/preview-slowdown-2026-11-24.md` from 637 edge-logged requests (02:08–02:42Z). JS time, payload size and server variance are not modelled. All requests go to one host, which matches Supabase REST, RPC, functions and auth.
- **[static]**: code reading, of the app and of `node_modules`: supabase-js/auth-js/postgrest-js 2.112.3, query-core 5.101.4, RN 0.86.2, expo-image 57.0.2.
- **[calc]**: arithmetic, with the formula shown.

---

## 1. Request dependency graphs

Notation:
- `wN` is serial wave N; a wave is the requests that leave together.
- **Bold** marks the critical path to the first useful interaction.
- *Italic* marks requests that are not critical but share the 5 slots.
- All requests are on the Supabase host unless marked `TMDB`/`expo`.

### 1.1 Cold start and session restore, up to the first Feed render
[static + local-bench + sim]

```
JS start
 └ AuthProvider: supabase.auth.getSession()
     · SecureStore chunked read (count key + N×1536 B chunks, in parallel), mirrored in memory after that
     · if the token is within 90 s of expiry: POST auth/v1/token  ← same host
         → _saveSession awaits the chunked SecureStore write (remove N, write N, write count; 4 s grace cap)
         → only then do getSession and every waiting request resolve
     (no network if the token is fresh)
 w1 **profiles (my-profile)**                       ← routing waits on it (status 'loading')
     stage pref (SecureStore, ≤4 s bound); routing goes to /feed as soon as stage==='done'
 w2 *rankings count, user_media count* (taste check; routing does not wait for it when stage is 'done')
    *report_device_context* (fire and forget; 1,201 ms mean in production [server, prior report])
    *register_device_token* (only after the Expo push token, which is on exp.host, a different host)
 Feed mounts:
 w3 **follows**, *provider_list_cache (Trending), rankings, my_notifications, watchlist, user_media*
 w4 **feed_events** (page of 20)
 w5 **public_scores, public_notes, feed_watch_scores, watch_tags** (hydrate, Promise.all)
 w6 *reactions, activity_comment_counts*   (counts on the cards)
```

- **Feed alone, measured** [local-bench]: 13 requests in 4 serial waves (`journeys.json` → `A.feed`).
- **Time before the first request** [static]:
  - JS bundle evaluation, fonts and the SecureStore read: no network.
  - After an idle hour, add a token RTT plus the chunked SecureStore write. The prior report measured 0.5 s on Android and 0.9 s on iOS from the token to the profile read [edge-log].
  - This is the only phase in which every request waits on one shared thing.
- **Network time** [sim], from auth ready to the last Feed read:

| From auth ready | cap 5 + taste + rdc | cap 5, no rdc | no cap |
|---|---|---|---|
| `follows` starts | 165 ms | 102 ms | 12 ms |
| `feed_events` done | 496 ms | 434 ms | 343 ms |
| scores done | 661 ms | 602 ms | 510 ms |
| last Feed read done | 942 ms | 963 ms | 774–822 ms |

- **Before the first useful interaction**: session → profile → follows → feed_events → hydrate. That is **4 RTTs after the profile**, and 5–6 with a token refresh.

### 1.2 Tab switches
[local-bench]

- Tabs are `expo-router` `Tabs` with defaults: lazy, never unmounted. A tab costs its first-mount requests on its first focus, and nothing on later focuses inside `staleTime`. Warm remounts sent 0 requests (`A.*:warm<60s`).
- First mount, by tab:
  - **Collection**: 5 requests, 1 wave (refine_candidates, rankings, user_media, rankings, ranking_backlog).
  - **Search**: 4 requests, 1 wave (watchlist, rankings ×2, user_media). Search's own reads begin only on typing.
  - **For You**: 14 requests in w0–w1, then the slate (§1.6).
  - **Profile**: **28 requests**. 22 of them leave in one wave (stats, goals, awards, streak, watchlist shelf, lists, follows ×3, recent activity), then the activity hydrate (4) and the counts (2).
    - At cap 5 that is ≈ 6 queue rounds [calc: ceil(28/5) × 165 ms ≈ 1.0 s] before the last header count arrives.
- **Once visited, a tab stays mounted, and so do its queries' observers.** No query is gated on focus: no `subscribed: isFocused` and no `enabled: isFocused` [static, grep].
  - So a mounted but invisible tab refetches on every invalidation that names one of its keys. This is the root of the §4 fan-out.

### 1.3 Title page (movie, series, season), cold and warm
[local-bench; order pinned by `TitleScreen.test.tsx` since #381]

```
w0 (15 at once) **media_items (row)**, **user_media, rankings, watchlist (personal)**, media_cache:credits,
                **community_score**, **following_score**, media_cache:videos, title_review_count,
                *watch_events (count)*, *title_reviews_v2*, *user_media, rankings, watchlist (log-state: same three
                tables, different columns)*, *tmdb-adapter watch-providers (edge, same host)*
w2              *title_recommendations_for_me, media_cache:similar*, (series:) media_items seasons + rankings/user_media
                for the season list
w3              *tmdb-adapter similar* (cold facet), (season:) *tmdb-adapter season-episodes*
```

- Film: 20 requests. Series: 24. Season: 21.
- `tmdb-adapter detail` fired in the harness only because the seed had no credits/videos facet. That is the deliberate videos-facet enrichment; a filled-in title does not send it.
- **Warm cache**:
  - Within 60 s (`staleTime`): 0 requests.
  - Between 60 s and 5 min: it draws from cache and refetches the whole w0 in the background.
  - After 5 min unobserved (`gcTime` default): fully cold.
- **The cap matters here even with nothing else running** [sim, D baseline]:

| Done after the tap | cap 5 | no cap |
|---|---|---|
| Row | 170 ms | 171 ms |
| `community_score` | **335 ms** | 171 ms |
| `title_reviews_v2` | 501 ms | 171 ms |
| Last request | 831 ms | 690 ms |

- The scores are 6th and 7th of 15 in the first wave, so they always take the second round of slots. This matches "scores and counts fill in late" after #378/#381.

### 1.4 Log, first comparison, each comparison, finalize
[static + sim]

```
Log sheet:  log_title ─(answer)→ LogSheet holds invalidateAfterCollectionChange (#378, ≤4 s ceiling)
RankingSheet: **rank_start** (one RPC; the pivot card comes in the answer, cardFor(data, pivot))
            └ rank_start settles → releaseRankingHold() → **~47 refetches leave now** (§4)
Each comparison: **rank_answer** (one RPC; the next pivot card comes in its answer; nothing else is critical)
Placed:     invalidateAfterCollectionChange(category) → ~45 refetches
            + award_unlocks (useNewUnlocks) + rankings (useStreakAdvance) + summary reads (settled standing)
```

- The critical path is one round trip per step. #378 moved the post-log burst from *before* `rank_start` to *right after* it. The burst now contends with the **first `rank_answer`** (§4, finding F-CLI-1).

### 1.5 Season and episode navigation
[local-bench + static]

- A season page shares the title w0. The episode rail comes from `season-episodes`, its own read, cached for an hour, or from the enrichment answer.
- Since #378 a filled-in season does not call `detail`. The episode rail is at w3 in the harness because the seed had no facet. With a seeded cache it is w0/w1 [static].
- `useEnrichOnce` guards once per *mount* (a `useRef`), not once per session. A title whose enrichment answers `enriched:false` is asked again on every visit [static]. In the harness, a warm revisit re-sent `detail` [local-bench]. This is minor (F-CLI-10).

### 1.6 For You
[static + local-bench]

```
w0  rankings ×4 (movies/seasons/shows/backlog), user_media ×2 (watched/logged), recommendation_feedback (dismissed),
    recommendation_engine, recommendation_exposure_within, recommendations_to_me_page, recommendation_requests, watchlist
w1  provider_list_cache (trending fallback), social_candidates
w2  the slate queryFn, gated on six inputs being settled (use-for-you.ts:970):
    media_cache similar (cachedSimilar) ∥ social/collaborative/catalogue_candidates
w3  (cold anchors only) fillAnchors → tmdb-adapter similar ×k (worker pool) → cachedSimilar again
w4  candidatesFor → media_items (the 20 tiles' rows)
w5  poster images on image.tmdb.org (separate OkHttp client, 5 per host, Glide priority 'high' for the first screen since #381)
```

- That is **4–5 serial network waves before the first poster request** [static]. `staleTime` is 30 min, but there is no persistence, so every cold start or OTA reload repeats it.
- The slate itself is the critical path. The 12 w0 requests are inputs to it, so they are critical too, and they take ≥ 3 queue rounds at cap 5 [calc: ceil(12/5)].

### 1.7 Collection open, sort, filter and drag
[static + local-bench]

- **Open**: 5 requests, 1 wave (§1.2). Collections under 1,000 rows are one keyset page (`read-all.ts` stops on a short page).
- **Sort and filter**: client-side over the cached lists. No network [static].
- **Drag to rerank** (`use-rerank.ts`):
  - optimistic `setQueryData` and `cancelQueries` on the category's list → move RPC → `invalidateAfterCollectionChange(category)` (≈45 requests);
  - **then** the queued next move's RPC is sent (`use-rerank.ts:268` invalidates, `:296` sends `next`).
  - A second drag or an Undo inside the burst therefore queues behind it (F-CLI-2).

### 1.8 Search
[static]

- The local pass is debounced 180 ms (`search_titles` + `media_items`). The provider pass is debounced 800 ms (edge function, same host) and is cached for 30 min.
- Superseded keystroke requests are never aborted, because no queryFn passes the AbortSignal (F-CLI-5). The cost is small given the debounce.

### 1.9 Watchlist and Watch History
[static]

- **Watch History**: `watch_events` + `feed_events` for one title, then `title-loggable`.
- **Edits** (date, rewatch, delete): one RPC, then `reconcile = invalidateAfterCollectionChange(…, {})`. That is the full 47-request fan-out (§4).

### 1.10 Notifications to their destination
[static; prior report]

- `my_notifications`: 25 ms production [server, prior].
- Opening a row: `useActivityEvent` reads presentation → event → hydrate. Three serial waves, the same as the prior report. #374 added nothing on the path.

### 1.11 Comments and reactions
[static]

- **Thread**: `activity_comments`, with `staleTime: 0` and `gcTime: 0`, so every open is a fetch. Deliberate (use-comments.ts).
- **Writes**: one RPC, then `['comments', viewer]`, `['comment-counts', viewer]` and awards. Reaction: `['reactions', viewer]`, which hits every mounted reaction query (Feed and Profile). This is narrow and cheap.

### 1.12 Profile and Leaderboard

- **Profile**: see §1.2. It has 28 first-mount requests, and 22 of them are in one wave.
- **Leaderboard** (Feed tab segment): `leaderboard` + `my_leaderboard_standing`, one wave, `staleTime` 60 s, keeping the previous board as placeholder. The `leaderboard` RPC is 113 ms in production vs 33 ms in staging [server, prior]. That cost is server-side, not client.

---

## 2. Android concurrency model
[static, from node_modules]

| Client | Where it is created | Dispatcher | Host | Notes |
|---|---|---|---|---|
| RN `fetch`, so all Supabase REST/RPC/functions/**auth** | `NetworkingModule` → `OkHttpClientProvider.createClient(context)` | its own `Dispatcher()`. Defaults: 64 total, **5 per host**, FIFO. Per-request `client.newBuilder()` shares it | one host | No OkHttp timeouts (connect/read/write 0). The JS 10 s deadline aborts, and `xhr.abort` cancels the call and frees the slot |
| expo-image (Glide) | `ExpoImageOkHttpClientGlideModule` → `OkHttpClientProvider.createClient()` (no context) | a **separate** `Dispatcher()`. Images never consume API slots | image.tmdb.org | Has its own 5-per-host cap. Glide `priority` orders admission only |
| expo-updates | its own native OkHttp | separate | u.expo.dev | `checkAutomatically` default `ON_LOAD`, background |
| PostHog | JS `fetch` | **the RN client's dispatcher**, but a different host | posthog | Shares only the 64 global cap |

- With HTTP/2, the per-host cap still applies, because the Dispatcher enforces it per call, not per connection. Supabase and Cloudflare serve h2, so the five slots are a client-side limit with no server-side reason.

**Journeys that exceed 5 concurrent requests to the Supabase host at their first burst** [local-bench counts]:

| Journey | First burst | Rounds at cap 5 [calc ceil(n/5)] |
|---|---|---|
| Post-log refresh (released at `rank_start`) | 47 | ≥10 (sim: drains at 1.8 s) |
| Finalize, rerank, note edit, history edit | 45–47 | ≥9–10 |
| Watchlist toggle, from the title page | 29 | ≥6 |
| Profile tab first mount | 22 (28 total) | ≥5 |
| Title page w0 | 15 | 3 |
| For You w0 | 12 | 3 |
| Startup (taste 2 + rdc + Feed w1 6) | 9 | 2 |
| Feed w1 alone | 6 | 2 |
| Collection, Search | 4–5 | 1 |

---

## 3. TanStack Query architecture
[static unless marked]

**Defaults** (`src/lib/query.ts`):

| Option | Value |
|---|---|
| `staleTime` | 60 s |
| `gcTime` | 5 min (default; 30 min for the provider-search keys) |
| `retry` | 2 (default backoff 1 s, 2 s) |
| `refetchOnWindowFocus` | false |
| `refetchOnMount` | true (default) |
| `refetchOnReconnect` | true, but **inert** (below) |
| mutations `retry` | 0 |

- **Focus**: `focusManager` is wired to AppState (`startQueryFocusTracking`). Only these queries opt in to focus refetch:
  - notifications (`staleTime` 30 s);
  - Trending (30 min);
  - `community-score`, once per mounted title page, and a stack can hold several.
- **`onlineManager` is not wired** (no NetInfo anywhere; grep). TanStack's default listens for `window` online events, which never fire in RN. So:
  - `refetchOnReconnect: true` never fires;
  - queries are never paused offline (`networkMode: 'online'` always believes it is online).
  - An offline open therefore runs every query through its full retry ladder (§7).
- **Persistence: none.** No persister, and nothing in SQLite. The comment in `query.ts` ("render from SQLite") describes something that does not exist.
  - Every cold start, process death or **OTA foreground reload** (`updates.ts` `reloadAsync` on the next safe foreground return after a download) starts from an empty cache.
- **Key ownership**: the keys are centralised in `queryKeys` with commentary. The account id is in every per-user key.
  - Not keyed by account: `title`, `list`, `comparisonCard`, `search`, `trending`. These rely on `queryClient.clear()` on `SIGNED_OUT` and on local sign-out (`session.tsx:218, 238`).
- **The same data under different keys** [local-bench]:
  - The title page reads `user_media`, `rankings` and `watchlist` for one title **twice**, with different column lists: `['title', id, 'personal', user]` and `['log-state', user, id]`. That is 3 of the 15 w0 requests.
  - `rankings` is read under ≥5 keys with different shapes: per-category lists, `my-scores`, bands, the taste check, the streak and profile counts. These are not exact duplicates, but merge candidates.
  - `['notifications', viewer]` is shared by two hooks with the **same** queryFn. Fine.
- **Duplicate fetches across mounted tabs**:
  - At first mount of all tabs plus a title, there were 66 requests and no exact duplicates other than the hydrate shared by Feed and Profile → Recent activity. That one is a seed artefact: both read the same seeded rows.
  - **During invalidation there are real duplicates** (F-CLI-4).
- **Cancellation on unmount: effectively none.** **No queryFn passes TanStack's `signal`** to `.abortSignal()`. Grep: 0 uses across the 99 files with `useQuery`/`useInfiniteQuery`.
  - Unmounting, cancelling, or a `cancelRefetch` re-invalidation never aborts the wire request. On Android, an obsolete request keeps its slot until it answers (F-CLI-5).

---

## 4. Mutation fan-out (most important)

### 4.1 Measured: everything mounted (5 tabs + one title page)
[local-bench, `journeys.json` → `B`]

| Helper (caller) | Queries refetched | Requests | Exact duplicate requests |
|---|---|---|---|
| `invalidateAfterCollectionChange(…, {category})` (finalize, rerank, drag) | 22 | **45** | `watch_events` ×2, `watch_goals` ×2 |
| `invalidateAfterCollectionChange(…, {})` (LogSheet post-log, note edit, history edit, failed-unknown) | 24 | **47** | same |
| `invalidateAfterWatchlistChange` (bookmark on Feed, For You, person) | 6 | 22 | — |
| Title-page bookmark (`[id].tsx:1578`: helper + `title(id)` + `collection(user)`) | 10 | 29 | `watchlist` ×2 |

Keys refetched by `invalidateAfterCollectionChange` (category given):
- **Collection and rankings**: `rankings/movies`, `collection/watchlist`, `collection`, `my-scores`, `ranking-backlog`, `refine-availability`.
- **Profile**: `profile-stats`, `profile-watchlist`, `goals` (twice, see F-CLI-4), `actor-activity` (+ hydrate 4 + counts 2), `awards`.
- **Title**: `title` + `title/personal`, `watch-count`, `title-reviews`, `title-review-count`, `community-score`.
- **Feed and inbox**: `feed` (+ hydrate 4 + counts 2), `watched`, `notifications`, `sent-to-you`.
- **Not measured, because the seed had no rails or extra screens**: `feed-group-previews`/`-reviews` (one per mounted rail), `top-rated`, `group-picks`, `taste-match` (per visited profile), `people-taste-matches`, `profile-notes`, `activity-event`, `title-reviews` second sort, `community-score` for other cached titles (prefix over *all* of the reader's titles, refetching every mounted one).
- A real account therefore exceeds 45. The device showed 45 and ~60 [edge-log, prior].

**A ranking costs two full fan-outs** [static]:
1. The held post-log refresh (47), released at `rank_start`.
2. The finalize refresh (45), seconds later, over almost the same keys.

That is **~92 requests per ranking**. The first is superseded by the second whenever the session places.

### 4.2 What the burst does to the next critical request
[sim, cap 5, 165 ms]

**C. `rank_answer` sent after the released post-log refresh** (that is the first comparison answer):

| Answer tapped after `rank_start` settles | cap 5: `rank_answer` RTT | no cap |
|---|---|---|
| 0 ms | **1,195 ms** | 218 ms |
| 500 ms | **694 ms** | 166 ms |
| 1,000 ms | **345 ms** | 166 ms |
| 2,000 ms | 166 ms | 166 ms |

The burst of 47 drains at ≈1.8 s at cap 5, vs ≈0.6 s with no cap.

**D. Finalize, then open a title from the summary 400 ms later**:

| Done after the tap | cap 5 + finalize burst | cap 5, no burst | no cap + burst |
|---|---|---|---|
| Title row | **963 ms** | 170 ms | 173 ms |
| `community_score` | **1,129 ms** | 335 ms | 173 ms |
| `title_reviews_v2` | 1,344 ms | 501 ms | 174 ms |
| Last title request | 2,058 ms | 831 ms | 710 ms |

**Rerank and drag** follow the same pattern as C, with 45 requests: a queued second move or an Undo sent within ~1 s of the first waits ≈0.35–1.2 s [sim proxy]. **Watchlist from the title page** sends 29 requests, ≈6 rounds [calc 29/5 × 165 ≈ 1.0 s], so the next screen opened within a second inherits a queue.

### 4.3 Per mutation: server write → invalidation → what refetches
[static + local-bench]

| Mutation | Server write | Client propagation | Mounted refetches (lower bound) | Contends with |
|---|---|---|---|---|
| Log a new title | `log_title` | held, then `invalidateAfterCollectionChange({})` at `rank_start` | 24 queries / 47 req | the **first `rank_answer`** |
| Ranking finalize (start, again, rebucket) | `rank_answer` → `_rank_finalize` | `invalidateAfterCollectionChange({category})` + unlocks + streak | 22 / 45 + 2 + summary | the summary's standing reads, the **next title opened** |
| Update a ranking (title "Rank again") | `rank_again` … | as finalize | 22 / 45 | as finalize |
| Collection drag, promote, Undo | move/promote RPC | optimistic `setQueryData` → `invalidateAfterCollectionChange({category})` per move | 22 / 45 **per move** | the **queued next move or Undo** |
| Rewatch, watch date, delete viewing | `log_rewatch*`, `set_watch_date`, `edit_/delete_watch_event` | `reconcile` = `invalidateAfterCollectionChange({})` | 24 / 47 | going back to the title page |
| Watchlist add/remove | `set_watchlist` | `invalidateAfterWatchlistChange` (title page also: `title`, `collection`) | 6 / 22 (title page 10 / 29) | the next navigation |
| Edit a review or note | `save_note` | `invalidateAfterCollectionChange({})` | 24 / 47 | the Reviews tab refetch the user is waiting for |
| Comment | `add/edit/delete_comment` | `comments`, `comment-counts`, awards (by viewer prefix) | thread + counts + awards (small) | — |
| Reaction | `set_reaction` | `['reactions', viewer]` | every mounted reaction query | — |

### 4.4 Classifying each key in `invalidateAfterCollectionChange`

Two questions per key: is it essential *now*, or can it be deferred until it is visible? And what protected behaviour does it support?

The visible surfaces are:
- **during a ranking**: the ranking sheet;
- **after placement**: the summary, then the title page or Collection behind it;
- **during a note edit**: the title page.

| Key(s) | Supports | Visible during/just after the write? | Class |
|---|---|---|---|
| `rankings/<category>`, `collection`, `collection/watchlist`, `my-scores` | no stale cross-screen state; ranking I1–I7 shown correctly; precedence (a ranked title leaves the watchlist) | Collection behind the sheet; Search badge | **Essential**, once per ranking (finalize). The LogSheet's earlier copy is redundant when the session places |
| `title`, `title/personal`, `log-state`, `watch-count`, `watch-history` | the title page under the sheet reflects the write | yes, the page behind the sheet | **Essential** |
| `community-score` (this title) | own rating in the aggregate | yes, the title page | Essential for this title. The *prefix over all cached titles* is deferrable (only mounted ones refetch, and the others are just marked stale) |
| `title-reviews`, `title-review-count`, `profile-notes` | review edits are visible (founder findings 08-28, 09-25) | Reviews tab, for a note edit only | Essential **for `save_note`**. Deferrable for a ranking, which only moves the author's live score on the row |
| `feed`, `actor-activity`, `feed-group-previews/-reviews`, `activity-event` | Feed shows the new activity; award revocation removes posts | not visible (other tab) | **Deferrable to tab focus** |
| `notifications`, `sent-to-you` | the Rank CTA disappears; a ranked title leaves Sent to You | not visible | Deferrable to focus |
| `profile-stats`, `profile-watchlist`, `goals`, `awards`, `weekly-streak` | counts, goals, awards (revocation) | not visible (the summary's celebration uses its own `award_unlocks` read) | Deferrable to focus |
| `ranking-backlog`, `refine-availability` | backlog, Refine card | Collection only | Deferrable to focus |
| `watched` (spoiler set) | spoilers unmask after watching | the Feed only | Deferrable to Feed focus. It must refetch before Feed paints, or a spoiler stays masked; masking errs on the safe side |
| `top-rated`, `group-picks`, `onboarding-starter-movies`, `taste-match`, `people-taste-matches` | aggregates and matches move | not visible | Deferrable |

- **Account isolation is not touched** by any of these. Every key is under the writer's own `userId` prefix. Deferral changes *when*, not *whose*.
- **Is the #378 pattern elsewhere?** Yes:
  - **finalize** contends with the summary and the next title;
  - **drag** contends with the next move or Undo (the fan-out is fired *before* the queued RPC);
  - **watchlist from the title page** contends with the next screen;
  - a **note edit** refetches 47 to show one changed review.
  - #378 fixed only the log → `rank_start` instance, by moving the burst later, to the first comparison.

---

## 5. Startup and auth
[static, plus prior edge-log]

- **Session restore** (`session-storage.ts`):
  - chunked SecureStore, 1,536-byte chunks, the count key read first and the chunks in parallel;
  - serialised per key;
  - an in-memory mirror after the first read.
  - auth-js 2.112 uses **no lock by default** (`this.lock = null`; the lockless `getSession` path), so there is no lock queue. **Refuted:** lock contention.
  - Every `fetchWithAuth` awaits `getSession()`, and that is answered from the mirror unless the token is within 90 s (`EXPIRY_MARGIN_MS`).
- **The shared bottleneck is the refresh.** When the token is inside the margin, every concurrent `getSession` calls `_callRefreshToken`, which deduplicates on `refreshingDeferred`.
  - That deferred resolves only **after `_saveSession` awaits the chunked SecureStore write** (remove N, write N, write count; up to the 4 s grace).
  - This happens on a cold start after idle (prior: 0.5 s Android, 0.9 s iOS [edge-log]). It also happens **about once an hour during active use**: the auto-refresh tick refreshes inside the same 90 s margin, and any request issued during it waits for refresh plus write [static; not measured in session].
- **Visibility gap in Diagnostics** [static]:
  - `requestWithDeadline`, so both the recorder and the 10 s deadline, is called **after** `fetchWithAuth`'s `getSession` wait. The comment at `supabase.ts:233` ("Opened before the token wait") is stale; `flight-recorder.ts:37` documents the correction.
  - Consequently, a Diagnostics `rest:`/`rpc:` record's start **excludes** the session wait and **includes** the Android OkHttp queue wait. That matters when reading the founder's device rings.
- **Profile, then Feed**: profile (routing waits on it) → Feed's follows → feed_events → hydrate. Four RTTs of network after the session (§1.1).
- **`report_device_context`**: fires on `ready`, in the same frame as the Feed mount. It holds one of the five slots for its duration (1.2 s mean in production [server, prior]).
  - Sim: moving it out of the startup burst brings `follows` forward ~60 ms (102 vs 165 ms). The `feed_events` gain is the same ~60 ms. Small (F-CLI-8).
- **OTA**:
  - `fallbackToCacheTimeout: 0`, `checkAutomatically` default (ON_LOAD, native background, own client): not blocking. This confirms the prior refutation.
  - The **foreground path** (`updates.ts`) checks and downloads on every background → active return. It then calls `reloadAsync()` when it is safe: status `ready`, not in auth or onboarding.
  - A reload empties the in-memory cache, and there is no persistence, so the next view is a full cold start.
  - On Preview this happens after each publish (prior); on Production after each OTA.

---

## 6. Caching proposals, with their guarantees

| Proposal | Benefit | Freshness guarantee | Account isolation guarantee | Protected behaviour at risk |
|---|---|---|---|---|
| **Persisted query cache**, via `expo-sqlite/kv-store`: the native module is already in the binary, so this is JS-only. An allowlist only: `feed`, `rankings`, `collection`, `my-profile`, `for-you`, `trending`, `title` rows | Cold start, OTA reload and process death draw the last Feed, Collection and For You at once; For You's 4–5 waves are hidden behind cached tiles | Restored entries are treated as stale (`staleTime` 0 on hydrate, `maxAge` ≤ 24 h), so the first burst reconciles them within ~1 s. A write made on another device is visible for at most that long | The persisted blob is **keyed by the account id** (`buster` = userId + runtime). It is deleted on `SIGNED_OUT` *and* on `onLocalSignOut`, before `queryClient.clear()`, and is not restored until `getSession` names the same user | **Privacy**: `log-state`, `watch-history`, `goals` and private notes are owner-only (PRD §22) and must be excluded, or stored encrypted. kv-store is not Keychain. Session restore ordering. Medium disruption |
| **Per-query `staleTime`**: catalogue keys (`title` row, `credits`, `videos`, `seasons`) at hours; personal keys stay at 60 s + invalidation | Removes the 60 s–5 min revalidation of a revisited title (≈17 requests) | Catalogue metadata can be stale by up to the new `staleTime` unless enrichment invalidates, which it does (`useEnrichOnce` invalidates `title`/`credits`/`videos`/`seasons`) | Unchanged. The catalogue keys are not per-user, and the cache is still cleared on sign-out | Admin catalogue fixes appear later. Low |
| **`placeholderData` from list caches**: a title header from the Feed, Collection or For You row (title, poster, year, kind) | The header draws instantly on the first visit | A placeholder is never written to the cache. It is replaced by the row within 1 RTT. `isPlaceholderData` must gate any action derived from personal state (Rank, bucket) | Placeholders are drawn only from the same `QueryClient`, so from the same account's caches, which are cleared on sign-out | Wrong kind or parent routing if a list row's shape differs. Low |
| **Prefetch on press-in** (`onPressIn` → `prefetchQuery` for the row + personal + both scores) | ~80–150 ms head start (press-in to navigation) on the 4 critical reads | The same keys and queryFns, so the same freshness | Same as the normal fetch | Adds requests to the Android queue. It must prefetch only the critical 3–4, or it worsens §4. Low |
| **Defer non-critical invalidations**: the "deferrable" rows of §4.4. Either `refetchType: 'none'` + refetch-on-focus, or `subscribed: isFocused` on tab observers (supported by query 5.101) | Removes ~30 of 45–47 requests from the moment the next critical request leaves | A deferred surface is marked stale immediately and refetches when it becomes visible. It may show the pre-write value for ≤1 RTT on return, as stale-while-revalidate. Drop to "essential" any surface where that is unacceptable, e.g. `watched` before the Feed paints | Unchanged: every key stays under the writer's own userId; only the timing moves | "No stale cross-screen state after successful writes" weakens from *immediately* to *on view, within 1 RTT*; the founder has to accept that. Award revocation posts linger until the Feed is viewed. Medium |

---

## 7. Reliability-adjacent

- **Retries are nested** [static]:
  - postgrest-js 2.112 retries **GET and HEAD** (every `from()` read; not RPCs, which are POST) up to **3 times on any non-abort fetch rejection** and on 503/520, after 1 s, 2 s and 4 s.
  - TanStack retries each query twice (1 s, 2 s) on top of that.
  - **An offline GET query therefore makes 12 HTTP attempts and takes ≈24 s before it errors** [calc: (1+2+4) + 1 + (1+2+4) + 2 + (1+2+4) = 24 s]. An RPC makes 3 attempts.
  - With no `onlineManager`, nothing pauses them, so an offline open of the Feed (13 queries, 8 of them GET) ≈ 8×12 + 5×3 = 111 attempts [calc]. They are cheap while offline, but they all fire as the link returns. That is a **retry storm on a flaky link**, competing with the reader's fresh requests (F-CLI-6).
- **Hanging requests**:
  - The 10 s `requestWithDeadline` bounds every request. Its abort surfaces as `AbortError`, which postgrest does not retry.
  - TanStack still retries: worst case 10 + 1 + 10 + 2 + 10 = **33 s** before an error state [calc].
  - At cap 5, five hung requests stall **the whole host** for 10 s.
  - The deadline does **not** cover the `getSession` or refresh wait. The `/token` request itself is covered; the 8 s hydration grace and the 4 s store-write grace bound the rest.
- **Unbounded refetch loops: none found.**
  - `refetchInterval` appears only in `use-engine` (30 min) and `use-person` (a claim poll that stops on error or answer).
  - Focus refetch is limited to three keys, and staleness-gated.
- **`useEnrichOnce`**: per-mount, so it is bounded per visit, not per session. The Where to Watch query has `retry: false` and `retryOnMount: false` (#381).
- **Cancellation**: no queryFn uses the AbortSignal (F-CLI-5). So `cancelRefetch` re-invalidations, unmounts and superseded searches leave wire requests in their slots.

---

## Findings

### F-CLI-1: the post-log refresh, held since #378, now lands on the first comparison answer, and a ranking costs two full fan-outs

- **Journey**: log → rank → first comparison.
- **Root cause**:
  - `releaseRankingHold` runs `invalidateAfterCollectionChange({})` when `rank_start` settles. That is 24 queries and 47 requests [local-bench].
  - The reader's first `rank_answer` is sent while those requests occupy the five Android slots.
  - When the session places, finalize re-invalidates almost the same set (45 requests). The first refresh is redundant whenever the ranking completes.
- **Evidence**:
  - [local-bench] the counts above.
  - [sim] cap 5 / 165 ms: the first `rank_answer` RTT is 1,195 ms when tapped at once, 694 ms at +0.5 s, 345 ms at +1 s and 166 ms at +2 s. With no cap: 166–218 ms.
  - [static] `RankingSheet.tsx:892` (`.finally(releaseRankingHold)`), `LogSheet.tsx:1103`.
  - [device] the founder reports "near-instant" ranking after #378. This is consistent if the first tap usually comes more than 1.5 s after the comparison is shown. That interval is unmeasured.
- **Confidence**: Strongly supported (mechanism confirmed; frequency on device unmeasured).
- **Impact**: M, for a reader who taps quickly. The second comparison is "sometimes slow".
- **Remedy**: drop the held refresh when the session reaches `placed`, since finalize's fan-out supersedes it. Run it only if the sheet ends without placing (cancel, back, failure), or at the 4 s ceiling only if no session opened.
- **Lower-risk alternative**: release the hold on `placed`/unmount instead of on `rank_start`. The refresh then runs once, after the comparisons, and is still exactly the same refresh.
- **Disruption risk**: L.
- **Effort**: small.
- **Verification**: Diagnostics ring: `rpc:rank_answer` start→end with no `rest:` burst before it. Plus `open-first.test.ts` and `RankingSheet` tests: the refresh runs exactly once on cancel, failure and placed.
- **Invariants touched**: no stale cross-screen state after a successful write, because finalize covers placed; the cancel and failed paths must still refresh. Ranking I1–I7 are untouched (read-only).
- **Class**: A.

### F-CLI-2: every collection write fires the broad fan-out before or alongside the next critical request (finalize, drag/Undo, note edit, history edit)

- **Journey**: ranking summary → next title; Collection drag → second drag or Undo; note edit; Watch History edits.
- **Root cause**:
  - `invalidateAfterCollectionChange` invalidates ~35 prefixes. Every mounted observer in every visited tab refetches, because no query is focus-gated. That is 45–47 requests, and more with real data.
  - In `use-rerank.ts` the burst is fired (`:268`) *before* the queued next move is sent (`:296`).
- **Evidence**:
  - [local-bench] 22 and 24 queries; 45 and 47 requests.
  - [sim] title row 963 vs 170 ms, `community_score` 1,129 vs 335 ms when a title is opened 400 ms after finalize. The drag-queue proxy is as F-CLI-1: 0.35–1.2 s.
  - [edge-log, prior] device bursts of 45 and ~60 at ≈30/s (5 slots ÷ 165 ms).
- **Confidence**: Confirmed (mechanism and counts) / Strongly supported (device impact on these paths was not logged separately).
- **Impact**: M–H. It hits the moment right after every write, which is the founder's "occasional sub-second delays" and "metadata fills in late after ranking".
- **Remedy**: split the helper into *essential-now* (§4.4: category rankings, collection, title and personal, log-state, watch count and history, this title's community score, my-scores) and *deferred* (everything else, marked stale without refetching active observers, `refetchType: 'none'`, and refetched on tab focus). Or gate tab observers with `subscribed: isFocused`.
  - In `use-rerank`, send the queued move before firing the invalidation, and fire one invalidation after the queue drains.
- **Lower-risk alternative**: keep every key, but fire the deferred set after the next screen's critical reads (e.g. on `InteractionManager`/idle, or 1.5 s later). Order the essential set first, since the queue is FIFO.
- **Disruption risk**: M. The "no stale cross-screen state" guarantee becomes "on view within 1 RTT" for deferred keys.
- **Effort**: moderate.
- **Verification**: the QueryClient fan-out harness (`harness/journeys.test.tsx` B) asserts the request count per helper. The existing `invalidate.test.ts` key coverage must still pass, with deferred keys asserted stale. Device: Diagnostics after finalize → title.
- **Invariants touched**: no stale cross-screen state after writes; award revocation removes the feed post; spoiler unmasking (`watched`). Account isolation is unchanged (keys stay userId-scoped).
- **Class**: B.

### F-CLI-3: Android's 5-per-host dispatcher serialises every burst on the single Supabase host

- **Journey**: all.
- **Root cause**:
  - RN's `NetworkingModule` client has OkHttp's default Dispatcher, which allows 5 per host. REST, RPC, functions and auth all share one host.
  - Images use a *separate* client (expo-image `createClient()`), so they do not contend. **This refutes** the idea that images steal API slots.
- **Evidence**:
  - [static] `OkHttpClientProvider.kt`, `NetworkingModule.kt:135`, `ExpoImageOkHttpClientGlideModule.kt`.
  - [sim] the title page alone at cap 5: `community_score` 335 vs 171 ms, last request 831 vs 690 ms. Under the bursts: F-CLI-1 and F-CLI-2.
  - [edge-log, prior] ≈30 req/s ceiling.
- **Confidence**: Confirmed.
- **Impact**: H. It amplifies every finding here.
- **Remedy**: a config plugin installing an `OkHttpClientFactory` with `dispatcher.maxRequestsPerHost` of ~16 (prior P2). This is native: it changes the fingerprint and needs a new binary.
- **Lower-risk alternative**: JS-only request hygiene (F-CLI-1, 2, 4, 5, 7) to keep first bursts at or under 5 critical requests.
- **Disruption risk**: M (needs a build).
- **Effort**: structural-native.
- **Verification**: rerun the sims at cap 16. On device, Diagnostics on the title page: both scores end within 1 RTT of the row.
- **Invariants touched**: none (transport only). Watch server concurrency on production Nano.
- **Class**: B.

### F-CLI-4: duplicate wire requests inside one invalidation (`goals` twice; title-page bookmark reads the watchlist twice)

- **Root cause**:
  - `invalidateAfterCollectionChange` invalidates `['goals', userId]` twice (`invalidate.ts:122` and `:307`).
  - `invalidateQueries` defaults to `cancelRefetch: true`, so the second call cancels the first fetch and starts another. The first is not aborted on the wire (F-CLI-5).
  - The title-page bookmark calls `invalidateAfterWatchlistChange` (`['collection', u, 'watchlist']`) and then `['collection', u]`, which re-matches the same query.
- **Evidence**: [local-bench] `watch_events` ×2 and `watch_goals` ×2 per collection change; `watchlist` ×2 per title-page bookmark.
- **Confidence**: Confirmed.
- **Impact**: L (2–3 extra requests per write, all in the burst).
- **Remedy**: delete the second `goals` line. In the title-page path, drop the redundant prefix or use `cancelRefetch: false`.
- **Lower-risk alternative**: `cancelRefetch: false` inside the helper.
- **Disruption risk**: L.
- **Effort**: small.
- **Verification**: the harness duplicate list is empty; `invalidate.test.ts` still passes.
- **Invariants touched**: goals progress freshness (unchanged).
- **Class**: D.

### F-CLI-5: no query is cancellable on the wire, because no queryFn passes TanStack's AbortSignal

- **Root cause**: 0 of 99 query files call `.abortSignal(signal)`. Unmounts, `cancelQueries`, `cancelRefetch` and superseded searches leave the request in flight, holding an Android slot until it answers.
- **Evidence**: [static] grep. [local-bench] the F-CLI-4 duplicates are its visible symptom.
- **Confidence**: Confirmed.
- **Impact**: L–M. It matters most when backing out of a title page mid-load, and for rapid search.
- **Remedy**: thread `signal` through the shared query helpers (`supabase.from(...).abortSignal(signal)`; RPC builders support it too).
- **Lower-risk alternative**: do it only for the title page, search and the Feed hydrate.
- **Disruption risk**: L–M. Aborted writes must never be affected; this applies to reads only.
- **Effort**: moderate (many call sites).
- **Verification**: a harness counts in-flight requests after an unmount.
- **Invariants touched**: none for reads. Do not add it to mutation RPCs (idempotency and outcome-unknown handling).
- **Class**: D.

### F-CLI-6: no `onlineManager`, so `refetchOnReconnect` is inert and offline queries burn nested retries

- **Root cause**:
  - React Query's default online detection needs `window` events, and none is wired (no NetInfo).
  - postgrest-js retries GETs 3 times on network errors, and TanStack retries twice on top.
- **Evidence**: [static] `query.ts`, `postgrest-js dist/index.mjs:3-27, 352-389`. [calc] 12 attempts and ≈24 s per offline GET; ≈111 attempts for an offline Feed open.
- **Confidence**: Confirmed (mechanism).
- **Impact**: M on flaky mobile links: a storm on recovery, and a slow error state.
- **Remedy**: wire `onlineManager` to an online signal. `expo-network` and NetInfo are **not** in the dependencies, so either one is a native addition (new build); a JS-only fallback is AppState plus a failed-fetch heuristic. Also set `retry: false` on the PostgREST client (`db: { retry: false }`) and let TanStack own retries, or the reverse.
- **Lower-risk alternative**: only disable postgrest-js retries, which keeps TanStack's.
- **Disruption risk**: L.
- **Effort**: small.
- **Verification**: a unit test of attempt counts with a rejecting fetch.
- **Invariants touched**: the offline outbox semantics (`offline-sync.md`). Mutations are unaffected (`retry: 0`, POST).
- **Class**: A for the retry dedup; D for `onlineManager`.

### F-CLI-7: the title page sends 15 requests in its first wave, including two personal reads of the same three tables

- **Root cause**:
  - `['title', id, 'personal', user]` and `['log-state', user, id]` each read `user_media`, `rankings` and `watchlist` for the same title, with different columns.
  - The non-visible-above-the-fold reads (`watch_events` count, reviews, log-state, Where to Watch) share the first wave. At cap 5, the scores land in the second round.
- **Evidence**:
  - [local-bench] the title w0 list (§1.3).
  - [sim] `community_score` 335 vs 171 ms, reviews 501 vs 171 ms.
  - [device] the founder: "metadata, scores and counts still fill in late".
- **Confidence**: Strongly supported.
- **Impact**: M.
- **Remedy**: serve log-state from the personal query (one key, `select` superset), or delay log-state until the sheet opens. Delay the Reviews-tab and watch-count reads one wave, or until the row is back.
- **Lower-risk alternative**: delay log-state's read until the Log sheet is opened. It has `staleTime: 0` anyway (`use-log-state.ts`).
- **Disruption risk**: L–M. The LogSheet's open state must still be correct; the key's comment records why it is separate.
- **Effort**: small–moderate.
- **Verification**: the `TitleScreen.test.tsx` order assertions; Diagnostics.
- **Invariants touched**: private-note isolation (log-state is account-keyed and must stay so).
- **Class**: A.

### F-CLI-8: launch-time non-critical requests share the Feed's first wave

- **Root cause**: the taste check (2), `report_device_context` (1.2 s mean in production) and `register_device_token` leave as the Feed mounts. The Feed's `follows` is third of its own six.
- **Evidence**: [sim] `follows` starts at 165 vs 102 ms; `feed_events` is done at 496 vs 434 ms (cap 5, rdc 1.2 s vs none).
- **Confidence**: Strongly supported; the effect is small.
- **Impact**: L.
- **Remedy**: send `report_device_context` and push registration after the first Feed page settles, or on idle. Have the Feed send `follows` first.
- **Lower-risk alternative**: delay `report_device_context` only.
- **Disruption risk**: L.
- **Effort**: small.
- **Verification**: the startup harness E.
- **Invariants touched**: proactive and notification timezone correctness (it is reported a second or so later).
- **Class**: D.

### F-CLI-9: the session refresh is a shared stall, at cold start after idle and about hourly in use

- **Root cause**: when the token is within 90 s of expiry, every request awaits `_callRefreshToken`, which resolves only after the chunked SecureStore write.
- **Evidence**: [static] auth-js `__loadSession`, `_callRefreshToken`, `session-storage.ts`. [edge-log, prior] 0.5 s (Android) / 0.9 s (iOS) token → profile.
- **Confidence**: Confirmed (prior P2; the in-session hourly case is [static] only).
- **Impact**: M at launch, L in session.
- **Remedy**: as prior P2: let the mirror answer `getSession` as soon as the refresh returns, with the disk write settling behind it.
- **Lower-risk alternative**: none safer. The auth path is sensitive.
- **Disruption risk**: M.
- **Effort**: moderate.
- **Verification**: `session-storage*.test.ts` plus a token-refresh launch on device.
- **Invariants touched**: session restore after a crash mid-write; sign-out precedence.
- **Class**: B.

### F-CLI-10: `useEnrichOnce` guards per mount, not per session

- **Root cause**: a `useRef` set inside the component. A title whose enrichment answers `enriched:false`, or whose facet never lands, re-calls `detail` (an edge function plus a TMDB charge) on every visit.
- **Evidence**: [static] `use-enrichment.ts:75`. [local-bench] the warm revisit re-sent `detail` with the facet absent.
- **Confidence**: Hypothesis (frequency on real data unknown).
- **Impact**: L.
- **Remedy**: a module-level, per-session `Set` of attempted ids, cleared on sign-out.
- **Disruption risk**: L.
- **Effort**: small.
- **Class**: D.

### F-CLI-11: no persisted cache, plus the OTA foreground reload, so every cold start and every update shows empty screens

- **Root cause**:
  - The cache is in memory only.
  - `updates.ts` reloads on the next safe foreground return after a download.
  - For You needs 4–5 serial waves before its first poster.
- **Evidence**: [static]. [edge-log, prior] repeated relaunches 10 s apart on Preview.
- **Confidence**: Confirmed (mechanism).
- **Impact**: H for perceived startup and For You placeholders.
- **Remedy**: the allowlisted persisted cache in §6, with its guarantees (account-keyed buster, deleted on both sign-out paths, private keys excluded, restored as stale).
- **Lower-risk alternative**: persist only the For You slate inputs and Trending, keyed by account.
- **Disruption risk**: M.
- **Effort**: moderate.
- **Verification**: two-account sign-out/sign-in tests (`sign-out-safety.test.tsx`-style), plus cold-start timing on device.
- **Invariants touched**: no cross-account cache leakage; privacy of notes and dates (PRD §22).
- **Class**: B.

---

## Refuted hypotheses

- **Images compete with API requests for OkHttp slots.** Refuted. expo-image builds its own `OkHttpClient` (a separate Dispatcher) on a different host [static].
- **auth-js lock contention: every request queues on a lock.** Refuted. 2.112's default lock is `null` (lockless path), and storage reads are served from the in-memory mirror. Only the refresh deferred is shared (F-CLI-9) [static].
- **A per-request SecureStore read.** Refuted (the mirror) [static].
- **Deadline aborts are retried by postgrest.** Refuted. An abort surfaces as `DOMException AbortError` (whatwg-fetch 3.6.20), which postgrest rethrows. TanStack still retries [static].
- **Collection sort and filter hit the network.** Refuted (client-side) [static].
- **Keyset paging always costs an extra empty page.** Refuted (it stops on a short page) [static].
- **Unbounded refetch loops or polling.** Refuted. Only the 30-min engine interval and the bounded person-claim poll exist [static].
- **expo-updates blocks launch.** Refuted (as before): `fallbackToCacheTimeout: 0`, background ON_LOAD [static].
- **Duplicate fetches across mounted tabs at first mount.** Largely refuted. There are no exact duplicates beyond a seed artefact. The real duplicates occur during invalidation (F-CLI-4) and across keys with different shapes (F-CLI-7) [local-bench].

## Evidence gaps (and the smallest follow-up)

1. **Time from a comparison being shown to the first tap**, on device. It decides how often F-CLI-1 bites. Follow-up: the Diagnostics ring after one ranking; read `rpc:rank_start` end to `rpc:rank_answer` start, and the `rest:` records between them.
2. **Real mounted-query counts with the founder's data** (Feed rails, several title pages on the stack, visited profiles). The harness is a lower bound. Follow-up: one staging edge-log window after a finalize on the founder's device, counting requests in the 2 s after `rank_answer`.
3. **The device RTT assumption** (165 ms, one session in the prior report) and JS-thread time, neither modelled in [sim]. Follow-up: Diagnostics timings for one title open on Wi-Fi and on cellular.
4. **The in-session hourly refresh stall** (F-CLI-9) has not been observed. Follow-up: Diagnostics `auth` notes plus request starts around a `TOKEN_REFRESHED` while browsing.
5. **The For You slate graph with real anchors** (the harness skipped the slate on an empty collection). Follow-up: extend `harness/journeys.test.tsx` with a seeded ranked collection, or take a staging edge-log window of the founder's For You cold open.
6. **iOS (NSURLSession) per-host concurrency** was not examined; the default is `HTTPMaximumConnectionsPerHost` 4 on HTTP/1.1, and h2 multiplexes. The prior report's iOS "no cap" assumption is unverified for RN's session config. Follow-up: read `RCTHTTPRequestHandler` in node_modules.

## Harness inventory (scratchpad only, never committed)

- `audit/client/harness/net.ts`: the recording Supabase stand-in, with an optional FIFO cap and latency.
- `audit/client/harness/mocks.ts`: router and auth mocks.
- `audit/client/harness/journeys.test.tsx`: scenarios A (graphs), B (fan-out), C (`rank_answer` sim), D (finalize → title sim) and E (startup sim). To rerun, copy it to `<worktree>/src/__audit__/`, run `npx jest src/__audit__/journeys.test.tsx --forceExit`, then delete the copy.
- Outputs: `audit/client/journeys.json`, `audit/client/journeys-E.json`.
