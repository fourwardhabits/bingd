# UI pass plan — Collection, Search, Title, Ranking, Feed, Profile

Phase 1 output. This is the implementation contract for Phase 2. It supersedes nothing in
`design-system.md` or the PRD; where this document and a documented product rule disagree,
the product rule wins and the conflict is called out inline.

Audit inputs: every route in `app/`, every component in `src/ui/components`, the token files,
`src/features/{auth,collection,ranking,search}`, all 24 migrations, the seed pipeline, the
Beli / Apple TV / Letterboxd reference sheets, and the supplied brand SVGs.

---

## 0. What the audit actually found

Five findings reframe the work. Everything below follows from them.

**The catalog has no artwork, on purpose, and that is the central design constraint.** The 2,010-row
alpha catalog is seeded from Wikidata (`20260814001131_seed_catalogue.sql`: 382 films, 196 series,
1432 seasons). `poster_path`, `backdrop_path`, `overview` and `popularity` are null in every row,
and `media_cache` — where director and cast belong — has zero rows. `genres` is populated,
`runtime_minutes` and `release_date` largely are, and the season tree is complete.

This is a recorded decision, not a gap to close in this pass. `change-log-v0.6.md` §7.14:

> The catalogue is deliberately thin: no posters, because a poster is not a free work and Wikidata
> has none to give — **which means the client has to look right without artwork, better learned now
> than after screens assume it.**

So the brief's "image-forward" is implemented as *artwork-led when artwork exists, and excellent
without it*. Absence of artwork is the default state this pass must design for, not an edge case,
which makes the artwork-absent poster treatment the app's primary visual texture — see §2. Every
component takes artwork and upgrades silently when the provider adapter eventually fills the
columns; nothing waits on it, nothing fakes it, and no fixture metadata reaches production.

**The logo was never wired to the supplied SVGs.** `BrandMark.tsx` builds the film-strip mark
out of four `View`s with borders, and the wordmark is `<Text>bingd</Text>` — missing the period
that is part of the mark. Separately, 12 of the 14 supplied SVGs are unrenderable in an app:
they contain `<text>` plus `@import url('https://fonts.googleapis.com/…DM+Serif+Display')`
and zero `<path>` elements. Neither `SDWebImageSVGCoder` (iOS) nor `androidsvg` (Android)
fetches a remote webfont, so those files render as blank or as a fallback face. Only
`gemini-svg icon.svg` and `gemini-svg (1) icon.svg` are pure geometry and safe to ship.

**There are no tab bar icons.** `(tabs)/_layout.tsx` sets tints, background and label style and
never sets `tabBarIcon`. `@expo/vector-icons` is not installed. `expo-symbols` is installed but
is iOS-only and cannot be the answer.

**Almost nothing navigates.** There is no `<Link>` or `href` anywhere in the repo. `router.push`
appears seven times, all auth or tab redirects. `/title/[id]` exists, is reachable only by deep
link, and no row in Collection, Feed or Profile is tappable.

**No schema migration is needed.** `media_items` and `media_cache` are world-readable
(`create policy … for select using (true)`, `20260813000400_media.sql:91-92`), and
`feed_events` already allows your own plus followed users' activity
(`using (can_view_profile(auth.uid(), actor_id))`, `20260813000600_feed.sql:63`). Every data
requirement below is reachable with client selects against fields that already exist. **There is no
backend work in this pass** — no migration, no RPC change, no adapter, no enrichment. Where a field
exists and is not wired through, wire it through; that is the whole of the data work.

---

## 1. Brand assets

Originals in `Brand SVGs/` are never edited. Derived production assets go in `assets/brand/`.

### Icon

`assets/brand/bingd-icon.svg` — geometry copied verbatim from `Brand SVGs/gemini-svg icon.svg`
(viewBox `0 0 200 120`, maroon `#773744` strokes at width 8, amber `#D4A64C` 40×40 fill at the
intersection). No `<style>`, no `<text>`, no `@import`. Rendered with `expo-image`, whose SVG
coders are already compiled into the existing dev client — no rebuild.

