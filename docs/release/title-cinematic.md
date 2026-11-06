# Cinematic title page — final layout and content architecture

Founder brief: "bingd. — Cinematic Title Page: Final Layout & Content Architecture"
(2026-11-06). This file records what changed, how it was checked, what was published, how to
undo it, the TMDB artwork audit, and what is left before production. The Original title page
is untouched and still the default; the Cinematic Editorial layout remains Labs-only in
Preview and locked off in production (`isTitleLayoutAvailable`).

## Where it comes from

- **Base:** `25a3250` on `refine/nav-cohesion` (code `7f535b6`, published as `d11433e`: Android
  update `01a1b282-d6cb-7999-8a6a-6d79a6a706d1`, group `9906ddd5-b789-4497-bd42-a0c28b67d8eb`,
  runtime `2503ffaa`), confirmed against `eas update:list --branch preview` before any change.
  None of it is on `main`.
- **Rollback target, recorded before any change:** group `9906ddd5`.
- **Branch:** `refine/title-cinematic` in `../worktrees/title-cinematic` (node_modules junction
  to rc-direction-a). Local only; not pushed, not merged. The only other session (app-f1) was
  idle and finished; this session was the nav cohesion publisher and is the one publisher here.

## Change ledger

| Commit | Area | What |
| --- | --- | --- |
| `add67e0` | Credits | `directors`: every credit whose job is Director; `directedBy` formatting |
| `30b74fe` | Hero | The sharp band and the overlapping Paper module; no field, fade or chevron |
| `33cad6b` | Page | One column of sections, no tabs; the director line; Details; Trailers opt-in |
| `d232884` | For You | Find for a Group / Group Recommendations; shortcuts stack below 360pt |
| `eacbe80` | Review 1 fixes | Section actions wrap at large text; the module title's 1.3× ceiling |
| `c9f3fa4` | Review 2 fixes | The group sheet scrolls its intro and rows together; the action stays in reach |
| `e12fce8` | Test only | A Feed test waits for the Laugh label, not only the card (a race seen once under load) |

### 1. The hero: sharp artwork, overlapped by the Paper module

- **Kept:** the large sharp band and its sizing rules, unchanged (16:9 of the width made a
  quarter taller, growing toward 40% of the visible height, never past 1.4× the 16:9 frame), so
  a backdrop is never stretched to portrait. The top scrim, so the back and overflow controls
  read on any art.
- **Removed:** the blurred, darkened reflection of the backdrop that filled the rest of the
  first screen, the strips that softened the band into it, the band's dark foot, the filler
  height above and below the module, and the chevron. The hero is as tall as its contents.
- **The overlap is 22% of the band's displayed height** (the brief's 20–25%), computed from the
  band rather than fixed: 62pt over a 284pt band at 360pt, 55 over 250 at 320, 71 over 324 at 412.
- **One surface.** The module is the top of the page's Paper: 12pt in from each edge, top corners
  rounded, no border, shadow or lower corners. Over the artwork its edge is the picture's;
  where the band ends, the Paper runs edge to edge and About follows on it.
- **One content line.** The module's text sits 28pt from the screen edge (12pt inset + 16pt
  padding), and so does every section below: text sections in a 12pt column, the Cast,
  Trailers and Similar rails starting on it and scrolling to the screen edge.
- **Poster-only titles** keep the sharp poster on its own soft poster ground (that is the band,
  not an extension below it); **no artwork** keeps Parchment and the initials frame.

### 2. The module: genres above the fold, a director line

- Order: **Title / Genres / Year · Certification · Runtime / Directed by … / your rank line /
  Rank · Watchlist · Add to List · Share / Your score · bingd. · Following.** Everything that
  was there is unchanged, including the one-line genre presentation and its tappable +N.
- **Directed by** is a quiet footnote in tertiary ink, films only, read from credits whose job
  is *Director* (an assistant director is not taken); every credited director, de-duplicated:
  one or two named, past two the first two and a count (*Directed by A, B and 1 more*), the
  spoken label naming everyone. Absent when there is no Director credit. Seasons and series
  draw no director line: a season's Director credit is an episode's.

### 3. Sections instead of tabs

The Similar | Trailers | Details tabs are gone from the Cinematic layout. The page is one
column: **About → Where to Watch → Episodes / Seasons (TV) → Cast → Reviews → Trailers →
Details → Similar**, each once.

