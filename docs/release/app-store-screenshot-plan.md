# App Store screenshot plan — bingd.

**Written 2026-08-29 against `54e32fd`.** The shot list, the exact navigation for each
frame, the demo state each one needs, and what must never appear in one.

**No screenshots were captured in the pass that produced this document, and the reason is
recorded in §1 rather than glossed.** Nothing here is a placeholder for images that exist
somewhere — the App Store set does not exist yet.

---

## 1. Screenshot automation audit — the machine as it actually is

Checked on this machine on 2026-08-29, by running the commands rather than assuming:

| | Result | How |
|---|---|---|
| Operating system | **Windows 11 Home 10.0.26200** (`MINGW64_NT-10.0-26200`) | `uname -a` |
| Xcode | **absent** | `which xcodebuild` → nothing |
| `xcrun` / `simctl` | **absent** | `which xcrun simctl` → nothing |
| **iOS Simulator** | **not available, and cannot be** | iOS Simulator is macOS-only. This is a platform fact, not a missing install |
| Android SDK | **absent** | `which adb emulator sdkmanager` → nothing; no `%LOCALAPPDATA%\Android\Sdk`; no `C:\Program Files\Android` |
| Android emulator | **absent** | as above |
| Java | **absent** | `which java` → nothing |
| Maestro / Detox / Appium | **absent** | not on `PATH`; not in `package.json`; no `.maestro/` or `e2e/` directory |
| Existing screenshot tooling | **none** | there is no screenshot script in `scripts/` or `package.json` |
| Can the app launch against nonprod without a code change? | **Yes** — `.env` holds the nonprod URL and key, `npm start` needs no edit | `.env`, `config/backends.cjs` (development lane permits `abheeqyjzekiowkztfxv`) |
| A documented safe demo account | **Not for production.** [`store-review-access.md`](./store-review-access.md) specifies one; it must be created again on production and does not exist there | that document, and the fact that production does not exist |
| iPad supported by the submitted binary? | **No** — `ios.supportsTablet: false` | `app.config.ts` |

### The conclusion, stated plainly

**Automated iOS screenshot capture is not available on this machine and no App Store
screenshots were produced.** macOS with Xcode is required, and this is Windows.

**Android was not substituted.** An Android emulator is not installed either, but even if it
were, an Android capture is not an App Store screenshot: wrong status bar, wrong corner
radius, wrong system font metrics, wrong aspect ratio, and Apple rejects submissions whose
screenshots are not of the app running on the device class they are filed under. Passing one
off as iOS would be the kind of shortcut that costs a review round.

**No new E2E framework was added.** The brief forbade it and it would be the wrong tool
anyway: the states below are five minutes of tapping on a real phone, and a framework would
still need the same seeded account.

### So the capture route is manual, and it is a good one

The founder has an iPhone with the beta installed. **Capture on the RC build, on the
production demo account** (see §4) — not on the beta, and not on the founder's own account.

- **Device:** any iPhone whose screenshots land at an accepted 6.9" size — see §2. A device
  that captures at 1290 × 2796 or 1320 × 2868 is directly usable with no resizing.
- **Method:** the phone's own screenshot gesture. No tooling, no simulator, no editing.
- **Do not upscale a smaller device's capture to 6.9".** Apple accepts the smaller sizes in
  their own slots; a stretched image is visibly soft and looks like what it is.

### If a Mac becomes available

`npx expo run:ios` against nonprod, then `xcrun simctl io booted screenshot <file>` on an
iPhone 16 Pro Max (or newer equivalent) simulator, which captures natively at 1320 × 2868.
Seed the same account described in §4. **Nothing in this repository needs to change for
that** — the development lane already permits nonprod and `npm start` needs no edit.

---

## 2. The exact requirement — from Apple's current specification

Read from Apple's *Screenshot specifications* on 2026-08-29.

