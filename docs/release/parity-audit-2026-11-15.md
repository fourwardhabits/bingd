# Android/iOS parity audit and staging candidate 1115

2026-11-15. Read-only investigation of GitHub, the branches and the PR record, then one
isolated integration branch (`claude/zealous-dijkstra-c9vof5`, draft PR into
`staging/integration-1114`). **Nothing was merged to `main` or a release branch, no OTA or
build was published, no migration was applied, no channel was changed.** The audit session
had no EAS login, so every deployment fact below comes from PR text and is marked as such.

**Morning summary.**

- The two Preview phones were running two different commits. That explains every Android
  vs iOS difference the founder reported. None of them is a platform bug.
- Candidate `1da55321` puts the approved work on one commit. Every automated gate passed on
  it. Its native fingerprint equals the last commit each Preview binary took. All its
  migrations are already on staging.
- Nothing is published, so the candidate is ready to publish to staging but not yet ready
  for QA. Section 8 lists what to approve.
- #286 is a no-go as it stands, for four checks that have not run. Watch History is not one
  of them: #286 matches production there. Section 9 has the detail.

---

## 1. Source state (verified against GitHub, 2026-11-15)

| Reference | Brief said | Now | Notes |
|---|---|---|---|
| Production `main` | `a228c6a5` | **`a228c6a5`**, unchanged | Merge of #267 (`ace7c3fa`). |
| Android staging pass 4 | `5ac03633` | `staging/integration-1114` = **`5ac03633`** (#296) | Contains all of #286 (`916bacb2`) and #294 separately. Only the `d702d098` merge commit itself is missing. |
| Selective production | #286 | `release/prod-selective-1113` = **`d702d098`** | 31 commits on `main`, all present in staging by patch-id. |
| iOS selective candidate | #306 `e6e7b241` | **`e6e7b241`**, unchanged | `d702d098` + `7b6ebf48` (`cherry-pick -x a724d1de`, #292) + `e6e7b241` (Profile "TV Shows" on one line). |
| Wave 2 | #298–#302 | `5cb50e14`, `337b87f8`, `86b2aad6`, `502807e1`, `09dfc4e3` | Stack: `5ac03633` → #299 → #302 → #305. #298, #300 and #301 each sit directly on `5ac03633`. |
| Import/UI polish | #303 | `7707ae93` | 1 commit on `5ac03633`. |
| Reviews/social | #304 | `aeadc896` | 2 commits on `5ac03633`. |
| Onboarding 2.0 | #305 | `9b2a66c9` | 7 commits on #302's head. |

**#292 is not duplicated.** It is in staging through `79bd4bc2` (merge of `a724d1de`). #306
carries a cherry-pick of it with the same patch-id. The candidate takes it from staging
only. `git cherry` reports it as already present.

## 2. Source-to-deployment matrix

The identifiers are different kinds of thing, so they are kept apart. An *app build* is a
store or internal binary with a version and build number. A *runtime* is the native
fingerprint hash that build carries. An *update* is one OTA for one platform. An *update
group* is one `eas update` invocation. A *Git SHA* is the source the update was bundled
from.

### What is installed and served

| | Android Preview | iOS Preview | Android Production | iOS Production |
|---|---|---|---|---|
| Binary | Preview build 11, EAS `c25cbaf6…`¹ | Preview build 9, EAS `4295384b…`¹ | 1.1.0 (15), EAS `4d71b121` | 1.1.0 (15), EAS `e38d94d9` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` | `ef07f4b898dc…` (full hash not recorded) | `ec79e181…` | `8ea562b7…` |
| In `config/live-runtimes.json` | yes | **no** | yes | yes |
| Last *recorded* OTA | `01a1da2e-79fe-7b25-…`, group `0fc7e363…`, from **`5ac03633`**, 2026-11-14 07:10 CST² | `01a1da2e-79fe-760d-…`, group `60fc013e…`, from **`5ac03633`**, same time² | `01a1d0f9-8c10-7053-…`, group `f97b8534-…`, from **`ace7c3fa`**³ | `01a1d0f9-8c10-7ee5-…`, group `4eded7f4-…`, from **`ace7c3fa`**³ |
| What the phone *showed* (founder) | `SN AVG`, FU1113-A Watch History: **`5ac03633`** | `AVG`, #286 Watch History: **`d702d098`** (or `e6e7b241`) | n/a | n/a |
| How that got there | `ota-preview.yml` or `update:preview` (method not recorded) | **Not recorded anywhere** | EAS workflow (#267) | EAS workflow (#267) |
| Backend | staging `…rzyr` | staging `…rzyr` | production `…ztfxv` | production `…ztfxv` |

¹ From #267 and the #285 comment. ² From the #296 comment ([link](https://github.com/fourwardhabits/bingd/pull/296#issuecomment-6877856995)). Group IDs were recorded only as 8-character prefixes, and no publish method was named. ³ Inferred: #286 calls it the rollback target, and #272/#273 say "live as OTA `01a1d0f9`". No publish record exists.

**Conclusion.** The last recorded state had both Preview platforms on `5ac03633`. After that,
iOS Preview was moved to the selective candidate by a publish that left no trace on GitHub
(#306: "the founder's iPhone smoke of d702d098"). **The two platforms are not synchronised.
The only proof of either side's current state is EAS itself.** One read-only command settles
it:

```bash
node scripts/release-manifest.mjs live preview
```

That command needs `eas login`. It prints the newest update per platform, with the commit
EAS recorded, and runs the parity checks on it.

### Where each change lives

| Change | Android Preview (`5ac03633`) | iOS Preview (`d702d098`/`e6e7b241`) | Production (`a228c6a5`) | Candidate 1115 |
|---|---|---|---|---|
| #286 selective subset (TV Collection one poster, Keep Show, person page, shared sheets, Watch History cards) | yes | yes | **no** | yes |
| #294 LogSheet close guard | yes | yes | no | yes |
| FU1113-A #287 Watch History per-watch note | yes | **no** | no | yes |
| FU1113-B #288 DS contracts (`SN AVG` badge) | yes | **no** | no | yes |
| FU1113-C #291, FU1113-F #293, IMP1113-UI #289, #297 | yes | no | no | yes |
| FU1113-E #290 Sent to You seen-when-listed | yes | no | no | yes |
| FU1113-D #292 season-completion labels | yes | `e6e7b241` only | no | yes (once) |
| #306 Profile "TV Shows" one line | no | `e6e7b241` only | no | **yes** (`cherry-pick -x`) |
| #303 import polish, "Your score (SN avg)" | no | no | no | yes |
| #304 review refresh and cards | no | no | no | yes |
| #299 + #302 DS-V3 A.2 and 44pt targets | no | no | no | yes |
| #305 Onboarding 2.0 | no | no | no | yes |
| #298 unread-first page RPC | no (migration on staging) | no | no | yes |
| #301 Rec V2 (dark) | no (migrations on staging) | no | no | yes, switch off |
| #300 username sign-in | no | no | no | **excluded** |
| Sent to You Movies/TV filter | no | no | no | **new**, this PR |

**Genuinely platform-specific code in the candidate:** the platform-scoped accessibility
props in `Field.tsx` (this PR) and the StatRow note about Android's `minimumFontScale` in
#306. Nothing else differs between Android and iOS.

## 3. Root causes of the observed differences

### A. Collection TV badge "SN AVG" vs "AVG": a version divergence

- `SN AVG` comes from FU1113-B (`8f256130`, #288). It lives in `seasonAverageBadgeText` in
  `src/ui/components/PosterWall.tsx`, and every wall, row and sheet uses it. That commit is
  in staging and was never in #286. #286 carries WS-TVC's `averagePillText` → `AVG 8.7`.
- There is one implementation and no platform branch. Android showed the newer commit and
  the iPhone the older one.
- The desired treatments already exist in the candidate:
  - a compact season-derived badge reading `SN AVG 9.4`, outlined (FU1113-B);
  - an explicit show score drawn as the regular filled score (`kind: 'explicit'`);
  - the expanded show-page label "Your score (SN avg)" (#303, `ImmersiveScores.tsx`
    `SEASON_AVERAGE`; staging alone says "Season Average").
- No new code is needed. #303's open decision 3 remains: the label prints "SN avg" literally.

### B. Watch History notes and companions: a version divergence in the *write path*

- Both versions read the same data. `use-watch-history.ts` is byte-identical between #286
  and staging. Both draw `With …` and `watch_events.note` on the collapsed card.
- The difference is where **Edit** saves a note:
  - **#286 and production `main`:** the Watch History editor writes the **title's** note
    (`useTitleNote` → `save_note`, `user_media.note`). The card shows the **watch's** note
    (`watch_events.note`), and nothing writes that any more. So a note typed in Watch
    History on the iPhone build never appears on the card. Title-level and per-watch notes
    are conflated. Production has done this since `e4e035cc` (2026-11-06), so it is not a
    #286 regression.
  - **Staging and the candidate (FU1113-A, #287 + Codex fixes `b2c26d27`, `378d2fec`):**
    Edit writes `set_watch_details` → `watch_events.note` on exactly that watch. The card
    shows it. The title's review is untouched. Notes are counted in code points, as the
    column's check counts them.
  - The candidate's card also reorders: date, then `With …`, then provenance, then the note.
- Companion data is not missing from the query. It is the same read and the same `With …`
  line.
- If a companion line appeared on Android but not on the iPhone for the *same* watch and
  account, the code does not explain it. That would be data. Delta-QA item Q4 checks it.
- Privacy is unchanged. `watch_events.note` stays private to its owner, and no data is
  migrated. Notes written through #286's editor are in `user_media.note`, where they were
  saved, and are not lost.

### C. Sent to You

| Requirement | Status |
|---|---|
| Movies/TV selection filters Sent to You | **Missing on every branch.** Only genre, language, decade and bucket filters applied. **Built here:** `sentInMedium` (movie → Movies; season and series → TV), applied before the filters. |
| Unread clears once viewed in a successfully loaded list, with no title opened | **Already built** (FU1113-E #290 + #297): `useMarkSentSeen`. It marks only when the list is selected, focused and `isSuccess`, and only the ids drawn. `mark_recommendations_seen` writes `seen_at` (`20261121000100`). |
| Newly delivered and hidden/unviewed rows stay unread | Already built (only drawn ids are sent). The medium filter extends this to the other side of the switch. Tested. |
| Opening stays distinct from seen | Already built. `opened_at` is written only by `mark_recommendation_opened`. A sender can no longer read `opened_at` or `seen_at`. |
| Unread-first ordering past the 200-row cap | #298 (`20261121000400`, applied to staging; the client falls back to `recommendations_to_me` where it is missing, as in production). |

**New copy for founder sign-off** (shown when everything sent is on the other side):

- "No TV sent your way yet" / "No movies sent your way yet"
- "Switch to Movies/TV to see what people have sent you."

The shortcut badge still counts unread on both sides.

### D. IMDb and Letterboxd (#303)

All six approved items are in #303 `7707ae93` and in the candidate:

- fresh import entry (`ImportIntro`);
- normalised heading typography;
- shortened copy;
- Export and Upload shown as actions (`ActionPair`);
- the unmatched disclosure cleanup (`UnmatchedDisclosure`, −5 lines);
- the unranked count cleanup (`CompletionSummary`).

Nothing was rebuilt. **CI failure root cause:** run
[43642676329](https://github.com/fourwardhabits/bingd/actions/runs/43642676329/job/132593475995)
failed one test, `RankedSummaryStanding.test.tsx:437` ("2 titles checked" not found within
5 s). That suite took 6.49 s under CI load. #303 touches nothing on that path. The same test
passed on `5ac03633`, on #304 and on #305, and 30/30 locally. It is a timing flake. Re-run
the job. The suite passes on this candidate (section 7). #303's open founder decisions 1–4
still stand.

### E. Reviews (#304) and onboarding (#305)

- **#304 `aeadc896`:** Codex receipt on the head, with no findings. D-R1 and D-R2 remain
  founder calls.
- **#305 `9b2a66c9`:** Codex last reviewed `1565027d`. The two P2s that `9b2a66c9` fixes
  were never re-reviewed. This PR's Codex review covers that code.
- #305 sits on #302, which sits on #299, so the order is fixed.
- OB-7 waits on #300 (both edit `sign-in.tsx`).
- OB-6's `@username` search uses the existing people search, not username login.
- **Username login stays off.** #300 is excluded, `sign-in.tsx` has no username path, and
  `20261123000100` is applied nowhere.
- **Rec V2 stays off.** `recommendation_engine()` answers `v1` unless `app_config`
  `recommendations.v2_engine` is `"v2_metadata"`. It is `"v1"` on staging, per the
  coordinator note on #301. A missing RPC, as on production, also gives `v1`.

## 4. Consolidated candidate (this PR)

Base: **`5ac03633`** (`staging/integration-1114`). It already contains #286, #287–#294 and #297.

| # | Commit | What |
|---|---|---|
| 1 | `fa9075cc` | merge #303 @`7707ae93` |
| 2 | `ca81a82c` | merge #304 @`aeadc896` |
| 3 | `16068e6c` | merge #305 @`9b2a66c9`, which brings #299 @`337b87f8` and #302 @`09dfc4e3` |
| 4 | `a88656fb` | merge #298 @`5cb50e14` |
| 5 | `c6d8ac2f` | **new:** Sent to You follows Movies/TV, with tests |
| 6 | `acb32d6e` | **new:** `Field` keeps an error TalkBack can read (fixes #302's open Codex P2) |
| 7 | `cdb73a77` | **new:** release manifest and parity check (tooling, no runtime effect) |
| 8 | `462f2b52` | test update: the Sent chip survives a medium switch |
| 9 | `204da159` | merge #301 @`502807e1`, dark |
| 10 | `1da55321` | `cherry-pick -x e6e7b241` (#306 Profile "TV Shows" one line), so staging does not regress what the iPhone approved |
| … | later commits | Codex follow-ups and this document; see the PR |

- **Not included:** #300, and #306's `7b6ebf48` (it duplicates #292).
- **Merges:** no textual conflicts. #300 would conflict in `mutation-check.mjs`.
- **Semantic conflicts:** one. The old test expected a film on the TV side of Sent to You.
  It was updated in commit 8 and its guarded property was kept.
- **Reused:** every PR head merges as is, with no rebase or rewrite. #292 appears once.
- **Open Codex findings carried in:** #301's two P2s at `502807e1`. Both concern only a V2
  engine (the slate cache key) or the offline replay harness. With the switch at `"v1"` they
  cannot be reached. They must be fixed before V2 is turned on anywhere.

## 5. Release-parity gate design

What exists today, and is kept:

- `release.mjs`: lane identity, a passthrough allowlist, and Beta/Production gates.
- `ota-gate.mjs`, with the `preflight` and `runtimes` jobs.
- `ota-production.yml`, which publishes `all` in one group.
- `ci.yml`, `release-gate.yml` and `db-races.yml`.

The gap is that **Preview is published per platform and nothing records or checks the
pair.**

1. **The manifest** (`scripts/release-manifest.mjs`, added here, with tests). One JSON file
   per release gives:
   - the lane, channel, Git SHA, backend ref and status;
   - per platform: update ID, group ID, runtime and the `gitCommitHash` EAS reports;
   - verification fields;
   - an optional `isolated-platform` exception.

   `check` refuses:
   - mixed-commit publishes;
   - one-platform publishes without an exception;
   - exceptions on beta or production;
   - a runtime that is not the recorded binary's;
   - a lane with no recorded binary;
   - a disallowed backend;
   - a wrong channel;
   - "verified" without CI, the release gate and both device checks.

   `live <lane>` reads `eas update:list` read-only and applies the same checks to what is
   actually served. The repo's manifests are tested in `test:config`. The pass-4 record is
   there, and its three missing IDs are pinned in `knownProblems`.
2. **One publish for both platforms.** This takes two reviewed edits, which need founder
   approval and were not made here because the full hash below is missing:
   - (a) add `preview.ios` to `config/live-runtimes.json` with the iOS Preview binary's
     **full** runtime, from `eas build:view 4295384b…`;
   - (b) set `ota-preview.yml`'s `platform:` to `all` and `ota-gate.mjs` `LANES.preview.platforms`
     to `['android','ios']`.

   Then `ota-preview.yml` publishes both platforms in **one update group**, refuses unless
   both runtimes match their binaries, and nothing typed at dispatch can narrow it.
   `config/ota-workflows.test.mjs` needs its preview platform expectation updated in the
   same change.
3. **Feature flags and schema.** The manifest carries the backend ref. For Preview, the
   migration head is read from `list_migrations` and written into `backend.migrationHead`.
   Flags are server-side `app_config` rows (section 6) and are recorded in
   `backend.flags`.
4. **Isolated platform QA** is a manifest with
   `exception: { type: "isolated-platform", platform, reason, approvedBy, expires }`. Without
   one, `check` fails. A dedicated isolated channel (for example `rc`) would need its own
   **installed binaries**. A build's channel is fixed at build time, so it means
   `eas build --profile <rc>` for each platform: two new internal binaries, and a new
   profile in `eas.json`. EAS can also remap a channel to a different branch with no new
   binary: `eas channel:edit preview --branch rc-1115`. That moves *every* Preview phone,
   so it is not isolation. **Recommendation:** no new channel. Use the manifest exception
   for the rare isolated case, and publish both platforms otherwise.
5. **Rollback, per platform.** Republish the previous manifest's SHA through the same
   workflow, or use `eas update:republish --group <previous group>`, one group per platform
   when they differ. Then run `live` again. Rollback targets:
   - **Preview:** pass 4 (`01a1da2e…`, both platforms);
   - **Production:** `01a1d0f9…` (section 2).

   `safe-update-runbook.md` §4 still governs. A production rollback needs its own founder
   authorisation.

## 6. Inventories

### Migrations (candidate vs `main`)

| Migration | PR | Staging | Production |
|---|---|---|---|
| `20261118000100` verified IMDb id | #280 | applied | not applied |
| `20261118000200` shared IMDb id only when title agrees | #280 | applied | not applied |
| `20261119000100` a voice once ten titles in | #283 | applied | not applied |
| `20261120000100` a show kept after a season | #284 (in #286) | applied | **not applied; required by #286** |
| `20261121000100` recommendation seen when listed | #290 | applied (2026-11-14 03:24 CST) | not applied |
| `20261121000300` request released only to a mutual pair | #290/D1 | applied (03:24 CST) | not applied |
| `20261121000400` Sent to You unread-first page | #298 | applied (11:09 CST) | not applied (client falls back) |
| `20261122000100` / `…0200` Rec V2 | #301 | applied (11:28 CST, switch off) | not applied (client answers `v1`) |
| `20261123000100` username sign-in | #300, excluded | **not applied** | not applied |

Staging was last read at 198 versions, head `20261122000200` (2026-11-15 00:15 CST,
coordinator note). This audit did not query the database. Re-read `list_migrations` before
publishing. The candidate needs **no new staging migration.** Edge function change vs `main`:
`letterboxd-import` (#280/#289). Confirm the staging deploy before Q6.

### Feature flags (server `app_config`, no client flags in the candidate)

| Key | Intended on staging | Effect |
|---|---|---|
| `recommendations.v2_engine` | `"v1"` | Master switch. Anything else that is not `v2_metadata` also means V1. |
| `recommendations.v2_allowlist` / `v2_allowlist_engine` / `v2_rollout_percent` | unchanged | Inert while the master switch is `v1`. |
| Username sign-in | absent | No client code path in the candidate. |

## 7. Verification (head `1da55321`)

The app code head is `1da55321`. Later commits on this branch are docs only: they change no
bundle and no runtime. The PR comment records the re-run on the final head.

| Gate | Result | Head |
|---|---|---|
| `npm run typecheck` | 0 errors | `1da55321` |
| `npm run lint` | 0 errors, 78 warnings (the same 78 as on `5ac03633`) | `1da55321` |
| `npx jest --ci` | 359 suites passed, 1 skipped; **6858 tests passed**, 4 skipped, 0 failed | `1da55321` |
| `npm run test:config` | 195/195, including 11 new manifest tests | `1da55321` |
| `npx expo export --platform all` (placeholder Supabase env, as CI) | exit 0 | `1da55321` |
| `npm run test:db` (PGlite) | **3235/3235** | `204da159`¹ |
| race (`node --test --test-timeout=300000 supabase/tests/concurrency/*.test.mjs`, as `db-races.yml`) | **200/200** | `204da159`¹ |
| `npm run test:race:mutants` | 24/24 mutations detected, 3/3 controls held | `204da159`¹ |
| `npm run test:web` / `test:web:mutants` | 223/223; 28/28 defects detected | `204da159`¹ |
| `emails/welcome/email.test.mjs` | 42/42 | `204da159`¹ |
| `functions:check`, `functions:lint` | exit 0 | `204da159`¹ |
| deno push-sender check / lint / test | exit 0 / 6 files / 74 passed | `1da55321` |
| `test:acceptance`, `test:award-privacy`, `test:social`, `test:remote` | **not run.** They need staging credentials, which this session does not have. Run them after the staging publish. | n/a |

¹ `1da55321` adds only `StatRow.tsx`, its test and `ProfileIdentity.tsx` on top of
`204da159`. None of those is imported by the database, race, web, email or function suites.

**One local-environment note.** As root, `embedded-postgres` cannot reach the root-owned
0700 temp directory, so the race suites were run as an unprivileged user. CI runs them as
it always has.

**Flake seen once.** `SentToYou.test.tsx` "leaves the menu open when the list lands under
it" failed once. That run overlapped a full parallel Jest run, and the test relies on a
400 ms simulated server delay. It passed 42/42 when run alone, and the full runs above are
green. This is the same class of timing flake as #303's CI failure.

**Native fingerprint.** Each commit was hashed from a clean worktree in the same local
environment, without the EAS env. Absolute local hashes differ from EAS's because of the
environment, so only equality between commits is meaningful.

| lane / platform | candidate | `5ac03633` (on both Preview phones per #296) | `d702d098` | `e6e7b241` | `a228c6a5` (production) |
|---|---|---|---|---|---|
| preview / android | `ff2b79ae` | `ff2b79ae` | `ff2b79ae` | `ff2b79ae` | `ff2b79ae` |
| preview / ios | `5ae60644` | `5ae60644` | `5ae60644` | `5ae60644` | `5ae60644` |
| production / android | `c7aea3b0` | `c7aea3b0` | `c7aea3b0` | `c7aea3b0` | `c7aea3b0` |
| production / ios | `47158586` | `47158586` | `47158586` | `47158586` | `47158586` |

#306 measured the same production hashes, `c7aea3b0` and `47158586`.

- The candidate equals `5ac03633` on Preview, so it reaches the installed Preview binaries.
- It equals `a228c6a5` on production, so it needs **no new binary** anywhere.
- The authoritative check is the EAS `fingerprint` job in `ota-preview.yml`.

## 8. Safe staging publication (needs founder approval, not done)

1. Confirm what is live: `node scripts/release-manifest.mjs live preview`. Record the output
   as the rollback manifest.
2. Confirm staging is at head `20261122000200` and `recommendations.v2_engine` is `"v1"`.
   Confirm the `letterboxd-import` deploy.
3. Re-run CI on this PR's head and confirm the Codex receipt is for that exact commit.
4. Publish **one SHA to both platforms**. Until section 5.2 lands, run the Android workflow
   and an iOS publish from the same clean checkout:

```bash
SHA=<candidate head>
eas workflow:run .eas/workflows/ota-preview.yml --ref $SHA -F sha=$SHA -F message="staging 1115 (${SHA:0:7})" --non-interactive --wait
```

```bash
git checkout --detach $SHA && git status --porcelain   # must print nothing
```

```bash
npm run update:preview -- --platform ios --message "staging 1115 (${SHA:0:7})" --non-interactive
```

   The `update:preview` run takes iOS from the same SHA. `release.mjs` supplies
   `APP_VARIANT=preview` and `BINGD_LANE=preview`.

   When section 5.2 has landed, the workflow alone publishes both platforms in one group.
5. Verify the pair before anybody tests: run `node scripts/release-manifest.mjs live
   preview`. It must print `ok`. Then commit its output as
   `docs/release/manifests/preview-<date>.json`.
6. **Rollback:** republish the step-1 manifest's groups, one per platform, and re-run step 5.

## 9. #286 production go/no-go

**No-go tonight. GO once the four items below are done.** Watch History is not a blocker.
#286's Watch History behaviour (Edit writes the title note) is what production has run since
2026-11-06, so shipping #286 changes nothing there. FU1113-A's fix ships with the
consolidated release, not as a late addition to #286.

The four blockers:

1. **The exact production candidate is not device-verified on both platforms.** The iPhone
   ran `d702d098`, apparently. Android has not run it: "This candidate's exact JS has not
   been published to Preview" (#286). Decide whether #306 is in, then publish **that one
   SHA** to both Preview platforms and smoke it on both phones.
2. **The Codex receipt is for `916bacb2`, not the head `d702d098`.** The LogSheet P2 thread
   is still open (#294 addresses it). Request a review of the final head.
3. **Award-privacy and social checks are marked "NOT RUN … blocker"** in #286. Run
   `test:award-privacy` and `test:social` against the release head.
4. **`20261120000100` must be applied to production before the OTA**, or Keep Show fails.
   That is a production migration and needs its own approval and order:
   migration → verify → OTA.

Then the production publish runs through `ota-production.yml`, which is unchanged: both
platforms, one group, runtimes `ec79e181`/`8ea562b7`. Record a production manifest.

## 10. Founder approvals and delta-only QA

**Approvals needed:**

- (1) Publish candidate 1115 to staging, both platforms, per section 8.
- (2) Copy for the Sent to You other-side empty state.
- (3) #303's open decisions 1–4.
- (4) #304's D-R1 and D-R2.
- (5) #305's open choices: press-read fallback, coach while loading.
- (6) Section 5.2's workflow change, together with the iOS Preview runtime record.
- (7) #286 scope (#306 in or out) and its production migration.

**Delta-only QA on both phones, after step 5 of section 8 prints `ok`.** Everything else was
covered in pass 4.

| # | Check | Platform |
|---|---|---|
| Q1 | Diagnostics show the same update ID prefix for each platform's group and the same commit on both phones | both |
| Q2 | Collection TV: a season-derived tile reads `SN AVG x.x` (outlined); a show with an explicit score shows the filled score; the show page says "Your score (SN avg)" | both |
| Q3 | Watch History: Edit watch, type a note, Save. The note appears on that card only, and the title's review is unchanged | both |
| Q4 | Same account, same watch with companions: `With …` shows on both phones | both |
| Q5 | Sent to You: Movies lists films only; TV lists shows and seasons. Viewing Movies leaves the TV unread count; switching to TV clears it; opening a title still opens it | both |
| Q6 | Import: fresh entry, Export and Upload visible, unmatched/unranked cleanup (#303) | one |
| Q7 | Reviews: post or edit a review, then refresh. Card hierarchy (#304) | one |
| Q8 | Onboarding 2.0 on a new account: header, First Five, Up next, People `@username` search, Invite (#305) | both |
| Q9 | Edit Profile: an invalid social link. TalkBack reads the error; VoiceOver says it once | both |
| Q10 | Profile stats: "TV Shows" on one line at default text size; the frame flush in the card (#306 open decision 1) | both |

## 11. Orchestration usage (bounded)

The repository holds no coordinator or watcher code, config or usage telemetry. The
coordinator appears only as an author in PR text: "applied by the coordinator" and
"validated by the coordinator". **Confirmed from GitHub:**

- At least 8 parallel agent sessions in 36 hours (session links on #297–#306).
- Many large HANDOFF comments of 2–6k words.
- Repeated `@codex review` cycles, several per PR (#301 and #305 had three).
- Evidence kept off-repo on a build box (`overnight-1114/*.md`). That forces each session to
  reconstruct state from PR text, which this audit also had to do.

**Not measurable here:** token counts, model mix, polling frequency, image work. No Grok
telemetry is reachable from this session, so no cost figures are given.

**Hypothesis, unverified:** usage is dominated by repeated large-context reconciliation.
Each new session re-reads long PR threads, because the deployment state lives nowhere
machine-readable.

**Lighter workflow:**

- (a) The release manifest is the single state file. A session reads one JSON file, not 20
  PR threads.
- (b) Replace model polling with event wakeups: GitHub PR subscriptions, `eas workflow:run
  --wait` and webhooks. A cheap model or a plain script checks "is the Codex receipt for the
  head SHA?" and "did CI pass?". Escalate to the premium model only on a state change.
- (c) Keep handoffs as a fixed-schema block (head, gates, open decisions) instead of prose.
- (d) Commit build-box evidence into `docs/release/` with the manifest.