- **Spacing:** 12pt above each heading, so sections sit about 24pt apart with the heading's own
  row, and each body follows its heading directly; the synopsis lost its own 16pt top padding
  under the heading. Where to Watch carries its spacing with it, so a title with no providers
  leaves no gap.
- **About, Where to Watch, Episodes/Seasons, Cast, Reviews:** the existing components and
  behaviour, unchanged (the synopsis' *more*, the compact provider row and JustWatch attribution,
  the cast rail and its full-cast sheet, the reviews preview of up to two with author, date,
  rating, spoilers, Helpful, Edit and See all).
- **Trailers:** a compact horizontal rail (184pt cards) with a play glyph, the video's name and
  where it plays; a tap opens the video on YouTube exactly as before. See the privacy note below.
- **Details:** Released, Runtime, Original language, Created by (television only) and Your rank.
  Genres and Director are no longer repeated here because the module shows them. The app holds
  no production-country, original-title or similar fields, so none are invented.
- **Similar:** the existing poster grid at the foot, on the page's content line; at most nine
  titles (the existing budget), so no paging is needed. Each tile opens its title.

### 4. Trailer thumbnails and privacy

- **The concern** (carried since post-QA sprint 2): a thumbnail is an image from YouTube's host
  `i.ytimg.com`, a request to Google carrying the reader's IP. As a tab, those requests waited
  for the reader to open Trailers.
- **What this sprint does:** the cards draw without thumbnails, and the section's heading offers
  **Show previews** ("Show trailer previews. Loads images from YouTube."). Only that tap loads
  them, once per page. That is the same user-initiated request the tab made, not an earlier or
  broader one. Opening a video is unchanged.
- **Measured** in the real-app render with every host but TMDB blocked and logged: **0**
  `i.ytimg.com` requests on opening the page and after scrolling the whole page; **3** after
  Show previews, for the three videos. Pinned by a test that fails if a `ytimg` source is drawn
  before the tap.
- **Not resolved:** whether loading thumbnails on request needs a line in the privacy inventory.
  It is no worse than before; it is still the inventory item it was.

### 5. Find for a Group

- The For You shortcut reads **Find for a Group**; its sheet is headed **Group Recommendations**
  with "Choose who's watching, and get recommendations based on everyone's tastes." The member
  picker, limits, eligibility, algorithm, results, endpoints and `group_picks` analytics names
  are unchanged.
- **Fit:** "Find for a Group" needs about 125pt and half of a 320pt phone leaves about 108, so on a
  phone narrower than 360pt (and at large text) the two shortcuts stack; at 360pt and wider they
  share the row, with Android's shrink-to-fit as a safety margin. No abbreviation, no clipping.

## Deviations from the brief

- **Analytics:** `similar_tab_opened` is no longer sent from the Cinematic layout, which has no
  Similar tab to open; it was only ever sent on a switch *to* Similar, which was already the
  default tab. `similar_title_opened` on a tile tap is unchanged. The Original layout is
  unchanged.
- **Trailers** show thumbnails only after Show previews (section 4), as the brief's privacy rule
  requires.
- **Where to Watch** gained an optional outer `style`; **CastStrip**, **PosterGrid** and
  **TrailerRail** gained an optional `gutter`; **Synopsis** gained `flush`. All are additive:
  without them each renders exactly as before.

## Verification

- **Typecheck:** clean. **Lint:** 0 errors, 81 warnings (the same as the base).
- **Jest:** 286/286 suites, 5,478 passed, 1 skipped at `e12fce8` (the same env-gated skip;
  the base ran 285 suites, 5,472).
- **New and updated tests:** the hero (only the sharp band, drawn once and unblurred; the 22%
  overlap at three band heights; the 12pt inset and content line; Paper with no border or
  shadow; poster-only and no-artwork bands); the page (as tall as its contents, no chevron;
  the section order with no tabs; the director line, its absence without a Director credit,
  and Details without Genres or Director; trailer cards with no `ytimg` source until Show
  previews, and a card opening YouTube before previews; a wrapping action and the title's
  ceiling); `directedBy`; Find for a Group and Group Recommendations; the shortcuts stacking
  on a 320pt phone.
- **Real-app renders** (react-native-web against the local mock; 320×640, 360×780, 412×915;
  200% text through a render-only patch): the opening screen for a ranked dark backdrop, a
  title with three directors, a long-titled poster-only title with six genres and two
  directors, a bright unranked backdrop, a long title with no artwork and no director, and a TV
  season; every section by scrolling; the top bar over bright and dark artwork; the Original
  page's tabs; the reviews sheet opening and closing; For You at 320pt; the Trailers header at
  200%. Third-party requests were counted by blocking every host but TMDB images.
