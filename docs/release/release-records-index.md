# Release records, 2026-11-15 to 2026-11-20

**Imported 2026-11-20** from branch `ops/preview-1115-records` at `c4b966a2`. These are the
manifests, execution records and handoffs written while releases 1115 through #331 shipped.
Until this import they lived only on that branch. The branch is kept as history.

The records are **historical**: each one describes the state when it was written, and none was
edited during the import except the two plans in `docs/plans/`, which gained a dated status
line. What is in production now is in [`production-state.md`](./production-state.md).

## Production releases

| Date | Record | What shipped |
|---|---|---|
| 2026-11-15 | [`manifests/production-2026-11-15-1115.json`](./manifests/production-2026-11-15-1115.json) | Release 1115 (#307), which carried Onboarding 2.0 and Rec V2 (shipped dark) |
| 2026-11-15 | [`manifests/production-2026-11-15-polish-a.json`](./manifests/production-2026-11-15-polish-a.json) | Polish A (#309, the Tier A slice of #308), app only |
| 2026-11-16 | [`manifests/production-2026-11-16-pr308.json`](./manifests/production-2026-11-16-pr308.json) | #308 post-QA refinements and the founder QA closure |
| 2026-11-16 | [`manifests/production-2026-11-16-feed-grouping.json`](./manifests/production-2026-11-16-feed-grouping.json) | Feed grouping: #310 watchlist sessions, #311 backlog half hours |
| 2026-11-17 | [`manifests/production-2026-11-17-feed-rails.json`](./manifests/production-2026-11-17-feed-rails.json) | Feed poster rails (#312) and expanded grouping (#313) |
| 2026-11-17 | [`qa/production-2026-11-17-feed-consolidation.json`](./qa/production-2026-11-17-feed-consolidation.json) | Historical Feed consolidation: 115 groups, 702 posts, reversible |
| 2026-11-20 | [`production-2026-11-20-319-321.md`](./production-2026-11-20-319-321.md) | #319 drag-to-rerank and TV promotion, #321 companion picker (OTA `1c24b5cd`) |
| 2026-11-20 | [`production-2026-11-20-328.md`](./production-2026-11-20-328.md) | #328 30-minute first-ranking grouping (database only) |

#329 (logo-only Welcome email) and #331 (the `bingd-welcome-dispatch` pg_cron job) have no
separate record on the branch. They are recorded in
[`production-state.md`](./production-state.md).

## Preview and staging

- [`preview-2026-11-19-morning-qa.md`](./preview-2026-11-19-morning-qa.md): integrated QA candidate.
- [`preview-2026-11-20-drag-fix.md`](./preview-2026-11-20-drag-fix.md): #319 drag stability fix.
- [`preview-2026-11-20b-final-qa.md`](./preview-2026-11-20b-final-qa.md): #319 final refinements and TV direct ranking.
- [`preview-2026-11-21-wsc.md`](./preview-2026-11-21-wsc.md): #322 follow-story reactions and comments. **Staging and Preview only, not released.**
- [`pr319/runbook-staging-preview-f010b51f.md`](./pr319/runbook-staging-preview-f010b51f.md) and [`pr319/execution-2026-11-19.md`](./pr319/execution-2026-11-19.md): #319's staging migration runbook and its execution record. [`pr319/rollback-20261129000100.sql`](./pr319/rollback-20261129000100.sql) joins the two rollbacks already on `main`.

## QA and Feed records

- [`qa/2026-11-16-pr308-closure.md`](./qa/2026-11-16-pr308-closure.md): #308 automated QA closure and the staging social fixture (synthetic `qa_fx_*` accounts).
- [`qa/2026-11-16-feed-rails-and-grouping.md`](./qa/2026-11-16-feed-rails-and-grouping.md): poster rails and expanded grouping.
- Consolidation evidence: [dry run](./qa/2026-11-16-consolidation-dryrun-production.json), [full-history dry run](./qa/2026-11-17-consolidation-dryrun-full-history.json), [precheck](./qa/2026-11-17-consolidation-precheck-production.txt), [plan](./qa/2026-11-17-consolidation-plan-production.txt), [apply](./qa/2026-11-17-consolidation-apply-production.txt).
- [`feed-grouping-production-reconciliation-2026-11-19.md`](./feed-grouping-production-reconciliation-2026-11-19.md): #310 to #313 checked against production.

## Handoffs

- [`handoff-2026-11-16-overnight.md`](./handoff-2026-11-16-overnight.md)
- [`handoff-2026-11-17-feed-closeout.md`](./handoff-2026-11-17-feed-closeout.md)
- [`handoff-2026-11-17-engineering-closeout.md`](./handoff-2026-11-17-engineering-closeout.md)
- [`handoff-2026-11-20-morning.md`](./handoff-2026-11-20-morning.md)
- [`handoff-2026-11-20-final-qa.md`](./handoff-2026-11-20-final-qa.md)

## Plans

- [`../plans/follow-activity-engagement-requirements.md`](../plans/follow-activity-engagement-requirements.md) and [`../plans/follow-activity-engagement.md`](../plans/follow-activity-engagement.md): the requirements audit and reconciled plan behind #322.

## Left on the branch, and why

Read any of these with `git show origin/ops/preview-1115-records:<path>`.

- **One-off operator scripts.** `docs/release/pr319/*.py` and `*.mjs`, `docs/release/pr328/prod-migrate-328.py`, `docs/release/pr331/prod-migrate-331.py`, `scripts/ops/consolidation-*` and `prod-consolidate.py`, and `scripts/staging-checks/*.mjs`. Each was pinned to one release, and several apply migrations to a named project. On `main` they would look like maintained tooling, which they are not. The records above name them as evidence.
  - The consolidation can still be reverted without the script: `revert_feed_consolidation('<batch>')` is a database function, and the batch names are in the consolidation record.
- **Three Preview manifests** (`preview-2026-11-15-1115.json`, `preview-2026-11-15-before-1115.json`, `preview-2026-11-15-pr308.json`). `config/release-manifest.test.mjs` checks every manifest here against `config/live-runtimes.json`. These three need the Preview iOS binary that the branch adds to that file. That file is release tooling config, not documentation, so it is not changed by a docs import. Import them together with that config change.
- **The branch's edit to `manifests/preview-2026-11-14-pass4.json`**, which fills in full group ids. It depends on the same config change.
- **Path change.** On the branch the consolidation record sits at `manifests/production-2026-11-17-feed-consolidation.json`. It is not a release manifest and fails the manifest schema, so it is imported at `qa/production-2026-11-17-feed-consolidation.json`. The records that cite the old path were not edited.
