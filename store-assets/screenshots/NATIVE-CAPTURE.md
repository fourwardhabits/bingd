# Native capture: decision and plan

Written 2026-11-02, revised the same day against the Visual 2.0 candidate
(`visual2/4-profile-awards` at `87ea14c`). The founder decides; nothing below has been
provisioned.

**Everything this pipeline has produced so far is a layout proof.** None of it is a final store
screenshot, and none of it should be uploaded to a store.

## The decision

| Surface | Chrome render of the real components | Why |
|---|---|---|
| Website | **Acceptable** | The site is a browser surface already, and the images illustrate the product |
| Social | **Acceptable** | Same reasoning, subject to the three decisions at the end |
| App Store listing | **Not acceptable as the final image** | Capture on a phone, below |
| Google Play listing | **Not acceptable as the final image** | Capture on a phone, below |

Neither store publishes a rule that says a screenshot must come from a device, so this is a
judgement, not a quoted prohibition. Apple asks that screenshots "show the app in use"
(Guideline 2.3.3). Google asks for screenshots that "reflect your app's actual experience".
A store listing is a promise about the build someone is about to install, and this render is
not that build.

What differs, specifically:

- **It is a hybrid no phone has.** The render forces the Android tab bar (56pt) so the layout
  looks like a phone, while `Platform.select` gives web the iOS navigation bar height (44).
  An iPhone listing would show an Android tab bar.
- **It is not the shipped renderer.** react-native-web draws DOM, so text metrics, shadows and
  image scaling are Chrome's, and `hairlineWidth` is shimmed to imitate a 3x phone. Native-only
  props do nothing. On the sprint branch, "Add details" ran edge to edge on the score sheet
  because `adjustsFontSizeToFit` has no web implementation. Visual 2.0's wider buttons hide
  that, but the prop is still inert in every render.
- **There is no operating system in the picture.** There is no status bar, Dynamic Island or
  home indicator; the frames crop the blank space that stands in for them.
- **It runs against a mock, not the backend.** The mock can drift from the real contract. It
  already has: `recommendations_to_me` changed shape and Sent to you rendered empty until the
  fixture caught up.
- **It is built from a branch**, so it can show work that is not in the store build.

Compose and export do not care where a raw PNG came from. Moving to native capture replaces
stage 1 only: the frames, copy and sizes stay as they are.

## Compatibility with Visual 2.0

Run against `87ea14c`, which contains `main`, #221 and the four Visual 2.0 pull requests:

- **Every capture-time patch still applied unchanged**: web output `single`, both Android tab
  bar branches, the entry shim, and the `expo-notifications` stub. No export path moved.
- **All 13 scenes passed without a scene change.** The visible copy they wait on survived the
  redesign, and the mock saw no backend call it does not answer.
- **One thing broke: framing.** The score sheet grew taller to show its neighbour posters, and
  a crop set as a fixed fraction of the screen started cutting through its handle. Scenes now
  name the shared `Sheet`'s own `sheet-body` test id, capture records where it starts, and
  compose frames the sheet from that. A fraction stays only as the fallback for native captures.
- **Nothing in the redesign put a Paper surface against the Maroon field.** The Ink bezel
  always sits between them.
- The redesign's Maroon sign-in masthead is not in any frame. Apple's Guideline 2.3.3 says
  screenshots should not merely show a login page, so sign-in is not a scene.

## What this machine has

Probed 2026-11-02 without installing anything.

| Tool | Result |
|---|---|
| `adb`, `emulator`, `sdkmanager`, `avdmanager` | Not on PATH |
| `ANDROID_HOME`, `ANDROID_SDK_ROOT` | Unset |
| `%LOCALAPPDATA%\Android\Sdk`, `C:\Android`, `C:\Program Files\Android` | Absent |
| `%USERPROFILE%\.android`, including `avd` | Absent |
| Android Studio | Absent from the default path |
| `java`, `JAVA_HOME` | Not on PATH, unset |
| `maestro`, `%USERPROFILE%\.maestro` | Absent |
| `scrcpy` | Not on PATH |
| `xcodebuild`, `xcrun`, `simctl` | Absent, and Xcode does not run on Windows |
| Chrome | Installed; this is what stage 1 uses |

