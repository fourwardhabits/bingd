# Bingd — Heading system

**Date:** 2026-11-22 · **Brief:** founder, "App-Wide Typography, Section Hierarchy & Spacing Refinement" · **Tokens:** `src/ui/tokens/typography.ts`, `layout.section` in `src/ui/tokens/layout.ts` · **Component:** `SectionHeader`

Two principles from the brief: **similar elements look like one system**, and **headings orient the reader without competing with posters, heroes, rankings and reviews**. The attention order the system is built to keep is artwork and hero first, then the activity or information about it, then navigation, headings, filters and labels.

This is not a redesign. The serif page and sheet titles, the burgundy capitals, the wordmark and every control are unchanged. What changed is that one visual role had two or three treatments, and that the same relationship (a heading to the thing it names) was spaced four different ways.

---

## 1. Audit

Measured in the running app (Expo web, fixture data, 360pt and 320pt, 100% and 130% text). "Ink gap" is the visible distance from the bottom of a heading's capitals to the first pixel of what it heads.

| Role                      | Where                                                                                                                                                                                                                                    | Before                                                                     | Decision                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Page title**            | Title name, person name, list title, onboarding steps                                                                                                                                                                                    | `title1` DM Serif 28/34, Ink                                               | Unchanged. Serif is the page's name, never a section's.                                                                           |
|                           | For You's and Collection's `Recommended ▾` / `Watched ▾`, a profile's name                                                                                                                                                               | `title2` DM Serif 22/28                                                    | Unchanged: the page's name, set as a control.                                                                                     |
| **Sheet title**           | `SheetHeader` (Collection, Following, Awards, Group Picks), Where to watch, Cast, New list, Goals, Reviews (`2 reviews`)                                                                                                                 | `title2` DM Serif 22/28, Ink, `maxFontSizeMultiplier` 1.5 on `SheetHeader` | Unchanged; already one treatment.                                                                                                 |
|                           | Control sheets: `Filters`, `Sort` (Leaderboard, Collection, Filmography)                                                                                                                                                                 | `headline` Inter 600 17/22                                                 | Unchanged, as an exception (§3).                                                                                                  |
| **Section heading**       | Feed: TRENDING NOW, LEADERBOARD, DISCOVER PEOPLE, RECENT ACTIVITY                                                                                                                                                                        | `sectionHeaderLarge` Inter 600 **15/20, +0.7**, caps, Maroon, 130% ceiling | **`sectionHeading` 13/18, +0.5**                                                                                                  |
|                           | Your profile: YOUR 2026, bingd AWARDS, TOP RANKED, WATCHLIST, LISTS, RECENT ACTIVITY                                                                                                                                                     | **15/20, +0.7**                                                            | **`sectionHeading`**                                                                                                              |
|                           | Somebody else's profile: the same six, REVIEWS                                                                                                                                                                                           | `sectionHeader` **12/16, +0.6**                                            | **`sectionHeading`** — same sections, same heading                                                                                |
|                           | Title page, Cinematic: ABOUT, EPISODES, SEASONS, CAST, TRAILERS, REVIEWS, SIMILAR, MORE DETAILS, WHERE TO WATCH                                                                                                                          | **12/16** (two of them hand-set)                                           | **`sectionHeading`**                                                                                                              |
|                           | Title page, original layout: SCORES, WHERE TO WATCH                                                                                                                                                                                      | **12/16**, hand-set                                                        | **`sectionHeading`**                                                                                                              |
|                           | Person page FILMOGRAPHY, Settings index, My lists, Watch history                                                                                                                                                                         | **15/20**                                                                  | **`sectionHeading`**                                                                                                              |
| **Group label**           | Settings sub-screens, Notifications' days and Follow requests, Search's result kinds and Recent searches, onboarding People, Where-to-watch sheet's STREAM / RENT, Add titles, filter sheets' GENRE / TIME PERIOD, Watch history's years | `sectionHeader` 12/16, +0.6, caps, Maroon                                  | Unchanged, renamed **`groupLabel`**.                                                                                              |
| **Small label**           | Original title page's Details (DIRECTOR…)                                                                                                                                                                                                | `caption` caps, +0.2, tertiary                                             | **`label`** 12/16 Inter 500, +0.6, caps, `text.secondary`                                                                         |
|                           | Match explainer's MATCH / SHARED                                                                                                                                                                                                         | `footnote` 13 caps, tertiary                                               | **`label`**                                                                                                                       |
|                           | Award breakdown's halves (MOVIES / TV)                                                                                                                                                                                                   | `footnote` caps, +0.6, secondary                                           | **`label`**                                                                                                                       |
|                           | Celebration eyebrows (AWARD EARNED, STREAK CONTINUED)                                                                                                                                                                                    | `caption` caps, secondary                                                  | **`label`**                                                                                                                       |
| **Metadata / supporting** | Leaderboard's `All Titles · This month`, Discover People's sublines, timestamps, counts, For You's explanation line                                                                                                                      | `footnote` 13/18, secondary or tertiary                                    | Unchanged; already consistent.                                                                                                    |
| **Feed post headline**    | `FeedHeadline` (Feed polish PR)                                                                                                                                                                                                          | `subhead` 14/20, names in Inter 600, Ink                                   | Not this PR's. Checked: the 13pt Maroon capitals now sit below the 14pt Ink headline in weight, where the 15pt ones sat above it. |

