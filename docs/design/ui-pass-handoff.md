# UI pass — handoff

Read this instead of re-exploring the repo. Full rationale, screen by screen, is in
`ui-pass-plan.md`; this file is the short version for picking up device-review fixes.

## State

- Branch `ui/visual-pass`. `main` is untouched. Nothing has been pushed.
- Latest: `cafd144` — 911 Jest, 681 database, deno 17, lint and typecheck clean, and
  `expo export --platform android` succeeds.
- The pass this document was written for changed no schema. **Two later passes did**, and
  both are deployed to bingd-nonprod only: `20260817001300` (friend recommendations) and
  `20260818000100` (removal takes its activity, and the Bingd threshold at ten). Bingd
  Awards, added 2026-08-18, needed no backend change at all.
- Ranking semantics untouched throughout.

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

## Founder smoke checklist — device pass, 2026-08-18

Client and existing-query changes only. No migration, no adapter change, nothing
deployed. `rank_unrank` and `unlog` were already granted; this is the first client code
that calls them.

**Title page**

- Open a film with a backdrop. The artwork should read as a backdrop rather than as a
  detail of one — it is zoomed about 10% now, down from 27%. The fade and the poster
  overlap should look unchanged.
- Open a season. Heading should read the show on one line, then `Season 1, 2023`. No em
  dash anywhere on the page.
- On an unranked title: a grey circle sits where the score will go, and the **Rank**
  button is right-aligned in the same spot the **Ranked** chip appears after scoring.
  Score something and check the button does not jump.
- Action row: **Watchlist** and **Recommend** only. Both should fit on the narrowest
  device you have. Tap Recommend and confirm **Share off Bingd** is the last row of the
  sheet and still opens the native share.
- A series page: Watchlist only, no Recommend. A season page: both.

**Scores**

- Three rows: **Your score**, **Following**, **Bingd**. Grey circle wherever there is no
  number.
- Below the Bingd threshold it should read `Not enough ratings yet` and never count down.
- Following should light up on a single rating from somebody you follow. If you follow
  nobody, the row should be absent rather than empty.

**Unranking and removal**

- Tap **Ranked**. Three rows: change the rating, remove the ranking, remove from
  collection.
- **Remove ranking** should take the position away and leave the title in Watched with a
  dashed badge. Check Collection and the profile counts.
- **Remove from collection** asks first, names what goes, and afterwards the title is out
  of Watched and out of Ranked.
- **Known gap, on purpose.** The past *activity* survives. `unlog` deletes the
  `user_media` row and nothing deletes `feed_events`, so "Sai ranked Inception" stays in
  the feed and on your profile after the title has left your collection. Closing that
  needs a server change — either `unlog` deleting the events for that (user, title) or a
  cascade — which is a migration, and this pass did not touch any. Flag it if it bothers
  you and it becomes its own small piece of work.

**For You**

- Movies / TV shows at the top, one filter row, then straight into the wall. No "For
  you", no "Based on your taste", no "Inspired by".
- **Sent to you** is the first chip. Turning it on switches to the receipt list; the
  unopened count sits on the chip.
- Set a genre on Movies, switch to TV shows, switch back. The filter should still be on.
- With a filter on, long-press a tile: the anchors named in the explain panel should now
  all be titles from *inside* the filtered subset. That is the fix.
- Tap a received recommendation. The title page should carry a rounded
  `Recommended by X · 2d ago` callout over the hero. Reach the same title from search and
  the callout should be absent.

**Profile**

- Photo left, name/handle/bio left-aligned beside it.
- **Share Profile** is the button. Gear to the left of the bell; the bell stays where it
  is on every other tab.
- Counts row and Top Ranked unchanged.

**Edit Profile**

- Tap the Bio field. It should scroll clear of the keyboard rather than sitting behind
  it. Same for Handle. Save should work on the first tap while the keyboard is up.

**Feed**

- The action row under a row is react, comment, watchlist, recommend, timestamp. Check it
  fits without the timestamp being pushed off.
- Reacting to somebody else's activity should still land in their inbox; reacting to your
  own should still be silent.

---

## Founder smoke checklist — 2026-08-18, second pass

One migration deployed (`20260818000100`, bingd-nonprod only). Awards are client-only.
Build note: **no native module changed**, so a JS reload is enough — no new development
build is needed for any of this.

### Remove from collection

