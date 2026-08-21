# UI pass — handoff

Read this instead of re-exploring the repo. Full rationale, screen by screen, is in
`ui-pass-plan.md`; this file is the short version for picking up device-review fixes.

## State

- Branch `ui/visual-pass`. `main` is untouched. Nothing has been pushed.
- Latest: the TV-metadata and award-drilldown micro-pass of 2026-08-18 — Jest, the
  database suite, lint and typecheck all clean, and `expo export --platform android`
  succeeds. Counts are in the last section of this file.
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
- **Superseded on 2026-08-18 by the final tuning pass.** *Remove ranking* was the other
  row and no longer exists; the sheet has two rows. Debt item 18 — that unranking left
  the old activity saying "ranked" — is closed by removal rather than by a fix, because
  the state it created is one the product does not want. `rank_unrank` itself is
  untouched and `rank_rebucket` still calls it.

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

---

## Founder smoke checklist — 2026-08-18, final product-tuning pass

**Client and config only. No migration, no adapter change, nothing deployed, nothing
pushed.** No native module changed either, so a JS reload is enough — no new development
build is needed for any of this.

Verified before stopping: `tsc` clean, `eslint` clean, Jest green, and
`expo export --platform android` succeeds. The database and Deno suites were not affected
and were not re-run for this pass; `npm run test:db` was last green at `cafd144` and no
SQL changed since.

### Awards — the numbers are long-term now

The first set was walkable in an evening. These are set so Bronze is already earned,
Silver reads as an enthusiast, and Gold is rare and possibly multi-year. **They are not
tuned to the seeded account** — expect to lose most of the badges you had.

| track | bronze | silver | gold |
|---|---|---|---|
| Movie Muncher | 50 | 200 | 1,000 |
| Season Snacker | 15 | 60 | 250 |
| Invite Instigator | 3 | 15 | 50 |
| Queue Dragon | 25 | 100 | 300 |
| Rating Rascal | 100 | 500 | 2,000 |
| Comment Gremlin | 20 | 100 | 500 |
| Hype Courier | 25 | 100 | 500 |
| Scream Snack · LOL Mode · Softie Hours · Space Brain · Boom Club | 25 | 100 | 300 |
| Toon Bloom | 20 | 75 | 250 |
| Truth Worm | 15 | 50 | 150 |
| Passport Mode | 15 | 75 | 250 |
| Time Hopper | 25 | 100 | 300 |
| Genre Gremlin | 14 | 16 | 17 |
| Two-Screen Life | 30 | 100 | 300 |
| Heart Magnet | 50 | 250 | 1,000 |
| Mutual Mania | 5 | 25 | 100 |

Every one of them is written out in `awards.test.ts` as well as in `tracks.ts`, so a
number cannot move without somebody moving it in two places on purpose.

**Genre Gremlin was rebalanced on 2026-08-20, and its whole ladder moved.** It was
8 / 14 / 16, then briefly 12 / 14 / 16, and is now **14 / 16 / 17**. The founder's Preview
verdict was that the ladder was too easy *and too compressed* rather than that one number
was wrong, and the measurement agreed: 12 / 14 / 16 cost a median of 15 / 27 / 62 logged
titles, against 250–300 for every other Gold in the set.

The evidence is reproducible — `node scripts/awards/genre-ladder-report.mjs` reads the
seeded catalogue and simulates acquisition, and its own suite holds it honest. Two earlier
statements on this page were wrong and are corrected here: the rarity figures quoted
(*"Documentary two titles, Animation eight, Western fourteen"*) were counts among the 382
**movies**, not the whole loggable catalogue. Over all **1,814 loggable rows** — of which
1,551 carry a canonical genre at all — they are **6, 10 and 23**.

**Gold is 17 of 18 and deliberately not 18.** Seventeen lets a reader miss any one genre;
eighteen names the rarest row in the catalogue and demands it. The last genre costs a
median of 126 further titles against 45 for the seventeenth, so 18 would turn breadth into
a scavenger hunt. Nothing about the Awards UI changed — same rows, same dots, same art.