- **Not seen on a device:** web ignores `adjustsFontSizeToFit`, and the render's text-scale
  shim applies a token's cap but not a `maxFontSizeMultiplier` prop, so at 200% it draws the
  module title at 2× where the app caps it at 1.3× (the app's `Text` spreads the prop after the
  token's cap; pinned by a test). iOS was not checked.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout gives `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` at `eacbe80` and again
  at `ebf1fa3`: the installed Preview APK's runtime. Only `app/` and `src/` changed: no
  migration, native, config or server change.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, three passes. Reports are in
`.agent-workflow/codex-reviews/title-review{1,2,3}.md` (gitignored).

1. **`25a3250..d232884` — needs attention, one MEDIUM, fixed in `eacbe80`.** At 200% text on a
   320pt phone, TRAILERS and Show previews needed about 308pt of the 264 available, so the
   opt-in action ran off the screen. The Cinematic section headers now let an action drop
   under its heading (`SectionHeader wrap`, opt-in); rendered at 200% it sits at 28–214pt.
   The same pass found, in the render, the module title breaking mid-word at 2×; it now grows
   only to 1.3×, and the director line may take two lines.
2. **Whole branch at `eacbe80` — needs attention, one MEDIUM, fixed in `c9f3fa4`.** On a
   320×568 phone at 200% text the group sheet's longer heading and sentence crowded the bounded
   list of people to nothing and pushed Get picks out of the sheet. The intro and the rows now
   scroll together in one scroller (`PeoplePicker inline`, no nesting) and give way first; the
   action stays below them. Rendered at 320×568 and 200%: the scroll area 73–492, the action
   504–552. The heading grows only to 1.5×.
3. **Whole branch at `c9f3fa4` — approve, no material findings,** including the choosing-step fix.

No HIGH or CRITICAL finding was raised at any pass. Codex's own Jest run is blocked by its
read-only sandbox; the suite above is the implementer's.

## Android Preview

**Live on 2026-11-06**, published by this session as the one publisher from the real-`npm ci`
checkout `../worktrees/visual2-preview-publish` (left detached at `ebf1fa3`), after a
fingerprint check at that commit and a `BINGD_RELEASE_DRY_RUN=1` dry run. Verified with
`eas update:list --branch preview`; no iOS group was published.

| | |
| --- | --- |
| Channel / branch | `preview` |
| Platform | Android only |
| Update group | `8c8dfb90-7fd8-4e32-9cd5-3c613c66f498` |
| Android update | `01a1b2d9-e941-70a6-9953-d50758c19537` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (the installed Preview APK's) |
| Source commit | `ebf1fa3` (code `e12fce8` plus this record) |
| Rollback group | `9906ddd5-b789-4497-bd42-a0c28b67d8eb` (nav cohesion, `d11433e`), still listed |
| Dashboard | https://expo.dev/accounts/fourward/projects/bingd/updates/8c8dfb90-7fd8-4e32-9cd5-3c613c66f498 |

## Rollback

Nothing here writes server state, so nothing needs a data rollback.

1. **The whole sprint, on every Preview phone:** republish the nav cohesion group.

   ```sh
   npx eas update:republish --group 9906ddd5-b789-4497-bd42-a0c28b67d8eb --message "rollback: before the cinematic title page"
   ```

   Phones take it at their next launch, back on `d11433e`. Earlier groups (`d27b8144`,
   `2724ce75`) are still listed too.
2. **One area, keeping the rest:** revert its commit from the ledger and publish again.
3. **The Original title page** is still a Labs choice on any Preview phone: Settings → Labs.

## TMDB alternate-artwork audit (read-only)

Read-only: TMDB's public developer docs and website image pages, no API key, nothing touching
the app. The app's `tmdb-adapter` requests details with `credits,videos,release_dates` (or
`content_ratings`) and **never `/images`**; the client never talks to TMDB.

| Title | Backdrops | untagged | Posters | untagged |
| --- | --- | --- | --- | --- |
| Pandorum (2009) | 26 | 21 | 68 | 7 |
| In the Blood (2014) | 8 | 3 | 20 | 2 |
| The Dark Knight | 144 | 102 | 291 | 25 |
| Oppenheimer | 136 | 102 | 223 | 5 |
| Barbie | 122 | 89 | 254 | 12 |
| Dune: Part Two | 179 | 128 | 479 | 41 |
| Coherence | 33 | 25 | 52 | 7 |
| Primer | 29 | 25 | 27 | 2 |
| The Vast of Night | 15 | 13 | 20 | 1 |
| Casablanca | 72 | 61 | 157 | 9 |
| Seven Samurai | 81 | 65 | 236 | 13 |
| Spirited Away | 129 | 108 | 253 | 9 |
| Klaus | 52 | 44 | 72 | 4 |
| Severance (series) | 122 | 46 | 177 | 9 |
| Severance S1 (season: posters only) | — | — | 77 | 5 |
| The Bear (series) | 183 | 121 | 126 | 22 |
| In the Blood (1989, obscure) | 0 | 0 | 1 | 1 |

"untagged" is TMDB's *No Language* (`iso_639_1 = null`); counts are the public site's on
2026-11-06 and will drift.

- **How often a portrait, textless alternative exists:** a 2:3 poster tagged No Language
  existed for every sampled entry, but as 2–17% of a title's posters, and only one for the
  obscure title and The Vast of Night; the long tail will have more zeros. **No portrait
  backdrops exist**: TMDB's backdrop rules require 16:9 and exclude vertical images. The
  portrait candidate is therefore always a *poster*.
- **How reliably it can be identified:** not reliably. TMDB has no textless flag. Its poster
  guidance reserves No Language for textless key art, but newly uploaded images default to No
  Language, so mis-tagging is likeliest exactly on thinly moderated titles, where a better
  image would matter most. Language metadata is a hint, not proof (the brief's own caution);
  only a human look or an image classifier could confirm it.
- **What selection would need:** server work. `append_to_response=images` (with
  `include_image_language=null`) on the details request the adapter already makes, a choice
  rule (untagged, ~0.667 aspect ratio, width ≥ 1000, by vote average then count, low-confidence
  below a vote threshold), a new cached field per title with a refresh, and series-level
  images for seasons (a season has posters only).
- **Fallback:** textless poster → the current 16:9 backdrop → the current poster.
- **Recommendation:** **not now.** The gain is real but narrow: well-known films already have
  strong 16:9 backdrops, which this layout now shows sharp and large, while the titles that
  would benefit most are the ones whose tags are least trustworthy, so a wrong choice would
  put a poster with its title baked in under a module that prints the title again. If it is
  revisited, make it an opt-in per-title override curated by a person (or a small,
  hand-checked set), not an automatic rule, and leave the Cinematic layout as it is.

## Phone QA checklist

Android Preview, after the update has downloaded (relaunch once), with the Cinematic layout
on (Settings → Labs).

1. **Big backdrop** (a Pandorum-like title): sharp artwork, the module rising over its foot,
   no blur below; faces in the upper part still visible. Scroll: About follows with no gap.
2. **Bright artwork** (an In the Blood-like title): back and ⋯ readable at the top; the bar
   turns solid before the module's controls reach it.
3. **Ranked title** (One Night in Bangkok-like): Edit ranking, your score, genres above the
   fold, *Directed by …* under the year line.
4. **Very long title, poster-only title, no artwork, TV season:** nothing clipped; no director
   line on the season; Episodes appear after Where to Watch.
5. **Sections:** About → Where to Watch → Cast → Reviews → Trailers → Details → Similar, no
   tabs. Expand About; open the cast sheet and the reviews sheet and close both; spoilers stay
   masked.
6. **Trailers:** cards with a play glyph; tap one to open YouTube. Tap Show previews: thumbnails
   appear. A title with no trailers has no Trailers section.
7. **Details:** no Genres or Director repeated; Created by on a series or season where TMDB has it.
8. **For You → Find for a Group:** the sheet says Group Recommendations and the new sentence. On
   a narrow phone the two shortcuts stack, nothing clipped.
9. **Large text:** the module grows, nothing clips, the shortcuts stack.
10. **Original page:** Settings → Labs → Original: the old page with its tabs, as before.

## Production

Nothing here reaches production. Blockers carried forward: founder phone QA of this Preview
and an explicit production decision to switch the Cinematic layout on (it stays off in the
production lane by code); the whole Preview lineage (`85a8a03` → … → `d11433e` → this) is not
on `main`; production runs Android `ec79e181` / iOS `8ea562b7`, so the merged `main` must pass
the cloud workflow's fingerprint gate; the trailer-thumbnail privacy inventory item (no worse
here); and the open items in earlier records (the default-date race, the security record's
M-5, M-6 and the M-3 residual).
