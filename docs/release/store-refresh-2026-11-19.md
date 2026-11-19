# Store refresh, 2026-11-19: the name `bingd` and the new screenshots

**Goal:** one App Store submission that carries both the plain-text name change (`bingd.` → `bingd`) and the refreshed six-screenshot set. Never two review cycles. Bundle identifier (`app.bingd`), Apple team (`98729PG8GD`), app record (`6803954532`) and the brand stay as they are. The graphic wordmark inside the app and the screenshots keeps its period.

**Status on 2026-11-19: prepared, not submitted.** Nothing has been uploaded to App Store Connect or Google Play, and no production binary has been built. Assets: `store-assets/listings/2026-11-19-refresh/` (branch `claude/launch-a-store-refresh`). Binary config: branch `claude/launch-a-store-binary-1.2.0`.

|                      | State                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Six cards, all slots | Done, except card 03's new feed capture                                                         |
| Card 03 feed swap    | **Waiting for one input:** `Screenshot_20261119_160109_bingd.jpg` (not in the repo or on Drive) |
| Card 06              | Unchanged by decision (no stronger capture exists)                                              |
| Metadata             | Name, version and What's New drafted; live text not readable from here                          |
| New binary           | Prepared (1.2.0 on `a3300bf`), **not built**: needs the coordinator's go                        |
| App Store Connect    | No direct access from this environment                                                          |

---

## 1. Which set is approved

| Source                                                                     | What it is                                                                                                                                     | Used?                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| PR #245 (`cursor/store-screenshot-copy-v3-e1c9`, head `a2500485`)          | v3 copy and upload order on the v2 design; renderer and sources                                                                                | Yes: the basis               |
| Drive "bingd store screenshots — final candidate 2026-11-11" (`1NID4eD9…`) | #245's cards with the founder's Nov 11 picks: **position 6 = balanced layout**, position 5 apostrophe = U+2019; plus a 1080 x 1920 Play render | Yes: the latest approved set |
| Drive "bingd screenshots status 2026-11-09" and its summary                | v2 status (superseded by v3 and the Nov 11 picks)                                                                                              | Background only              |

`refresh.mjs` reproduces the Nov 11 candidate **byte for byte**: all six Apple files (1206 x 2622) and all six Play files (1080 x 1920) match the sha256 values in the Drive README. So the reuse is exact, not a redesign.

## 2. Final assets

All paths under `store-assets/listings/2026-11-19-refresh/`. Upload in file-name order.

|   # | Card                      | Headline / subtitle                                                       | Apple 6.3" 1206 x 2622 | Apple 6.9" 1320 x 2868 | Play 1080 x 1920     |
| --: | ------------------------- | ------------------------------------------------------------------------- | ---------------------- | ---------------------- | -------------------- |
|   1 | `01-movies-tv`            | Your favorites, / ranked your way · Movies and TV, scored by your taste   | 3.05 MB `dd356e82`     | 3.59 MB `9ad698b1`     | 1.74 MB `6bd80f42`   |
|   2 | `02-head-to-head`         | Pick a favorite / Build your ranking · Head-to-head picks shape your list | 2.04 MB `78e9098b`     | 2.37 MB `272b068b`     | 1.20 MB `24d07824`   |
|   3 | `03-friends`              | See their picks / Share your takes · Follow friends, react, and send recs | 1.39 MB `54b1cf6b` ⚠   | 1.60 MB `9835f5fb` ⚠   | 0.82 MB `69688443` ⚠ |
|   4 | `06-for-you`              | Less scrolling / More watching · Discover picks shaped by your rankings   | 3.00 MB `bf9a8dd6`     | 3.51 MB `0f1be900`     | 1.73 MB `526d2ad9`   |
|   5 | `04-watchlist`            | Save it now / Watch it later · Keep your watchlist and friends’ picks     | 2.03 MB `1b087156`     | 2.38 MB `f74f3db9`     | 1.19 MB `b72428a7`   |
|   6 | `05-your-year` (balanced) | A little progress / A lot to celebrate · Set watch goals and earn Awards  | 0.77 MB `51e6da35`     | 0.87 MB `49195ab7`     | 0.48 MB `81307ab0`   |

⚠ Card 03 still shows the approved Nathan for You capture; it changes when the swap runs (§4). Full hashes: `checksums.json`; per-card detail: `manifest.json`. Contact sheets: `review/contact-sheet.png` (App Store) and `review/contact-sheet-play.png`. Play feature graphic candidate: `play-feature-graphic-1024x500.png`.

The 6.9" set is a native render of the same layout (uniform scale 2868/2622, centred), not an upscale of the PNG.

## 3. Validation