**Two-Screen Life is capped contribution, not the weaker side.** Each side counts up to
half the threshold and the two are added: Bronze is fifteen films and fifteen seasons, and
fifteen films with seven seasons reads `22 / 30`. A hundred films and no television reads
`15 / 30` and stays there, which is the point of the award. The old `min(movies, seasons)`
needed a sentence explaining itself; this one says `Next: Watch 15 movies and 15 TV
seasons`.

### Awards — Invite Instigator counts people now

**This is the one thing on the sheet that will read as broken and is not.** It counts
people who joined Bingd on your invitation and used it — `invite_attributions` where
`activated_at` is set — instead of the number of times you asked for your link.

Nothing writes that column yet: there is no link resolver, `app/i/[token].tsx` is a
placeholder, and no migration inserts an attribution. So the row sits at `0 / 3` for
everybody, including you, and it should.

It is deliberately **not** shown as "could not load this one". The read succeeds and the
answer is genuinely none; claiming a failure that did not happen would be its own lie. The
full dependency is written up in `docs/product/growth-instrumentation.md` §1 — five named
pieces, all Beta Hardening — and when they land this award starts counting with no client
change.

### Awards — order, copy and the drill-down

- **Three rows are pinned to the top and never move**, whether earned or not: Movie
  Muncher, Season Snacker, Invite Instigator. They are what Bingd is for. Log a thousand
  films and they are still first; log nothing and they are still first.
- After them: everything earned, then everything locked, and inside each of those a fixed
  grouping — activity, then genres, then exploration. **The list should not rearrange
  itself as you use the app.** It moves once per tier, when something is earned. If you
  see rows swapping places for no reason, that is a bug.
- **The summary line at the top is gone.** The sheet opens with `Bingd Awards` and then
  rows.
- **No row has an explanatory paragraph.** Check Queue Dragon, Invite Instigator and
  Two-Screen Life especially — all three used to have one.
- At the top tier a row reads `Gold earned` over `Watched 1,000 movies`, not one long line.
- **Tap a row whose number is made of titles** — Movie Muncher, Season Snacker, any genre,
  Passport Mode, Time Hopper, Two-Screen Life. It opens a Goals-style sheet listing the
  exact titles that counted, poster and year, each leading to its page. Seasons should read
  `The Last of Us, S1`.
- **Rows that are not made of titles should not be tappable at all**: Invite Instigator,
  Heart Magnet, Mutual Mania, Hype Courier, Rating Rascal, Comment Gremlin, Queue Dragon,
  Genre Gremlin. Nothing new was built to make them tappable, deliberately — a contributor
  list for reactions or follows is a social analytics feature and this pass is not that.

### Profile

- `[avatar]` then name and `@handle` beside it. **The bio is now a full-width block below
  that header**, not a third line squeezed into the name column. Try it with a two-line bio.
- On somebody else's profile, Taste Match is **under the avatar** as `84%` over `Match`.
  Where there is not enough overlap it is **absent** rather than showing a sentence — that
  is a deliberate change and the one thing this pass removed rather than moved.
- Order down the page: identity, bio, stats, **Share Profile / Bingd Awards**, Goals, Top
  ranked. The buttons moved below the stat row.
- Unchanged: gear left of bell, bell where it always is, Share outlined, Awards filled
  Maroon.

### Collection — the Unranked tab is per category

The founder's device bug: Movies showed an Unranked tab because an unranked *TV season*
existed, and tapping it gave an empty list.

- Leave one film unranked. **Movies** should show Unranked; **TV seasons** should not.
- Leave one season unranked. The reverse.
- Stand on Unranked and switch category to a side with none: you should land on **Watched**,
  and switching back should leave you on Watched rather than quietly returning you to a tab
  you were moved off.
- Both sides unranked: switching keeps you on Unranked, because the tab did not disappear.

### Title page

