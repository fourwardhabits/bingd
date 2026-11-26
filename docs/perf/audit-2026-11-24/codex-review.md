# Codex review and reconciliation

## How Codex was used
- **Q&A mode is not available.** The `@codex` question mode needs a Codex cloud environment, which this repository does not have; the bot replied "create an environment".
- **Both passes therefore used `@codex review`, with explicit instructions, on PR #384.** In each, Codex was told to answer against the application code and to be analysis-only.
- **Pass 1 was independent.**
  - **What Codex saw:** only the charter and a questions file (`codex-pass1-questions.md`).
  - **What it did not see:** none of Claude's findings existed yet. Claude's four investigations were running in parallel and were not shared.
  - **Result:** 8 review comments (Q1–Q5) on commit `ecbfa7ed`.
- **Pass 2 was a challenge review.** Codex reviewed `findings.md`, `regression-analysis.md`, `performance-baseline.md` and `functionality-preservation.md` on commit `27a23180`, and was told to try to break them. It produced 3 findings.
- **Limits.** Codex worked from static code only. It had no access to the device, the database or the logs. Its claims are code-proven or suspected, never measured.

## Pass 1: independent findings, and how they were reconciled

| Codex point | Outcome | Evidence |
|---|---|---|
| **New work since 11-01 is real and includes things the #378 report missed:** the `recommendation_engine` read gating the For You slate (#307, `use-for-you.ts:970–978`); grouped Feed previews and their invalidation (#312); series reviews (#364). The #378 report "overextends" in saying no PR added a request | **Accepted.** #312 and #364 are confirmed by the regression harness and edge logs. The engine gate was verified in code (`enabled: … !engineQuery.isPending`). It is one more request in the first wave, not a serial round trip | `regression-analysis.md` (small additions); finding P18 |
| Measure active observers, not invalidated keys | **Accepted.** The client investigation counted real mounted refetches: 45–47 per write, 92 per ranking [local-bench] | P4, P5 |
| The session mirror already exists, so "add an in-memory session cache" is not new; attribute startup waits by stage | **Accepted.** The client investigation independently refuted SecureStore-read-per-request and lock contention. The remaining stall is the refresh plus durable write (P22, class F) | P22 |
| For You is already at `w342`; image delivery versus eager rendering must be measured separately | **Accepted.** For You moved to w342 in OTA 8. The rendering investigation found the remaining over-fetch in the Feed's rails and Trending, still at w500 (P8). Virtualization stays "investigate further" pending device data (P9) | P8, P9 |
| SQL and cron contention need plans and real load, not schedules | **Accepted, and measured.** Plans were run (warm SQL is 0.04–13 ms). Cron busy time fell from about 750 to about 230 s/day. The remaining cron effect is a 2–2.7 s spike every 15 min (P14) | `evidence/backend-evidence.md`, `evidence/regression-evidence.md` §4.3 |
| Episodes still wait for enrichment, which awaits invalidation refetches before settling (`use-enrichment.ts:109–124`) | **Accepted as a new hypothesis.** Neither Claude investigation raised it. Recorded as P19, class F | P19 |
| Server-arrival gaps are not purely client time; a first-in-first-out replay is not the handset's dispatcher; three warm runs are not p95 | **Accepted.** All simulated numbers are labelled [sim]. Production p50/p95 come from the edge logs (n per path given), not from EXPLAINs | Labels throughout |
| An instrumentation contract is needed: user action to useful completion, with outcomes and denominators | **Accepted, and adopted as the P12 design.** It goes further than the rendering investigation's five spans: outcomes and denominators are added | P12 |
| Correctness boundaries: ranking RPCs, operation claims, the category lock, I7, cache partitioning, watch-history completeness, privacy predicates | **Accepted in full.** Mapped into `functionality-preservation.md` §1 and §4 | — |

## Pass 2: challenges, and how they were reconciled

| Codex challenge | Outcome | Evidence |
|---|---|---|
| **P6's duplicate personal read does not run on an ordinary open.** `loggingTitle` starts null, `LogSheet` returns early, and `useLogState` reads only `user_media` and `rankings`. The scores already precede providers and reviews after #381 | **Accepted. P6 corrected and downgraded from A/B to D.** Claude verified `[id].tsx:335`, `LogSheet.tsx:286` and `use-log-state.ts:111–124`. The client investigation's harness attributed a set of reads to `log-state` that do not occur on a normal open. The scores are 6th and 7th, so at most one queue round remains to gain | `findings.md` P6 |
| **The persisted-cache allowlist leaks owner-only fields.** `useLoggedCollection` keeps `watched_on`, and the title's personal query carries dates and notes | **Accepted.** §3 of `functionality-preservation.md` now requires a field-level sanitised projection or encryption, plus a test that inspects the serialised store. P3b stays class B, "investigate further" | `functionality-preservation.md` §3 |
| **P4 understates the impact:** on a cache miss, the first comparison card needs a `media_items` read issued after the hold is released, so the refresh can delay the comparison becoming usable, not only the first answer | **Accepted.** Added to P4. This strengthens the case for P4's remedy (keep the refresh until placement). The cached and uncached paths still need separate device measurement | `findings.md` P4 |

## Disagreements and what remains uncertain
- **No disagreement was left unresolved.** Where Codex and an investigation conflicted (P6), the code settled it in Codex's favour.
- **Claude's root-cause emphasis was not challenged by Codex in pass 2.** That emphasis is P1/P2 (Nano compute and cold connections) and P3 (cold-start frequency). Codex had no access to the edge logs that support it. **Those findings rest on Claude's measured evidence alone, with no independent check.** The founder can confirm P1/P2 cheaply by re-running the edge-log gap query after a compute change.
- **Unmeasured on both sides:** device render and image cost (P8, P9), iOS concurrency, and the real cached-versus-uncached split of the first comparison (P4).
