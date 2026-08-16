# UI pass — handoff

Read this instead of re-exploring the repo. Full rationale, screen by screen, is in
`ui-pass-plan.md`; this file is the short version for picking up device-review fixes.

## State

- Branch `ui/visual-pass`, commit `87528f5`. `main` is at `ec3d205`, untouched.
- Lint, typecheck, 133 unit tests, 223 database tests all pass on that commit.
- No schema, RPC or migration changes. No TMDB work. Ranking semantics untouched.

## The constraint that shaped everything

The alpha catalogue is Wikidata-seeded and has no posters, backdrops, synopses or
credits (`change-log-v0.6.md` 7.14). Hierarchy comes from type, density and structure,
never from artwork. Components read the artwork fields and upgrade silently if a
provider ever fills them, but nothing renders a visible placeholder and no section is
mocked — sections without data are omitted.

Do not add fake metadata to make a screen look fuller. That is the whole point of the pass.

## Running it

The device has a `development` build. Live reload, no rebuild needed for JS changes:

```powershell
$env:APP_VARIANT="development"; npx expo start --dev-client
```

Rebuild only after changing native config (`app.config.ts`, plugins, native deps).

### When the app will not start after a JS-only reload

Symptom, in this order: `Cannot find native module 'Expo…'`, then an Expo Router failure reading
`ErrorBoundary` of `undefined` through `useScreens.js`. They are **one** defect. A module that
throws while being imported makes expo-router's `loadRoute()` return `undefined`, and
`fromImport(value, undefined)` destructures `ErrorBoundary` off it. The router error is the
shadow; the missing module is the cause. Do not chase the second one.

The cause is always the same: JavaScript that calls a native module the installed binary does not
contain. `runtimeVersion: { policy: 'fingerprint' }` prevents this over OTA — an older build is
simply not offered the update — but nothing prevents it when Metro serves a dev client directly.

Ask the build which native modules it is missing, rather than guessing from the module name:

```powershell
npx eas build:list --platform android --limit 1 --json --non-interactive   # get the build id
npx eas fingerprint:compare --build-id <id>
```

It prints the differing native dependencies by name. If the list is non-empty, the fix is a new
development build and nothing else:

```powershell
npx eas build --profile development --platform android
```

The profile sets `APP_VARIANT` itself, so it does not need to be exported first.

**Do not work around a missing native module by deferring its import.** Moving a `require` inside a
function turns a startup crash into a crash on first use, which is harder to diagnose and hides a
binary that is genuinely out of date. Lazy-loading is a route-isolation decision, not a remedy for
a stale build.

The failure of 2026-08-15 was this exactly: `37500af` added `expo-image-picker` and
`expo-image-manipulator` (plus their transitive `expo-image-loader`), the installed build was from
`dda2d8f`, and the throw surfaced on the Settings route through `AvatarPicker`.

## Conventions that will fail CI if broken

- No colour literals in `src/**` or `app/**`; a custom ESLint rule bans them. Use
  `src/ui/tokens/`.
- Spacing, radius, type, elevation and poster sizes all come from tokens, not numbers.
- Row metadata formats through `TitleMetadata` only. It owns the show-the-year-once
  rule, so do not rebuild metadata strings inline.
- `Screen` owns safe-area insets. Pass `includeBottomInset` rather than padding again.
- User-facing copy says Watched, not Logged. Logged survives only in internal names.

## Verify with

```powershell
npm run lint; npm run typecheck; npm test; npm run test:db
```

## What device review has not yet confirmed

- The brand lockup. `BrandMark` renders `assets/brand/bingd-icon.svg` through
  `expo-image`. Twelve of the fourteen supplied `Brand SVGs/` files cannot render
  natively at all — they set the wordmark as a `<text>` element with a remote Google
  Fonts `@import` and carry no path data. `Wordmark` therefore draws "bingd." as text
  in bundled DM Serif Display. Fix the geometry, never reintroduce those SVGs.
- Ranked-list density and the comparison screen.
- Tab bar icons, now from `@expo/vector-icons`.
- Whether screens read as cleanly sparse or simply empty after the placeholder
  modules were removed.

## Recently fixed — do not regress

Watchlist was a dead button; Rank pushed to an empty search screen; Share called
`expo-sharing` with an https URL, which throws silently. Cold start fell through to
`+not-found` because `(tabs)` is a group and matches no path, so `app/index.tsx`
redirects `/` to `/feed`. Comparison cards used two fixed 180pt posters, which
overflow a 375pt screen.