| Display size | Portrait | Required? |
|---|---|---|
| **6.9"** | **1260 × 2736** — also accepts **1290 × 2796** and **1320 × 2868** | **REQUIRED if the app runs on iPhone.** This is the only size that must be supplied |
| 6.5" | 1284 × 2778, or 1242 × 2688 | Required **only if** no 6.9" set is provided |
| 6.3" | 1179 × 2556, or 1206 × 2622 | Optional |
| 6.1" | 1170 × 2532, 1125 × 2436, or 1080 × 2340 | Optional |
| 5.5" | 1242 × 2208 | Optional |
| 4.7" | 750 × 1334 | Optional |

- **1 to 10 screenshots per display size.** The first three are what a browsing user sees
  without scrolling, so they carry the argument.
- **Formats:** `.png`, `.jpg`, `.jpeg`. **No alpha channel, no transparency.** A PNG straight
  off an iPhone has no alpha and is fine.
- **Portrait only** for this app — `app.config.ts` sets `orientation: 'portrait'`.

### iPad — **not required**

`app.config.ts` sets `ios.supportsTablet: false`, so the submitted binary does not run on
iPad, and Apple requires iPad screenshots only for apps that do. **Do not produce iPad
screenshots**; supplying them would imply support that the binary does not declare and that
nothing has been tested against.

### The existing images are not usable, and it is worth saying why

`store-assets/google-play/screenshots/` holds four captures at 1080 × 2340. They are:

- **Android**, not iOS;
- from the **dev variant**, captured 2026-08-14, before the middle tab was renamed Log →
  Search on 2026-08-19 — so the tab bar reads "Log" and the app no longer does;
- showing **placeholder initial tiles instead of TMDB posters**, and placeholder actor names.

They were fit for a friend beta on Play and are recorded as such in that file's own caveats.
They are not App Store material and are not reused here.

---

## 3. The shot list — six frames, in upload order

Six rather than ten. Each one has to earn its slot; a seventh frame showing another list
does not.

The **first three are what a scrolling browser sees**, so the order is: the hook, the payoff,
the proof.

---

### Shot 1 — The comparison *(the hook)*

| | |
|---|---|
| **Screen** | The head-to-head ranking comparison |
| **Navigation** | Search tab → search a film the demo account has not ranked → open it → **Rank** → pick a reaction → the comparison appears |
| **Demo state** | At least 8–10 titles already ranked in the same category, so the comparison is against a real title and not an empty band |
| **What it communicates** | *This app asks you an easier question than every other app.* It is the one screen no competitor's listing has, and it explains the product without a caption |
| **Avoid** | A pairing where either poster is a placeholder initial tile. Retry the search until both sides have real TMDB artwork |
| **Caption** | **"Which one did you like more?"** |

---

### Shot 2 — The ranked collection *(the payoff)*

| | |
|---|---|
| **Screen** | Collection tab, Movies, Watched, sorted by score |
| **Navigation** | **Collection** tab → **Movies** on the medium selector → **Watched** segment → confirm the sort is score order |
| **Demo state** | 10+ ranked films with real posters, and a spread of scores — a list where everything is 8.x looks broken |
| **What it communicates** | The comparison in shot 1 produces *this*: a personal, ordered list with a score out of 10 that came from the user's own decisions |
| **Avoid** | An empty state; a list short enough to show the bottom of the screen |
| **Caption** | **"Your list, in your order"** |

---

### Shot 3 — Title detail with the user's own rank *(the proof)*

| | |
|---|---|
| **Screen** | `title/[id]` for a well-known, well-illustrated film the demo account has ranked highly |
| **Navigation** | From shot 2's list, tap the top-ranked title |
| **Demo state** | The title must be ranked, so **Your rank** is populated; a short review written by the demo account reads better than none |
| **What it communicates** | The score is attached to a real title with real artwork, and the app is a place things live rather than a quiz |
| **Avoid** | A title whose hero image is missing. **Do not show a private note** — if the demo account has one on this title, pick another title |
| **Caption** | **"Every title, exactly where you put it"** |

