# RND: rendering, images, startup/OTA, observability (audit, 2026-11-24)

**Scope and method.**
- **Source.** `origin/main` `72a10764` (= `32790c48` + docs), read in my own worktree `/home/user/wt-audit-render`, which has since been removed.
- **[local-bench] harnesses.** Jest with the React Profiler API, run in the worktree only. The copies kept under `scratchpad/audit/render/` are `FeedProfiler.audit.test.tsx`, `TitleProfiler.audit.test.tsx` and `TitleProfilerStaggered.audit.test.tsx`. Nothing was committed.
- **Compiler check.** A scratch install of `babel-plugin-react-compiler@1.0.0` (the lockfile version) was run over every non-test `.tsx` in `app/` and `src/` (222 files) with a logger, to see which components the React Compiler actually compiles.
- **Library source reading.** `@sentry/react-native` 7.11.0, `@sentry/browser` 10.37.0, `expo-image` 57.0.2 (Android Glide 5.0.5, iOS SDWebImage), RN 0.86 `OkHttpClientProvider`, and expo-router's vendored bottom tabs.

**Jest timings are not device timings.** They run in Node/V8 with react-test-renderer: no Hermes, no native layout, no image decode. I make no claim about frames, device CPU or on-device milliseconds. Render counts and how cost scales are the transferable part. Absolute milliseconds are not.

---

## Summary of material findings

| ID | Finding | Confidence | Impact | Class |
|---|---|---|---|---|
| F-RND-1 | The **Feed screen is not compiled by the React Compiler**, and it is an unvirtualized `ScrollView`. Every Feed state change or data arrival re-renders **every loaded card** | Confirmed (mechanism); impact Hypothesis | M | A (small fix) / B (FlashList) |
| F-RND-2 | Grouped-post rails **mount all ≤12 posters at `w500`** for 84 pt tiles, and Trending is also `w500`. The Feed's image burst at launch is several times what it was before 11-12/11-17. On Android it shares one 5-per-host FIFO queue with For You and title images | Over-fetch Confirmed [calc]; symptom link Hypothesis | M–H (For You placeholders) | A |
| F-RND-3 | Foreground OTA reloads fire **seconds after** the user returns, and they empty every in-memory cache. Eight production OTAs went out 11-22..11-24, four of them on 11-24 between 03:35Z and 07:24Z | Strongly supported | M (perceived "slow startup") | A (process) |
| F-RND-4 | **Production has no per-journey or per-OTA performance view.** The Sentry `release` is the binary's for every OTA. There is no TTFD or journey span, image loads are invisible, and the Diagnostics recorder is off in production | Confirmed | H (it blocks every regression question) | A |
| F-RND-5 | Unfocused tabs and screens lower in the stack are never frozen, so invalidation storms re-render hidden screens | Confirmed (config); impact Hypothesis | L–M | B |
| F-RND-6 | `expo-image` default `cachePolicy: 'disk'` **skips the memory cache** on both platforms, and nothing is ever prefetched. Blurhash placeholders are wired in but no data exists | Confirmed | L–M | D |
| F-RND-7 | Title screen: one 3,400-line component with ~25 queries; 9–18 commits per open | [local-bench] | L–M | F |
| F-RND-8 | Sentry trace headers go on every native request. Latency is negligible and there is no preflight | Confirmed | L | D |
| F-RND-9 | Avatars are 512 px JPEGs drawn at 32 pt | Confirmed [calc] | L | D |
| F-RND-10 | All 18 Inter TTFs ship in every bundle and OTA asset set, though only 3 are used | Confirmed (export log) | L | D |

---

## 1. Rendering architecture

### 1.1 List virtualization per surface [static]

| Surface | Primitive | Bounded? | Notes |
|---|---|---|---|
| **Feed** (`app/(tabs)/feed.tsx:635`) | `ScrollView` + `events.map` | **No.** Pages of 20 (`FEED_PAGE_SIZE`), no `maxPages`, so it grows with scroll | Every card mounts and every card's images load at mount. Leaderboard (50 rows, `p_limit: 50`) and People render inside the same `ScrollView` |
| Feed grouped-post rail (`PosterRail`) | horizontal `ScrollView` + `.map` | ≤12 (`GROUP_PREVIEW_LIMIT`) | All 12 mounted, ≈3.7 visible (see F-RND-2) |
| Trending shelf (`PosterShelf`) | horizontal `ScrollView` | list size | `w500` |
| **For You wall** (`recommendations.tsx:1063`) | `ScrollView` + `PosterGrid` (`.map`) | 20 per page, `MAX_PAGES` 5, so ≤100 tiles | #381 added `priority: 'high'` for first-screen tiles |
| **Collection** (`CollectionView`) | **FlashList 2.0.2** (`PosterGridList`) | virtualized | Also drag (`use-lift-drag`) |
| **Search** (`app/(tabs)/log.tsx:986,1310`) | **FlashList** | virtualized | |
| Per-title Watch History (`app/title/[id]/history.tsx`) | `FlatList` | virtualized | Its component is also not compiled (try/finally) |
| Notifications (`app/settings/notifications.tsx`) | `ScrollView` | ≤100 (`my_notifications p_limit 100`) | Light rows |
| Comments thread (`CommentThread.tsx`) | `ScrollView` + `.map` | thread size | Component not compiled (eslint-disable, see 1.3) |
| Leaderboard (`LeaderboardView`) | `.map` inside the Feed `ScrollView` | 50 | |
| Profile / `u/[username]` | `ScrollView` | 20 activity rows | |
| Lists, `lists/by`, profile sheets, `EpisodeRail` | `FlatList` | virtualized | |