Do not apply `tintColor`: the mark is two-colour and a tint flattens the amber square.

### Wordmark

The supplied wordmark is DM Serif Display at `fill: #773744`, string `bingd.` — and
`DMSerifDisplay_400Regular` is already bundled and loaded in `app/_layout.tsx`. Reproduce it as
text rather than as an asset. This is the explicitly permitted route, and it is the better one:
it scales with Dynamic Type, is selectable by screen readers, and cannot regress to a fallback
face. The one fix it needs is the missing period.

### Lockup

Ratio taken from `Brand SVGs/gemini-svg (8).svg`: icon spans x 20–180 of a 550 viewBox, wordmark
starts at x 210, both centred on y 60. So the gap between icon and wordmark is ~19% of icon
width, and the wordmark's optical centre aligns with the icon's.

Components: `BrandMark` (icon only), `Wordmark` (text only), `BrandLockup` (both). Sizes
`sm | md | lg`.

**Where branding appears** — and nowhere else:

| Surface | Treatment |
|---|---|
| The five top-level tabs | `BrandLockup` size `sm` in a 44pt header, no subtitle |
| Sign-in | `BrandLockup` size `lg` |
| Empty states | nothing (remove the `BrandMark` from `EmptyState`) |
| Detail screens, modals, settings | nothing — native header with back and title |

`AppHeader`'s current `subtitle` prop is deleted. "Collection" under a bingd wordmark, above a
tab bar whose Collection tab is already selected, is the same word three times.

---

## 2. Design system

### Tokens to add — `src/ui/tokens/layout.ts`

```
aspect        = { poster: 2/3, backdrop: 16/9 }
avatar        = { xs: 24, sm: 32, md: 44, lg: 72 }
icon          = { sm: 20, md: 24, lg: 28 }
control       = { searchFieldHeight: 40, chipHeight: 32, headerHeight: 44 }
row           = { dense: 56, media: 76, ordinalColumn: 28 }
```

`searchFieldHeight: 40` is deliberately below `minTapTarget`. A 40pt search field matching the
platform is correct — iOS's own is 36pt — and the 44pt floor is preserved by the 48pt row that
contains it. `minTapTarget` still governs every independent control.

### Tokens to add — `src/ui/tokens/typography.ts`

One token: `ordinal` — `Inter_600SemiBold`, 15/20, `fontVariant: ['tabular-nums']`. Ranked rows
must not jog horizontally between `#9` and `#10`.

Nothing else is added, and no existing token changes. The type scale is not the problem; its
*application* is. The rules for this pass:

- `display` and `reveal`: the ranking reveal and share cards only. Not screen headings.
- `title1` (28pt serif): one per screen at most, and only on Title Detail and sign-in.
- `title2` (22pt serif): the Collection medium selector, title names, profile display name.
- Section headers stay `caption` uppercase. They are already restrained — do not enlarge them.
- Everything navigational, metadata, or control-shaped is Inter.

### Poster and Backdrop

`Poster` gains a responsive mode: today it only takes fixed tokens (`xs`…`xl`), which is the
direct cause of the ranking comparison bug in §6. Add `width?: number | 'fill'`; when set, the
poster sizes itself with `aspectRatio: 2/3` instead of the fixed pair. Fixed tokens stay for
lists. `MissingArtwork` stays as a designed state but drops to `title2`/`headline` — the current
`title1` initials shout on a 40pt thumbnail.

New `Backdrop`: 16:9 `expo-image`, optional parchment scrim for text overlay, same hairline
discipline as `Poster`. Built now, exercised by fixtures, and rendered in the app only where
`backdrop_path` is non-null — which today is nowhere.

### The artwork-absent poster — the most consequential decision in this pass

Because no row has a poster, `MissingArtwork` is not a rare fallback: it is what every list, card
and hero in the app is made of. The current treatment — `title1` serif initials centred on
`surface.sunken` — is precisely what makes the app read as "large boxes on a beige background",
because at every size it is a grey rectangle with letters in it.