---

### Shot 4 — The feed *(the social case)*

| | |
|---|---|
| **Screen** | Feed tab |
| **Navigation** | **Feed** tab, scrolled so a full activity card with a reaction row is centred |
| **Demo state** | The second demo account has posted **two or three** activities — a ranking, a review, ideally a comment thread with a reaction on it |
| **What it communicates** | Other people are here and what they think is legible at a glance |
| **Avoid** | **Any real tester's handle, display name, avatar or writing.** Both accounts in this frame must be the two seeded demo accounts. This is the single highest-risk frame in the set |
| **Caption** | **"See what your friends actually think"** |

---

### Shot 5 — For you *(discovery)*

| | |
|---|---|
| **Screen** | For you tab, the recommendation slate |
| **Navigation** | **For you** tab, default segment |
| **Demo state** | Enough ranked titles that the slate is populated **and each card shows its reason line** — the "why it is there" is the differentiator and a frame without it is just posters |
| **What it communicates** | Recommendations that explain themselves |
| **Avoid** | A sparse or empty slate. If it will not fill, rank more titles rather than shipping a thin frame |
| **Caption** | **"Suggestions that say why"** |

---

### Shot 6 — Profile with awards *(the reward loop)*

| | |
|---|---|
| **Screen** | Profile tab — the stats row, a goal in progress, and **Top ranked**; or the Awards sheet open over it |
| **Navigation** | **Profile** tab. For the awards variant: **Bingd Awards** |
| **Demo state** | Stats populated; at least one goal partly complete; at least one award earned with its "what it was for" line; Top ranked showing three real posters |
| **What it communicates** | The app keeps score of what you have actually done |
| **Avoid** | The founder's own profile. **No email address anywhere on screen** |
| **Caption** | **"A record of what you have watched"** |

### Capture order, and why it is this order

1. **Shot 2** first — the ranked collection has to exist before anything else looks right.
2. **Shot 3** — tap straight through from shot 2.
3. **Shot 6** — the profile is populated by the same data; take it while you are there.
4. **Shot 5** — For you needs the rankings from step 1 to have been processed.
5. **Shot 4** — the feed needs the *second* account to have posted; do that, then come back.
6. **Shot 1** last — it needs an **unranked** title, and ranking titles for the other shots
   has been consuming them. Leave one aside deliberately.

Upload order in App Store Connect is 1 → 6 as numbered above, which is **not** the capture
order. That is intentional.

---

## 4. The account these are taken on

**The production store-review account, seeded per
[`store-review-access.md`](./store-review-access.md) §3**, plus its second account. Not the
founder's account, and not a friend tester's.

Three reasons, and the third is the one that bites:

1. It is the account App Review will sign into, so the screenshots and the reviewer's first
   screen agree.
2. Its content is deliberate rather than personal.
3. **The seeding it already requires is exactly the seeding these shots need** — ten ranked
   titles, a second account following both ways, two or three feed events, one recommendation
   received. Doing it once serves both.

### Never in a store screenshot

- A real email address — the reviewer account's included
- A one-time code, or the verify screen with a code visible
- A private note. Notes are private by default; a screenshot publishes one permanently
- Any tester's handle, display name, avatar, review, comment or reaction
- The Diagnostics sheet, or anything naming the backend
- A notification banner from another app
- Low battery, no signal, or a debug/dev-variant badge

**Check every frame for a handle you did not seed before uploading.** A feed is the one
surface that draws other people's names, and it is shot 4.

---

## 5. Not in this pass

- **No app preview video.** Out of scope by instruction, and the right call for a first
  release: a video is a separate production and Apple requires it per display size.
- **No captions burned into the images.** The captions in §3 are for a framed-and-captioned
  set if the founder later wants one. **Plain, unframed device captures are recommended for
  launch** — they are honest, they take an afternoon, and they are what the App Store shows
  by default.
- **No localised sets.** There is one localisation.
