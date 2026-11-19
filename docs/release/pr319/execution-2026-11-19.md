# PR 319: staging execution record, 2026-11-19 (founder GO for steps 3–5)

| Step | Result |
| --- | --- |
| 1. Clean checkout `f010b51f` | Done. **Deviation:** `node_modules` was a symlink to another checkout instead of `npm ci`. This caused step 5's failure (below). |
| 2. Pre-flight | Staging head `20261128000100`, pending exactly `20261129000100`. Preview live on `e94589b6`, Android group `d2c7190b…`, iOS group `d09bbb7e…`. |
| 3. Migration | `applied 20261129000100 a_move_you_make_yourself recorded`. Staging is at 204 migrations, head `20261129000100`. `rank_reorder(uuid,integer,uuid,integer,uuid)`: authenticated yes, anon no. The trigger fires on `correction` and `manual`. |
| 4. Smoke | `rerank-staging-smoke.mjs`: **14/14**, cleanup 0 profiles left. `remote-smoke.mjs`: **137/137**. |
| 5. Preview publish | **FAILED VERIFICATION, publish stopped.** See below. |

## Step 4 notes
- The first rerank smoke run reported 13/14. The invariant step could not execute: the read-only API role may not call `assert_ranking_valid`.
  - That was a script defect, not a staging failure.
  - Fixed: the step now runs as the owner inside `begin transaction read only … rollback`. It was verified to report errors (division by zero) and to refuse writes (`25006`).
  - The whole smoke was re-run: 14/14.
- Node's built-in `fetch` needs `NODE_USE_ENV_PROXY=1` in this environment.
- **A staging-wide invariant sweep (additional) found a pre-existing P1 gap, not caused by #319.**
  - 6 rankings have no placement, all on one QA fixture account, inserted directly on 2026-11-16 21:51.
  - I1–I3 hold for all 32 (user, category) pairs.
  - The fixture data was left untouched.

## Step 5 failure
`npm run update:preview -- --platform all` published two updates:
- Android `01a1f290-5e5f-7dd0-966d-0df635cef1eb`, group `85913f1c-1d1d-4cae-9042-dc6a7a46d9cb`, runtime `d017445b…`.
- iOS `01a1f290-5e5f-7243-be34-645707bb718b`, group `eb08e1db-88ae-49ca-a92e-cdb06fdfb29a`, runtime `23b78dfb…`.

**No installed Preview binary runs those runtimes**, so no device can receive them. The phones stay on `e94589b6`.

**Cause:** `eas fingerprint:compare` against the last good update shows every native-module source path as `../../../home/user/bingd/node_modules/...` instead of `node_modules/...`. That came from the symlinked `node_modules`. The contents are identical, but the hash differs.

**Verified fix, not yet published:** after `npm ci` in the checkout, the fingerprint matches the installed runtimes exactly. Android is `2503ffaa…` and iOS is `ef07f4b8…`. It was computed with the EAS Preview environment: `eas env:exec preview "npx expo-updates fingerprint:generate --platform <p>"` with `APP_VARIANT=preview BINGD_LANE=preview`.

### Corrected step 5 (awaiting founder go-ahead)

Run from the checkout:
```bash
cd <checkout of f010b51f with real node_modules> && EXPO_TOKEN=placeholder npm run update:preview -- --platform all --non-interactive --json --message "Collection drag-to-rerank PR 319 (f010b51f)"
```

Then confirm `release-manifest live preview` shows runtimes `2503ffaa…` / `ef07f4b8…` and `gitSha f010b51f…`. Rollback is unchanged (republish `d2c7190b…` / `d09bbb7e…`).

## Runbook amendments (apply to every future Preview publish)
1. **Never symlink `node_modules`.** Run `npm ci` in the clean checkout.
2. **Mandatory fingerprint pre-check before publishing**, per platform, from the checkout:
   ```bash
   APP_VARIANT=preview BINGD_LANE=preview EXPO_TOKEN=placeholder eas env:exec preview "npx expo-updates fingerprint:generate --platform android" --non-interactive
   ```
   Each must equal the installed runtime: Android `2503ffaa…`, iOS `ef07f4b8…`. Any mismatch stops the publish.
3. Run the smoke scripts with `NODE_USE_ENV_PROXY=1`.

## PR 321 (tagging picker): prepared, not published
- **Checkout:** a clean checkout of `2b50825b`, with `npm ci` and the same lockfile as `f010b51f`.
- **Fingerprint pre-check:** Android `2503ffaa…`, iOS `ef07f4b8…`. Both match the installed builds.
- **No staging change needed:** #321 is client only.
- **Publish only after the founder finishes #319's Android QA.** The Preview channel serves one update per platform, and #321 does not contain #319. Publishing it replaces #319 on whichever platforms it targets.
  - **If iOS QA of #319 is still running,** publish #321 to Android only:
    ```bash
    EXPO_TOKEN=placeholder npm run update:preview -- --platform android --non-interactive --json --message "Who I watched with: tagging picker PR 321 (2b50825b)"
    ```
  - **Otherwise,** publish to both platforms with `--platform all` and the same message.
- **Verify:** `release-manifest live preview` shows `gitSha 2b50825b…` on the published platforms.
- **Rollback:** republish #319's corrected groups, recorded when step 5 is redone.