FlashList is used only by Collection, Search and `PosterGridList` (Collection's wall). The two image-heaviest, longest-lived surfaces (Feed and For You) are not virtualized.

### 1.2 Re-render sources

- **The React Compiler bails out on the Feed screen (Confirmed, [static], using compiler 1.0.0).** `FeedScreen` (line 139) logs `CompileError: Support functions with unreachable code that may contain hoisted declarations`. The cause is `function reactionFor(eventId)`, declared *after* the component's `return` (line 1282).
  - In a scratch copy I moved it above the return. The compiler then bails on a second rule: `Existing memoization could not be preserved` (the hand-written `useMemo`/`useCallback`s).
  - So it is not a one-line fix, but it is a small one.
  - **This pre-exists:** the hoisted `reactionFor` is in September's `9d9683a`. It is not a November regression. What changed in November is how heavy each card is (cinematic `FeedCard` from 11-06/11-12, rails from 11-17, and #368's labelled actions).
- **Other components the compiler skips** (out of 222 files):
  - `CommentThread` (line 178, "React ESLint rules were disabled");
  - `RankingSheet`'s `Session` (395);
  - `LogSheet`'s `Body` (365);
  - `RankSessionScreen`'s `BacklogSession` (137);
  - `WatchHistoryScreen` (`history.tsx:87`) and `WatchRow`'s `WatchEditor` (383);
  - `ActionPair`;
  - `RecommendSheet`, `NotificationStep`, `InviteFriendsButton`, `FirstFiveShareSheet`, `PushPermissionCard`, `RefineScreen` (66), `create-profile`, `privacy`, `i/[token]`, `onboarding/notifications`.
  - Most of these are `try` without `catch` or `try/finally`, which compiler 1.0 cannot lower.
  - `TitleScreen`, `RecommendationsScreen`, `ProfileScreen`, `FeedCard`, every `PosterWall` component and `CollectionView` **are** compiled.