**Spacing, before** (ink gap, heading → what it heads, 360pt):

| Surface                              | Heading → first item       | Previous block → heading                                              |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------- |
| Feed: TRENDING NOW → shelf           | 21                         | —                                                                     |
| Feed: RECENT ACTIVITY → first post   | **13**                     | 20                                                                    |
| Your profile: grids, shelves, badges | **21.5 – 28.5**            | 36, then **16** (Watchlist), **20** (Lists), **48** (Recent activity) |
| Their profile                        | **23 – 29.5**              | 37, then **17**, **21**, **49**                                       |
| Title page: rails, cards, grids      | **11.5** (Seasons **7.5**) | 31 – 36                                                               |
| Title page: ABOUT → synopsis         | 13                         | —                                                                     |

The two findings: a heading on a profile stood twice as far from its posters as the same heading on a title page, and the profile's own section seams ran 16 to 49.

## 2. Roles

Three roles under the page and sheet titles, each a token, each reached through one component where the component fits.

|                | **Section heading**                                                            | **Group label**                 | **Small label**                                |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------- |
| Token          | `sectionHeading`                                                               | `groupLabel`                    | `label`                                        |
| Reached by     | `SectionHeader size="large"` (`FeedHeading` on the Feed)                       | `SectionHeader` (default)       | `Text variant="label"`                         |
| Family, weight | Inter 600                                                                      | Inter 600                       | Inter 500                                      |
| Size / line    | 13 / 18                                                                        | 12 / 16                         | 12 / 16                                        |
| Tracking       | +0.5                                                                           | +0.6                            | +0.6                                           |
| Case           | Uppercase as a style; spoken as written                                        | Same                            | Same                                           |
| Colour         | Maroon (`semantic.action`), 8.2:1 Paper, 7.4:1 Parchment                       | Maroon                          | `text.secondary`, 6.4:1 Paper, 5.8:1 Parchment |
| Above          | The page's section seam (§4)                                                   | `section.above` (16) in a sheet | Its own row's padding                          |
| Below          | 12 to the first item, 8 to a sentence (§4)                                     | `headingToControls` (8)         | 2 – 4, it belongs to the value                 |
| Dynamic type   | Scales without a ceiling; the Feed's alone stop at 130% beside the mode toggle | Without a ceiling               | Without a ceiling                              |
| Accessibility  | `accessibilityRole="header"`, label is the title as written                    | Same                            | Read as text                                   |

**Why 13pt Maroon capitals, and not something quieter still.** The judgment call in the brief was compared in context on the Feed, both profiles and the title page, at 360pt (scratchpad `type-shots/variants/`):

- **15pt caps, +0.7 (before).** The labels-laid-on-the-page problem: the loudest type on the Feed after the wordmark, louder than the post headline under it.
- **13pt caps, +0.4 – 0.5, Inter 600, Maroon (chosen).** Clearly structure, clearly bingd, and quieter than the post headlines, row titles and scores it heads. +0.5 sits between the +0.4 compared and the group label's +0.6, so the capitals keep some air without the spaced-out label look.
- **13pt caps, Inter 500.** Lighter than the Inter 600 names in the post headline beneath it, so the heading read as the weaker of the two lines rather than the quieter.
- **13pt caps in `text.secondary`.** Calm, but the page lost its one warm accent apart from the toggle, and read as a settings screen.
- **Sentence case, Inter 600 17, Ink.** Read as content: the same size and weight as a row title (`headline`), so TRENDING NOW and a title's name were one voice.
- **Sentence case, DM Serif 20.** Handsome, and the most prominent of all: serif is the title's and the wordmark's voice, and a serif heading competed with the title name under it.

So the burgundy capitals stay, with less of everything: two points smaller than the Feed and Profile's, one larger than the title page's, and tighter. They are not stripped anywhere, and sentence case was not adopted for this role.

**Why the group label stays 12.** A group sits inside something that already has a heading (a sheet's serif title, a screen's title). One step smaller says "inside", and it is the size every one of these was already drawn at, so none of them moved.

## 3. Exceptions, with reasons

