# PR 319 (#318 drag-to-rerank): staging migration + Preview update runbook

**Commit:** `f010b51f879d665b7c4fb2e045a4dd73cfa29c49`, on branch `feature/318-collection-rerank`.

**Scope:**
- **Staging Supabase:** `fjxhcbowoxuzulwirzyr` (bingd-staging).
- **Preview channel:** `preview`.

**Out of scope:** production, merging, Beta.

**Status:** prepared only. Nothing here has been run against either database or EAS, except the read-only checks in §0.

Files beside this one:

| File | What it is |
| --- | --- |
| `staging-migrate.py` | The production migrate script, pinned to the staging ref and to exactly `['20261129000100']`. One transaction, recorded in `supabase_migrations.schema_migrations`. |
| `rollback-20261129000100.sql` | Restores the exact pre-migration state; see §5. |
| `rerank-staging-smoke.mjs` | 13 checks with disposable `@example.invalid` accounts, deleted at the end. |
| `run-staging-suite.mjs` | Runs an existing credentialed suite against staging, with keys held only in the child process. |

The Supabase management token and the Expo token are injected by the session proxy. No key is typed, printed or stored.

## 0. Environment verification (done read-only, 2026-11-19; re-run before §2)

| Check | Result |
| --- | --- |
| Staging migration head | `20261128000100`, 203 applied. **Pending for `f010b51f`: exactly `20261129000100`.** Nothing on staging is missing from the checkout. |
| Staging `rank_reorder` today | `rank_reorder(uuid,integer,uuid)`, `authenticated` cannot execute. The trigger fires on `correction` only. 0 `manual` rows. |
| Preview runtime | Fingerprint of `f010b51f` equals that of `e94589b6`, the commit now live on Preview: Android `ff2b79ae…` / iOS `5ae60644…` (local, placeholder environment). No fingerprint input differs. So the update reaches the installed Preview binaries, Android runtime `2503ffaa…` and iOS `ef07f4b8…`. **No new build.** |
| Live Preview (rollback target) | `e94589b6` "Feed poster rails PR 312". Android group `d2c7190b-3a34-49a4-82c6-99612930ef34`, iOS group `d09bbb7e-d1a9-42ad-b748-6c34044ec3a6`. |
| CI on `f010b51f` | Typecheck/lint/test/database, Concurrency (real PostgreSQL) and Cloudflare Pages all pass. Codex: no findings. |
| Rollback SQL | Tested on PGlite: migrate, then roll back. Function definitions, grants, comments and trigger match the pre-migration schema exactly. |

**Order matters.** Database first, then the update.
- An older client never calls `rank_reorder`, so the migration is invisible until the update lands.
- An update that lands first gets `PGRST202` on a drop. The app rolls back and offers Retry; that is safe, but noisy.

## 1. Clean checkout of the exact commit

```bash
git fetch origin feature/318-collection-rerank
```
```bash
git worktree add --detach /tmp/r319 f010b51f879d665b7c4fb2e045a4dd73cfa29c49
```
```bash
cd /tmp/r319 && npm ci
```
```bash
git -C /tmp/r319 status --short
```

The last command must print nothing. `git -C /tmp/r319 rev-parse HEAD` must print `f010b51f…`.

## 2. Pre-flight (read-only)

```bash
cd /tmp/r319 && python3 docs/release/pr319/staging-migrate.py dry-run
```

It must end `pending: ['20261129000100']` and `DRY RUN: nothing applied`. Any other pending set stops the runbook.

Copy the four helper files from the ops branch into `/tmp/r319/docs/release/pr319/` first, or run them by absolute path.

```bash
EXPO_TOKEN=placeholder node scripts/release-manifest.mjs live preview
```

It must still show `e94589b6` with the two group ids above. If not, re-record the rollback target before going on.

## 3. Staging migration: needs explicit approval

```bash
cd /tmp/r319 && python3 docs/release/pr319/staging-migrate.py apply
```

Expected: `applied 20261129000100 a_move_you_make_yourself recorded`, then `done`.