Redesign it as a deliberate object rather than a hole where artwork should be, using the brand's own
geometry: the film frame from the icon. A sprocket rail of three or four small marks down one edge in
Ink at ~10%, the title's initials in DM Serif Display at `text.tertiary`, on `surface.sunken`, inside
the existing hairline and radius. At `xs` drop the rail and keep initials alone — a 40pt thumbnail
has no room for detail.

This is brand-derived structure, not decoration, and it is the one place in this pass where adding
visual interest is warranted. It stays quiet: no gradient, no shadow beyond the existing `e1` rule,
no animation. Everything else in the app earns its hierarchy from type, density and structure.

Where artwork's absence would leave a section with nothing to say at all — a cast strip, a backdrop
hero, an editorial card whose entire content is an image — the section is omitted rather than
rendered empty. See §12.

### Components

Reuse unchanged: `Button`, `Field`, `RankBadge`, `Text`.

Refactor:

| Component | Change |
|---|---|
| `BrandMark` | Delete all `View` geometry; render `assets/brand/bingd-icon.svg` via `expo-image` |
| `AppHeader` | 44pt row, `BrandLockup` `sm`, `right` slot, **`subtitle` deleted** |
| `Screen` | **Delete the floating env badge.** Add bottom inset so content clears the tab bar |
| `Poster` | Responsive `width`/`fill` mode; quieter missing state |
| `TitleRow` | Rebuilt — see below |
| `EmptyState` | Drop the `BrandMark`; add a `compact` variant |
| `BucketChip` | Generalise into `Chip`; `BucketChip` becomes a preset |

`TitleRow` is currently one joined metadata string
(`[subtitle, bucketLabel, '#4 in Movies'].join(' · ')`) and is inert without `onPress`. Rebuild
it with explicit slots: `leading` (ordinal or nothing) · `Poster` · primary line (title + year) ·
secondary line · tertiary line · `trailing` (action or badge). Two metadata tiers with distinct
styles, per the brief's "do not cram everything onto one line". `onPress` becomes required.

New:

| Component | Purpose |
|---|---|
| `Backdrop` | 16:9 artwork with optional scrim |
| `TitleMetadata` | Formats `year · runtime · genres`, omitting whatever is null |
| `SearchField` | 40pt field, leading magnifier, clear button |
| `SectionHeader` | `caption` uppercase + optional trailing action |
| `SegmentedTabs` | The Ranked · Watched · Watchlist row |
| `MediumSelector` | `Movies ▾` — serif label + chevron, opens a two-option menu |
| `Chip` | Filter and bucket chips, 32pt |
| `Avatar` | Image or initials, four sizes |
| `Divider` | Hairline, gutter-inset |
| `ActivityCard` | One feed event |
| `FeaturedCard` | Editorial backdrop card |
| `CastStrip` | Horizontal cast row |
| `StatRow` | Compact divided stats — replaces Profile's three cards |

### Icons

Add `@expo/vector-icons` (Ionicons). It is a JavaScript package whose fonts load over Metro at
runtime through `expo-font`, which is already installed and already used for DM Serif Display and
Inter. No native module, no config plugin change, no rebuild.

| Tab | Unselected | Selected |
|---|---|---|
| Feed | `newspaper-outline` | `newspaper` |
| Collection | `albums-outline` | `albums` |
| Log | `add-circle-outline` | `add-circle` |
| For you | `sparkles-outline` | `sparkles` |
| Profile | `person-circle-outline` | `person-circle` |

24pt (Log 28pt), maroon selected, `text.tertiary` unselected. Outline→filled carries the state
alongside colour, so selection does not depend on hue alone.

---

## 3. Collection

### Current problems

