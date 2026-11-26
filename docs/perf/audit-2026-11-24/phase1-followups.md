# Phase 1 follow-up investigations: P9a and P12

Both were investigated only, as authorized. **Neither is implemented.**

## P9a: React Compiler on the Feed screen

**Recommendation: do not ship P9a on its own.** Making the screen compilable is easy. It does not reduce renders, because the re-render comes from the inline card list, not from compilation.

**Why the compiler skips `FeedScreen` today.** The probe is a babel run of `babel-plugin-react-compiler` with a logger, on scratch copies, nothing committed.

**Blocker 1 (as-is).** The compiler reports: "Support functions with unreachable code that may contain hoisted declarations". The cause is `function reactionFor(…)` declared after the component's `return` (`app/(tabs)/feed.tsx:1290`).

**Blocker 2 (with `reactionFor` moved above the return).** The compiler reports: "Existing memoization could not be preserved" at `feed.tsx:209`. That line is the board pull-to-refresh `useCallback`, whose dependencies are `[leaderboard.refetch, standing.refetch]`. The compiler infers `leaderboard` and `standing` instead.

**With both fixed, `FeedScreen` compiles (`CompileSuccess`).** The second fix lifts `refetch` into locals and uses them as the dependencies. Both changes were scratch-only. All 639 Feed tests pass with them.

**Measured effect** [local-bench]: the audit's FeedProfiler jest harness, 3 runs each at N = 10, 30 and 60 cards.

| | Before | Compiled |
|---|---|---|
| Card renders on one comment-count change (N=60) | 60 / 60 / 60 | 60 / 60 / 60 |
| Card renders at mount (N=60) | 180 (3 per card) | 180 (3 per card) |
| Update commit, jest ms (N=60) | 89 / 78 / 71 | 149 / 84 / 103 |
| Mount actual, jest ms (N=60) | 380 / 307 / 388 | 391 / 326 / 556 |

Jest timings are noisy and are not device timings. The render counts are exact and unchanged.

**Why.** The cards are rendered inline in `events.map`, and the map depends on the counts, reactions and saved-state maps. Any change to those re-creates every card element, compiled or not. Only a per-row component would let a single count change re-render one card. That is P9b in the register: moderate effort, and it touches Feed reactions, comments, bookmarks, spoiler masking and `mustReconcile`.

**Next step if wanted.** First get a device render profile: React DevTools or the Perf Monitor on a long Feed. Proceed to P9b only if that profile shows Feed re-render cost the founder can feel.

## P12: privacy-safe journey timings at zero additional cost

**What production already records.** All of it is on by default in `@sentry/react-native` 7.11 (`src/lib/monitoring.ts`), sampled at `tracesSampleRate` 0.2 and tagged `eas_update_id`, `eas_channel` and `build_kind`.
- Navigation transactions with **time to initial display** (`enableTimeToInitialDisplay: true`).
- **App start** cold and warm measurements on the first transaction.
- **Slow, frozen and stall frames** per transaction.
- `http.client` spans for every request.

**What can be read today, with no change and no cost:**
- cold start and navigation p75 or p95 per OTA, filtered by the `eas_update_id` tag;
- the slow-frame share per screen;
- request spans per transaction.

**What is missing.** "Useful content" completion: the moment the title scores, the first For You posters, the first comparison and the first Feed page are actually drawn. Initial display fires at the first frame, before the data arrives.

**Smallest proposal (not implemented).** Turn on Sentry's **time to full display** (`enableTimeToFullDisplayTracing: true`). Then mark each journey's "useful" moment with `<TimeToFullDisplay record={ready} />` on five screens:
- Feed (first page hydrated);
- title (row plus both scores settled);
- For You (first-screen posters loaded);
- the ranking sheet (first comparison card shown);
- cold start (falls out of the first Feed full display).

**Cost:**
- **Volume.** It adds **one span to transactions that are already sampled**. It adds no new transactions and no new events.
- **At current traffic** [calc]: a few hundred navigations a day × 0.2 sampling gives a few dozen extra spans a day.
- **Plan dependency.** On a transaction-billed Sentry plan, spans inside a transaction carry no extra charge. On a span-billed plan, the increment is about one span per sampled navigation, against dozens of `http.client` spans per transaction already.
- **Verify before enabling.** This audit has no Sentry API access. Check the plan's billing unit and current usage in Sentry → Settings → Subscription. If the plan is span-billed and near its quota, keep the sample rate and drop to two journeys (title and first comparison).

**Privacy.** Use fixed span names only. Include no route params, titles, ids, notes or dates. Add a scrubber test in `release.test.ts`.

**Delivery.** JS-only OTA; no native change and no new dependency. **Verification:** one staging trace at sample rate 1.0, plus the scrubber test.

**Limits.** It measures on-device completion only for the sampled 20%. Image *display* timing still needs an `onLoad` hook on `Poster`, which is a separate and slightly larger change.
