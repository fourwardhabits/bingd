# Protected behaviour register

This register is for whoever implements an approved remedy. For every candidate it gives:
- the contracts the remedy could break;
- the tests that guard them today;
- the gaps in those tests;
- the regression checks the remedy must pass.

**A remedy whose material correctness risk is unresolved is not low-risk, whatever it saves.**

## 1. Contracts and their guards

| Contract | Where it is guaranteed | Automated guards |
|---|---|---|
| **Ranking I1–I7**: gapless unique positions (I1, I4); band order (I2); every ranking has its collection row (I3); exactly-once (I5); provisional re-rank (I6); one completed ranking is one Feed activity (I7) | RPCs only (AD-4): `_rank_finalize` under the category lock (`20261129000300:65`); operation claims (`20260825000200:625,664`); `assert_ranking_valid()` | `supabase/tests/ranking-contract.test.mjs`, `watch-again.test.mjs`, `ranking*.test.mjs`, `collection-rerank.test.mjs`, `ranking-undo`, `ranking-resume-integrity`, `tv-show-ranking`, `correction-is-not-a-ranking`; the concurrency suite (`supabase/tests/concurrency`) and its mutants |
| **Watch History**: no lost viewings, dates or notes; precedence | `log_*`, `edit_/delete_watch_event`, `save_note`; `20261003000100:1278–1282` | `lists-and-watch-history`, `rewatch`, `watch-details`, `recording-is-not-watching`, `watch-events-backfill` |
| **No stale cross-screen state after a successful write** | `invalidateAfterCollectionChange` / `…WatchlistChange` (`src/features/collection/invalidate.ts`) | `src/features/collection/invalidate.test.ts` (key coverage); `open-first.test.ts`, the LogSheet and RankingSheet hold tests (#378) |
| **Feed**: grouping (one window per author, two posts), visibility, reactions, comments, replies, no duplicate notifications | Feed SQL (`20261130000900`, `…001000`), `can_view_profile` | `feed-group-previews`, `ranking-grouping*`, `reviewed-rankings-group*`, `comments*`, `comment-*`, `notification-*`, `feed-order-index`, `feed-score-is-current`; jest `FeedPagination`, `CinematicFeed`, `FeedEngagement`, `CommentSheet`, `ActivityScreen` |
| **Auth and privacy**: session restore; sign-out; **no cross-account cache leakage**; RLS | `queryClient.clear()` on both sign-out paths (`src/features/auth/session.tsx:217–218, 233–238`); `session-storage.ts` revision checks and failed-write invalidation (`:329–359`); RLS policies | `sign-out-safety.test.tsx`, `methods.signout.test.ts`, `account-escape.test.tsx`, `hydration.test.tsx`, `rls.test.mjs`, `review-visibility-cross-account`, `recommendation-read-privacy`, `award-privacy` |
| **Recommendations**: relevance, filters, dismissals, V2 rollback | `use-for-you.ts` gating (`:970–978`), `use-engine.ts` re-read | `for-you-*` jest suites, `recommendation-feedback` |
| **Notification delivery and preferences** | `my_notifications`, `notification_preferences`, push-sender | `notification-preferences`, `notification-context`, `proactive-notifications` |
| **Imports** | import pipeline | `import-*.test.mjs` |
| **Titles, seasons and scores**: correct presentation; at most one TMDB request per enrichment | `use-enrichment.ts` (`useEnrichOnce`, the #378 videos-facet gate) | `use-enrichment.test.ts`, `TitleScreen.test.tsx` (request order, the #378/#381 tests) |

## 2. Candidate remedies mapped to risk

| Remedy | Files / modules | User-visible behaviour touched | API / data / authz change | Invariants | Failure modes | Existing tests | Missing tests | Device QA | Native / migration | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|
| **P1** compute upgrade | none (Supabase dashboard) | none | none | session restore across the restart | brief outage; reconnect storms | n/a | n/a | none | no | downgrade compute |
| **P2** PostgREST idle timeout | none (PostgREST config) | none | none | none (no per-user state in the pool; role and claims are set per transaction) | more idle backends using memory on Nano (do it after P1) | n/a | n/a | none | no | revert the setting |
| **P3** OTA cadence | release process | updates arrive later | none | none | a slower path for fixes | n/a | n/a | none | no | n/a |
| **P3b** persisted cache | `src/lib/query.ts`, `app/_layout.tsx`, `session.tsx` | instant last-known screens | none | **no cross-account leakage**; owner-only data (notes, watch dates, goals, `log-state`) must not reach disk unencrypted | another user's data shown after an account switch; stale personal state on screen | `sign-out-safety`, `account-escape` | per-account keying; purge on both sign-out paths **before** `clear()`; no restore until `getSession` names the same user; exclusion list; restore treated as stale | Dev2 (account switch, sign-out, reinstall) | no (`expo-sqlite/kv-store` is already native) | disable the persister; purge the store |
| **P4** single refresh per ranking | `LogSheet.tsx`, `RankingSheet.tsx`, `open-first.ts` | none | none | no stale state after cancel or failure | a cancel path that never refreshes | `open-first`, LogSheet/RankingSheet hold tests | "exactly once on placed / cancel / failure / unmount" | Dev1 (Android, quick taps) | no | revert the commit (OTA) |
| **P5** deferred invalidations | `invalidate.ts`, `use-rerank.ts`, tab options | a deferred surface can show the pre-write value for ≤ 1 round trip on return | none | "no stale cross-screen state" becomes "on view"; award revocation; spoiler unmasking (`watched` must refetch before the Feed paints) | stale Collection, Watchlist or score after a write; a spoiler shown | `invalidate.test.ts` | deferred keys asserted stale and refetched on focus; the fan-out request-count harness | Dev1 (write → switch tab) | no | revert (OTA) |
| **P6** title critical-first ordering / merged personal reads | `app/title/[id].tsx`, personal-state hooks | none if done right | none | Rank/bucket gating on personal state; title correctness | a missing personal state; Rank shown when already ranked | the `TitleScreen` order tests (#381) | the merged-read equivalence | Dev1 | no | revert (OTA) |
| **P7** OkHttp per-host limit | config plugin (native) | none | none | none | image and API concurrency both change; server burst load rises | n/a | n/a | Dev2 | **native: new binary** | ship the previous binary |
| **P8** rail/Trending w342, lazy rail tiles | `PosterRails`, `TrendingShelf` | slightly softer artwork at 3x (within 2%) | none | none | blur on very large phones | `PosterRails.test`, `CinematicFeed` | — | Dev1 (look) | no | revert (OTA) |
| **P9** Feed compiler fix / row component / FlashList | `app/(tabs)/feed.tsx` | (c) scrolling and pagination behaviour | none | Feed grouping and visibility, reactions, spoiler masking, `mustReconcile` | lost scroll position; pagination double-load; stale row | the Feed suites | the FeedProfiler render-count assertion | (a) none, (b) Dev1, (c) Dev2 | no | revert (OTA) |
| **P10** `report_device_context` shortcut | migration | none | **function body** | timezone used by proactive and release scheduling | a valid new zone rejected or an invalid one accepted | — | pgTAP accepted and rejected zones | none | **migration** | rollback SQL |
| **P11** `my_notifications` lateral gate | migration | none | function body | the `watchlist_social` hide rule; `can_discover_profile` | `watchlist_social` rows shown or hidden wrongly | `proactive-notifications`, `notification-*` | output equality on a recipient sample | none | **migration** | rollback SQL |
| **P12** journey spans | `src/lib/monitoring.ts` and 5 call sites | none | none | **privacy**: no ids, route params or titles in span names or attributes | PII in telemetry; overhead | `release.test.ts` scrubber tests | a scrubber test for the new attributes | one staging trace | no | revert (OTA) |

## 3. Persisted cache: the guarantees it must keep (if ever approved)
1. **Per account.** The store key includes the account id and the runtime. The store is **deleted on `SIGNED_OUT` and on the local sign-out path, before `queryClient.clear()`**, and nothing is restored until `getSession()` resolves to the same user.
2. **Allowlist only.** Feed, rankings/collection, own profile, For You and title rows. **Excluded:** owner-only data (`log-state`, watch history, goals, private notes), unless encrypted.
3. **Restored entries are stale.** `staleTime` is 0 on hydrate and `maxAge` is at most 24 h, so the first burst reconciles them.
4. **Tests must cover:** account A signs out and B signs in on the same device, and nothing of A appears; reinstall; token expiry during restore.

## 4. What must not change for performance
- **Ranking writes stay in the RPCs.** No client-side or parallel position writes, no cached-band insertion, no splitting of collection and ranking updates, and no regenerated operation ids on retry (I1–I6).
- **I7 semantics stay intact.** Do not suppress Feed writes wholesale.
- **RLS and privacy stay intact.** Do not remove `can_view_profile` / `can_discover_profile` from Feed, preview or leaderboard reads. Do not cache viewer-authorised results across viewers.
- **The cache is never shared across accounts.** No unpartitioned persisted cache.
- **Watch history stays complete.** Do not collapse repeated viewings into one date, and do not skip the reconciliation after history edits.
- **Do not raise the PostgREST pool on Nano.** It adds memory pressure; upgrade compute first.