Native capture cannot run here today, and iOS capture can never run on this machine.

## The native capture plan

The cheapest route needs no tooling: take screenshots by hand on two real phones. `maestro/`
has flows for the same screens, written but **never run**.

### 1. Devices

| For | Device | Screenshot size |
|---|---|---|
| App Store, required | An iPhone with a Dynamic Island, not a Max or Plus. Apple's page names iPhone 14 Pro, 15, 15 Pro, 16, 16 Pro, 17, 17 Pro and 18 Pro | 1179x2556 or 1206x2622 |
| App Store, optional | A Max or Plus with a Dynamic Island, for native 1320x2868 | Up to 1320x2868 |
| Google Play | Any current Android phone with a 1080px-wide screen | 1080 wide |

One iPhone set feeds all three App Store sizes, because compose scales the screen into the frame.

### 2. Account, build and data

- **Build:** the store build of the version being listed, or a Preview build of the same commit
  if the account lives on staging. The decision below says which.
- **Account:** the dedicated demo account specified in "The demo account" below, with the data
  in its table. Never the founder's account, never a real member's.
- **Phone settings:** portrait, light mode, default text size, Do Not Disturb on, and no
  keyboard on screen. The status bar is cropped away, but notifications can cover the app.

### 3. Exact scenes

Name each file exactly as the scene id, for example `feed.png`.

| Scene id | Steps on the phone | Used by |
|---|---|---|
| `compare` | Search, open an unranked title with a mild poster and a backdrop, Rank, I liked it. Stop on "Which did you like more?" | App Store and Play "head to head", social |
| `reveal` | Keep choosing until the score sheet shows, with its neighbour posters. Stop there | Social "promise" |
| `feed` | Feed tab, Activity, scrolled to the top so Trending now shows | "friends" |
| `comments` | From the Feed, open the comments on the activity with a short thread | "friends" inset |
| `collection-movies` | Collection, Movies, Watched, grid view, sorted by Rating | "movies and TV" |
| `collection-tv` | Collection, the Movies menu, TV | "movies and TV" inset |
| `watchlist` | Collection, Movies, Watchlist, grid view | "watchlist" |
| `sent-to-you` | For you, Sent to you | "watchlist" inset |
| `for-you` | For you, the Recommended Movies wall at the top | "for you" |
| `profile` | Profile tab, at the top | "your taste" inset |
| `awards` | Profile, bingd Awards, See all | "your taste" |
| `group-picks` | For you, Group Picks, tick two friends. Do not press Get picks | Website only |
| `first-five` | Only reachable on a brand-new account during onboarding. Skip it unless the website needs it | Website only |

After `reveal`, undo the ranking so the next capture starts from the same list.

### 4. Into compose and export

1. Copy the files into `store-assets/screenshots/out/native/iphone/` and
   `out/native/android/`. Everything under `out/` is gitignored, and the files contain posters,
   so never put them anywhere else in the repo.
2. Measure the status bar on one capture, in pixels from the top edge to the top of the app's
   own header. It differs by phone, so measure rather than assume.
3. Compose and export the iPhone set:

   ```
   node compose/run.mjs --raw out/native/iphone --out out/native/iphone-composed --status-bar <px> --canvases store-tall
   node export/run.mjs --raw out/native/iphone --composed out/native/iphone-composed --out out/native/iphone-export --status-bar <px> --targets app-store-dynamic-island-large,app-store-dynamic-island-medium,app-store-face-id-large
   ```

4. The Android set is the same with `--canvases play-phone` and `--targets google-play-phone`.
5. Open every frame. Two things are guaranteed only for the Chrome captures:
   - **Sheet framing.** The sheet frames use `focus.fallback` in `manifest/frames.mjs` when
     there is no `capture.json`. If a crop cuts through a sheet, change that number.
   - **The tab bar cut.** The test that keeps the canvas edge off the tab bar models the Chrome
     device. Check by eye that a native frame's foot does not slice through it.
6. If a scene was not captured, pass `--frames` with only the frames whose scenes exist.

## The demo account

**Do not provision it until the current staging security retest has finished**, and not from
this pipeline.

### What it needs

