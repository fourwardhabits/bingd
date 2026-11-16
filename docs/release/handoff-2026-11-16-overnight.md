# Overnight handoff, 2026-11-16 (living record; newest state at the bottom)

## State at 07:45Z

- **Production:** #308 is published at `fb44d469`.
  - Record: `docs/release/manifests/production-2026-11-16-pr308.json`.
  - Healthy: live manifest ok, u.expo.dev targets production only, anon smoke 137/137.
  - Backend: 199 migrations, head `20261124000100`. The grouping flags don't exist in production yet.
- **Feed grouping:** the combined candidate is #311's head, `80f72210` = main `fb44d469` + #310 + #311.
  - Codex: no findings on `80f72210`. Earlier findings were all fixed with tests:
    - the late-note orphan, fixed with `feed_ranking_sitting_joins` and the actor lock in `rank_batch_note`;
    - the ranking sheet's `staleTime: 0`.
  - Local: tsc 0, lint 0, jest feed 442, test:db 3281/0, races 208/208 (RG4 new).
- **Staging:**
  - Both migrations are applied byte-identical to the files at `80f72210`.
  - Both grouping flags are true.
  - `scripts/staging-checks/feedgroup-staging.mjs --ranking` passes 24/24.
- **Preview:** both platforms serve `80f72210` on the installed runtimes, read back ok, staging only.
  - Android group `767a4229`, iOS group `db9a6fb3`.

## Remaining release order

The founder authorized this order on 2026-11-16.

1. CI on `80f72210` green.
2. Merge #310, then #311, into main with merge commits. Verify the final main tree equals `80f72210`.
3. Push `release/2026-11-16-feed-grouping` at the final main SHA. Wait for the release gate and for main CI.
4. **Production backend, never concurrent with anything else:**
   - Pre-insert `feed.watchlist_grouping_enabled` and `feed.ranking_grouping_enabled` as `false`.
   - Run `prod-migrate.py` dry-run from a clean checkout of the final main SHA. Expect exactly `20261125000100`, then `20261126000100`.
   - Apply. Verify: 201 migrations, flags still false, anon smoke.
5. `ota-production-check`, then `ota-production` at the final SHA. Health: live manifest, u.expo.dev, anon smoke.
6. Enable both flags. Post-release checks: anon smoke; read-only verification of functions, tables and grants. No production test accounts.
7. Record a manifest with the rollback pair:
   - **Rollback pair:** #308's groups (Android `30bf8eef`, iOS `cacbef1e`).
   - **Database rollback:** set both flags false. The migrations are not reverted.

## Rollback references

- **Production OTA before Feed:** Android `30bf8eef-acc3-4946-9126-db55ae9110c9`, iOS `cacbef1e-0ab1-4ed1-bed6-037e17a142a0` (`fb44d469`).
- **Production OTA before #308:** Android `46fd8420-8ac6-4183-86b3-18a19f8af07d`, iOS `4c6412a8-9b40-4b80-8713-75eeba728f11` (`979e3c21`).
