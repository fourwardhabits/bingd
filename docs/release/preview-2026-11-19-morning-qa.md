# Preview 2026-11-19: morning integrated QA candidate

**Integration commit:** `bf721a9a` (branch `integration/preview-1120`):
- `main` `a3300bf0`, which is #320 and #323;
- #319 at `5e40acc8`, cross-category drag-to-rerank;
- #321 at `2b50825b`, the searchable companion picker.

**Workstream C (#322) is not included.** Its re-review was still pending at publish time, and it stays isolated.

## Staging backend (`fjxhcbowoxuzulwirzyr`)
- Migration `20261129000200_a_move_across_a_line` applied in its own transaction and recorded. The migration head is now `20261129000200`, with 205 versions and none pending against `bf721a9a`.
- `rank_reorder(uuid,integer,uuid,integer,uuid,taste_bucket,taste_bucket)` is executable by `authenticated` and not by `anon`.
- `rerank-cross-staging-smoke.mjs` passed 14/14 on disposable accounts, which were deleted afterwards. It covered:
  - the founder's case: 10.0 dragged onto an It was fine title became It was fine at 5.2, and that persisted on a fresh read;
  - the `user_media` row agreeing with the new category;
  - the latest watch's post following the move;
  - Undo restoring 10.0;
  - a move up from It was fine;
  - an installed client's same-category call still working;
  - 22023 and 55000 refusals;
  - no post, comparison or watch created;
  - four manual placements;
  - I1–I4 and P1–P4.
- Rollback: `pr319/rollback-20261129000200.sql`, rehearsed.

## Publish
- Clean detached checkout of `bf721a9a` with a real `npm ci` (no symlinked dependencies).
- Fingerprints before publishing: Android `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` and iOS `ef07f4b898dc935a022f24c388a75358aa4fcc23`, which equal the installed Preview runtimes.
- `npm run update:preview -- --platform all`:

| Platform | Update | Group | Runtime |
|---|---|---|---|
| Android | `01a1f2f7-3efe-7730-adcf-1033aadb0c29` | `226c4345-d4ad-451a-9815-a9009b1dbb0b` | `2503ffaa…` |
| iOS | `01a1f2f7-3efe-7277-8143-7970fb14e6d0` | `d0f1bafb-3329-4521-be28-3f398751ca10` | `ef07f4b8…` |

- Live manifest: the `preview` channel serves both, at commit `bf721a9a`. The EAS preview environment points at the staging backend (`fjxhcbowoxuzulwirzyr`).
- Previous Preview, which is the rollback target: `f010b51f`, with groups `28ff2ad6-63cd-4457-bea4-3baa25b633c8` (Android) and `34da676e-c3a9-4c75-9e08-f29cef90f732` (iOS).