- Rank something, react to it from a second account if you have one, then open the title,
  tap **Ranked** → **Remove from collection**.
- The alert now names the reactions and comments as well as your rating, date and note.
  Read it: that sentence is the only warning anybody gets, and the cascade reaches other
  people's writing.
- After confirming: the title is out of Watched and out of Ranked, **and the activity is
  gone from the Feed and from your profile**. That was the known gap on the last
  checklist and it is closed.
- It should **not** reappear on your Watchlist. Removal is not a decision to watch it
  again.
- **Known and deliberate:** *Remove ranking* is the other row and behaves differently. It
  takes the position away, leaves the title in Watched, and **leaves the old activity
  saying "ranked"**. That is debt item 18 and a product decision, not an oversight —
  `rank_rebucket` calls the same function, so closing it there would delete reactions
  every time somebody moved a title between bands.

### Title scores

- The hero has **Your score**, the rank line under it, and **Ranked** / **Rank** opposite
  the poster.
- The Scores section below has exactly two rows: **Following** and **Bingd**. Your own
  number should appear **once** on the page. It was on it twice.
- Both rows are always present. Empty is a grey circle and the words `Not enough ratings`,
  and nothing anywhere counts down.
- Following lights up on a single rating from somebody you follow. Bingd now waits for
  **ten**, up from three, so expect more titles to sit on the empty state than before.

### Season naming

- Feed, Collection, Search, Sent to you, notifications and the Recommend sheet should all
  read `The Last of Us, S1 (2023)`.
- No em dash anywhere, and no spelled-out "Season 1" in a compact row.
- A season's own page keeps the hierarchy: the show on one line, `Season 1, 2023` under
  it.
- The one to look at hardest is **Sent to you**, whose read does not carry the season
  number and recovers it by parsing `Season N` from the title. If a season there reads
  `Show, Season 3 (2021)` rather than `Show, S3 (2021)`, that is the fallback firing and
  worth reporting.

### Awards sheet

- Profile: **Share Profile** (outlined) beside **Bingd Awards** (filled Maroon).
- Tapping opens a sheet that should feel like the Goals list: heading, one line, then
  rows.
- Twenty rows, always all twenty. Earned first, then locked closest-to-unlock first.
- The summary at the top reads `6 awards earned`; on a brand new account it says nothing
  of the sort and invites instead.
- **Ten tracks show an emoji rather than a drawing.** That is expected — see the
  placeholder list below.

### Locked, bronze, silver, gold

Movie Muncher is the easiest one to walk, because a film is quick to log.

| what you should see | when |
|---|---|
| grey badge on a flat ring, `Next: Watch 10 movies`, `7 / 10` | under ten films |
| full-colour bronze bucket, `Bronze earned`, `Next: Watch 50 movies`, `27 / 50` | at ten |
| the bucket with the ticket, `Silver earned`, `Next: Watch 150 movies` | at fifty |
| the gold crowned bucket, `Gold earned: Watched 150 movies`, and a bare `164` | at 150 |

- Only ever **one** badge per row. Three tiers side by side would be a scoreboard of what
  you have not done.
- Locked is the same artwork faded on a flat ring, not a separate grey asset. If it reads
  as *loading* rather than *locked*, say so — that is the judgement call most worth a
  second opinion.
- Two rows carry a caveat line, deliberately: Queue Dragon says it counts the watchlist
  you are holding now, and Invite Instigator says Bingd cannot see whether a link was
  opened.
- Turn airplane mode on and reopen the sheet: a row whose number could not be read says
  **Could not load this one** with a dash, and sinks to the bottom. It must never show a
  zero for a number nobody measured.

### Badge placeholders — the ten tracks with no artwork

Space Brain, Boom Club, Toon Bloom, Truth Worm, Passport Mode, Time Hopper, Genre Gremlin,
Two-Screen Life, Heart Magnet, Mutual Mania. All thirty of their tiers are emoji. The
sheet drew the first ten families and stopped. Each is one line in
`src/features/awards/badges.ts` away from being finished, and
`scripts/awards/build-badges.mjs` re-cuts everything from a replacement sheet.

The thirty that **are** drawn: Movie Muncher, Season Snacker, Invite Instigator, Queue
Dragon, Rating Rascal, Comment Gremlin, Hype Courier, Scream Snack, LOL Mode, Softie
Hours — three tiers each.