- **The Feed's headings stop at 130% text** (`FEED_HEADING_MAX_SCALE`): they share a row with the 44pt mode toggle. At 13pt, LEADERBOARD at 130% now leaves 25pt spare beside it on a 320pt phone, and TRENDING NOW no longer wraps there.
- **bingd AWARDS keeps its case** (`exactCase`): the product's name is lower-case.
- **Control sheets' `Filters` / `Sort` stay `headline`.** They head a set of controls rather than a reading surface, and the Leaderboard's filter sheet and its three-way switch are preserved as they are.
- **WHERE TO WATCH, SCORES and MORE DETAILS are set by hand** in `sectionHeading`: each shares a line with something (logos, a chevron) that `SectionHeader`'s full-width row cannot hold. Same token, same colour.
- **A heading with an action keeps its 44pt row** (profiles, Settings). The row's slack under an 18pt line is 13, which stands in for both the 12 and the 8 in §4; the title page's `tight` headings carry their target in slop instead, as before.
- **Rails keep 4pt of room for a pressed poster** (`PosterShelf`, `PosterRail`, owned by the Feed polish work). Their frame is on the step; the artwork starts 4 lower.
- **The ABOUT synopsis starts 4 under its heading,** not 8: two lines of text supply the rest from their own leading (13 ink, unchanged).

## 4. Spacing rules

All values are existing `space` steps, named on `theme.layout.section`:

| Relationship                                         | Rule                                                                                                           | Token                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Major section transition (content page)              | 20 of seam + the heading's row on profiles (33 to the heading's line); 28 on the title page's reading sections | `space[5]`, `SECTION_SEAM` (`space[7]`)             |
| Heading → first item (grid, rail, card, rows)        | **12** from the heading's line                                                                                 | `section.headingToContent`                          |
| Heading → poster carousel                            | 12 to the rail's frame (+4 press room inside it)                                                               | same                                                |
| Heading → card                                       | 12; **16 on the Feed**, where it matches TRENDING NOW's row (below)                                            | same, `FEED_CARD.leading` + the heading's share     |
| Heading → supporting description                     | **8**                                                                                                          | `section.headingToText`                             |
| Heading → its own controls (chips, toggles, filters) | 8, then 12 to the content                                                                                      | `headingToControls`, `controlsToContent`            |
| Repeated groups (rows, reviews, sections)            | Rows 8 apart; reviews 16; sections one seam                                                                    | `space[2]`, `space[4]`                              |
| Bottom-sheet heading                                 | 8 above (under the handle), 12 below; groups inside it 16 above, 8 below                                       | `SheetHeader`, `section.above`, `headingToControls` |

**The Feed.** TRENDING NOW's line sits in the 44pt row it shares with the mode toggle: 13 under it to the shelf, plus the rail's 4, is 16 – 17 to the artwork's frame (21 ink). RECENT ACTIVITY's line was 8 from the first post's outline (13 ink), the card's own `leading`. Its wrapper now adds the heading's share, `space[4] − FEED_CARD.leading`, so the first post is 16 from the line (20 ink) and the two headings hold their content the same way. The card's margin stays the card's.

## 5. Before and after

Measured the same way as §1 (ink gaps, 360pt, 100% text):

| Surface                            | Heading → first item, before → after                                                                                            | Seam, before → after  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Feed: TRENDING NOW → shelf         | 21 → 21                                                                                                                         | —                     |
| Feed: RECENT ACTIVITY → first post | **13 → 20**                                                                                                                     | 20 → 20               |
| Your profile                       | 21.5 – 28.5 → **14 – 20.5** (grid 16.5, rail 20.5 with its press room, badges 14; activity rows 28.5, inside their own padding) | 16 – 48 → **37 – 41** |
| Their profile                      | 23 – 29.5 → **14 – 20.5**                                                                                                       | 17 – 49 → **37 – 41** |
| Title page                         | 11.5 (Seasons 7.5) → **15.5**                                                                                                   | 31 – 36 → 32 – 36     |
| Title page: ABOUT → synopsis       | 13 → 13                                                                                                                         | —                     |

Type: the Feed, your profile, Settings' index, My lists, Watch history and the person page go from 15 to 13; somebody else's profile and the title page go from 12 to 13. Every page-level heading in the app is now one size.

**How it was evaluated.** Real screens, not swatches: an uncommitted Expo-web harness rendering the actual screen modules with the Supabase boundary stubbed by fixture rows, shot by Playwright at 360pt and 320pt, at 100% and 130% text (tokens scaled within each token's own ceiling), the same fixtures before and after. Covered: Feed (Trending, Recent activity and a two-line ranking headline), Leaderboard, Discover People (Mutuals), your profile and somebody else's, a film and a series title page (Cinematic and original), More details, For You, Collection, the Reviews sheet, the Comments sheet and the Match explainer. Device-only: Android's font rasterisation of the 13pt capitals, the 130% ceiling on iOS Dynamic Type, and the profile headings' 44pt targets under a real thumb.
