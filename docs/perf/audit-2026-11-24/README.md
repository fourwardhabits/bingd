# Performance & regression audit, 2026-11-24/25

**Audit-only.** Nothing in this folder changes app behaviour, and nothing was deployed for it.

## Why
The founder reports noticeable delays in Production and Preview that were "not previously apparent". The reported symptoms:
- title pages show artwork before scores and secondary info;
- Where to Watch arrives late;
- For You poster placeholders linger;
- the first ranking comparison is sometimes slow;
- seasons and episodes fill in progressively.

Several fixes have already shipped: #378, #381, and #380 for observability.

## Questions
1. What is causing the slowdown now, compared with earlier versions?
2. Which broader inefficiencies or architectural limits should be addressed as usage grows?

## Deployed state at the start of the audit
- **Production:** OTA 8 from `32790c48` on Android and iOS, on the 1.1.0 (15) runtimes. 217 migrations, head `20261130001300`.
- **Android Preview:** the same commit, against the staging backend.

## Deliverables
- `regression-analysis.md`
- `performance-baseline.md`
- `findings.md`
- `functionality-preservation.md`
- `codex-review.md`
- `decision-brief.md`

**Start with `decision-brief.md`.** The `evidence/` folder holds the four investigation reports (regression, client, backend, rendering), with every number labelled by its source. `codex-pass1-questions.md` is the brief Codex reviewed in its independent pass.

**Production safety.** The audit made read-only Production queries and edge-log reads (aggregated, no identifiers published), ran rolled-back EXPLAINs, ran local jest harnesses (not committed) and did one rolled-back `rank_start` on staging. Nothing was written, deployed, configured or migrated.