| Check                                                                                        | Result                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sources match #245 `SOURCES.json`                                                            | PASS, 9 layers                                                                                                                                       |
| Approved lineup = Nov 11 candidate, Apple 1206 x 2622                                        | PASS, 6/6 byte-identical                                                                                                                             |
| Approved lineup = Nov 11 candidate, Play 1080 x 1920                                         | PASS, 6/6 byte-identical                                                                                                                             |
| Every output: PNG, exact size, 8-bit RGB, no alpha, sRGB                                     | PASS, 18/18                                                                                                                                          |
| Apple: ≤ 10 MB each, ≤ 10 per slot                                                           | PASS (largest 3.59 MB; 6 per slot)                                                                                                                   |
| Play: aspect ≤ 2:1, sides 320–3840, ≤ 8 MB                                                   | PASS (9:16, largest 1.74 MB)                                                                                                                         |
| Feature graphic 1024 x 500, no alpha                                                         | PASS                                                                                                                                                 |
| Upload order 1 collection, 2 head-to-head, 3 friends, 4 for-you, 5 watchlist, 6 goals-awards | PASS                                                                                                                                                 |
| Re-run is byte-identical                                                                     | PASS                                                                                                                                                 |
| Card 03 swap pipeline (crop, redaction gate, "only the screen changed" check)                | Exercised end to end on a throwaway copy with an existing raw capture; not committed                                                                 |
| Plain-text "bingd." in the cards                                                             | None. Headlines and subtitles never name the app; "bingd." appears only as the in-app header wordmark (graphic, stays). Card 06 shows "bingd Awards" |

**Device classes.** Apple's screenshot specification (fetched 2026-11-19) lists one required iPhone size: _iPhone with Dynamic Island (medium display)_, which accepts 1206 x 2622. The large display (6.9": 1260 x 2736, 1290 x 2796, 1320 x 2868) is optional but falls back to the 6.5" slot when empty, so a stale 6.5" set from an earlier version would keep showing on large phones. Uploading both sets, and deleting any other iPhone sets, avoids that. The app is iPhone-only (`ios.supportsTablet: false`), so no iPad set is needed. Localisation: en-US only.

## 4. Card 03: the one missing input