`Ranked | Logged | Watchlist` is the top-level segment row, so collection *state* occupies the
slot Beli gives to the *medium*, and the Movies/TV toggle is demoted to a control inside the
Ranked branch only — meaning Watched and Watchlist silently mix films and seasons. "Logged" is
the database enum shown to users. No row is tappable. Rows carry only bucket and position, never
genre or director. The unranked banner reads "You still have unranked titles." — backlog framing.
Band headers are `LOVED IT` / `IT WAS FINE` / `NOT FOR ME` in caption caps, which is fine, but
they sit on top of rows with no visual grouping.

### Target hierarchy

```
AppHeader        BrandLockup sm
MediumSelector   Movies ▾                       ← switches medium, not state
SegmentedTabs    Ranked · Watched · Watchlist [· Unranked]
[nudge]          one quiet dismissible line, Ranked only
list             band header → rows
```

`Unranked` appears only when `unranked.length > 0`. The medium selector governs all three
states, so Watched and Watchlist are filtered by `kind` too.

Ranked row: `ordinal` (28pt tabular column) · `Poster sm` · **title (year)** ·
`genres · runtime` · nothing trailing. The ordinal is `ordinal`-token Inter, not display serif —
it must be findable without outweighing the title. `TitleMetadata` takes a director slot for later
and omits it while `media_cache` is empty.

Watched row: `Poster sm` · title (year) · `bucket · genres` · watched date trailing.
Watchlist row: `Poster sm` · title (year) · `year · genres · runtime`.

Header count line: `142 ranked · 380 watched` — documented copy, with "logged" replaced.

Every row navigates to `/title/[id]`.

### Nudge copy

Opportunity, not debt, and dismissible via `src/lib/prefs.ts`:

> Rank a few more and your recommendations get sharper. → **Rank some**

### Data

`useRankedCollection` already embeds `media_items(title, release_date, poster_path)`; widen the embed
to `title, release_date, poster_path, genres, runtime_minutes, kind` and map `category` through to
`RankedEntry` — the column is selected today and dropped on the way to TypeScript. All of that data
exists in the seeded catalog. Director is omitted until `media_cache` has rows.

Backend change: none.

### Acceptance

- `Movies ▾` is the top control and switching it changes all three states.
- No user-facing "Logged" anywhere.
- Unranked tab absent when there are no unranked titles.
- Every row opens Title Detail.
- Posters render wherever `poster_path` is non-null.
- A 45-character title wraps to two lines without moving the ordinal or the poster.
- No bordered card wraps a list row.

---

## 4. Search / Log

### Current problems

A labelled `Field` at 48pt minimum plus a section gap, then an `EmptyState` carrying a
`BrandMark`, a `title1` heading and a body line — together roughly the top third of the viewport
before a single result. Results are `TitleRow`s whose one metadata line is
`Series · pick a season` or nothing. Tapping a result immediately opens the log sheet, so the
entity itself has no neutral inspect action. No `KeyboardAvoidingView`.

### Target hierarchy

```
AppHeader     BrandLockup sm
SearchField   40pt, inside a 48pt row, autofocus
results       FlashList, dense
```

Result row: `Poster xs` · title (max 2 lines) · `year · genres` · `runtime` or
`Series · N seasons` · trailing `+` button. The row renders a third tier for director and cast when
those fields arrive; today it has two tiers, which is still the deliberate primary/secondary split
the brief asks for and is more than the single joined string it replaces.

Row body → `/title/[id]`. Trailing `+` → the existing log flow (`SeasonPicker` for a series,
`LogSheet` otherwise). This is the brief's separation of inspect from log, and it also fixes a
latent trap: today a mis-tap while scrolling opens a logging sheet.

Empty state: one `callout` line, no logo, no display heading. If the user has watched anything,
follow it with a compact "Recently watched" shortcut list; otherwise nothing.

Keyboard: keep `keyboardShouldPersistTaps="handled"`, add `keyboardDismissMode="on-drag"` and
bottom content inset for the keyboard so the last result is reachable.

The 180ms debounce, 2-character floor and `keepPreviousData` are documented behaviour — leave
them alone.

### Data

