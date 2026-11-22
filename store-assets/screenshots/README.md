# bingd marketing screenshots

A repeatable pipeline from the real app to marketing images: real components, fictional
people, every size from one manifest. It is built to be re-run on a redesigned branch by
changing one argument.

**Nothing here publishes.** See [Publishing](#stage-4-publishing-deliberately-absent).

**Everything it produces is a layout proof, not a final store screenshot.** Store images need
captures from a real phone build; [NATIVE-CAPTURE.md](./NATIVE-CAPTURE.md) has the plan.

| Stage | Command | Reads | Writes |
|---|---|---|---|
| 1. Capture | `npm run capture -- ...` | The app at a git ref or folder | `out/raw/` |
| 2. Compose | `npm run compose` | `out/raw/` | `out/composed/` |
| 3. Export | `npm run export` | `out/composed/`, `out/raw/` | `out/export/` |
| 4. Publishing | None, on purpose | | |

Each stage runs alone. Compose and export need no server, no network and no app source, and
compose accepts raw PNGs from anywhere, which is how native captures come in.

## Setup

Node 22 and system Chrome. No browser is downloaded; set `CHROME_PATH` if Chrome is somewhere
unusual.

```
cd store-assets/screenshots
npm install --ignore-scripts
npm test
```

This folder has its own `package.json` and lockfile because the root ones feed the app's
runtime fingerprint. So does the root `.gitignore`, which is why this folder has its own. Do
not add scripts or dependencies to the root for this pipeline.

## Stage 1: capture

```
node capture/run.mjs --source <git ref or folder> --node-modules <path> [--scenes a,b] [--fresh]
```

- `--source` is any ref in this repo, or a folder holding an app checkout. For the redesign,
  pass its branch name.
- `--node-modules` is the installed dependencies of a checkout of that source. A lockfile
  mismatch prints a warning.
- `--fresh` replaces `out/raw`. Without it, a run adds to a folder of the same commit and
  refuses to mix two commits, because a frame must not combine two builds.

The first build took 39 seconds on a quiet machine and can take several minutes under load.
To iterate on scenes without rebuilding each time:

```
node capture/run.mjs --serve --source <ref> --node-modules <path> --workdir <dir>
node capture/run.mjs --attach --source <ref> --workdir <dir> --scenes feed
node capture/run.mjs --stop --source <ref> --workdir <dir>
```

`--serve` stays in the foreground, so give it its own terminal. After changing the source,
stop it and serve again: `--no-dev` can serve a stale bundle, so every build starts clean.

### What a run does

1. Exports `app src assets config app.config.ts babel.config.js tsconfig.json package.json`
   into a temp folder. It never builds in a checkout, because Expo can rewrite config files.
2. Patches the export only: web output `single`, the Android tab bar on web, and a `main`
   that sets `StyleSheet.hairlineWidth` to 1/3, since react-native-web hard-codes 1.
3. Links `node_modules` as a junction. The folder is cleared by removing the junction first,
   and that removal refuses anything that is not a link.
4. Starts Expo on port 8199 with a private TEMP, so its `--clear` cannot reach another render's
   Metro cache. `.env` holds a loopback URL and a fake key, and backend variables in the
   operator's shell are stripped.
5. Starts the mock backend in-process on 54499, loopback only.
6. Drives Chrome at 390x844, 3x, with safe areas 47 and 34, and writes one PNG per scene plus
   `capture.json`.

It stops only what it started. A port already in use is an error, never a reason to kill
something.

### What makes it deterministic

- The clock starts at a fixed instant and then runs, in the browser and the mock, so "12m ago"
  repeats and animations still finish. `Math.random` is seeded.
- Scenes wait on text that only that screen shows, not on timers. If a redesign renames
  something, the scene fails by name instead of capturing the wrong screen. `--FAILED.png` is
  saved beside the output for diagnosis.
- Before a shot, no poster may be in flight and everything in view must have loaded. A poster
  that fails to load fails the scene.
- A shot only counts once two frames in a row are identical. Posters fade in, and a fixed delay
  caught them half transparent under load. A screen that never holds still fails the scene.
- Only `127.0.0.1` and `image.tmdb.org` are reachable. Anything else is aborted and listed.
- Unknown backend calls are listed at the end and in `capture.json`. On a redesigned branch,
  **read that list**: a new call means an empty section the mock does not fill yet.

- Chrome runs with GPU raster off. With it on, identical poster bytes came out differently
  resampled from run to run.
- Posters come from the CDN once, then from `out/poster-cache/`. The CDN sometimes answers a
  whole page in JPEG instead of WebP, which changes the frame. Delete that folder to refetch. It
  holds poster artwork, so it stays gitignored like everything else under `out/`.

Repeat captures of one commit on one machine are byte-identical. That holds for the same Chrome
version and the same poster cache: `capture.json` records the version and a hash of every poster,
so a difference can be traced. Another machine or Chrome version may render differently.

### Adapting to the redesign

Expect to touch `manifest/scenes.mjs`, because scenes wait on visible copy, and
`capture/mock/backend.mjs` if backend calls changed. If the tab bar file moved, the patch warns
and the run continues. If the web output line moved, the run stops.

On Visual 2.0 (`visual2/4-profile-awards` at `87ea14c`), every patch and all 13 scenes held
unchanged, and the mock saw no unknown call. What broke was framing: the score sheet grew
taller, and a crop set as a fraction of the screen cut through its handle. So a scene can name a
`focusOn` selector, capture records where that element starts, and compose frames from it. The
sheet scenes use the shared `Sheet`'s `sheet-body` test id, which is a component hook rather than
copy. To keep the outputs of two builds apart, pass each its own folders:

```
node capture/run.mjs --source visual2/4-profile-awards --node-modules <path> --out out/visual2/raw
node compose/run.mjs --raw out/visual2/raw --out out/visual2/composed
node export/run.mjs --raw out/visual2/raw --composed out/visual2/composed --out out/visual2/export
```

## Stage 2: compose

```
node compose/run.mjs [--raw out/raw] [--frames a,b] [--canvases store-tall] [--fonts <dir>]
                     [--status-bar <px>]
```

Templates are HTML in `compose/templates.mjs`, rendered by Chrome at the canvas's exact size.
They match the live store frames: a Maroon `#773744` field, an uppercase Amber `#D4A64C`
eyebrow, a DM Serif Display headline in Parchment `#F5EBDD`, Inter below, and a device with an
optional overlapping second phone. Social canvases drop that second phone, because at phone
size it would be too small to read.

- **`portrait`**: text over a device that runs off the bottom edge.
- **`landscape`**: text left, device right.
- **`brand`**: logo and promise, no device and so no artwork.

Rules it enforces:

- **Fonts.** From the same `@expo-google-fonts` packages the app ships, or `--fonts <dir>`, such
  as the kit's `06-fonts` folder plus `Inter_700Bold.ttf`. The kit folder lacks that weight. A
  missing or failing face stops the run. Private family names mean a font installed on the host
  cannot stand in, and no stack has a fallback.
- **Amber** is 3.88:1 on Maroon, which passes only as large text. The eyebrow is bold and at
  least 18.66px at phone width, and the test enforces it. A canvas too small for that drops the
  eyebrow. The headline carries the message at 7.4:1.
- **Layout.** A frame fails if text enters the 4% margin or runs into the device or logo, and a
  test fails if a device's foot would slice through the tab bar. A frame's `focus` starts the
  screen lower for subjects that sit low, and compose clamps it so the screen fills the device.
- **Name.** `bingd` in text. `bingd.` appears only as the drawn logo on the `brand` template.
- **Copy** comes only from `manifest/copy.mjs`, where every string records its source. The test
  fails on anything not already approved.
- **Artwork** appears only inside a device, inside an app screenshot.

Add a frame in `manifest/frames.mjs`, then list it on a target in `manifest/targets.mjs`.

## Stage 3: export

```
node export/run.mjs [--targets a,b] [--frames c,d] [--partial] [--status-bar <px>]
```

`manifest/targets.mjs` is the one list of outputs. Each file is read back and refused if its
size, format or colour space is wrong or it has an alpha channel. Both stores reject alpha, but
only after an upload.

| Target | Size | Format | Note |
|---|---|---|---|
| `app-store-dynamic-island-large` | 1320x2868 | PNG | |
| `app-store-dynamic-island-medium` | 1206x2622 | PNG | Apple's stated required size |
| `app-store-face-id-large` | 1284x2778 | PNG | Required only without the large size above |
| `google-play-phone` | 1080x1920 | PNG | Composed at 9:16, because the limit is 2:1 |
| `google-play-feature-graphic` | 1024x500 | PNG | Brand only, no artwork |
| `website` | 640x1285 | WebP q80 | Bare screen, no frame, to match `web/src/shot-*.webp` |
| `social-portrait` | 1080x1350 | PNG | |
| `social-square` | 1080x1080 | PNG | |
| `social-link` | 1200x630 | PNG | |

Sizes were read from Apple's and Google's documentation on 2026-11-02; the sources are noted in
`manifest/targets.mjs`. Apple's requirements changed recently, so check them again before a
release. `supportsTablet` is false, so no iPad sizes apply.

`website` images are candidates, not replacements. Copying one into `web/src/` changes the
production site, so that stays a founder decision and a separate pull request.

## Stage 4: publishing, deliberately absent

There is no upload, no store API, no CDN push and no step that touches a site, a database, EAS
or an account. `npm test` fails if a script or dependency is added here. Publishing stays a
human act, taken after the checks below.

## Limits

- **Store images from this pipeline are layout proofs.** Chrome renders are fine for the website
  and social, but the final store images need native raw captures. See
  [NATIVE-CAPTURE.md](./NATIVE-CAPTURE.md), which also specifies the demo account.
- **Poster licensing is unresolved.** Output is gitignored for that reason. Never commit raw or
  exported images, and never attach them to a public pull request or issue.
- **Fictional demo data only.** No real member, no cast or crew names. Film and TV titles and
  TMDB image paths are the only real-world facts in the fixtures.
- **`maestro/` flows are unverified.** Maestro is not installed where they were written.

## Before anything leaves this folder

- [ ] Open every image you intend to use. Automated checks do not judge a picture.
- [ ] Posters pass a 4+ rating (Apple 2.3.8), and poster licensing is decided.
- [ ] Store images came from native raw captures.
- [ ] Copy is still true of the build going out.