- **Tap Ranked. Two rows now: change your rating, remove from collection.** *Remove
  ranking* is gone. If a title is in your collection Bingd expects it to have a position;
  the escape hatch for an accidental log is removal, which still names everything it takes.
  `rank_unrank` is untouched internally and `rank_rebucket` still uses it.
- **Scores is one row of two columns**: Following on the left, Bingd on the right, circle
  above the label. Same thresholds as before — Following lights on one rating from somebody
  you follow, Bingd waits for ten — same grey circle, same `Not enough ratings`, still no
  countdown. On a narrow device or with type size turned up it falls back to the two
  stacked rows rather than cramming.
- Your own score is still only in the hero.

### Hero — inspected, unchanged

Asked again and answered with arithmetic rather than by eye. `contentPosition="top center"`
is what the Image carries and expo-image does apply it.

For a real backdrop **the vertical half does nothing**: a 16:9 image in the 1.62 frame is
scaled by height and cropped on the *sides*, so top, centre and bottom render identically.
The "cropped cutoff" impression is the ~10% horizontal loss `HERO_RATIO` already documents,
and no alignment value returns it — `left: '50%'` is already the middle.

For the blurred poster fallback the vertical anchor **is** load-bearing, and top is the
right choice there. So no supported one-line change is an improvement and the hero was left
alone. Both cases are now pinned by tests in `TitleHero.test.tsx`.

### Known, unchanged, and worth knowing

- **Seasons carrying no genres and no original language was fixed on 2026-08-18** by the
  micro-pass below. `tmdb_upsert_seasons` still writes neither column — that has not
  changed and needs no migration — but a season now inherits both from its series at read
  time, so the genre tracks, Passport Mode and Genre Gremlin all count television.
- The seeded catalogue is 382 movies and 1,432 seasons, so several top tiers are beyond
  what exists today. That is intended — the catalogue grows through the TMDB adapter — but
  it is why nobody will be walking Movie Muncher Gold on the alpha.
- The ten emoji badge families are still emoji. Nothing about that changed.

---

## Founder smoke checklist — 2026-08-18, TV metadata and award drilldowns

**Client and read-composition only. No migration, no RPC change, nothing deployed,
nothing pushed.** No native module changed, so a JS reload is enough.

Verified: `tsc` clean, `eslint` clean (one pre-existing `no-console` warning in
`src/features/auth/methods.ts`), Jest green, the database suite green, and
`expo export --platform android` succeeds. Counts are at the end of this section.

### A season is part of its show now

**The defect, which was three defects.** A season row carries no `genres` and no
`original_language` — TMDB publishes both on the series and `tmdb_upsert_seasons` writes
neither — so `The Last of Us, S1` described nothing. That showed up as: genre awards
television could never contribute to, a Collection genre filter that emptied the TV tab,
and a For You wall whose TV anchors vanished the moment a genre was picked.

**One resolver, applied at every read: `src/lib/media-metadata.ts`.** A season inherits
its series' genres and language when it has none of its own; a movie and a series use
their own; own-first, so an anthology season with real metadata still wins. Nothing is
copied onto any row and no migration was needed — the parent embed these queries were
already fetching for the show's *name* now carries two more columns.

What to check on the device:

- Open a season's page. **Genre pills** should be the show's, and Details should now name
  a **Language**. Both were blank on every season before.
- The hero's rank line can now read `#3 in Drama` for a season.
- **Collection → TV seasons → Filters.** The Genre and Language lists should be populated
  rather than empty, and choosing one should keep your seasons rather than emptying the
  tab. The Anime facet can match a TV title for the first time.
- **For You → TV shows → set a genre.** The wall should still be anchored — long-press a
  tile and the "because you loved" anchors should be shows from inside the filter. Before,
  filtering TV left it with no anchors at all and a popularity-only slate.
- **Sent to you** with a genre filter on: a recommended *season* should survive it. That
  path reads an RPC that returns the season's own metadata, so it resolves the parent with
  one small supplementary read rather than a widened RPC.