- **The Feed data waves.** The card `map` reads `feed.data`, `reactions.data`, `commentCounts.data`, `groupPreviews.data`, `watchlist` (via `saved`), `watched.data`, `busy` and `pickerFor`. Each arrival or change re-renders all N cards with new inline closures. Because the screen is uncompiled, so do state changes unrelated to cards:
  - opening the comment sheet (`setCommentsFor`, the #374 entry point);
  - the Recommend sheet;
  - the reaction detail;
  - a bookmark tap, which calls `setBusy` twice and then invalidates the watchlist, for about three full-list renders.

**[local-bench] Feed with N cards** (FeedProfiler harness)
- **Setup.** All `title_ranked` cards with backdrops, 5 authors, mocks answering immediately so waves collapse. 3 runs each; run 1 at N=10 includes JIT warm-up.

| N | Commits to settle | FeedCard renders at mount | Render ms to settle (jest) | One comment count changes on one card: FeedCard renders | That commit (jest ms) |
|---|---|---|---|---|---|
| 10 | 4–5 | 30 (3.0 per card) | 138–540 | **10** | 18–47 |
| 30 | 4–5 | 90 (3.0 per card) | 217–425 | **30** | 51–117 |
| 60 | 4–5 | 180 (3.0 per card) | 450–563 | **60** | 97–101 |

- **The transferable result:** one count changing on one post re-renders every card, and the commit cost grows with N.
- On a device the waves arrive separately, so expect one full-list render per data source: the feed page, reactions, comment counts, group previews, the watchlist and watched [static]. My immediate mocks collapsed these into three.

**Title screen [local-bench]** (`TitleScreen`, compiled):
- **Immediate mocks:** 5 commits, 74–97 ms of update render (jest).
- **Staggered mocks** (each read answers 4–118 ms later, in a fixed pattern): 9–18 commits, 133–171 ms of total render, at most 24–51 ms for any one commit.
- 18 reads are issued in both modes. This is the "fills in progressively" shape. The page is compiled, so sub-trees whose inputs did not change are skipped, and most of the waiting is network order, which the prior report covers.

**Context providers [static]**
- `AuthProvider`'s value `useMemo` depends on the whole `profileQuery` object, which has a new identity every render. So any `AuthProvider` render rebuilds `{status:'ready', …}`, and every `useAuth`/`useCurrentProfile` consumer re-renders: every mounted tab and stack screen.
- It renders on auth events (start, hourly `TOKEN_REFRESHED`), so it is rare. Low impact, not listed as a finding.

**`onLayout` [static]**
- `EngagementRow` and `ReactionSummary` each set state once after layout. That is one small local re-render per card, as the prior report already said. Not a material source.
- `CommentThread`'s measurements go into refs.

### 1.3 Animations [static]

- **`react-native-reanimated` 4.5.1 is installed, but nothing imports it** (`grep` over `app/` and `src/`). All motion is RN `Animated` (19 importers) plus `expo-image` transitions: 120 ms state, 260 ms navigation.
- **The draggable sheet (#374, `Sheet.tsx:304–331`).**
  - A `PanResponder` calls `drag.setValue(dy)` on the JS thread, and release uses a native-driver spring.
  - Expand and collapse is a height change (layout), not an animation.
  - So following the finger is JS-thread bound. It will stutter if JS is busy. The plausible case is the uncompiled Feed re-rendering behind the sheet as comment counts are invalidated after a post.
  - Low impact. A `react-native-gesture-handler` (already a dependency) plus Reanimated version would be a structural change for little gain.

### 1.4 The heading system and the FeedCard 3:2 hero (#368, #372) [static]

- **#368** changed the hero frame from 16:9 clamped to 150–190 pt to **3:2 of the artwork width**, clamped to 150–280 pt (221 pt at 390 pt). The **image is unchanged: the same `w780` backdrop** (`feedArtwork` → `backdropUri(…, 'card')`). Bytes per card are unchanged; each card is 31–58 pt taller.
- **#372 and #373** (headings, content-sized actions) are layout only. The only new layout-driven state is `EngagementRow`'s width, covered above.

---

## 2. Image pipeline

### 2.1 Size per surface vs rendered size

**Assumptions.**
- Rendered pixels = points × 3.
- Width math is at 390 pt unless stated: gutter 16, grid gap 6, shelf gap 10, peek 0.7.
- TMDB buckets: `w342` = 342×513, `w500` = 500×750, `w780` backdrop = 780×439, `w1280` = 1280×720, `w185` = 185×278.

| Surface | Code | URL size | Rendered | Need at 3x | Ratio (width; pixels) [calc] |
|---|---|---|---|---|---|
| For You wall tile | `recommendations.tsx:788` | `w342` (since #381; `w500` before, as far back as Sept `9d9683a`) | (390−32−12)/3 = 115 pt | 345 px | 0.99×; 1.0×. Before #381: 1.45×; 2.1× |
| Collection wall | `CollectionView:734` | `w342` | 115 pt | 345 px | ≈1× |
| **Feed hero backdrop** | `feed-artwork.ts:32` | `w780` | 332×221 pt; `cover` of 16:9 into 3:2 is height-bound, so the source must be 221×3×16/9 = 1,179 px wide | 1,179 px wide | **0.66× (under-fetch, soft, not over)**. At 360 dp × 2.625: 0.83× |
| Feed hero poster fallback, plus its blurred field (same URL) | `feed-artwork.ts:35` | `w342` | (221−24)×2/3 = 131 pt | 394 px | 0.87× |
| **Feed grouped rail tile** | `feed.tsx:457` | **`w500`** | floor((356−12−30)/3.7) = 84 pt | 252 px | **1.98×; 3.9×**. And **all ≤12 tiles mount** with ≈3.7 visible |
| **Trending shelf** (top of the Feed) | `TrendingShelf.tsx:67` | **`w500`** | floor((374−30)/3.7) = 92 pt | 276 px | **1.81×; 3.3×** |
| ActivityRow (award/goal rows, profile, `u/`) | `posterUri()` default | `w342` | `xs` 40 pt | 120 px | 2.85×; 8×. `w154` would cover it |
| Title hero | `hero.ts` | `w1280` | 390 pt wide | 1,170 px | 1.09× (fine) |
| Title hero blurred-poster fallback | `hero.ts:48` | `w500` | blurred | — | Over, since it is blurred anyway. `w154` would do |
| Ranking and comparison cards, sheets | `'card'` | `w500` | ~132–180 pt | 400–540 px | ≈1× |
| Cast | `profileUri` | `w185` | 64 pt | 192 px | 0.96× |
| Provider logos | `w92` | | 28 pt | 84 px | 1.1× |
| Episode stills | `w300`, sheet `w780` | | rail cards / full width | | fine |
| **Avatars** | Supabase storage public URL | **512×512 JPEG** (`avatar.ts:16`) | 32 pt (Feed headline) | 96 px | **5.3×; 28×** |

**Largest over-fetches, in order.**
1. **Feed rails:** 12 × `w500` = 4.5 Mpx per grouped post, against 0.34 Mpx for a single-title hero [calc].
2. **Trending:** `w500` at 92 pt.
3. **Avatars:** 512 px at 32 pt.
4. ActivityRow posters: `w342` at 40 pt.

Bytes could not be measured, because `image.tmdb.org` is blocked by this container's proxy (403). The ratios are in pixels, and they assume JPEG bytes are roughly proportional to pixels.

### 2.2 `expo-image` settings [static]

- **`cachePolicy`.** Never set anywhere, so the default is `'disk'`.
  - Android: `ExpoImageViewWrapper.createPropOptions` calls `skipMemoryCache(true)` unless the policy is `memory`/`memory-disk`.
  - iOS: `SDImageCacheType.disk`, so the memory cache is not queried either.
  - So **every remount re-reads and re-decodes from disk**, then plays the 120 ms fade (`transition={theme.duration.state}`).
  - Disk defaults: Glide 250 MB LRU. SDWebImage's library default is a 7-day max age by modification date and no size cap; expo-image only overrides `maxDiskSize`/`maxMemoryCost` when `configureCache` is called, and the app never calls it. The 7-day value is SDWebImage's documented default and was not read from source here (it is a pod, not in node_modules).
- **`recyclingKey`.** Set on `Poster` and the `FeedCard` hero. Relevant only to recycled lists (FlashList cells); harmless elsewhere.
- **`priority`.** Only the For You first screen sets `'high'` (#381).
  - On Android this orders Glide's own executor queue only.
  - Once a request is handed to OkHttp (asynchronous `enqueue`), OkHttp's `Dispatcher` is **FIFO**, so priority cannot overtake requests already queued for the same host.
- **`placeholder`/blurhash.** `Poster` and `TitleHero` accept `blurhash`, but **no query, table or migration carries one** (`grep blurhash` over `app/`, `src/` and `supabase/` finds only the UI props). So a loading poster is a flat `surface.sunken` box. This is how "For You poster placeholders stay visible" looks; it is not why they stay.
- **`Image.prefetch`.** Never used.

### 2.3 Android image transport [static, from library source]

- `ExpoImageOkHttpClientGlideModule` builds **its own client**, `OkHttpClientProvider.createClient()`. RN's `NetworkingModule` builds another through the same factory method. Each `createClient()` is a new `OkHttpClient` with **its own `Dispatcher`**, and `GlideUrlWrapperLoader`'s `newBuilder()` shares the Glide client's dispatcher.
- So, yes: **images go through a separate OkHttp client with its own 5-per-host limit.**
  - TMDB images queue among themselves on `image.tmdb.org`, never behind Supabase API calls.
  - Supabase-hosted avatars use the Glide client, so they also do not compete with API calls, despite sharing the host.
  - This fits "artwork before scores": the two arrive through separate queues.
- **Consequence for the prior report's P2.4** (an `OkHttpClientFactory` raising `maxRequestsPerHost`): `createClient()` consults the factory, so a factory installed before Glide registers its module would raise the **image** limit too. That is probably welcome, but it is a second behaviour change to verify.
- **iOS:** SDWebImage downloads 6 at a time by default.

### 2.4 Did #381 (`w500`→`w342`) cause one-time cache misses?

Yes [static]. Cache keys are URLs.
- **One-time miss.** On the first For You visit after OTA 8, every wall poster is a cold network fetch, at the new smaller size. It is one-off per device.
- **Lasting side effect.** Before #381, For You tiles shared `w500` entries with Trending, the Feed rails and the title page's `'card'` poster uses. They now share `w342` with Collection, ActivityRow and lists instead.
- Net bytes per poster fall by about half [calc: 175k vs 375k px]. **No lasting regression is expected.**

---

## 3. Startup and OTA

### 3.1 Configuration [static]

- **`app.config.ts`:** `updates: { url, fallbackToCacheTimeout: 0 }`. No `checkAutomatically`, so the default is `ON_LOAD`: a background check and download on every cold start, applied at the next launch. `runtimeVersion: fingerprint`.
- **`src/lib/updates.ts`:**
  - **On every transition into `active` from anything else**, including `inactive` (notification shade, permission prompts, Apple/Google sign-in), it runs `checkForUpdateAsync`, then `fetchUpdateAsync`.
  - If the update is new and `isSafeToReload(status, group)` holds (`ready`, not in `(auth)`/`onboarding`), it calls `Updates.reloadAsync()`.
  - The latch `reloadRequested` limits this to one reload per process.

### 3.2 How often a production user reloads (F-RND-3)

- **The mechanism.** For each published OTA, every signed-in production user reloads once, on the **first foreground return after publication** (or picks it up at the next cold start).
- **The OTA timeline:** OTA 1–2 on 11-22, OTA 3–4 on 11-23, OTA 5–8 on 11-24 between 03:35Z and 07:24Z. A daily user could have had **up to 8 reloads in three days, 4 of them in one morning** [calc from the brief's timeline].
- **The reload is not at the moment of return.** It comes after the check plus download.
  - The Android OTA bundle is **7.4 MB of Hermes bytecode** (`scratchpad/sentry-export/_expo/static/js/android/entry-*.hbc`, an `expo export` artefact). Compressed transfer size is unmeasured.
  - So the reload lands roughly seconds after the user is back and already reading or tapping [calc, network-dependent].
- **What each reload does.**
  - It restarts JS and empties the React Query cache (no persister).
  - It re-runs session hydration, the profile read, the routing gate and the Feed's three serial waves.
  - The image disk cache survives, but the memory cache is not used anyway (2.2).
- To a user this looks like "slow startup" or "it reloaded on its own". The prior report suspected this on Preview (launches 10 s apart). **The same mechanism applies to production.**
- **Evidence gap:** the actual reload count per device. EAS update insights or the Sentry session count per `eas_update_id` would answer it.

### 3.3 Cold-start sequence [static]

1. **Module scope:**
   - `initMonitoring()` (`Sentry.init`: native SDK init, app-start, stall, frames and navigation integrations);
   - `initAnalytics()` (PostHog);
   - `configurePushPresentation()`;
   - `SplashScreen.preventAutoHideAsync()`.
2. **`RootLayout` returns `null` until `useFonts`** settles: five bundled TTFs, DM Serif ×2 and Inter ×3. The splash is hidden on fonts loaded *or* error. **Fonts are the only thing that holds the native splash.**
3. **Providers mount.** `Navigation` withholds the `Stack` until `auth.status` resolves, and `AuthStatusOverlay` draws `LoadingScreen`. The resolution path is:
   - `getSession()` from SecureStore (chunked), plus a token refresh if expired;
   - then **`profiles` over the network**: `ready` waits on this read;
   - with a hydration grace timer as fallback.
4. `Stack` mounts. `index.tsx` draws `LoadingScreen` while `useAuthRouting` waits on `useTasteOnboarding`. For an established account that is a SecureStore pref read, with no network. Then it routes to `/feed`.
5. **The Feed mounts:**
   - `follows` → `feed_events` → hydrate;
   - then reactions, comment counts, group previews, watchlist and watched (one full-list re-render each, F-RND-1);
   - then every card's images (F-RND-2).

**What blocks the first frame:** only fonts (the splash). The first *meaningful* frame waits for SecureStore, the profile read and the Feed waves. There is no persisted query cache (prior report, P2.5). `hydrateTitleLayout()` and `startIconFont()` are not awaited.

### 3.4 Retained tab state [static]

- expo-router's vendored bottom tabs use the defaults: **`lazy: true`** (a tab mounts on first visit), `detachInactiveScreens: true` (native views detached), **`freezeOnBlur` unset**, and `enableFreeze` is never called.
- `popToTopOnBlur` is unset; `unmountOnBlur` no longer exists.
- So **once a tab has been visited it stays mounted and keeps re-rendering** on every query update and invalidation, though it is not visible. The same holds for screens lower in the native stack (title → title → title).
- The Feed, the initial tab and uncompiled, is always among them. The For You wall mounts on first visit and stays.
- Whether Glide or SDWebImage keep downloading for views in a detached tab was not verified (evidence gap). I believe they do, because requests are tied to the view's lifetime, not to visibility.

---

## 4. Observability

### 4.1 What exists in production today

| Capability | State | Source |
|---|---|---|
| Errors and crashes | Yes. Scrubbed `beforeSend`/`beforeSendTransaction`/`beforeBreadcrumb`; `sendDefaultPii: false`; user is `{id}` only | `monitoring.ts` |
| Tracing | `tracesSampleRate` **0.2** in the production variant (beta included), 1.0 elsewhere | `monitoring.ts:64` |
| Default integrations with tracing on | **app start** (cold/warm), **native frames**, **stall tracking**, **`reactNativeTracingIntegration`** (XHR spans), `timeToDisplayIntegration`; user-interaction tracing is off | `@sentry/react-native` `integrations/default.js`, `sdk.js` `DEFAULT_OPTIONS` |
| Navigation | `reactNavigationIntegration({ enableTimeToInitialDisplay: true })`, registered from `useNavigationContainerRef`, giving idle navigation transactions per route with native TTID | `_layout.tsx` |
| **HTTP spans** | **Yes.** `traceXHR: true` (`traceFetch: false` on native, because RN fetch is XHR). Spans are created **only inside an active root span** (navigation or app start). Query strings are stripped by `scrubTransaction`. Supabase REST, RPC, auth and functions plus PostHog all appear; images do not | `@sentry/browser` `tracing/request.js` |
| Release identity | `release`/`dist` come from the **native build** (Expo plugin), so **every OTA reports the binary's release**. OTAs are distinguishable only by the tags `eas_update_id`, `build_kind`, `runtime_version` and `eas_channel` | `release.ts`, `monitoring.ts` |
| Release health | Native auto session tracking (the SDK default), so crash-free sessions **per binary release**. Sessions cannot be split by tag, so there is **no per-OTA release health** | SDK defaults |
| Source maps for OTAs | Yes since #380 (Debug IDs via `getSentryExpoConfig`; `upload_sentry_sourcemaps: true`) | `metro.config.js`, `.eas/workflows/ota-production.yml:93` |
| Journey timings (TTFD, "scores visible", "first comparison") | **None.** No `TimeToFullDisplay`, `startSpan` or `setMeasurement` anywhere; no PostHog duration properties among the 63 events | grep |
| Image timing | **None.** Glide and SDWebImage are native and invisible to XHR instrumentation. `onLoad`'s `cacheType` is unused | grep |
| Diagnostics flight recorder | `ENABLED = !isRelease`: **off in the production lane**, and the Settings block is gated by `isRelease` | `flight-recorder.ts:85`, `settings/index.tsx:536` |

**What the recorder captures, on Preview and Beta only.**
- The last 30 network operations by logical name (`rest:<table>`, `rpc:<fn>`, `auth:<endpoint>`, `storage:object`, `other`), with start and end ms since process start, status, and error class.
- 80 events across `auth`, `route`, `onboarding`, `signout`, `push`, `app`, `store`, `render` and `query`. Query begin/success/error come from `watchQueries` on the React Query cache.
- Counters such as `app.mounts` and `query.fetches`, and a 12-event tail written to the Keychain on background.

**Why it is off in production.** It is the code's explicit rule: "A store build records nothing and offers no way in". It follows the privacy posture (no extra on-device data surface for the public) and the founder's decision that release builds show a version line only.
- Consequence: **the founder's production-device observations have no timing evidence at all.**

### 4.2 Does Sentry tracing add request overhead? (F-RND-8)

- **Headers are added to every native request.** On native, `getDefaultTracePropagationTargets()` returns `[/.*/]` (`reactnativetracing.js:8–13`). `xhrCallback` adds `sentry-trace` and `baggage` to **every** XHR whether or not a span is active (`request.js:269–276`): Supabase REST, RPC, auth and functions (`tmdb-adapter`) and PostHog. Native images are not included.
- **The cost is a few hundred bytes per request** [calc].
  - `sentry-trace` is 32+16 hex chars plus a flag, about 65 bytes with its name.
  - `baggage` carries environment, release, public key, trace id, sample rate, `sampled` and the transaction (route pattern), about 250–400 bytes.
  - On HTTP/2 most of it is HPACK-indexed after the first request. No measurable latency.
- **CORS preflight: refuted.** Native has no CORS. On web, `isWeb()` returns `undefined` targets, so the browser SDK's default is same-origin only, and cross-origin Supabase calls get no headers.
- **Privacy note.** `baggage` tells Supabase and PostHog the route pattern and release. There are no ids beyond the Sentry trace id. Optional `tracePropagationTargets: []` stops it, since there is no backend tracing to correlate with.

### 4.3 Proposal: the smallest safe instrumentation for p50/p95 per journey and per release

Do not implement this yet; the founder decides.

**Option 1 (recommended): five fixed-name Sentry spans plus a release tag that is already sent. JavaScript only, so it ships by OTA.**
1. **Journey spans,** each started at the user's action and ended at the moment the founder means by "done":
   - `journey.cold_start` (process start → Feed first page drawn);
   - `journey.title_open` (tap → `community_score`, `following_score` **and** Where to Watch settled);
   - `journey.foryou_first_screen` (tab focus → `onLoad` of the first-screen tiles, with a count of `cacheType: 'none'` as an attribute);
   - `journey.rank_first_comparison` (`log_title` sent → `rank_start` answered and drawn);
   - `journey.feed_page` (scroll trigger → page drawn).
   - Each would use `Sentry.startSpan`/`startInactiveSpan`, or a `TimeToFullDisplay` marker where a screen exists.
2. **Sampling:** under the existing `tracesSampleRate` 0.2, or a `tracesSampler` that keeps journeys at 1.0 while the user count is small.
3. **Per release:** spans carry the existing `eas_update_id` tag (`Sentry.setTags(releaseTags())` applies scope tags to transactions). Discover or Performance can then chart p50/p95 by `eas_update_id` and `environment:production`. No `release` change is needed.
   - Since #380, OTA maps match by **Debug ID**, so the old reason not to set `dist` per OTA ("it un-symbolicates stacks", `monitoring.ts`) probably no longer holds. Setting `dist` = update group would also split *release health* per OTA. Treat that as a separate, verifiable change, because sessions and native crashes are keyed on `release`/`dist`.

**What it needs.**
- **An OTA only.** No native module and no fingerprint change; these are SDK APIs already in the binary (7.11).
- A Sentry auth token for reading. That is founder-side and not needed by the app.

**Privacy.**
- Span names are fixed strings. Attributes would be counts, a cache type, booleans and network type if wanted. No title ids, query strings or user content.
- The transaction's `user.id` is already attached (account UUID). That is already declared under "Performance Data / Diagnostics" in `docs/release/store-privacy-inventory.md`.
- It needs a review-28-style check that no attribute takes a route param.

**What it could break:** nothing functional. The risk is a mis-nested span inflating durations. Verification is a staging run with `tracesSampleRate` 1.0, then one production day.

**Option 2 (alternative): one PostHog event, `perf_journey`, with `{journey, duration_ms_bucket, cache_cold}`.** PostHog already attaches `eas_update_id`/`app_version`. It is simpler to chart for a non-engineer, but it is product analytics: it needs the analytics doc and the privacy inventory updated, and it adds request volume to the RN network queue (Android 5 per host on `us.i.posthog.com`, a separate host).

**Not recommended:** enabling the flight recorder in production. It is a data surface the privacy posture deliberately excludes, and it is manual-copy only.

---

## 5. Sentry data access

- **No Sentry access exists in this environment:** no `SENTRY_*` env vars and no `.sentryclirc`, and `https://sentry.io/api/0/` returns proxy **403** (CONNECT refused). No credential was requested.
- **Evidence gap:**
  - app-start p50/p95;
  - navigation TTID by route;
  - `http.client` span durations on production;
  - stall and frozen-frame rates;
  - crash-free sessions per release;
  - any before/after by `eas_update_id`.
- **The smallest follow-up:** the founder opens Sentry Performance, filtered `environment:production`, `transaction.op:navigation`, `transaction:"title/[id]"`, and reads p75 duration grouped by `eas_update_id` across OTA 3 to OTA 8. Same for `app.start.cold`.

---

## Candidate findings (full form)

### F-RND-1: Feed re-renders every card on every change (uncompiled screen, unvirtualized list)

- **Journey:** Feed scrolling and every Feed interaction (Like, picker, bookmark, comment sheet open, #374); also post-log and post-comment invalidations while the Feed is mounted behind other tabs.
- **Root cause:**
  - The React Compiler bails on `FeedScreen` (hoisted `function reactionFor` after `return`, then "existing memoization could not be preserved").
  - Cards are rendered inline in `events.map` inside a `ScrollView` with no page cap, with fresh closures per render.
  - Pre-existing since at least September. The cost per card grew with the 11-06/11-12 cinematic card, the 11-17 rails and #368.
- **Evidence:**
  - Compiler log [static];
  - FeedProfiler [local-bench]: one count change re-renders 10/30/60 of 10/30/60 cards, the commit growing from about 18–47 to about 100 jest-ms; 3.0 renders per card at mount with collapsed waves;
  - about 6 data sources feed the map [static].
- **Confidence:** the mechanism is Confirmed. The device cost is a Hypothesis (no device profile).
- **Impact:** M, a candidate for "occasional sub-second delays" on long Feeds and Feed-adjacent taps.
- **Remedy:**
  - (a) Make `FeedScreen` compilable: move `reactionFor` above the return and drop or adjust the hand-written memos that block preservation. Confirm with the compiler logger.
  - (b) Extract a `FeedRow` that takes the event, its reaction summary, count and saved flag as primitives, with id-taking callbacks, so a change re-renders one row.
  - (c) Structural: FlashList for the Feed, with a page cap.
- **Lower-risk alternative:** (a) alone. It removes the re-renders from unrelated state (comment sheet, sheets, busy), but not those from data arrivals.
- **Disruption risk:** (a) L, (b) L–M, (c) M–H. FlashList changes pagination `onScroll`, `scrollTo` reset, `RefreshControl`, the `feed-scroll` testID suites, `maintainVisibleContentPosition`, and the heights of the leading and trending headers.
- **Effort:** (a) small, (b) moderate, (c) moderate to structural.
- **Verification burden:** the Feed suites (`FeedPagination`, `CinematicFeed`, `FeedEngagement`, `CommentSheet`, `ActivityScreen` and others); the compiler logger; the FeedProfiler harness counts (expect 1 card render on one count change after (b)); a device Profiler or Perf Monitor trace.
- **Invariants touched:** Feed grouping and visibility (render only), reactions, comments, watchlist reconciliation (`mustReconcile`), spoiler masking.
- **Class:** A for (a)+(b), with impact provisional on device data; B for (c).

### F-RND-2: Feed image over-fetch and burst; For You queues behind it on Android

- **Journey:** cold start → Feed → For You (placeholders), and Feed → title.
- **Root cause:**
  - Rails use `posterUri(row.posterPath, 'card')` = `w500` for 84 pt tiles (3.9× pixels), and **all ≤12 tiles mount** (horizontal `ScrollView`).
  - Trending is `w500` for 92 pt (3.3×).
  - Every Feed card's images load at mount (unvirtualized), off-screen included.
  - On Android every `image.tmdb.org` request shares Glide's OkHttp `Dispatcher`: **5 per host, FIFO**, and `priority` cannot overtake requests already enqueued. So For You's first-screen tiles wait behind the Feed's below-the-fold backdrops and rail posters. iOS caps at 6 concurrent downloads.
- **Timeline:** cinematic heroes (a `w780` backdrop per card) reached production with the 11-12 OTA; rails with 11-17 (#312). **Before 11-12, production Feed rows were small `w342` thumbnails.** This is the most plausible rendering-side "it was fast before" window.
- **Evidence:**
  - [static] code and library reading;
  - [calc] pixel ratios. Example: a page of 20 posts with 5 grouped posts is about 15×0.34 + 5×12×0.375 ≈ **27.6 Mpx of TMDB images**, before Trending.
  - Prevalence of grouped posts on production is **not measured**: my bounded read-only aggregate was refused by the session's permission policy (evidence gap).
- **Confidence:** the over-fetch is Confirmed [calc]. Queue contention is Strongly supported [static]. The link to the founder's symptom is a Hypothesis.
- **Impact:** M–H (For You placeholders; data use).
- **Remedy:**
  - Rails and Trending → `'row'` (`w342`), which covers 252–276 px.
  - Render rail tiles beyond the first ~4 lazily: a horizontal `FlatList` with `initialNumToRender`, or mount on scroll.
  - Optionally `w154` for ActivityRow and `w154` for blurred fallbacks.
- **Lower-risk alternative:** the size change only, two call sites. Cost: a one-time cache miss for rail and Trending posters.
- **Disruption risk:** L.
- **Effort:** small.
- **Verification burden:** `PosterRails.test`, `TrendingShelf`, `CinematicFeed`; founder step 5 of the prior report (For You time to all posters) before and after.
- **Invariants touched:** none (presentation). The rail's "complete list" sheet is unchanged.
- **Class:** A.

### F-RND-3: OTA foreground reloads, delayed and frequent

- **Journey:** foreground return after any production OTA, and perceived startup.
- **Root cause:** `applyAnyUpdate` reloads after check plus download, seconds after the return. Each publish costs every active user one cold start with empty caches. The production cadence was 8 OTAs in 3 days, 4 of them on the morning of 11-24.
- **Evidence:** [static] `updates.ts`; [calc] the timeline; a 7.4 MB HBC bundle ([static] export artefact); the prior report's Preview launches 10 s apart [edge-log, staging].
- **Confidence:** Strongly supported. The count per device is unmeasured.
- **Impact:** M.
- **Remedy (process):** batch production OTAs, at most one per day outside emergencies.
- **Code alternative:** reload only if the download finished within ~1 s of the return, otherwise defer to the next cold start; or show "Update ready" instead of reloading. JS only, but fresh installs keep the embedded bundle's policy until a 1.2.0 binary, as the code's own note says.
- **Disruption risk:** L (process); M (code), because it changes how fast fixes reach users. The #198 install guard must be kept.
- **Effort:** small.
- **Verification burden:** `updates.test.ts`; EAS update insights.
- **Invariants touched:** session restore and onboarding safety (`isSafeToReload`).
- **Class:** A (process).

### F-RND-4: No per-journey or per-OTA production performance view

- **Journey:** every regression question, this audit included.
- **Root cause:**
  - The Sentry `release` is constant across OTAs.
  - No journey spans or TTFD; only idle navigation transactions and raw `http.client` spans, at 20%.
  - No image timing.
  - The recorder is off in production by design.
- **Evidence:** [static] (section 4); no Sentry API access.
- **Confidence:** Confirmed.
- **Impact:** H (diagnosability).
- **Remedy:** Option 1 in 4.3. **Lower-risk alternative:** read what already exists (navigation p75 by the `eas_update_id` tag) before adding anything.
- **Disruption risk:** L.
- **Effort:** small (a handful of call sites).
- **Verification burden:** a staging trace at a 1.0 sample rate; a scrubber test for the new attributes.
- **Invariants touched:** privacy (no ids or route params in attributes).
- **Class:** A.

### F-RND-5: Hidden tabs and screens keep rendering

- **Root cause:** `freezeOnBlur` unset and no `enableFreeze`. Visited tabs and stacked title pages re-render on every invalidation; the prior report counted 45–60 refetches after a log.
- **Evidence:** [static] vendored `BottomTabView.js:175–202`.
- **Confidence:** the configuration is Confirmed. The impact is a Hypothesis, and smaller since #378 deferred the post-log refresh.
- **Impact:** L–M.
- **Remedy:** `freezeOnBlur: true` on `Tabs` `screenOptions`, and possibly on stack screens. It is a JS option; react-native-screens is already native.
- **Lower-risk alternative:** freeze only the For You and Profile tabs.
- **Disruption risk:** M.
  - A frozen screen does not process updates until focused.
  - `useTabReset` listeners, the Feed's `BackHandler` focus effect and the trending `refetchOnWindowFocus` behaviour must be re-verified.
  - The jest suites do not exercise freezing.
- **Effort:** small.
- **Verification burden:** device QA of tab switching, pull to refresh and deep links.
- **Invariants touched:** none in data. It affects when a Collection or Watch History change appears on another tab.
- **Class:** B.

### F-RND-6: Image cache policy, no prefetch, no blurhash

- **Root cause:** the default `'disk'` skips the memory cache (Android `skipMemoryCache(true)`; iOS `.disk`), so each remount re-decodes and fades for 120 ms. Nothing is prefetched; for example, the title hero could be prefetched on press from the Feed or For You. Blurhash is wired in the UI but there is no data.
- **Evidence:** [static] expo-image source.
- **Confidence:** Confirmed.
- **Impact:** L–M.
- **Remedy:** `cachePolicy="memory-disk"` on `Poster`, `FeedCard` and `TitleHero`; `Image.prefetch(backdrop w1280)` on title press.
- **Lower-risk alternative:** memory-disk on `Poster` only.
- **Disruption risk:** L. The risk is memory pressure on old Android devices; Glide's memory cache is size-bounded.
- **Effort:** small.
- **Verification burden:** a device memory check.
- **Invariants touched:** none.
- **Class:** D.

### F-RND-7: Title screen render waves

- **Evidence:** [local-bench] 9–18 commits and 133–171 jest-ms of total render per open with staggered answers; 18 reads issued.
- **Root cause:** one 3,400-line compiled component owns ~25 queries.
- **Confidence:** Hypothesis that it matters on a device. Most of the fill-in is network order (prior report).
- **Impact:** L–M.
- **Remedy:** split sections (scores, Where to Watch, seasons, reviews) into components that own their queries. Structural.
- **Disruption risk:** M.
- **Invariants touched:** ranking entry points on the page, Watch History precedence (display).
- **Class:** F, until a device Profiler trace exists.

### F-RND-8: Trace headers on every request

- **Evidence and confidence:** Confirmed [static]; cost [calc] a few hundred bytes; latency impact L; no preflight.
- **Remedy:** `tracePropagationTargets: []`. It loses nothing today, because there is no backend tracing.
- **Risk / effort / class:** L, small, D.

### F-RND-9: Avatar size

- **Finding:** 512 px JPEGs for 32–44 pt (28× pixels at 32 pt) [calc].
- **Remedy:** a 192 px thumbnail at upload. Existing avatars are unchanged until re-upload.
- **Invariants touched:** avatar deletion (`delete-avatars`) would need to remove both files.
- **Class:** D.

### F-RND-10: Bundle carries all 18 Inter weights

- **Finding:** importing from `@expo-google-fonts/inter`'s index pulls every TTF into the export, about 6 MB of 12 MB of assets (`scratchpad/sentry-export.log` asset list). It affects the binary size and the first OTA asset download after a binary, not per-OTA bundles (assets are deduplicated by hash).
- **Remedy:** import the three weight files directly. Check the fingerprint (assets embedded).
- **Class:** D.

---

## Refuted hypotheses

- **"Images and API calls share Android's 5-per-host queue."** Refuted. Glide uses its own `OkHttpClient`/`Dispatcher` (`createClient()`), as does RN networking. Different hosts aside, even Supabase-hosted avatars do not queue with API calls.
- **"#368's 3:2 hero made Feed images bigger."** Refuted. Same `w780` URL; only the crop and frame height changed. It is in fact an under-fetch at 3x.
- **"#381 introduced a lasting regression."** Refuted. There is a one-time miss per device for For You posters; afterwards fewer bytes.
- **"For You moved to `w500` recently."** Refuted. It was `w500` in September's `9d9683a`; the prior report's "since 2026-11-06" is off. The For You size did not regress; what changed around it is the Feed's image burst (F-RND-2).
- **"Reanimated or worklet animations are a JS-thread cost."** Refuted. Reanimated is not imported anywhere.
- **"Sentry tracing triggers CORS preflights or adds material latency to Supabase calls."** Refuted (section 4.2).
- **"expo-updates blocks launch."** Re-confirmed as refuted: `fallbackToCacheTimeout: 0`, background `ON_LOAD`. Its cost is the later reload (F-RND-3).
- **"`onLayout`-driven re-renders on Feed cards are material."** Refuted, as before: one local re-render per card.
- **"Context churn re-renders the app often."** Refuted as material. `AuthProvider` re-renders consumers only on auth events.

## Evidence gaps (and the smallest follow-up)

1. **Sentry production data** (no access; proxy 403). The founder reads navigation and app-start p75 by `eas_update_id`, OTA 3 → OTA 8.
2. **Device render cost.** One device Profiler or Flipper/Perf Monitor capture of: Feed with ~40 cards, tapping Like; and opening the comment sheet.
3. **Image bytes and latency** (`image.tmdb.org` blocked here). Fetch one `w342`, `w500` and `w780` sample from a machine with access, and record the founder's For You timing (prior report, step 5).
4. **How common grouped posts are on production** (my read-only aggregate over `feed_events` was refused by the session's permission policy). The DB worker or coordinator can run: share of 14-day `ranking_batch`/`watchlist_added` events with `payload->>'count' > 1`, and the average of `min(count, 12)`.
5. **Reloads per device per OTA.** EAS update insights (launches per update) or Sentry sessions by `eas_update_id`.
6. **Whether image loads continue in detached tabs.** A device log of Glide requests while For You is hidden.
7. **Whether babel-preset-expo's compiler options differ from my scratch run.** I used compiler defaults plus `panicThreshold: 'none'`. The `FeedScreen` bailout reason is structural, so this is low risk. A one-line check: build with `logger` in `babel.config.js` in a scratch copy.