`search_titles` returns `id, kind, title, release_date, poster_path, provenance` and cannot be
changed without a migration. It does not need to be: after the RPC returns, batch-select
`media_items` for `genres, runtime_minutes` keyed on the returned ids. `media_items` is
world-readable, so this is one extra select, the RPC stays the search authority, and no second
media-data path is created.

Backend change: none.

### Acceptance

- Field is 40pt; header + field together under ~100pt.
- Empty state under a quarter of the viewport.
- Results show at least two distinct metadata tiers.
- Tapping a result opens Title Detail; only `+` starts logging.
- Results stay visible and scrollable with the keyboard up.
- A two-line title does not change row height for its neighbours.

---

## 5. Title Detail

### Current problems

No header and no back affordance — the screen is only reachable by deep link, and once there
you are stranded. Poster-led with no backdrop. `YOUR STATE` and `FRIEND SIGNAL` are raw internal
labels; `FRIEND SIGNAL` renders
`"Friend rankings will appear here once social signals are connected."` The only action is
disabled with `"Title actions are being wired in this phase."` Genres are gated on
`provenance === 'tmdb'`, so they are invisible for the entire current catalog. No cast, no
director, no seasons list.

### Target hierarchy

Apple TV's information layer, with bingd's rank promoted above the generic metadata.

```
native Stack header      back · title on scroll
hero                     poster lg beside title      ← backdrop layer when the field is non-null
title                    title1 serif
TitleMetadata            year · runtime · genres
actions                  Rank / Re-rank (primary) · Watchlist · Share
your rank                RankBadge #18 in Movies · bucket · watched date · note
[synopsis]               3 lines, expandable         ← omitted while overview is null
[director / creator]     one line                    ← omitted while media_cache is empty
[CastStrip]              top-billed, horizontal      ← omitted while media_cache is empty
[seasons]                series only — per-season state, each row rankable
attribution              TMDB line when provenance = tmdb
```

**A conflict to resolve explicitly.** The brief names Apple TV as the artwork reference, which implies
a backdrop-led hero. `design-system.md` §6 says the opposite: `poster.lg` beside the title, *not* a
full-bleed backdrop — and §7 forbids full-bleed artwork anywhere, requiring a 16pt parchment margin.
The documented rule wins, and it is also the only workable answer given no row has a backdrop. So the
hero is poster-led and composed to hold up with no artwork at all; `Backdrop` renders behind it as an
upgrade when `backdrop_path` arrives. Apple TV's influence lands where it can: the metadata order,
the cast treatment, and the weight given to artwork once artwork exists.

Bracketed sections above are omitted entirely today — no headings, no empty containers, no "coming
soon". With the current catalog a movie detail renders hero, title, metadata, actions, your rank and
attribution; a series adds its season list. That is a complete screen, not a gutted one.

Section labels become sentence-case English: "Your rank", "Cast". `FRIEND SIGNAL` and its
placeholder are deleted outright — no friend module until `match_scores` and `follows` are
queryable.

Remove the `provenance === 'tmdb'` gate on genres. It was a licence-attribution guard, but the
attribution line already handles that, and the effect today is hiding data the app has.

### TV

`_assert_loggable` refuses a series (`20260813000700_ranking_functions.sql:207-211`), and the
rankable unit is the season. So a series detail shows no Rank action at all. It lists seasons with
per-season state, and each season row is the thing that carries actions. Wiring Rank on a series
would produce a server error the user cannot act on.

### Data

`kind, title, release_date, runtime_minutes, overview, poster_path, genres, provenance, tmdb_id`
are already selected. Add `backdrop_path`. Seasons come from the existing `useSeasons` query. The
credits read is designed as a hook boundary (`useCredits`) that returns nothing while `media_cache`
is empty, so the screen omits those sections without special-casing.

Backend change: none.

### Acceptance

- Reachable from search, collection, feed and profile, with a working back.
- Poster renders when the catalog has one; the hero holds up when it does not.
- Zero placeholder modules; the friend section does not exist.
- The user's rank sits above the synopsis.
- Cast is a horizontal strip.
- A series offers no Rank action; its seasons do.
- Missing optional data omits its subsection silently.