- **Awards.** Seasons now count toward Scream Snack, LOL Mode, Softie Hours, Space Brain,
  Boom Club, Toon Bloom, Truth Worm, Passport Mode and Genre Gremlin. A show with three
  seasons counts as three titles and one genre — the season is the counted unit and the
  series is never counted at all.
- **A season whose show has no metadata either stays unknown.** Nothing guesses from a
  title, and no client-side provider call was added to fill a field.

### Awards: the tier name is the title

- A creative track is now **headed by the tier it has reached**. Genre Gremlin becomes
  **Dabbler**, then **Mixer**, then **Chaos Collector**. There is no separate
  `Dabbler earned` line any more; the row is two lines at every stage.
- **The next tier's name is never shown early.** A locked Genre Gremlin says "Genre
  Gremlin" and `Next: Watch 8 different genres`. Seeing "Dabbler" before you have earned
  it would spend the reward in advance — if you can find one, that is a bug.
- **Movie Muncher, Season Snacker and Invite Instigator keep their family names** at every
  tier. A row headed "Silver" says nothing about what was done. The art and the dots carry
  the metal.

### Awards: three tier dots

Under each badge, overlapping its lower edge: `○○○`, then `●○○`, `●●○`, `●●●`.

- **Each dot keeps its own metal.** At silver the first dot stays bronze; at gold all three
  are individually coloured. If they all turn gold, that is a regression.
- They should read as a progression, not as carousel pagination, and the row must not get
  any taller — the strip is positioned inside the badge's own box.
- Locked treatment on the badge itself is unchanged, deliberately.

### Awards: every row opens

**All twenty rows are tappable now**, not the twelve title-based ones. The principle is
the founder's: if Bingd shows you `10 / 14`, you are entitled to see what the ten are.

| award | what the sheet shows |
|---|---|
| Movie Muncher | the films, with the watch date where there is one |
| Season Snacker | the seasons, named `The Last of Us, S1` |
| Invite Instigator | people who joined and used it — **empty until the referral wiring lands** |
| Queue Dragon | the watchlist you are holding now |
| Rating Rascal | every ranked title with the score you gave it |
| Comment Gremlin | your comments and public notes, by title and type — **never the text** |
| Hype Courier | what you sent and who to |
| the seven genres | the exact films **and seasons** that qualify |
| Passport Mode | the titles, with the language named ("Japanese", not "ja") |
| Time Hopper | the pre-2000 titles |
| Genre Gremlin | one row per **genre**, with how many titles carry it |
| Two-Screen Life | a Movies section and a TV Seasons section, each with its own cap |
| Heart Magnet | what was reacted to and how many — never who reacted |
| Mutual Mania | the people who follow you back |

- **The number on the row and the total of the sheet are the same call.** There is no
  second query anywhere in this feature; a test asserts the identity for all twenty tracks
  at every tier boundary. If a sheet ever disagrees with the badge above it, that is a
  serious bug and worth reporting immediately.
- Tapping a title opens it; tapping a person opens their profile.
- A row whose number could not be read is the one row that does not open — there is
  nothing behind a dash.

### Privacy, and the one compromise

Nothing here asks for more than the count already counted: the drill-downs render the rows
the metric measured, under the same policies.

- **An account you may not see** — blocked, suspended, deleted — comes back from the embed
  as nothing. It still *counts*, because the follow is still a follow, and it renders as
  **"Someone on Bingd" / "This account is not available to you"** with no handle and no
  route. That is the compromise: a row exists, and it discloses nothing.
- **Heart Magnet never lists reactors.** It is content-centric on purpose — "The Wolf of
  Wall Street, 18 reactions" — and no new reactor sheet was built.
- **Comment Gremlin never reprints what you wrote.** A note's body belongs where its
  spoiler masking lives.
- **Invite Instigator** is unchanged in meaning: activated attributed signups, still zero
  for everybody, still documented in `docs/product/growth-instrumentation.md` §1.

### Counts

1,020 Jest across 63 suites, 686 database, lint and typecheck clean, Android export green.