| Screen | Data |
|---|---|
| Profile | Fictional display name and handle, a short bio, no photo. Goals set for the year. Some Awards unlocked and some in progress |
| Collection | At least 12 ranked movies and 15 ranked TV seasons across all three buckets, mild posters highest. Nothing logged but unranked, or the Collection leads with a prompt card |
| Watchlist | At least 6 titles, mild posters first |
| Feed | 4 to 6 fictional friends with mutual follows, each with 15 or more rankings. Activity from the last day at capture time, so the times read naturally. At least one reaction |
| Comments | One activity with a thread of 2 or 3 comments between fictional friends |
| For You | Enough rankings that the wall is personalised, not the cold-start line |
| Sent to you | 3 to 6 recommendations of titles the account has **not** ranked. The app hides ranked ones |
| Group Picks | The same fictional friends, with enough overlap to return picks |
| Ranking | One unranked title with a mild poster and a backdrop, and a list long enough for 2 or 3 comparisons |

`capture/mock/backend.mjs` is a working example of all of this.

### What must never appear

- **Real people**, unless they have consented in writing: no member's name, handle, photo,
  comment, ranking or list, including the founder's own account and friends. No real face as an
  avatar, stock photos included. No cast or crew names.
- **Personal or account details**: email addresses, sign-in codes, phone numbers, the device's
  name, notifications, keyboard suggestions.
- **Credentials**, in this repo, a Maestro flow or a log.
- **Build internals**: staging URLs, the name `bingd preview`, dev menus, debug overlays, error
  toasts, loading states, empty states.
- **Anything the store build cannot do**: no unreleased feature, no unmerged screen.
- **Invented claims**: no member counts or rankings of the app. Google Play bars text that
  indicates store performance, such as "#1".
- **Third-party logos as a feature**: skip the Where to watch screen.

## Founder decisions

These are three separate decisions. Settling one does not settle another.

### Decision 1: Poster licensing

Every frame with a phone shows posters inside it. The brand kit allows artwork only inside an
app screenshot, and asks that paid or print use is checked first. Whether TMDB's terms and the
rights holders permit posters in store listings and social posts, even inside a screenshot, is
unresolved. The Google Play feature graphic is the one asset with no posters, by design.

### Decision 2: Privacy

Only fictional people, or people who have consented in writing, may appear. The brand kit's rule
2 says to keep other members' names and faces blurred in every screenshot. The Chrome captures
show only fictional people, so nothing is blurred. Decide whether the rule should apply to
fictional names anyway. A native capture from any account where a real member appears must be
blurred, and compose has no blur step: `web/shots.mjs` shows how it was done. The demo account
exists so that no blur is needed.

### Decision 3: App rating

Apple's Guideline 2.3.8 says screenshots must suit a 4+ rating whatever the app's own rating, for
example no gruesome images and no weapon pointed at someone. Every poster the scenes load was
reviewed on 2026-11-02:

- **Removed from the fixtures**: *Stranger Things*, whose key art is a red tentacled monster and
  which was the top TV tile and on the Feed's Trending shelf, and *Parasite*, whose poster shows
  a body's legs on a lawn. Earlier passes had already removed *Fight Club*, *The Conjuring*,
  *Ted*, *Pulp Fiction*, *The Wolf of Wall Street*, *Game of Thrones*, *Attack on Titan*,
  *Breaking Bad* and *The Last of Us*.
- **Judgement calls left in**: *The Matrix* (figures in black coats), *Mad Max: Fury Road* (a
  desert chase), *The Dark Knight* (a burning building) and *Inception* (a group in a flooded
  street). None shows a weapon aimed at anyone at the size it appears. Remove them if in doubt.
- **The live listing** shows *The Wolf of Wall Street*, which is worth checking under this rule.
- **Native captures** inherit the demo account's posters, so the same review applies to its list.

### Also needed: where the demo account lives

- **Staging with a Preview build (recommended).** Fictional friends cannot leak into real
  members' suggestions, leaderboards or community scores. Check first that no Preview-only UI
  shows on the captured screens.
- **Production.** The screens are exactly the store build, but seeding fictional people puts
  fictional rows into real members' suggestions and score averages.