---

## 6. Pairwise ranking

Ranking logic, RPCs, session semantics and every test stay exactly as they are. This is a
presentation change.

### Current problems — both are real layout bugs

`Card` renders `<Poster size="xl">`, which is a fixed 180×270. Two of them side by side need
360pt plus gaps and gutters; an iPhone SE has 375pt of width. **The comparison overflows on small
screens today.**

Each card is a `Pressable` containing a fixed poster and a `numberOfLines={2}` title. When one
title wraps and the other does not, the two cards' heights differ, so the posters no longer share
a baseline and the controls below shift. This is the misalignment in the brief.

### Target

- Cards `flex: 1` with `Poster width="fill"` and `aspectRatio: 2/3`, capped at `poster.xl` width
  so large screens do not blow the artwork up.
- Title area a **fixed** height of two `headline` lines (44pt), `numberOfLines={2}`, centred,
  vertically top-aligned inside its box. One-line and two-line titles then produce identical
  cards.
- Question, progress line and controls in fixed rows so no title length can move them.
- Keep the sheet presentation (`Modal` `pageSheet`) — no new dependency, and it is already less
  intrusive than a full page.
- Keep `Back` + `Too tough to call` as exactly two controls. `screens.md` §4 is explicit that
  Beli's third control is redundant since both call `rank_skip`.
- Keep the opponent's rank hidden. Founder decision, 2026-08-13.

### Acceptance

- Renders correctly at 320pt width.
- A one-line title beside a two-line title keeps both posters aligned to the pixel.
- Controls do not move between comparisons.
- `RankingSheet.test.tsx`, `session.test.ts` and `supabase/tests/ranking*.test.mjs` still pass
  unchanged.

---

## 7. Feed

### Current problems

Three featured cards reading `Top 10 in Chicago` / `Date night picks` / `New in theaters` over
the literal label `Sponsored/editorial slot` on a blank beige card. The activity section renders
the user's own last four rankings as bare `TitleRow`s with a hardcoded `"Movies"` category. Then
`"Following activity will appear here once you connect with people."` as a full section, and a
footnote counting logged titles. Nothing is tappable.

### Target

**Featured strip.** Keep the architecture, and stop rendering it for now. A featured card is
substantially an image with a label on it; with no backdrops and no `popularity` there is neither the
artwork to make it cinematic nor a true signal to rank it by, and the two available framings both
fail. Three artwork-absent tiles at the top of the feed rebuild the exact "large boxes on beige"
problem this pass exists to fix. Inventing "Popular now" from `release_date` would be the fabricated
metadata the brief forbids.

So: `FeaturedCard` and `useFeatured` are built and exercised by fixtures in the harness, and
`FeaturedStrip` returns `null` when it has no inventory — which is its state today. The architecture
stays sponsorship-ready and the feed starts with real activity instead of three empty rectangles.
This is the brief's "gracefully omit that subsection rather than putting a visible placeholder block
into an otherwise finished screen", applied to the one module whose content *is* the artwork.

**Activity.** Read `feed_events` — own plus followed, which the existing RLS already permits —
joined to `media_items` and `profiles`. `ActivityCard`:

```
Avatar sm   sentence with the actor and title emphasised
            RankBadge or the relevant bingd state
            Poster / Backdrop
            compact metadata
            relative time
```

Event types available: `title_ranked`, `title_logged`, `season_completed`, `list_created`,
`list_added`, `milestone_reached`, `joined_from_invitation`. Render the first three; ignore the
rest until they are produced.

Reactions and comments are not implemented, so no Like or Comment control appears. `reactions`
has a table but no RPC; `screens.md` §7 defers comments outright.

Copy: activity sentences read as sentences, not as event records. "Sai ranked **Sinners** #3 in
Movies" — not "TITLE_RANKED · Movies". Run the humanizer skill over the strings.

Empty feed: one compact line with a single action. Not a section.

### Data

