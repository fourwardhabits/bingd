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

## State at 08:30Z: Feed grouping shipped

- **Production:** OTA `9d11a797` (Android `b82a0376`, iOS `0c141d10`).
  - Backend: 201 migrations, head `20261126000100`. Both grouping flags were enabled at 08:26:36Z.
  - Record: `docs/release/manifests/production-2026-11-16-feed-grouping.json`.
- **Health after enabling:** anon smoke 137/137. Integrity reads are clean: 232/232 watchlist groups with members, 0 stale drafts.
- **Rollback:** flags off first, then republish #308's groups if needed. Never revert the migrations.

## 08:41Z health check (15 minutes after the flags went on)

- **Flags:** both on.
- **Integrity:** 0 orphaned groups, 0 count mismatches, 0 stale drafts.
- **Smoke:** anon 137/137.
- **Live manifest:** production ok.
- **Real activity since the flags went on:** none yet (0 new watchlist or ranking posts), so grouping is not yet exercised by real users in production.

## Morning handoff

### Shipped
- **#308 in production:** OTA `fb44d469` (Android `30bf8eef`, iOS `cacbef1e`), app-only. Manifest: `production-2026-11-16-pr308.json`.
- **Feed grouping, #310 + #311, in production:**
  - OTA `9d11a797` (Android `b82a0376`, iOS `0c141d10`).
  - Migrations `20261125000100` and `20261126000100` (201 total).
  - Flags on at 08:26:36Z.
  - Manifest: `production-2026-11-16-feed-grouping.json`.
- **Staging social fixture `social-v1`:** verify 330/330, with a lookup table in `docs/release/qa/2026-11-16-pr308-closure.md`.

### Ready
- **Preview (staging):** serves `80f72210`, the same tree as production main, for any on-device check (Android `767a4229`, iOS `db9a6fb3`).

### Blocked
- Nothing.

### Next
- Watch the first real grouped posts. Read-only checks:
  - `feed_events` where `payload->>count > 1` matches the membership count;
  - no stale `ranking_batch_draft` rows.
- H-1 is still tracked separately and is NOT resolved.

### Founder action required
- **Optional on-device checks:** none were performed for either release. In particular, check B5's in-editor share, the 85% sheets, and the watchlist and ranking group sheets.
- **Welcome email:** production `welcome.delivery_enabled` is true. That predates this work and is a separate workstream; it was not touched.
- **Fixture password:** if you want to sign in to fixture accounts by hand, derive the password as described in the QA record. It is never stored.
