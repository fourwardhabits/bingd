# Loading investigation: title, TV/season, person, reviews/comments, reopen (2026-11-25)

Code: `origin/main` `287dad95` (#378, #381, #385 P8, #387 P4), disposable worktree `/home/user/wt-load`. No repo file was changed or committed. Temporary harness and patches were reverted (`git status` clean); the harness is kept at `scratchpad/load/harness/`, raw output at `scratchpad/load/load*.json`, log queries at `scratchpad/load/lq/`.

## Labels
- **[sim]**: the audit's recording Supabase stand-in plus an OkHttp-like FIFO, 5 slots per host, uniform 165 ms round trip. Edge-function calls are 400 ms (watch-providers: founder exec p50 152–535 ms [edge-log] plus RTT), `season-episodes` and `similar` 600 ms, and `person` 930 ms (founder n=1: 763 ms plus RTT). The screens are the real ones on `287dad95`. Times are ms after mount. JS, payload size and server variance are not modelled.
- **[local-bench]**: request order and depth from the same jest runs, plus React Profiler commit counts. **Jest ms are not device ms.**
- **[edge-log]**: the founder's own Production sessions, 11-17 07:00Z to 11-25 06:45Z, aggregated. No ids, emails or query strings were printed.
- **[static]**: code reading. **[calc]**: arithmetic.
- **No device measurements exist.** Device render time and image download time are **unmeasured**.

## 0. What the Production logs can and cannot say
- The founder has **no Production sessions on the #378/#381 bundle**. OTA 8 was published 11-24 07:24Z. The only founder session after it (11-24 16:11Z, 87 requests) still shows the pre-#378 shape: the title-scoped reads reach the edge 0.12–0.26 s after the row, in a second wave. So it ran the old bundle while it downloaded the new one [edge-log][inference]. The founder's post-fix reports are therefore most likely from **Preview (staging)**, whose logs are outside this brief.
- **Server time is small on these journeys** (origin p50, requests less than 5 s after the previous one) [edge-log]:

| Request | n | Origin p50 |
|---|---|---|
| Title row | 225 | 24–38 ms (one day 141) |
| `community_score` / `following_score` | 290 | 24–46 ms |
| `title_reviews_v2` | 58 | 26–57 ms |
| `activity_comments` | 26 | 40–63 ms |
| `person_cache` | 3 | 46–49 ms |

- **Device round trip, estimated from serial pairs** (dependent request arrival minus the previous request's arrival and origin time): about 57–164 ms [edge-log, n=4].
- **`tmdb-adapter` exec time by action**, the action inferred from the request body length [edge-log, founder]:

| Action | n | Exec p50 | Max |
|---|---|---|---|
| watch-providers | 79 | 152–535 ms | 4.7 s |
| similar | 79 | 396–841 ms | 3.0 s |
| detail | 30 | 330–1,009 ms | — |
| person | 1 | 763 ms | — |
| season-episodes | 0 in the window | — | — |

  There are no `season-episodes` calls because the old bundles seeded episodes through `detail`.
- **Cold connections (audit P2)**:
  - Of 243 founder title-row reads, **1** followed more than 60 s of idle (611 ms) and **2** followed 30–60 s (about 280 ms) [edge-log].
  - In the burst after idle, the first few requests each pay: position 1–2 p50 243–804 ms, position 3–5 p50 127–236 ms, position 6 and later 60–245 ms [edge-log, n=48–71 per position].
  - **So the penalty is material only when the page is the first thing loaded after idle** (a push, a deep link, or resuming straight onto a title). It is not material for in-app navigation. When it does hit, the full-screen loader holds the **whole** title page behind the one slow row (§1).

## 1. Movie title page
**Request graph [local-bench][sim, cap 5]**: 18 requests.

| Wave | Leaves | Requests |
|---|---|---|
| w0, 15 at mount | 5 | **row**, **personal ×3** (user_media, rankings, watchlist for this title), **credits**, **community**, **following**, videos, review count, watch-providers (edge), watch count, reviews list, and 3 library-wide reads (watched ids, my-scores rankings, full watchlist with embed) |
| after the row | 212 | `title_recommendations_for_me`, `similar` facet |
| after the facet | 670 | similar `media_items[in]` |

**Critical vs secondary.**
- *Critical* (first useful render): the row. `LoadingScreen` covers the page until it arrives.
- *Above the fold*: the personal state (actions, bookmark, rank), credits (director line) and the scores.
- *Secondary*: Where to Watch, the review count on the tab, the reviews list (only on the Reviews tab, **never the default tab** in the production Original layout [static]), the watch count line, and Similar (the **default tab** on a film).

| Milestone [sim] | cap 5 | uncapped | cap 5 + cold first request (+520 ms) |
|---|---|---|---|
| Row: page leaves the loader | 172 | 171 | **692** |
| Personal, credits | 172 | 171 | 172 (waiting behind the loader) |
| Scores, videos, review count | 338 | 171 | 337 |
| Reviews list, watch count | 504 | 171 | 502 |
| Where to Watch | 572 | 406 | 737 |
| Similar tiles (data) | 835 | 535 | 1,063 |

**Render** [local-bench]:
- 10 commits per open (8 uncapped), 128–263 jest-ms in total, largest commit 40–50 jest-ms.
- That is small next to a 0.84 s network timeline, but **the device share is not measurable here**.

**Images** [static]:
- The hero (`w1280`) starts only after the row, then fades for **260 ms** (`theme.duration.navigation`).
- The 12 cast avatars and the posters fade for 120 ms each, on Glide's own 5-per-host queue to `image.tmdb.org`.
- On Android, expo-image runs the fade whatever the source, memory or disk (`ExpoImageViewWrapper.kt` `onResourceReady`).

## 2. TV show and season pages
- **Series** [sim]: 22 requests.
  - The **Seasons list (default tab)** waits for the row's `kind`: it is sent at 212, queued behind round 3, and lands at **668**. Uncapped: 378.
  - The season rows' controls add 3 more library reads (ranked seasons, my-scores, logged) at 738–833.
- **Season** [sim]: 19 requests.
  - **Episodes (default tab)**: the row and the videos facet answer (338), then `season-episodes` is sent at 369, waits for a slot until 532, and lands at **1,132**. Uncapped: 826. This is the slowest primary element of any page in this study.
  - **New since #378, by design** [static, 0de804e2]: a filled-in season no longer calls `detail`, so its episodes always come from the `season-episodes` fallback. That is a live TMDB call, never stored (`handleSeasonEpisodes`, "stored nowhere"), once per season per launch (1 h in-memory `staleTime`).
  - Before #378, `detail` (about 0.45 s at the edge) seeded the rail instead, so the latency is of the same order. What is new is that the fallback is now the usual path.
  - The wait for the videos facet (Codex #378) prevents two TMDB calls when the facet is null; it costs one round trip.
- **Cold first request**: as for a film, the loader holds until about 693–697; Seasons lands at 905 and Episodes at 1,348 [sim].

## 3. Cast member (person) page
**Request graph [local-bench]:**
- `usePerson`: `person_cache` → `media_items[in]` (the credited titles), **serial inside one queryFn**.
- Identity (name, portrait, bio) and filmography both appear only after **both** reads. The hero backdrop is chosen from the credits (`pickPersonBackdrop`), so its image request starts after the second read.
- On a miss: `person_cache`(null) → `tmdb-adapter person` → invalidate → `person_cache` → `media_items[in]`. That is **4 serial steps**.
- **Decoration reads**: watchlist, watched, ranked movies and ranked shows (with a `media_items` embed), my-scores, the logged collection (with embed), and ranked ids. That is **6–8 library-wide reads**, only for the row controls (score circle, bookmark, `+`). They share the FIFO with the critical reads.

| Case [sim] | Requests | Identity + filmography | Notes |
|---|---|---|---|
| Cached, cold client | 9 | **344–355** | 2 serial reads |
| Cached, library warm (after Search and a title) | 4 | 342 | |
| Cached, tapped 300 ms after opening the title (12 title requests still queued) | 7 | **590–634** | `person_cache` waits 205 ms for a slot |
| Cached, library keys stale (>60 s, the usual case) and embed reads +300 ms | 9 | **651** (vs 341 fresh) | The filmography read is 4th in the FIFO behind library refetches. Founder embed reads are 100–980 ms origin [edge-log] |
| Not cached | 11 | **1,445** | Skeleton throughout. Founder n=1: about 1.1 s between the first read and the items read at the edge [edge-log] |
| Expired (stale) row | 12 | 339–348, then a **second fill at 1,645–1,650** | The refresh behind the reader may change the list and the hero |

**Is the sequence optimal?**
- The cache-first, enrich-when-needed order is right, and the claim and poll logic must stay.
- Two things are not optimal:
  - **(a)** Nothing is drawn until both reads are back, although the name and portrait were on screen one tap earlier (cast rail, people search).
  - **(b)** The decoration reads compete with the critical read.
- **Prefetch on press-in** saves at most the press duration (unmeasured; about 100 ms assumed) and fires on scroll touches over the cast rail. It is **not worth it on its own**.

## 4. Reviews and comments
- **Title reviews** [sim]:
  - The count reaches the tab label at 338.
  - The list (`title_reviews_v2`, up to 100 rows) lands at 504, before anyone can plausibly tap the tab.
  - Server time is 26–57 ms p50 [edge-log]. Not a cause.
- **Feed comment sheet** [static]: one `activity_comments` RPC, with `staleTime 0` and `gcTime 0` **by design** (retracted comments must never be drawn from cache). That is one round trip of skeleton (40–63 ms server [edge-log]).
  - A press-in prefetch would save at most about 100 ms [assumption] and works against the `gcTime 0` intent. **Not recommended.**
- **Activity page (opened from a notification)** [static]: `feed_events` → hydrate (≈5 parallel reads) → `CommentThread` mounts with `event.id` → `activity_comments`.
  - The comments are **3 waves deep**, about 0.5–0.66 s at a 165 ms round trip [calc].
  - They could leave with the event read, from the route id.
  - This page is also the one most exposed to the cold first request.

## 5. Reopening a page [local-bench][sim]

| When | Requests | What shows |
|---|---|---|
| Within 60 s | 0 | Content at the first commit |
| 60 s – 5 min | 18 in the background, drained by 902 ms; 6 commits | Content drawn from the cache immediately |
| After 5 min (`gcTime` default), after an OTA reload or after process death | 18 | **Fully cold**: the §1 timeline again. There is no persistence |

- **Images on every reopen** [static]: the default `cachePolicy` is `'disk'`, so `skipMemoryCache(true)` on Android. Each remount decodes from disk and **fades again**: hero 260 ms, posters and avatars 120 ms.
- **So even an instant data revisit "fills in" visibly.**

## 6. Answers
- **Serial dependencies (confirmed)**:
  - series: row → Seasons;
  - film: row → similar facet → items;
  - season: row + videos → live `season-episodes`;
  - person: `person_cache` → items, and on a miss + adapter + 2 reads;
  - activity: event → hydrate → comments;
  - person hero image: after the credits.
- **Duplicates**: no exact duplicate request on any open [local-bench]. The person page reads `rankings` in 4 shapes. They are not equivalent (score vs ranked membership vs embed), so **no consolidation is recommended**.
- **Cache misses**:
  - watch-providers and `season-episodes` are live TMDB calls by policy (stored nowhere, PRD §19), once per title per launch;
  - `gcTime` 5 min, then cold;
  - no persistence across OTA reloads (P3/P3b, out of scope).
- **Cold-connection penalty**: material only for a page that is first after more than 60 s idle (about 1% of founder title opens) [edge-log]. In that case the row costs about +0.5 s and the full-screen loader holds everything behind it [sim].
- **Client render vs network**:
  - Network order dominates: client queueing at 5 slots, the round trip, and live TMDB.
  - Server SQL is about 20–60 ms per request [edge-log].
  - Jest render is 128–263 jest-ms per title open [local-bench]. **The device render share is unknown**; no on-device trace exists (P12 would provide one).
- **Recent changes**:
  - #378 and #381 moved the scores one round earlier (two waves became one; the scores now arrive in round 2) [static][sim].
  - #378 also made `season-episodes` the usual episode path (latency similar to before).
  - P4 and P8 do not touch these journeys; P8 slightly reduces Glide contention from the Feed.
  - **Nothing recent made these pages slower** [static].
- **New safety constraint found** [static]: the title page draws its bookmark and rank actions from `personal.data ?? null`, with **no pending guard** (`app/title/[id].tsx:1088, 1101`). Today this is safe only because the row and the personal reads land in the same round.
  - Any remedy that draws the page before the personal reads would flash "Rank" or an unsaved bookmark on a ranked or saved title for one round trip. Those buttons would be tappable in the wrong state.
  - This applies to a header preview, a row-only `gcTime` change, or prefetching the row alone.
  - **Any such remedy must keep the row and the personal reads in lockstep.**

## 7. Remedies, ranked (every one costs $0)

| # | Remedy | Expected impact (labelled) | Conf. | Regression risk | Verify | Effort | Protected behaviours touched |
|---|---|---|---|---|---|---|---|
| **1** | **Person: decorations after the filmography.** `enabled: detail !== null` on the 6–8 library reads (keys unchanged, so cached decorations still draw at once; only the refetch moves) | Filmography **651 → 343 ms** when the library is stale and slow; **634 → 523** when tapped during the title drain; 0 when the library is warm [sim, temporary patch] | S (the mechanism is confirmed; the size depends on library read time) | L | Auto + Dev1 | S | Watchlist (bookmark), ranking entry (`+` still waits for `rankingsKnown`), scores (circle), Watch History (watched set) |
| **2** | **Person: identity preview.** Name and portrait from the tapped cast credit or search row while loading; the filmography skeleton is unchanged | Identity at mount instead of **344 ms** (cached) or **1,445 ms** (uncached) [sim] | S | L (presentation only; must never feed `needsFetch` or the claim logic) | Auto + Dev1 | S–M | Navigation and error recovery (the empty and error states are unchanged) |
| **3** | **Series: default tab first.** Watch count, the reviews list and the watched read wait for the row and are declared after `useSeasons`/`useSimilarTitles` | Seasons tab **668 → 505 ms** [sim, temporary patch]. Film and season unchanged. Deferral alone without the reorder: **0** [sim] | S | L–M (spoiler masking must stay masked while `watched` is pending; a Reviews tap inside about 0.3 s shows a skeleton) | Auto + Dev1 | S | TV show and season semantics (unchanged), visibility (spoiler masking), reviews |
| 4 | In-memory `gcTime` 30 min for the title row **and** personal (together, §6), credits and videos | Reopen after 5–30 min: from cold (≈0.84 s fill) to instant [sim]. How often that happens is unknown | H (benefit frequency) | L–M (personal held longer in memory; account-keyed; cleared on sign-out) | Auto + Dev1 | S | Auth/account isolation, Watchlist and rank state freshness (invalidations still apply) |
| 5 | Activity page: comments leave from the route id alongside the event | About −2 round trips ≈ 330 ms to the thread [calc] | S | L–M (group redirect: one wasted read; render only when `event.id` matches; the RPC authorizes) | Auto + Dev1 | S | Comments, visibility, notifications (focused reply) |
| 6 | Title header preview (hero and title only, no actions) instead of the full loader | 172 ms on a quiet link; about **690 ms** on a cold first request; more under contention (audit D: row 963 ms) [sim] | S | **M** (the §6 lockstep; the hero remounts and fades twice; a layout jump) | Dev2 | M | Watchlist, ranking entry, navigation |
| 7 | `cachePolicy="memory-disk"` on TitleHero, Poster and avatars | Removes the disk decode on reopen (**unmeasured**); the fades stay | H | L (bounded memory) | Dev1 (memory) | S | none |
| 8 | Press-in prefetch (cast → `['person', id]`; title rows → row + personal [+ scores]) | ≤ the press duration (**unmeasured**, ≈100 ms assumed) | H | L–M (fires on scroll touches; 2–4 reads per touch; must prefetch row and personal together) | Dev1 | S–M | Watchlist, ranking entry (lockstep) |
| 9 | Per-query `staleTime` for catalogue keys | Fewer background refetches on a 60 s – 5 min reopen (18 → ≈12). **No visible change**: the cached render is already instant | S | L | Auto | S | none |

**Not recommended or out of scope.**
- *Merging the personal triple into the row through PostgREST embeds* (scores would move to round 1, ≈−165 ms [calc]). It reverses the deliberate 2026-08-16 failure-isolation split. M risk.
- *Storing episodes and providers as facets.* PRD §19 retention, and it needs a migration.
- *Raising the OkHttp cap* (P7, native).
- *Pool idle and compute* (P1/P2).
- *Prefetching comments* (`gcTime 0` by design).
- *A full-screen skeleton.*

## 8. Best candidates: implementation sketch

### A. Person page "critical first" (remedies 1 + 2, one PR)
1. **Hook options**, additive with default `true` so other callers are unchanged:
   - `useWatchlist(userId, { enabled })` in `src/features/collection/use-collection.ts:437`;
   - `useWatched(userId, { enabled })` in `src/features/collection/use-watched.ts:25`;
   - `useWatchlistToggle(userId, surface, { enabled })`, passed through to `useWatchlist`, in `src/features/collection/use-watchlist-toggle.ts:20`.
   - `useRankedCollection`, `useMyScores` and `useLoggedCollection` already take `enabled`.
2. **`app/person/[id].tsx`**: `const decorate = detail !== null;` passed to all seven hooks (lines 194–202, 319, 346).
   - Keys are unchanged, so cached data is still returned while the hooks are disabled.
   - `rankingsKnown` (`isSuccess` ×4) keeps "no `+` until known".
3. **`src/features/person/preview.ts`**: a module-level bounded Map, `rememberPersonPreview(id, { name, profilePath })` and `personPreview(id)`.
   - It holds public TMDB data only: not the query cache and no personal data.
   - Call it before `router.push` at `app/title/[id].tsx:2091, 2587, 2760` and `app/(tabs)/log.tsx:408`.
   - In the `loading` branch (`person/[id].tsx:447`), draw the name and the portrait from it; otherwise draw today's placeholder.
4. **Tests** in `src/features/person/PersonScreen.test.tsx`:
   - (i) with `person_cache` held, no library read is sent until it answers; then they are sent (pin it with the asked-order list);
   - (ii) with library data pre-seeded in the client, the bookmark and score draw with the filmography and no refetch precedes the filmography read;
   - (iii) the existing "no `+` until rankings are read" still passes;
   - (iv) the preview name shows while loading, is replaced by the detail, never shows in the error or "Nothing here yet" states, and `cachePerson` is called exactly once (no extra fetch from the preview).
5. **Device check (Dev1, Android)**: open a cast member from a title (cached and uncached), and from Search people.

### B. Series default tab first (remedy 3)
1. **`app/title/[id].tsx`**: move `useWatchCount` (line 640) and `useTitleReviews(…, serverSortOf(reviewSort))` (line 658) below `useSimilarTitles` (≈line 818). Key them on `const rowId = titleRow ? routeTitleId : null`.
   - Pass `enabled: Boolean(titleRow)` to `useWatched` (line 671; it needs the option from A.1).
   - Keys, `enabled` semantics after the row, and every invalidation are unchanged.
2. **Tests**:
   - Update the #381 order test in `src/features/title/TitleScreen.test.tsx`: on a series, the season list leaves before the watch count and the reviews list, and both scores still leave in the first burst.
   - Add: review spoilers stay masked while `watched` is pending.
3. **Expected**: Seasons tab −163 ms [sim]. No change for a film or a season. So this is smaller than A. Do it only if TV pages are the main complaint.

## 9. Uncertainty
- There are **no device measurements**: no render cost, image download time, press duration or real OkHttp timing. Every device-side number above is [sim] or [calc].
- **Production evidence predates #378/#381** for the founder. The post-fix behaviour comes from [sim] on `287dad95` and is not observed.
- The size of the person-page gain depends on how long the founder's library reads take on a cold or stale cache. 100–980 ms origin [edge-log] supports it, but it is n-limited.
- The `season-episodes` latency is assumed at 600 ms. There are 0 Production samples since it became the usual path.
- How often a page is reopened after 5 min is unknown, so remedy 4's value is unknown.
- **Verifying any of this on a device needs P12**, `TimeToFullDisplay` on the title and person pages.