`Screenshot_20261119_160109_bingd.jpg` (the founder's Crazy Rich Asians feed capture) was searched for on 2026-11-19: Drive (`title contains '20261119'`, `'160109'`, `'Crazy Rich'`, recent images): nothing; this container: nothing. No substitute was made.

When it exists, the swap is one command plus a redaction sign-off:

```sh
node store-assets/listings/2026-11-19-refresh/refresh.mjs --card03 <path>/Screenshot_20261119_160109_bingd.jpg
```

- **Crop:** the approved cards' Android chrome crop (rows 3.81 % to 95.41 %). On a 1080 x 2340 capture that is a 1080 x 2144 screen, the approved card 03 layer's 1.985 aspect, so the phone frames it exactly as before. No other position or scale change.
- **Privacy:** the run stops until `inputs/card03.json` has redaction boxes over every person's name and avatar on the visible screen (rows 0–2006: authors, "and others" names, engagement names) and `"reviewed": true`. Names get hard-edged blur boxes (sigma 12), avatars soft discs (sigma 10): the approved card 03 treatment. The unredacted preview goes to the system temp directory; the raw capture is never committed, only its sha256 and the redacted layer.
- **Check:** everything above the main phone's screen must be pixel-identical to the approved card, in all three sizes.

Then commit the outputs (listed in the folder README) and push. Card 06 (`Screenshot_20261119_160146_bingd.jpg`, optional) is not available either, and the library has nothing stronger (the `02 Screenshots/` captures are August dev builds with placeholder posters), so card 06 stays.

## 5. Metadata

The live App Store text could not be read from here (§6). The last recorded drafts are in `docs/release/app-store-submission-pack.md` on `release/production-and-store-prep-v4` (2026-08-31). Against those:

| Field                   | Recorded draft                                                                          | For this submission                                                                                                                                                                                                             | Note                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **App Name**            | `bingd.`                                                                                | **`bingd`**                                                                                                                                                                                                                     | The change this submission exists for. 5 characters                                                                                       |
| Subtitle                | `Rank what you watch`                                                                   | unchanged                                                                                                                                                                                                                       | No brand in it                                                                                                                            |
| Description, first line | `bingd. is a home for what you watch.`                                                  | `bingd is a home for what you watch.`                                                                                                                                                                                           | Only where "bingd." is the name. "bingd.app" and a sentence-ending "bingd." stay                                                          |
| Keywords                | `movies,tv,seasons,ranking,watchlist,film,series,tracker,friends,taste,recommend,binge` | unchanged                                                                                                                                                                                                                       | No brand in it                                                                                                                            |
| Promotional text        | "…bingd builds your ranking…"                                                           | unchanged                                                                                                                                                                                                                       | Already without the period                                                                                                                |
| What's New (1.2.0)      | —                                                                                       | Draft: "Everything from recent updates is now built into the app: a tidier feed that groups a ranking session into one post, clearer likes and comments on every post, and smoother sharing of reviews. Plus fixes and polish." | **FOUNDER CONFIRM**                                                                                                                       |
| Version                 | 1.1.0 (live)                                                                            | **1.2.0**                                                                                                                                                                                                                       | §7                                                                                                                                        |
| Screenshots, en-US      | live set                                                                                | six cards, both iPhone slots                                                                                                                                                                                                    | §2                                                                                                                                        |
| App Privacy             | as published                                                                            | unchanged                                                                                                                                                                                                                       | `store-privacy-inventory.md` records no new collection for this binary; the label is app-level. Open items F-6/F-8 are separate decisions |
| Support / privacy URLs  | bingd.app/support, /privacy                                                             | unchanged                                                                                                                                                                                                                       |                                                                                                                                           |

`metadata/apply-refresh.mjs` makes exactly these changes to a config **pulled from the live listing** (`eas metadata:pull`), prints every change, and lists anything that needs a human decision (another locale, a sentence-ending "bingd.", an older screenshot set). It was tested on a mock config only. No `store.config.json` is committed: one written from the August draft would overwrite whatever the founder has typed since.

Display names on the device are already right: the production variant's `name` is `bingd` (`app.config.ts`).

## 6. Access findings

| Path                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EAS API** (`api.expo.dev`, token injected by the proxy) | Works. Account `fourward`, app `@fourward/bingd` (`d10f76cc-…`)                                                                                                                                                                                                                                                                                               |
| **App Store Connect API key on EAS**                      | Exists: key `7L8FQ94SZX`, "[Expo] EAS Submit noU5ZIGm4w", role ADMIN, team `98729PG8GD`, assigned as the submissions key for `app.bingd`. So `eas submit -p ios` runs non-interactively and server-side                                                                                                                                                       |
| **`eas metadata:push` / `pull`**                          | eas-cli 27.11 reads that stored key from EAS, then calls App Store Connect **from this machine**. Blocked: the proxy refuses `api.appstoreconnect.apple.com` (403 at CONNECT). That host must be allowed in the environment's network settings for metadata to be pushed from here. Retrieving the stored key itself was not attempted                        |
| Public App Store lookup                                   | Blocked: `itunes.apple.com` (403)                                                                                                                                                                                                                                                                                                                             |
| **Google Play**                                           | No service account is assigned to `app.bingd`'s Android submission credentials, so `eas submit -p android` cannot upload. The EAS account does hold `eas-play-submit@fourward-2572d.iam.gserviceaccount.com` (2026-08-11); whether it has Play Console access is unknown. `production-state.md`: Play uploads are by hand. `play.google.com` is blocked (403) |
| Direct App Store Connect credentials                      | None. A static secret cannot help: the ASC API needs a short-lived JWT signed with the .p8 key                                                                                                                                                                                                                                                                |

Even with metadata access, **"Add for Review" / "Submit for Review" is the founder's step in App Store Connect**: neither `eas submit` nor `eas metadata:push` submits a version for review.

## 7. Current App Store state, and why a new binary is needed

Read from EAS on 2026-11-19:

- **Live iOS:** 1.1.0 (15), build `e38d94d9`, from `63694c3`, runtime `8ea562b7`; last EAS submission 2026-09-26 (FINISHED). No production build or submission since. `production-state.md` (store table read 2026-11-08) agrees.
- **Live production code:** OTA published 2026-11-19 09:04 UTC from **`a3300bf0`** (merge of #323), iOS group `78bc77db` on `8ea562b7`, Android group `e9ea7c27` on `ec79e181`. `a3300bf0` is `origin/main` today.
- **A version in "Prepare for Submission":** cannot be verified without App Store Connect. EAS shows nothing was uploaded after 1.1.0 (15).

Apple lets the name and screenshots change only on an editable version. 1.1.0 is released, so its train is closed: the refresh needs **a new version, 1.2.0, and a binary with that version string**. Only that binary is new; everything in it is already live by OTA.

**Prepared:** branch `claude/launch-a-store-binary-1.2.0`, commit `5821cb36` = `a3300bf0` plus `app.config.ts` only:

- `version: '1.1.0'` → `'1.2.0'` (minor, by the 1.1.0 precedent: grouped feed, Requests, Sent to You and more are new to a store binary; 1.1.1 is equally valid to Apple);
- `photosPermission` back to `bingd uses your photos…`, which `next-binary-checklist.md` §3 requires in the next binary's version-bump change.

`config/variants.test.mjs` passes on it. A production `expo config` cannot be resolved locally (the FCM file comes from the EAS environment), as expected. Not #319, #321 or #322.

**The bump moves the runtime on both platforms.** Consequences for the coordinator:

1. Until `main` carries 1.2.0, OTAs from `main` target only the 1.1.0 runtimes (`8ea562b7` / `ec79e181`), and iOS 1.2.0 runs its embedded `a3300bf0` until an OTA is published for its new runtime from a 1.2.0 tree.
2. Merging the bump to `main` makes OTAs from `main` target only 1.2.0 runtimes, which strands Android 1.1.0 (vc15) unless Android 1.2.0 ships to Play too.
3. `config/live-runtimes.json` must gain the new runtime(s) before any OTA can target them (`scripts/ota-gate.mjs`).

Recommendation: build iOS and Android 1.2.0 from the same release commit, and merge the bump to `main` once both binaries are live. iOS is the P0; Android is a hand upload to Play and must not delay Apple.

## 8. Exact submission plan

Steps 2–4 are the coordinator's call to escalate. They are not started.

1. **Card 03** (whoever has the file): run the swap (§4), sign off the redaction, commit and push to `claude/launch-a-store-refresh`. Founder/coordinator glances at `review/contact-sheet.png`.
2. **Release branch:** `git push origin 5821cb36:refs/heads/release/2026-11-19-store-1.2.0`. `release-gate.yml` runs on its own for `release/**`; wait for it to pass.
3. **Build** (on that branch, clean tree): `node scripts/release.mjs build production --platform ios --non-interactive --wait`. EAS assigns build number **16** (remote auto-increment; last `app.bingd` build was 15). Optionally the same with `--platform android` (vc16) for a hand upload to Play. A dry run on the prepared branch refuses, as it should: the branch name is not `main`/`release/*` and no gate has run.
4. **Upload to App Store Connect:** `eas submit --platform ios --profile production --id <build id> --non-interactive` (the stored ADMIN key does this; no review is requested).
5. **Metadata, in the same version** (founder in App Store Connect, or `eas metadata:pull` → `apply-refresh.mjs store.config.json --version 1.2.0` → read the diff → `eas metadata:push` if `api.appstoreconnect.apple.com` is allowed):
   - create version **1.2.0** (or use one already in Prepare for Submission and match the binary to it);
   - App Information → Name **`bingd`**; subtitle unchanged;
   - 1.2.0 → en-US → iPhone screenshots: upload `apple-1206x2622/` to _iPhone with Dynamic Island (medium display)_ and `apple-1320x2868/` to the large display, six each, in file-name order; in Media Manager, delete any other iPhone sets (6.5", 5.5") so nothing old remains;
   - description: change `bingd.` only where it is the name; What's New: confirm the draft;
   - select build 1.2.0 (16); export compliance answers itself (`ITSAppUsesNonExemptEncryption: false`); release option: manual.
6. **Before submitting:** sign in to the App Review demo account on a production install via _More sign-in options → Sign in with password_ (`store-review-access.md`). The 2026-11-15 auth change (H-2, `357bb126`) touched password handling.
7. **Submit for Review: founder, in App Store Connect.** Name and screenshots go in this one submission.
8. **After approval:** release manually; update `production-state.md`, `config/live-runtimes.json`, the `SHIPPED` table in `supabase/tests/legacy-client-compat.test.mjs`, and `next-binary-checklist.md`; decide when the bump reaches `main` (§7).

**Google Play** (lower priority, never blocks Apple): no API upload path. In Play Console, founder: store listing → app name **`bingd`**; phone screenshots from `play-1080x1920/` in order; feature graphic: keep the live one unless `play-feature-graphic-1024x500.png` is wanted. A Play listing change needs no new binary.

## 9. Outstanding actions

|   # | Action                                                                                                                                           | Who                              | Blocks                         |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------ |
|   1 | Provide `Screenshot_20261119_160109_bingd.jpg`, then run the card 03 swap and sign off the redaction                                             | Founder (file); any agent (swap) | Screenshot upload              |
|   2 | Approve building the 1.2.0 production binary from `5821cb36`, and the runtime plan in §7                                                         | Coordinator → founder            | Steps 2–4                      |
|   3 | Optional: allow `api.appstoreconnect.apple.com` in this environment's network settings, so metadata can be pulled and pushed with `eas metadata` | Founder (environment settings)   | Nothing: the manual path works |
|   4 | Confirm What's New text and the 1.2.0 version number                                                                                             | Founder                          | Step 5                         |
|   5 | Enter name and screenshots, select the build, Submit for Review                                                                                  | Founder in App Store Connect     | Submission                     |
|   6 | Play listing name and screenshots                                                                                                                | Founder in Play Console          | Nothing on Apple               |
