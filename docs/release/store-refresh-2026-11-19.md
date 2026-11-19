# Store refresh, 2026-11-19: the name `bingd` and the new screenshots

**Goal:** one App Store submission that carries both the plain-text name change (`bingd.` → `bingd`) and the refreshed six-screenshot set. Never two review cycles. Bundle identifier (`app.bingd`), Apple team (`98729PG8GD`), app record (`6803954532`) and the brand stay as they are. The graphic wordmark inside the app and the screenshots keeps its period.

**Status on 2026-11-19, 23:30 UTC: release candidate gated, not built, not submitted.** The founder approved building 1.2.0 for iOS and Android from one release commit. `release/2026-11-19-store-1.2.0` (`5821cb36`) passed the release gate, but the production build **cannot run from the cloud session** (§10). It has to run on the founder's machine. Nothing has been uploaded to App Store Connect or Google Play. Assets: `store-assets/listings/2026-11-19-refresh/` (branch `claude/launch-a-store-refresh`).

|                      | State                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Six cards, all slots | Done, except card 03's new feed capture                                                            |
| Card 03 feed swap    | **Waiting for one input:** `Screenshot_20261119_160109_bingd.jpg` (not in the repo or on Drive)    |
| Card 06              | Unchanged by decision (no stronger capture exists)                                                 |
| Metadata             | Name, version and What's New drafted; live text not readable from here                             |
| New binary           | Approved; `release/2026-11-19-store-1.2.0` gate **passed**; **not built** (§10: founder's machine) |
| App Store Connect    | No direct access from this environment                                                             |

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

The founder approved 1.2.0 for **both** iOS and Android from the same release commit (relayed by the coordinator, 2026-11-19).

1. **Card 03** (whoever has the file): run the swap (§4), sign off the redaction, commit and push to `claude/launch-a-store-refresh`. Then the founder or coordinator glances at `review/contact-sheet.png`.
2. **Release branch: DONE.** `release/2026-11-19-store-1.2.0` = `5821cb36`. Its diff from `a3300bf0` is `app.config.ts` only (version, photo-permission text). The release gate passed: <https://github.com/fourwardhabits/bingd/actions/runs/44632916599> (2026-11-19 23:07 UTC).
3. **Build: on the founder's machine** (§10 explains why not here), from a clean checkout of that branch with `./google-services.json` in the project root, as for 1.1.0:
   ```sh
   git fetch origin && git checkout release/2026-11-19-store-1.2.0   # HEAD must be 5821cb36
   node scripts/release.mjs build production --platform ios --non-interactive --wait
   node scripts/release.mjs build production --platform android --non-interactive --wait
   ```
   Expected: iOS **1.2.0 (16)** and Android **1.2.0, versionCode 16**. `appVersionSource: remote` auto-increments, and the last production `app.bingd` builds are 15 on both. Read the real numbers off the build pages.
4. **Upload iOS to App Store Connect:** `eas submit --platform ios --profile production --id <iOS build id> --non-interactive`. It needs no machine-local secret (EAS signs with its stored ADMIN key), so an agent here can run it once the build exists. It requests no review.
5. **Android:** no Play service account, so no `eas submit`. Download the `.aab` from the build page on expo.dev, signed in to the `fourward` account, and upload it by hand in Play Console. The artifact link is not recorded here.
6. **Metadata, in the same version**: the founder's checklist, §12.
7. **Submit for Review: the founder, in App Store Connect.** The name and the screenshots go in this one submission.
8. **After approval:** release manually, then do §11.

**Google Play listing** (lower priority, never blocks Apple; no API upload path). In Play Console, the founder sets the app name to **`bingd`** and uploads the phone screenshots from `play-1080x1920/` in order. Keep the live feature graphic unless `play-feature-graphic-1024x500.png` is wanted. A listing change needs no binary, so it can go with or before the 1.2.0 rollout.

## 9. Outstanding actions

|   # | Action                                                                                               | Who                                                       | Blocks                            |
| --: | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
|   1 | Provide `Screenshot_20261119_160109_bingd.jpg`, then run the card 03 swap and sign off the redaction | Founder (file); any agent (swap)                          | Screenshot upload                 |
|   2 | Run the two production builds (§8 step 3)                                                            | **Founder, on their machine** (or decide option B in §10) | iOS submit, Android upload        |
|   3 | `eas submit` the iOS build                                                                           | Any agent, or the founder                                 | App Store Connect build selection |
|   4 | Confirm What's New text                                                                              | Founder                                                   | §12                               |
|   5 | §12 in App Store Connect, then Submit for Review                                                     | Founder                                                   | Submission                        |
|   6 | Upload the Android `.aab`; Play listing name and screenshots                                         | Founder in Play Console                                   | Nothing on Apple                  |
|   7 | Optional: allow `api.appstoreconnect.apple.com` in this environment, to use `eas metadata`           | Founder (environment settings)                            | Nothing: the manual path works    |
|   8 | After both 1.2.0 binaries are live: §11                                                              | Coordinator                                               | OTAs to 1.2.0 installs            |

## 10. Build attempt from the cloud session, 2026-11-19

- `node scripts/release.mjs build production --platform ios --non-interactive --wait` on `release/2026-11-19-store-1.2.0`: the script's own guards **passed** (clean tree, `release/*` branch, release gate run 44632916599). Then `eas build` stopped **before uploading anything**. Resolving `app.config.ts` threw: _"A production build needs Android push configuration and there is none"_ (`config/push.cjs`). EAS lists no new build.
- **Cause.** The production lane needs `google-services.json` while the config is evaluated, and that happens on the machine that runs `eas build`. On EAS the file is `GOOGLE_SERVICES_JSON`, a FILE variable with visibility **SECRET**. eas-cli loads only _Plain text_ and _Sensitive_ variables into a local run, so a cloud session cannot see it. The 1.1.0 binaries were built from the founder's CLI (user `fourward`, eas-cli 21.8.0), which has the git-ignored local file.
- **Not worked around.** A placeholder `google-services.json` would get past a guard written to stop a production binary from shipping without working Android push. It was not tried.
- **Options:**
  - **A (recommended).** The founder runs §8 step 3 on their machine. It is two commands, and the same path 1.1.0 took.
  - **B.** The founder changes `GOOGLE_SERVICES_JSON` (production) to visibility _Sensitive_. It is a Firebase client config that ships inside every APK anyway. A cloud agent could then run the builds. It is a credential-policy change, so it is the founder's decision.
  - **C.** A server-side EAS build workflow. This is a new, unreviewed release path; not recommended for today.

## 11. After both 1.2.0 binaries are live: the version bump and `config/live-runtimes.json`

> **Reminder: do not merge the 1.2.0 bump (`5821cb36`, `app.config.ts`) into `main` until iOS 1.2.0 and Android 1.2.0 are both live in their stores.**

**`config/live-runtimes.json` needs no change on `main` now, and could not usefully take one.**

- **What the gate checks.** `.eas/workflows/ota-production.yml` publishes only from `main`. `scripts/ota-gate.mjs runtimes` requires the cloud fingerprint of that commit to _equal_ the single `production.{ios,android}.runtime` listed in `config/live-runtimes.json`.
- **While `main` is at 1.1.0,** its fingerprints are `8ea562b7` / `ec79e181`. The file must keep listing those, or OTAs to the 1.1.0 installs stop.
- **No OTA can reach the 1.2.0 runtimes yet.** Getting one there takes a commit on `main` that carries 1.2.0 and a file that lists the 1.2.0 runtimes. Until then, 1.2.0 installs run their embedded `a3300bf0`, which is today's production code.

**When both are live, one change to `main`:**

1. Merge `5821cb36` (the bump).
2. In the same change, set `config/live-runtimes.json` → `production.ios` = `{ runtime: <iOS 1.2.0 runtime from the build page>, build: <iOS build id>, version: "1.2.0 (16)" }`, and the same for `production.android` with its runtime, build id and `"1.2.0 (16)"`.
3. Update `production-state.md`, the `SHIPPED` table in `supabase/tests/legacy-client-compat.test.mjs`, and `next-binary-checklist.md` (§1 and §3 delivered by this binary).

From then on, OTAs from `main` reach 1.2.0 and **no longer reach 1.1.0 installs**. Those keep the last OTA they got (`a3300bf0` or later) and are prompted by the store to update. The file holds one runtime per platform, so serving both trains would need a second publish from a 1.1.0 tree, as in 1.0.1's time.

## 12. Founder's App Store Connect checklist

Do this when the iOS build shows in App Store Connect (after §8 steps 3–4), and after card 03 is swapped. **Build: 1.2.0 (16)**: expected, so confirm the number on the EAS build page before selecting it.

1. **Apps → bingd → (+) iOS App version: `1.2.0`.** If a version is already in _Prepare for Submission_, rename it to 1.2.0 instead.
2. **App Information → Name: `bingd`** (5 characters, no period). Leave the subtitle, category and privacy policy URL as they are. Save.
3. **1.2.0 → English (U.S.) → Previews and Screenshots → View All Sizes in Media Manager:**
   - **iPhone 6.9" Display** (large, Dynamic Island): delete the current images, then upload the six files in `store-assets/listings/2026-11-19-refresh/apple-1320x2868/` in file-name order (01 … 06).
   - **iPhone 6.3" Display** (medium, Dynamic Island): delete the current images, then upload the six in `apple-1206x2622/` in the same order.
   - **Any other iPhone size** that still holds its own images (6.5", 6.1", 5.5"): delete them, so it scales from the new sets.
   - Check the order on the product-page preview: 1 collection, 2 head-to-head, 3 friends, 4 for you, 5 watchlist, 6 goals and Awards.
4. **Description:** change `bingd.` to `bingd` only where it is the app's name (for example, the first line `bingd. is a home for what you watch.`). Leave `bingd.app` links alone, and leave a period that ends a sentence. Keywords and promotional text: no change.
5. **What's New in This Version:** paste the confirmed text (draft in §5).
6. **Build → (+) → 1.2.0 (16).** Export compliance should not be asked (`ITSAppUsesNonExemptEncryption: false`).
7. **App Review Information:** the demo account and notes are unchanged. **Before submitting**, sign in with it once on a production install (_More sign-in options → Sign in with password_): the 2026-11-15 password change (H-2) touched that path.
8. **Version Release: Manually release this version.**
9. **Add for Review → Submit to App Review.** Check that the submission lists both the App Information change (the name) and version 1.2.0 (the screenshots). One submission, one review.
10. After approval: **Release This Version**, then tell the coordinator, so §11 can run once Android 1.2.0 is live as well.