Available now. `feed_events` is written on rank finalize
(`20260813000700_ranking_functions.sql:161-167`) and readable via `can_view_profile`.

Backend change: none.

### Acceptance

- No card reads "Sponsored" or "editorial slot", and no empty featured tiles render.
- `FeaturedCard` renders correctly under fixtures, proving it is ready for real inventory.
- Activity items come from `feed_events`, not from a rankings query.
- Own and followed activity both appear when both exist.
- No Like or Comment controls.
- No "friends will appear here" section.
- Every card navigates to Title Detail.

---

## 8. Profile

### Current problems

Three stat cards (Ranked / Logged / Unranked) consuming most of the first viewport. Edit and
Share are rendered disabled with `"Profile editing is coming soon."` and
`"Profile sharing is coming soon."` A `Taste profile` card holds
`"Compare your rankings with friends once social matching is enabled."` Top ranked rows are inert.
No avatar, no follower or following counts.

### Target

```
Avatar md   display name (title2 serif) · @handle · member since
StatRow     Followers · Following · Ranked · Watched · Watchlist   ← one divided row
actions     Share profile
Top ranked  poster-led, tappable
Recent      compact ActivityCards
```

`StatRow` is a single hairline-divided row, not five cards. It replaces three cards with more
information in less space.

Share profile is genuinely buildable now: `expo-sharing` is installed and `/u/[username]` is a
registered deep-link route. Build it. Edit profile has no implementation, so it is omitted, not
disabled-with-an-excuse. The taste module is deleted until `match_scores` is queryable.

### Data

Ranked / Watched / Watchlist counts come from the existing collection hooks. Follower and
following counts are `count` queries against `follows` filtered on `state = 'approved'` — the
table and its policies exist, so the number is real even while it is zero. Top ranked is
`useRankedCollection` limited to the top few, with posters.

Backend change: none.

### Acceptance

- Identity, stats and the first poster all above the fold.
- One stats row, no stat cards.
- Top titles show poster art and navigate.
- No "coming soon" text and no taste placeholder.
- Share works.

---

## 9. Header and navigation

- `AppHeader` on the five tabs only: 44pt, `BrandLockup sm`, no subtitle.
- Register `title/[id]`, `u/[username]` and `lists/[id]` in the root `Stack` with
  `headerShown: true`, a back button, parchment header background and a `headerTitle` that is the
  title's name — not "bingd".
- `settings` keeps `presentation: 'modal'`; give it a header with a close action, since it
  currently has neither header nor any in-app entry point. Add the entry point from Profile.
- Ranking and log sheets keep the global header hidden.
- Tab bar structure is unchanged: Feed · Collection · Log · For you · Profile.
- **Delete the env badge from `Screen`.** It is `position: absolute; bottom: 8; alignSelf:
  center` on *every* screen, so in the founder's preview build a `PREVIEW` pill floats over the
  bottom of all content and the tab bar. The build variant is already reported properly by
  `BuildDetails` in Settings, which is where it belongs.

---

## 10. Onboarding

Audit only; do not broaden scope. `create-profile.tsx` already has MM/DD/YYYY segments with
`number-pad`, ref-chained auto-advance, `KeyboardAvoidingView` and
`keyboardShouldPersistTaps="handled"`. Verify and fix only:

- segment order is MM / DD / YYYY and auto-advance fires on segment completion
- no persistent "13+" instruction in the normal form; under-age handled by validation, which the
  existing `{ outcome: 'under_13' }` path and `create-profile.test.ts` already cover
- fields stay above the keyboard on a small screen
- one primary action per step, consistent header treatment, no large blank runs

---

## 11. Designing for data that is not there yet

No TMDB work happens in this pass. Provider enrichment is a separate follow-up after the UI
direction is validated. The rules:

**Wire what exists.** `genres`, `runtime_minutes`, `release_date`, `kind`, the season tree,
`rankings.category`, `feed_events`, and `follows` counts are all present and mostly unread. Wiring
them through is the data work.

