# Codex pass 1: independent investigation questions

These questions go to Codex before Claude's findings exist, so the answers are independent. Each one should be answered **against the code on this branch** (main `32790c48` plus docs). Separate what the code proves from what is suspected.

The founder reports slowness on physical devices that is new: title scores, Where to Watch, seasons and episodes all fill in late; For You poster placeholders linger; the first ranking comparison is sometimes slow.

1. Which merges since 2026-11-01 plausibly added latency on these journeys, and which pre-existing designs explain it instead? Look at title (`app/title/[id].tsx`), For You (`app/(tabs)/recommendations.tsx`), ranking (`src/features/ranking/`), Feed (`app/(tabs)/index.tsx`, `src/features/feed/`) and Collection.
2. Shared bottlenecks:
   - `src/lib/query.ts` defaults;
   - invalidation fan-out after writes (`src/features/collection/invalidate.ts`, the ranking and log paths);
   - the absence of a persisted query cache;
   - startup and session restore (`src/features/auth/session.tsx`, `src/lib/session-storage.ts`);
   - image sizing and caching (`src/ui/components/Poster.tsx`, `posterUri`);
   - unvirtualized lists (Feed, For You);
   - RLS-heavy SQL (`supabase/migrations`);
   - cron and background load.
3. What do you think `docs/perf/preview-slowdown-2026-11-24.md` overlooks, overstates or gets wrong?
4. What instrumentation is missing to measure real p50/p95 per journey and per release (`src/lib/monitoring.ts`, `src/lib/flight-recorder.ts`)?
5. Which plausible optimizations could break the ranking invariants I1–I7 (`docs/architecture/ranking.md`), cross-account cache isolation (`queryClient.clear()` on sign-out), Watch History integrity, or Feed/social correctness?