**Verify (read-only):**
- signature `rank_reorder(uuid,integer,uuid,integer,uuid)`, executable by `authenticated`, not by `anon`;
- the trigger's `WHEN` names both `correction` and `manual`;
- head `20261129000100`, 204 applied.

The smoke script below checks the first two.

## 4. Staging smoke: needs approval (writes disposable accounts, then deletes them)

```bash
cd /tmp/r319 && node docs/release/pr319/rerank-staging-smoke.mjs
```
```bash
cd /tmp/r319 && node docs/release/pr319/run-staging-suite.mjs supabase/tests/remote-smoke.mjs
```

The rerank smoke must report `RESULT 13/13 passed`. Its checks:
- grants and trigger;
- a guarded move, the shift and the score;
- replay;
- one manual placement;
- `55000`, `22023` and `P0002`;
- anon refused;
- no feed post, comparison or watch created;
- `assert_ranking_valid` and `assert_placements_valid`;
- cleanup leaves 0 profiles.

`remote-smoke` must pass in full, as it did at the last staging release (137/137). It still asserts that anon cannot execute `rank_reorder`.

**Any failure:** stop, and go to §5a.

## 5. Preview update: needs explicit approval

Publish from the clean checkout, both platforms in one invocation:

```bash
cd /tmp/r319 && EXPO_TOKEN=placeholder npm run update:preview -- --platform all --non-interactive --json --message "Collection drag-to-rerank PR 319 (f010b51f)"
```

**Use this, not `.eas/workflows/ota-preview.yml`.** That workflow publishes Android only, and its note that no iOS Preview binary exists is out of date: iOS build 9 is on runtime `ef07f4b8`. This is the same path as the last three Preview publishes.

**Verify:**
```bash
EXPO_TOKEN=placeholder node scripts/release-manifest.mjs live preview
```

Both platforms must show `gitSha f010b51f…` and backend `fjxhcbowoxuzulwirzyr`, on runtimes `2503ffaa…` (Android) and `ef07f4b8…` (iOS). Record both new group ids for the release manifest.

**On each phone:**
1. Signed in, background the app and bring it back.
2. Settings shows `update <8 chars>` for the new update.
3. Then run the PR's 15-step device checklist.

## 5a. Rollback

**Update first, then database.** The reverse order would leave a live client calling a function that no longer exists.

**1. Preview.** Republish the previous groups:

```bash
EXPO_TOKEN=placeholder npx eas update:republish --group d2c7190b-3a34-49a4-82c6-99612930ef34 --message "rollback to e94589b6" --non-interactive
```
```bash
EXPO_TOKEN=placeholder npx eas update:republish --group d09bbb7e-d1a9-42ad-b748-6c34044ec3a6 --message "rollback to e94589b6" --non-interactive
```

Then `release-manifest live preview` must show `e94589b6` again. If the published updates themselves are suspect, use the last resort:

```bash
EXPO_TOKEN=placeholder npx eas update:roll-back-to-embedded --branch preview --message "back to the shipped bundle"
```

**2. Staging database.** One transaction, through the management API, from the checkout:

```bash
cd /tmp/r319 && python3 - <<'EOF'
import json, subprocess
sql = open('docs/release/pr319/rollback-20261129000100.sql').read()
out = subprocess.run(['curl', '-sS', '-X', 'POST',
  'https://api.supabase.com/v1/projects/fjxhcbowoxuzulwirzyr/database/query',
  '-H', 'content-type: application/json', '--data-binary', '@-'],
  input=json.dumps({'query': sql, 'read_only': False}), capture_output=True, text=True).stdout
print(out[:400])
EOF
```
```bash
cd /tmp/r319 && python3 docs/release/pr319/staging-migrate.py dry-run
```

The dry-run must show head `20261128000100` and pending `['20261129000100']` again.

**What a rollback keeps:**
- Any `manual` placement rows and latest-watch post scores written during QA. They are true records of moves that happened.
- I1–I4 and P1–P4 still hold. A rollback deletes no ranking data.

## Not in this runbook

- Production.
- Merging to `main`.
- Beta.
- The padding change (`feed/card-top-spacing`), which ships through its own PR.

Each needs separate approval.
