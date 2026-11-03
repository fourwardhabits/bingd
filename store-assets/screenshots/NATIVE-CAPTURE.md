# Native capture: decision note

Written 2026-11-02. The founder decides; nothing below has been provisioned.

## The decision

| Surface | Chrome render of the real components | Why |
|---|---|---|
| Website | **Acceptable** | The site is a browser surface already, and the images are illustrations of the product |
| Social | **Acceptable** | Same reasoning, with the artwork caveat below |
| App Store listing | **Not acceptable as the final image** | See below. Native capture needed |
| Google Play listing | **Not acceptable as the final image** | See below. Native capture needed |

Neither store publishes a rule that says a screenshot must come from a device, so this is a
judgement, not a quoted prohibition. Apple asks that screenshots "show the app in use"
(Guideline 2.3.3). Google asks for screenshots that "reflect your app's actual experience".
A store listing is a promise about the build someone is about to install, and this render is
not that build. Use the store frames this pipeline makes today to check layout and copy, and
replace the raw captures before anything goes to a store.

What differs, specifically:

- **It is a hybrid no phone has.** The render forces the Android tab bar (56pt) so the layout
  looks like a phone, while `Platform.select` gives web the iOS navigation bar height (44).
  An iPhone listing would show an Android tab bar.
- **It is not the shipped renderer.** react-native-web draws DOM, so text metrics, shadows and
  image scaling are Chrome's. `hairlineWidth` is shimmed to imitate a 3x phone. Native-only props
  do nothing: `Button`'s `fit` mode relies on `adjustsFontSizeToFit`, which react-native-web does
  not implement, and "Add details" on the score sheet runs edge to edge in every render because
  of it. Whether a phone draws it that way has not been checked, because that needs a device.
- **There is no operating system in the picture.** No status bar, Dynamic Island or home
  indicator. The frames crop the blank space that stands in for them.
- **It runs against a mock, not the backend.** The mock can drift from the real contract. That
  happened while building this: the `recommendations_to_me` row shape had moved on, and Sent to
  you rendered empty until the fixture was corrected. A wrong screen is possible, not theoretical.
- **It is built from a branch**, so it can show work that is not in the store build. That is
  the same failure `web/shots.mjs` paints out by hand for the Letterboxd line.

Compose and export do not care where a raw PNG came from, so moving to native capture replaces
only stage 1. The frames, copy and sizes stay as they are.

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

So native capture cannot run here today, and iOS capture can never run on this machine.

## The cheapest way to get native captures

**Take them by hand on real phones.** It needs no tooling at all.

1. Install a build signed in to the demo account below.
2. Screenshot each screen on one iPhone with a Dynamic Island and one Android phone. A
   current non-Max iPhone produces 1179x2556 or 1206x2622, Apple's stated required size.
3. Name each file after its scene id in `manifest/scenes.mjs`: `feed.png`, `compare.png`.
4. Run compose against that folder, then export:

   ```
   node compose/run.mjs --raw <folder> --status-bar <pixels to crop from the top>
   node export/run.mjs --raw <folder>
   ```

If this is repeated often, Maestro can drive it. `maestro/` has two flows, written but **never
run**, because Maestro is not installed. They need a Mac with Xcode for the Simulator, or the
Android SDK plus a phone or emulator.

## The demo account

A dedicated account for captures. **Do not provision it until the current staging security
retest has finished**, and not from this pipeline.

### Where it lives: founder decision

- **Staging with a Preview build (recommended).** Fictional friends cannot leak into real
  members' suggestions, leaderboards or community scores, which production cannot promise.
  Check first that no Preview-only UI shows on the captured screens.
- **Production.** The screens are exactly the store build, but seeding fictional people means
  fictional rows in real members' People suggestions and score averages.

### What it needs

| Screen | Data |
|---|---|
| Profile | Fictional display name and handle, a short bio, no photo. Goals set for the year. Some Awards unlocked and some in progress |
| Collection | At least 25 ranked movies and 12 ranked TV seasons, spread across all three buckets, with mild posters highest. Nothing logged but unranked, or the Collection leads with a prompt card |
| Watchlist | At least 9 titles, mild posters first |
| Feed | 4 to 6 fictional friends with mutual follows, each with 15 or more rankings. Activity from the last day at capture time, so the times read naturally. At least one reaction |
| Comments | One activity with a short thread of 2 or 3 comments between fictional friends |
| For You | Enough rankings that the wall is personalised, not the cold-start line |
| Sent to you | 2 or 3 recommendations of titles the account has **not** ranked. The app hides ranked ones |
| Group Picks | The same fictional friends, with enough overlap to return picks |
| Ranking | One unranked title with a mild poster, and a list long enough for 2 or 3 comparisons. Undo the ranking after capture so the next run starts the same |

The fixtures in `capture/mock/backend.mjs` are a working example of all of this.

### What must never appear

- **Real people.** No real member's name, handle, photo, comment, ranking or list, and that
  includes the founder's own account and friends. No real face as an avatar, stock photos
  included. No cast or crew names on a captured screen.
- **Personal or account details.** Email addresses, sign-in codes, phone numbers, the device's
  name, carrier, personal notifications, keyboard suggestions.
- **Credentials.** The account's sign-in details never go in this repo, a Maestro flow or a log.
- **Build internals.** Staging URLs, the name `bingd preview`, dev menus, debug overlays,
  error toasts, loading states, empty states.
- **Anything the store build cannot do.** No unreleased feature and no unmerged screen.
- **Invented claims.** No member counts or rankings of the app. Google Play bars text that
  indicates store performance, such as "#1". Demo numbers belong inside the product UI only.
- **Posters that fail a 4+ rating.** Guideline 2.3.8 applies to screenshots whatever the app's
  own rating is. No gore, weapons aimed at someone, nudity or horror key art. The live store
  frames show *The Wolf of Wall Street*, which is worth a look under this rule.
- **Third-party logos as a feature.** Skip the Where to watch screen, which is full of
  streaming service marks.

## Open question this does not settle

**Poster licensing.** The brand kit allows artwork only inside an app screenshot and asks that
paid or print use is checked first. Every frame here that has a device has posters inside it.
The Google Play feature graphic has none, by design. Whether TMDB's terms and the rights
holders' permit posters in store listings and social posts, even inside a screenshot, is
unresolved and is the founder's call before anything is published.

**Kit rule 2**, "keep other members' names and faces blurred in every screenshot", exists to
protect real members. These captures contain none, so the pipeline does not blur the fictional
names. Native captures from an account with any real member on screen must still be blurred.
Compose has no blur step today; `web/shots.mjs` shows how it was done, and the demo account
exists so that no blur is needed.