**Build the interface for what doesn't.** `Poster` and `Backdrop` take artwork; `TitleMetadata` takes
a director slot; `CastStrip` and `useCredits` exist and read `media_cache`. When the adapter fills
those columns, the UI lights up with no further design work. That readiness is a deliverable of this
pass and is verified by the fixture renders.

**Omit, never placeholder.** A section with no data renders nothing — no heading, no empty container,
no "coming soon". Applies to synopsis, director, cast, backdrop hero layer, the featured strip, friend
signals, taste modules and match scores.

**Fixtures live only in the harness.** Fixture titles with plausible artwork, cast and synopses exist
to prove the components render correctly, and they live under the screenshot harness in §13 — never
imported by anything in `src/` or `app/` that ships, never written into `supabase/seed/`, never
committed as catalog data. Use public TMDB image paths for fixture artwork at render time only.

**A note for the follow-up.** Every film and series retains its `tmdb_id` and every row its Wikidata
id, so the adapter enriches in place. The `provenance` column already guards the licence boundary. The
one thing this pass adds for that future: removing the `provenance === 'tmdb'` gate on genres in Title
Detail, which currently hides CC0 genre data the app already has.

---

## 12. Broad audit checklist

Fixed as part of the above: floating `PREVIEW` badge; missing tab icons; approximated logo;
missing period in the wordmark; ranking overflow at 320pt; ranking card misalignment; inert rows
throughout; "Logged" in user copy; hardcoded `"Movies"` category in Feed; genres hidden behind a
provenance check; `EmptyState` logo repetition; `AppHeader` subtitle redundancy; oversized search
field and empty state.

To sweep separately:

- `recommendations.tsx` — `Start ranking` has `onPress: () => {}`. Point it at the Log tab.
- `u/[username]`, `lists/[id]`, `i/[token]` — three stub screens rendering `List ${id}.` and
  `Invitation ${token}.` to users. Either give them a real empty state or make them unreachable.
- `settings/index.tsx` — no header, no back, no entry point.
- `SeasonPicker` — season rows have no poster while every other list does.
- Long-title behaviour on every new row and card at 45+ characters.
- Dynamic Type at 200% on Collection rows, the comparison, and Title Detail.
- Loading, empty and error states for every new query.
- Disabled-state contrast: `Button`'s 40% opacity against parchment.
- Tab-bar overlap on scroll views now that `Screen` handles the bottom inset.
- Android vs iOS: header heights, shadow rendering, `expo-image` SVG tinting.

---

## 13. Verification

Order matters: checks, then render, then critique, then fix, then re-render.

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`.
2. Screenshot harness — a dev-only, variant-gated gallery route that mounts each screen with a
   pre-seeded `QueryClient` and a mocked auth session, captured through `react-native-web` with
   Playwright at 320, 375 and 430pt. Playwright is a devDependency; nothing native changes. It
   must not exist in a production build, and `src/test-utils/app-directory.test.ts` needs updating
   for the added route.
3. Capture Collection, Search with results, Title Detail, Pairwise ranking, Feed, Profile — each in
   **both** states:
   - **shipped state**, fixtures shaped like the real catalog: no posters, no backdrops, no synopsis,
     no cast. This is what the founder will actually see, and it is the state that has to look
     finished. Judge the pass on these.
   - **enriched state**, fixtures with artwork and credits, proving the components are ready and that
     omitted sections appear correctly when data exists.
4. Compare against `docs/design/references/beli-*`, `apple-tv-5-shelves`, `letterboxd-34-title-detail`.
5. Impeccable critique pass; classify P0 broken / P1 hierarchy / P2 polish.
6. Fix every P0 and P1.
7. Re-capture and re-inspect. At least one full critique→correction iteration.
8. Founder device pass on the dev client — the harness is a layout proxy, not a native render,
   and the final word is a real device.

The bar for the shipped state is explicit: a reviewer who does not know the catalog lacks artwork
should read those screens as a finished app with restrained art direction, not as an app waiting for
images.

Nothing merges until the founder has previewed the pass.
