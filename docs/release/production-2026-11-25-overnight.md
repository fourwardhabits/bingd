# Production releases 2026-11-24/25 (overnight): #378, #380, #381

These ship under the founder's 2026-11-24 "Overnight Release & Launch-Readiness Sprint" approval:
- #378 by name, after its release checks;
- isolated JS-only performance improvements;
- production monitoring changes that are independently safe and fully tested.

The release involved no migration (production stays at 217, head `20261130001300`), no native change and no new secret.

## Changes

| PR | What | Merge | Codex |
|---|---|---|---|
| [#378](https://github.com/fourwardhabits/bingd/pull/378) | `rank_start` goes before the post-log refresh; seasons are no longer re-enriched on every visit; title reads leave with the row; a season's episode fallback waits for the videos facet | `0de804e2` | clean on `11f9381f` (1 P2 fixed, with a test that fails without the fix) |
| [#380](https://github.com/fourwardhabits/bingd/pull/380) | Sentry: Metro Debug ID serializer (`metro.config.js`); production OTA uploads source maps | `a66dfb98` | clean on `ba8fd97b` |
| [#381](https://github.com/fourwardhabits/bingd/pull/381) | For You posters at `w342` with the first screen loaded at high priority; title scores and Where to Watch requested earlier | `32790c48` | clean on `03b0ebc9` (1 P2 fixed, with a test) |

**Before #378 merged:** its branch was updated onto main `6858528a`, which carries #374 and #376, and CI and Codex re-ran on that exact tree.

## OTA 7 (`0de804e2`: #378)
**Gates on `0de804e2`:**
- CI passed (run 45339871301).
- The Release gate passed (run 45339878727).

| Platform | Update | Group |
|---|---|---|
| Android | `01a20c50-1469-7fff-996f-3a4d67d25578` | `bc33ed40-227a-4296-8187-89eb6591da18` |
| iOS | `01a20c50-1469-74ff-9eb0-33eaf35c2974` | `a1b10c70-7908-4912-951d-3112d0a7dca4` |

**Rollback:** republish the `03b4769d` groups (Android `0ebdff38…`, iOS `33534cc6…`).

## OTA 8 (`32790c48`: #380 + #381)
**Gates on `32790c48`:**
- CI passed (run 45343910493).
- The Release gate passed (run 45343926288). Its Android export runs through the new Metro config.

| Platform | Update | Group |
|---|---|---|
| Android | `01a20c71-4ba2-7757-abaf-3487bf38e8f5` | `c400a5a7-093d-4a5b-a8a4-21aecbc4ab0f` |
| iOS | `01a20c71-4ba2-7e2b-b9a0-ea3fc2e7e5c4` | `cec5a2d0-53db-46b3-809d-9725b76e7b17` |

**Checks after publishing:**
- **Runtimes:** unchanged (Android `ec79e181…`, iOS `8ea562b7…`).
- **Live check:** `release-manifest live production` serves both platforms at `32790c48`, against backend `abheeqyjzekiowkztfxv`.
- **Source maps:** the first production OTA to upload them. The publish job's "Upload Sentry sourcemaps" step uploaded both bundles to `fourward-habits/bingd-react-native` (Android debug id `72eda578…`, iOS `5c6c55c7…`) and reported "Uploaded bundles and sourcemaps to Sentry successfully".
- **Secret scan:** `ota-log-scan.mjs` on workflow run `01a20c6c-5cd1-73b5-9ca7-fc14e93d1462` found every job clean.

**Rollback:** republish the `0de804e2` groups above. To turn off source-map upload only, set `upload_sentry_sourcemaps: false`.

## Android Preview (staging)
- **After #378:** `0de804e2` (update `01a20c54-b832-7e99-b263-8b350ec66898`).
- **After #381:** `32790c48` (update `01a20c76-81f0-72b5-baea-b787eb5418ae`).
- **Staging-only work:** no staging-only client code remains, because every performance fix is now in production. iOS Preview stays on `646a4021`, since no iOS Preview binary exists on the current runtime.
- **Staging database:** still holds `20261130000700` (#343) and `20261201000100` (#322), which are not in production.
