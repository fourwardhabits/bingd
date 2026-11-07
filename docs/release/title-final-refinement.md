# Final UI refinement — title page, Collection and trailers

Founder brief: "bingd. — Final UI Refinement: Title Page, Collection & Trailers" (2026-11-06),
from Android phone QA of the Cinematic title page Preview. This file records what changed, how
it was checked, what was published, how to undo it, the Feed ranking-nudge proposal (planning
only), and what is left before production. The Original title page is untouched and still the
default; the Cinematic layout remains Labs-only in Preview and locked off in production
(`isTitleLayoutAvailable`).

## Where it comes from

- **Base:** `e74a0f0` on `refine/title-cinematic` (code `e12fce8`, published as `ebf1fa3`:
  Android update `01a1b2d9-e941-70a6-9953-d50758c19537`, group
  `8c8dfb90-7fd8-4e32-9cd5-3c613c66f498`, runtime `2503ffaa`), confirmed as the newest Preview
  with `eas update:list --branch preview` before any change. None of it is on `main`.
- **Rollback target, recorded before any change:** group `8c8dfb90`.
- **Branch:** `refine/title-final` in `../worktrees/title-final` (node_modules junction to
  rc-direction-a). Local only; not pushed, not merged. The only other session (app-f1) was idle
  for a day; this session published the two previous Previews and is the one publisher here.

## Change ledger

| Commit | Area | What |
| --- | --- | --- |
| `e4e035c` | Title page | The hairline card; full-width sections; tight headings; the new order; Similar six; More details; trailer frames |
| `81d2a44` | Collection | Watched / Watchlist / Unranked at full weight (`solid`); a quieter Filter & Sort |
| `561a732` | Review 1 fixes | Where to Watch's seam inside its own row; tight headers raised over the body |
| `cae88d0` | Review 2 fixes | Heading-action slop reaches the seam and the body's padding, never a rail |

### 1. The title page: inset card, full-width page

- **The card** (`ImmersiveHero`): unchanged artwork, band height, 22% overlap and 12pt inset.
  It is now rounded all round and closed by one hairline (`border.hairline`, no shadow) with
  16pt under the scores. Before, it had no edge, so below the artwork it vanished, and its 28pt
  text line read as misaligned against everything under it.
- **The page under it is the app's own width.** The sections dropped the extra 12pt column the
  module's inset added (`sheetColumn`), so every heading, synopsis, rail and grid sits on the
  same 16pt gutter as the rest of bingd. Rails start on the gutter and scroll to the edge.
- **Vertically efficient.** A Cinematic section heading is its own 16pt line instead of a 44pt
  row (`SectionHeader tight`, opt-in). The body starts 8pt under it, or 4pt for text under text
  (About), where the two lines' own leading makes up the rest, so the words under every
  heading start the same distance down. Sections are 20pt apart (`SECTION_SEAM`). Where to
  Watch draws its own heading row, and takes the same 20pt as its own top padding
  (`topSpace`; it was 28pt).
- **Heading actions keep a whole target.** See all, Show previews and See more get a 46pt
  target from slop that reaches 20pt into the section's own seam and 8pt into the body's
  padding, never over a scroll view. For that reason the Cast and Trailers rails carry no
  vertical padding of their own; Cinematic is the only caller of both.

Measured in the render (360pt, default text), from the bottom of a heading's words to the top
of what is under it: About 4pt (text under text, about 10pt to the eye), Cast, Trailers, Reviews
and Similar 8–9pt; Episodes 16pt (a list row's own padding). Section seams: 20–21pt
everywhere, Where to Watch included; the card's bottom edge to ABOUT 20pt. Every heading and
body starts at x = 16.

### 2. Section order

About, Where to Watch, Episodes or Seasons (TV), Cast, Trailers, Reviews, Similar, More
details. Trailers and Reviews swapped; Similar moved above the facts. No tabs.

- **Similar:** the first six (two rows of three), and *See more* for the rest of the same list —
  the nine `useSimilarTitles` already holds — with *Show fewer* to fold it back. No new fetch,
  no change to selection, order or the title push; `similar_title_opened` still fires. Six or
  fewer: no action. No full-screen Similar view exists, so none was built.
- **More details:** a closed disclosure at the foot (`MORE DETAILS ⌄`, a 44pt button with
  `accessibilityState.expanded`). Open, it lists label and value on one line each, each row one
  spoken phrase (`Released: July 18, 2008`): Released, Original language, Created by (TV), Your
  rank with its denominator, and Runtime for a season or series. A film's runtime is already on
  the module's metadata line, so it is left out; genres and director were already out. Nothing
  to list: no disclosure.
- **About, Where to Watch, Cast, Reviews:** unchanged components and behaviour, on the new grid.

### 3. Trailers

- **Before previews:** each card is an Ink 16:9 video frame with a Parchment play button and its
  kind (`Teaser`, `Featurette`) on a small Ink plate in the corner, then the name and where it
  plays. The kind is left off a card whose name already says it ("Trailer"). No request to
  YouTube until *Show previews*, exactly as before.
- **After Show previews:** YouTube's `hqdefault` still fades in over the frame
  (`https://i.ytimg.com/vi/{key}/hqdefault.jpg`, cached on disk by expo-image like every other
  image). While it loads, and for good if YouTube cannot serve it, the frame stays: a 404 (a
  removed or private video) is caught by `onError` and that card keeps its frame, kind, play
  button and link. Never a blank rectangle.
- **URL check:** a well-known public trailer id returned 200 `image/jpeg` (28 KB) from that
  pattern on 2026-11-06; an unknown id returned 404. Keys are validated as 11-character YouTube
  ids before any URL is built (`videoUri`), so a bad key has no still and no link.
- **Not verified on a phone by this session** — on the QA checklist. No proxy or
  infrastructure change was needed or made.

### 4. Collection

- **Watched | Watchlist | Unranked** (`SegmentedTabs variant="nav" solid`, opt-in): the chosen
  segment is filled Maroon with its word in Parchment — the Feed mode toggle's grammar — and the
  others are Ink on Paper, at 16pt Inter Medium (was 15pt). Same hairline track, equal halves or
  thirds, 44pt targets, one line that shrinks before it truncates, the 1.3× label ceiling. The
  Leaderboard's categories keep the quiet default.
- **Filter & Sort:** footnote and secondary rather than callout and primary, its icon tertiary
  until a filter is on. Same 44pt row, same sheet, same status text, same logic.
- Movies/TV, Grid/List, My lists, the poster grid, score badges, persistence and Unranked
  eligibility are untouched.

## Deviations and compromises

- **The card has a hairline.** The brief asked to try the wider page first and add a very subtle
  boundary only if needed. Without one, the Paper card on the Paper page had no edge below the
  artwork and its text line looked misaligned against the sections, so it has one hairline at
  12% Ink, no shadow.
- **Heading actions.** A section heading is one line, so its action (See all, Show previews,
  See more) gets its 44pt target from slop. That slop reaches 20pt into the section's own
  seam and 8pt into the body's padding (46pt in all), never over a rail. That is why Cast and
  Trailers start 8pt below their heading from the outside rather than from inside the rail.
  Reviews 1 and 2 drove this.
- **Similar.** It expands in place: the list is the nine the page already fetches, and there is
  no full-screen Similar view to reuse.
- **More details.** The rows are Released, Original language, Created by (TV), Your rank, and
  Runtime for TV only. The movie runtime is on the metadata line.
- **Trailers.** The kind badge is hidden when the card's name already says it ("Trailer").
- **The Collection label size at large text** comes from `adjustsFontSizeToFit`, which web
  renders cannot show. At the 1.3× cap, "Watchlist" needs about 0.81 of its size in a third of
  a 320pt phone, inside the 0.7 floor (it needed 0.87 at the old 15pt).
- **Not seen on a device:** thumbnails loading from YouTube on Android, TalkBack's
  expanded/collapsed announcement, touch near the edges of the heading actions, and iOS.
- **Leftover Cinematic-only options.** `CastStrip gutter` and `PosterGrid gutter` are no longer
  used by any caller. They are harmless and were left in place.

## Feed ranking nudge — proposal only, not built

**What exists.**
- Collection already knows, per medium, how many titles are left to rank: the server's
  `ranking_backlog` (`useRankingBacklog(userId, category)`, one row, `{ total }`, flag-gated),
  with `useLoggedCollection().unranked` as the fallback when the flag is off.
- It already has a dismiss rule (`shouldShowUnrankedNudge`: hidden 14 days after a dismissal and
  until something new is ranked; stored per user under `collection.unranked-nudge`).
- The batch flow already has a route: `/rank-session?medium=movies|tv_seasons&start=backlog`.
- The Feed renders Trending Now, then a 12pt heading spacer, then activity.

So the data and the destination are sufficient; only a small Feed row and its own preference
are new.

**Proposal.**
- **Where:** one compact row between Trending Now and the first activity card, in Feed mode only
  (never on Leaderboard or People), not sticky. One line of copy and one action, for example
  "12 titles waiting to be ranked · Rank now", plus a close glyph. Not the Collection card.
- **Eligibility:** at least 3 unranked titles in a medium (one stray title is not worth a
  prompt), onboarding finished, and the ranking backlog query answered (never shown while
  loading). If both media qualify, name the larger; the action opens that medium's batch.
- **Action:** `/rank-session?medium=…&start=backlog`, the existing flow and summary.
- **Dismissal and frequency:**
  - A separate preference (`feed.rank-nudge`) so Feed and Collection can be tuned apart.
  - Dismissing hides it for 14 days and until the count has grown.
  - Three dismissals retire it for good.
  - At most once per app session, and never on the same day the reader finished a ranking
    session.
  - Dismissing it in Feed does not touch Collection's card, and the reverse.
- **Measurement:** three new events (shown, opened, dismissed) would need adding to the
  analytics schema; that is the only change outside the Feed screen.
- **Size of the change:** one presentational component, a small eligibility helper with tests,
  and the preference. No backend, schema or native work.

## Verification

- **Typecheck:** clean. **Lint:** 0 errors, 81 warnings (the same as the base).
- **Jest:** 286/286 suites, 5,490 passed, 1 skipped at `cae88d0` (the base: 5,478).
- **New and updated tests:**
  - The card: Paper, one hairline, no shadow.
  - Section order, and the heading on one line with its 4pt and 8pt gaps.
  - The Cast rail with no padding inside it.
  - Where to Watch's 20pt inside its own row, with no negative margin above it.
  - More details: closed, opened and closed again, with no film runtime.
  - Similar (`SimilarTab.test`): six with See 3 more, nine, Show fewer back to six; no action at
    four; a tile opening its title with `similar_title_opened`.
  - Trailers: frames and kinds before previews; two stills after; a still's `onError` keeping
    its frame, kind and link.
  - `SectionHeader tight`: one line, raised, a 46pt slop.
  - The `nav` quiet default against `solid`.
  - Collection's Maroon segment and Ink labels.
- **Real-app renders** (react-native-web against the local mock; 320, 360 and 412pt; 200% text
  through the render-only patch):
  - The opening screen for a dark backdrop, a bright one, poster-only, no artwork, three
    directors and a TV season.
  - Every section by scrolling, Similar collapsed and expanded, More details open and closed.
  - Collection on Watched, Watchlist and TV at all three widths, and the Leaderboard unchanged.
- **Trailer privacy, counted in the render:** 0 requests to `i.ytimg.com` on opening and on
  scrolling the whole page. After Show previews there were 3 requests, with two stills drawn,
  and the third (a forced 404) kept its frame.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout gives `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` at `81d2a44` and
  again at `cae88d0`, which is the installed Preview APK's runtime. Only `app/` and `src/`
  changed: no migration, native, config or server change.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, three passes. Reports are in
`.agent-workflow/codex-reviews/tf-review{1,2,3}.md` (gitignored).

1. **`e74a0f0..81d2a44`: needs attention, two MEDIUM, fixed in `561a732`.**
   - Where to Watch's −8pt margin laid its Pressable over the synopsis's More control. It now
     takes its seam as its own top padding (`topSpace`).
   - A tight heading action's lower slop sat over the rail drawn after it. The heading row is
     now raised (`zIndex`).
2. **Whole branch at `561a732`: needs attention, one MEDIUM, fixed in `cae88d0`.**
   - On Android, a rail still coasting from a fling intercepts a touch inside its own native
     bounds whatever the z order.
   - The slop now lies only over the section's seam (20pt up) and the body's padding (8pt
     down), and the rails carry no padding of their own.
3. **Whole branch at `cae88d0`: approve, no material findings.**

No HIGH or CRITICAL finding was raised at any pass. Codex's own Jest run is blocked by its
read-only sandbox; the suite above is the implementer's. Codex did not exercise native touch.

## Android Preview

**Live on Android Preview, 2026-11-06.** Published after every gate above passed, by this
session as the one publisher, from `../worktrees/visual2-preview-publish` (real `npm ci`)
detached at the record commit.

| | |
| --- | --- |
| Source commit | `1996619` (code `cae88d0`) |
| Update group | `29b60018-595c-4862-88c7-5d6c551f2a25` |
| Android update | `01a1b34f-25a8-79b3-8adc-08549f9230ae` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543`, the installed Preview build; no rebuild |
| Channel order after | `29b60018` (this), `8c8dfb90` (rollback), `9906ddd5` |

Android only. iOS, production, `main` and the website are untouched.

## Rollback

```
npx eas update:republish --group 8c8dfb90-7fd8-4e32-9cd5-3c613c66f498 --non-interactive
```

This returns the Preview channel to the Cinematic title page sprint (`ebf1fa3`), the build the
founder tested. Run it from `../worktrees/visual2-preview-publish`. The Original title page is
also always one switch away in Settings → Labs.

## Phone QA checklist

Turn on the Cinematic layout in Labs, and relaunch once after the update.

1. **The card:** a dark backdrop and a bright one. The card overlaps the artwork's foot with a
   faint edge and no shadow. Below it, About, Cast and the rest line up with the rest of the
   app (16pt), not with the card's text.
2. **Spacing:** ABOUT sits close above its synopsis. Every heading is the same distance above its
   content, and the sections are evenly spaced with no tall gaps.
3. **Order:** About, Where to Watch, Episodes/Seasons on TV, Cast, Trailers, Reviews, Similar,
   More details.
4. **Trailers before Show previews:** dark video frames with a play button, and "Teaser" or
   similar in the corner. Tap one and YouTube opens.
5. **Trailers after Show previews:** pictures fade in on every trailer. Scroll the rail, and
   check a title with several trailers.
6. **Taps near the edges:** fling the Cast rail, then tap just below "See all" while it is still
   moving. It opens the cast sheet. Do the same for Show previews.
7. **Where to Watch:** tap the bottom edge of a long synopsis's More. It expands the synopsis
   and does not open the services.
8. **Similar:** six posters. See more shows the rest, and Show fewer folds them back. A title
   with few similar titles shows no button.
9. **More details:** closed by default. Tap it for the release date, language, creator (TV) and
   your rank, and tap again to close.
10. **Collection:** Watched in solid Maroon with light text, the other one or two in dark text,
    and Filter & Sort quieter underneath. Switch Movies and TV, and use a medium with nothing
    unranked to see two tabs.
11. **Largest system font:** nothing clipped on the title page or Collection. Show previews
    drops under its heading.
12. **Labs → Original:** the old page with its tabs.

## Production

Not production. Before it:
- Founder phone QA of this Preview.
- A separate decision to switch the Cinematic layout on for production.
- The whole Preview chain is unmerged. `refine/title-final` stacks on `refine/title-cinematic`,
  on `refine/nav-cohesion` and the branches before it. The merged `main` has to pass the
  production fingerprint check.
- The earlier open items still apply:
  - The trailer-thumbnail entry in the privacy inventory. This sprint makes no new request:
    still opt-in, the same host and the same image.
  - The default-date race.
  - Security items M-5, M-6 and the M-3 residual.
- The Feed ranking nudge above is a proposal and needs its own approval.
