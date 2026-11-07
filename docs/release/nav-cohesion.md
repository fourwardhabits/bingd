# UI cohesion sprint — Feed, Leaderboard, For You and navigation

Founder brief: "bingd. — UI Cohesion Sprint: Feed, Leaderboard, For You & Navigation"
(2026-11-06), plus the same day's addendum on the Notification Settings switches. This file
records what changed, how it was checked, what was published, how to undo it, and the Phase B
plan. Phase A only: nothing in Phase B is implemented.

## Where it comes from

- **Base:** `b6b9193` on `fix/qa-corrections`, the QA corrections record head. Its code is
  `918f925`, published as `147b55c` (Android update `01a1b136-1bec-7519-8865-3e6b3d2df030`,
  group `d27b8144-cfad-49d4-ad98-d527cfd6104a`, runtime `2503ffaa`), confirmed against
  `eas update:list --branch preview` before any change. None of it is on `main`.
- **Rollback target, recorded before any change:** group `d27b8144`.
- **Branch:** `refine/nav-cohesion` in `../worktrees/nav-cohesion` (node_modules junction to
  rc-direction-a). Local only; not pushed, not merged. One other session (app-f1) was open and
  confirmed it was finished and not publishing.

## Change ledger

| Commit | Area | What |
| --- | --- | --- |
| `c6355ae` | Header | Movies \| TV on the logo's centre line; chosen word Maroon on Parchment |
| `e763a28` | Shared UI | MediumSelector `heading`/`filter` sizes with a small anchored menu; SegmentedTabs `dense`; SectionHeader `fit` |
| `3bd4a65` | Feed / Leaderboard | LEADERBOARD heading, four equal categories, time range as a filter; ACTIVITY heading removed |
| `cd8d8e8` | For You | Watch Together; Filters beside the heading; Sent to You and Watch Together as a pair |
| `73dbfc3` | People / Search | Empty state with Find people → Search on Users |
| `422759a` | Reactions | Liked / Agree / Disagree / Laugh / Wow / Sad; ❤️ Liked, not a filled heart |
| `65b0b2a` | Settings | Notification switches: Parchment thumb on Maroon (ON), grey on grey (OFF) |
| `7f535b6` | Review 1 fixes | A repeated Search param; the menu kept inside the window |

### 1. Header: Movies | TV

- **Measured, not guessed.** In the real app render the switch's outline was centred at y 25 in
  the 54pt header while the logo's mark was centred at 27 (the lockup carries a 4pt top margin,
  half of which a centred row gives back). So the switch sat about 2pt *high* of the mark.
- **The "low" impression on Android** is most likely the label inside the pill: `Text` never
  disables Android's font padding, so Inter sits about a point low in a 28pt fill.
- **Fix:** the header's `right` slot (Collection and For You only) is translated down by half
  the lockup's margin (2pt): the outline is now centred at 27, on the mark. A transform, so the
  header height (54pt), the 44pt targets and the bell and gear are unchanged. The label drops
  Android's font padding (`includeFontPadding: false`, `textAlignVertical: 'center'`).
- **Selected state:** Parchment fill with a **Maroon** word (was Ink), the treatment
  Collection's Watched | Watchlist and the Leaderboard categories use. Not the Feed toggle's
  solid Maroon fill, which would out-shout the logo. Same size and outline.

### 2. Feed

- **ACTIVITY removed.** No visible heading and no rule. A 12pt spacer plus the first card's own
  28pt is the transition (about 48pt from the rail's artwork to the first avatar, against
  ~43pt between posts). The spacer is still a heading to a screen reader ("Activity"). No
  divider, card or other heading added; cards, scores, imagery and scrolling untouched.

### 3. Leaderboard

- **Heading:** LEADERBOARD at 15pt in the content header, like TRENDING NOW; it shrinks onto one
  line at a large text size rather than running under the toggle.
- **Categories:** All | Movies | TV | Reviews as one segmented control of four equal 44pt
  segments (Collection's control, dense: 14pt). Spoken as All Titles, Movies, TV Shows,
  Reviews. Measured 71pt each at 320pt, 81 at 360, 94 at 412; nothing scrolls or clips.
- **Time range:** This month / All time as a compact text-and-chevron filter under the
  categories (Inter 14pt, secondary ink), opening a small two-line menu under itself rather
  than a bottom sheet. Same remembered preference, same values, same queries.
- **Checked:** five rows, one account (the viewer at #1), empty, long display names and handles
  (the name ellipsizes, the handle gives way first, the count never moves), the viewer's own
  row. Nothing about ranking, queries or analytics changed; a re-tap of the current category
  is still not reported as a change.

### 4. For You

- **Two rows of controls, each saying what it is:**
  1. Recommended / Top Rated at Inter 17pt (was a 22pt serif dropdown), opening a small menu;
     **Filters** opposite it as a quiet text action (secondary ink, no outline), with an
     icon-only Clear all when filters are on.
  2. **Sent to You** and **Watch Together** as two equal shortcuts: Maroon icon and word on a
     feature hairline, no fill; Sent to You's unread count is a badge drawn like the bell's,
     and its on state is Parchment with a Maroon outline. Both absent on Top Rated, as before.
     At a large text size they stack.
- **Watch Together** replaces Group Picks on screen: the shortcut, the sheet's title and
  accessibility label, and the founder's sentence, "Choose who's watching, and find something
  everyone can enjoy." Endpoints, the `group_picks` analytics names and the selected-person
  rules are unchanged.
- Recommendation wall, bookmark, dismiss, generation, scoring, exposure, paging, impression
  tracking and pull to refresh are untouched. No Grid/List toggle.

### 5. People You May Know

- **Empty state:** "No suggestions yet" / "Find people to follow and discover more shared
  tastes." and a compact **Find people** button, near the top instead of a screen-high block.
- **Route:** the app's existing member search, Search's Users list. `memberSearch()` opens
  `/(tabs)/log` with `show: 'users'`; Search applies and clears it (as Collection does
  `show: 'unranked'`) and, before anything is typed, says "Find people — Search by name or
  @username." instead of the title prompt.
- Populated rows, Follow, taste match and eligibility unchanged.

### 6. Reactions

- Labels: ❤️ **Liked**, 👍 Agree, 👎 Disagree, 😂 Laugh, 😮 Wow, 😢 **Sad** (was Love and Moved),
  in the picker, on the card's action, in the reactor list and to a screen reader.
- A Like is drawn ❤️ **Liked** like every other selected state; the filled Maroon heart is gone.
  Unreacted is still the outline heart and "Like".
- Stored kinds (`love`, `moved`, …), `set_reaction`, toggle, long press, counts and notification
  delivery are unchanged. Ordinary and grouped activity share the same control.

### 7. Notification Settings switches (addendum)

- **Where the green came from:** the switches set `trackColor` but no `thumbColor`, so Android
  painted the ON thumb in the AppCompat theme's default accent, Material teal `#009688`. The
  web render shows the same default (`activeThumbColor`), which confirms the source.
- **Fix, Notification Settings only:** `thumbColor = value ? semantic.actionText (Parchment) :
  text.tertiary (grey)`. ON: Parchment on Maroon, about 7.4:1. OFF: grey `#6E6862` on the
  existing grey track, about 3.3:1 against it and 5.6:1 against the card. No new colours.
- **Not changed:** the Privacy switch and the two Lists sheets have the same default; they were
  left alone as unrelated controls. Recommended as a one-line follow-up.

## Deviations from the brief

- **Search gained a route param and an idle prompt.** "Find people" needs a real destination,
  and Search with an empty query showed only the title prompt, which read as the wrong place.
  No new feature; the Users list already existed.
- **People's heading stays 12pt** while TRENDING NOW and LEADERBOARD are 15pt: at 15pt
  PEOPLE YOU MAY KNOW does not fit beside the toggle on a 320pt phone.
- **The For You Recommended / Top Rated control opens a small menu** rather than the bottom
  sheet, for the same reason as the time range. Same two options, same behaviour.

## Verification

- **Typecheck:** clean. **Lint:** 0 errors, 81 warnings (the same as the base).
- **Jest:** 285/285 suites, 5,472 passed, 1 skipped at `7f535b6` (the same env-gated skip;
  the base ran 282 suites, 5,437).
- **New and updated tests:** the six selected reaction states through the real Feed;
  `ForYouShortcuts` (halves, stacking at 1.3×, badge, toggle state); For You's two rows, 44pt
  targets and the seam; Watch Together naming and copy; the Leaderboard's four segments, spoken
  names, Maroon-on-Parchment, the time menu and no-op re-choices; LEADERBOARD's fit and the
  absent ACTIVITY; People's Find people → `memberSearch()`; Search arriving on Users; the
  header offset; CompactSwitch's selected colours; the switch thumb colours.
- **Real-app renders** (react-native-web against the local mock; 320×640, 360×780, 412×915;
  200% text through a render-only patch): header geometry before and after, Feed boundary,
  Leaderboard (five, one, empty, long names; the time menu), People empty and populated, Find
  people landing, For You Movies and TV, Top Rated, Watch Together, Sent to You, the menus.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout at `65b0b2a` and again at the record head: `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543`, the installed
  Preview APK's. Only `app/` and `src/` changed (39 files): no migration, native, config or
  server change.
- **Not seen on a device:** web ignores `adjustsFontSizeToFit` and `thumbColor`'s ON state, and
  reports a font scale of 1; those are checked by measurement and tests and are on the phone
  checklist. iOS was not checked.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, two passes. Reports are in
`.agent-workflow/codex-reviews/nav-cohesion-review{1,2}.md` (gitignored).

1. **`b6b9193..65b0b2a` — needs attention, two MEDIUM, both fixed in `7f535b6`.**
   - A repeated `show` param (`?show=users&show=users`) arrives as a new array each render,
     so Search's render-time comparison looped ("Too many re-renders"). It compares one string
     now; a regression test fails without the fix.
   - The anchored menu always opened below its control and clamped only sideways, so in a short
     window an option could sit off-screen. It now flips above, or pins to the foot and scrolls,
     capped by the safe area, and closes if the window changes size while open. Placement unit
     tests and a resize test (which fails without the fix).
2. **Whole branch at `7f535b6` — approve, no material findings,** including the review 1 fixes.

No HIGH or CRITICAL finding was raised at either pass. Codex's own Jest run is limited by its
read-only sandbox; the full suite above is the implementer's.

## Android Preview

**Live on 2026-11-06**, published by this session as the one publisher from the real-`npm ci`
checkout `../worktrees/visual2-preview-publish` (left detached at `d11433e`), after a fingerprint
check at that commit and a `BINGD_RELEASE_DRY_RUN=1` dry run. Verified with
`eas update:list --branch preview`; no iOS group was published.

| | |
| --- | --- |
| Channel / branch | `preview` |
| Platform | Android only |
| Update group | `9906ddd5-b789-4497-bd42-a0c28b67d8eb` |
| Android update | `01a1b282-d6cb-7999-8a6a-6d79a6a706d1` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (the installed Preview APK's) |
| Source commit | `d11433e` (code `7f535b6` plus this record) |
| Rollback group | `d27b8144-cfad-49d4-ad98-d527cfd6104a` (QA corrections, `147b55c`), still listed |
| Dashboard | https://expo.dev/accounts/fourward/projects/bingd/updates/9906ddd5-b789-4497-bd42-a0c28b67d8eb |

## Rollback

Nothing here writes server state, so nothing needs a data rollback.

1. **The whole sprint, on every Preview phone:** republish the QA corrections group.

   ```sh
   npx eas update:republish --group d27b8144-cfad-49d4-ad98-d527cfd6104a --message "rollback: before the nav cohesion sprint"
   ```

   Phones take it at their next launch, back on `147b55c`. Earlier groups (`2724ce75`,
   `1f99a23b`, `8272a1af`) are still listed too.
2. **One area, keeping the rest:** revert its commit from the ledger above and publish again.

**Limits:** an OTA applies at the next launch; republishing works only onto runtime
`2503ffaa`; there is no iOS Preview binary on this runtime.

## Phone QA checklist

Android Preview, after the update has downloaded (relaunch once).

1. **Header.** Collection and For You: Movies | TV sits level with the logo, the chosen word
   Maroon on Parchment. Feed keeps the bell; Search and Profile look as before.
2. **Feed.** TRENDING NOW, the rail, then the first post after a short gap: no ACTIVITY, no rule.
3. **Leaderboard.** Trophy: LEADERBOARD; All | Movies | TV | Reviews all visible, no scrolling;
   tap each. This month ⌄ opens a small menu; All time re-reads the board and is remembered next
   visit.
4. **People.** With suggestions, rows and Follow as before. With none: Find people opens Search
   on Users ("Find people"); type a name and only members appear.
5. **For You.** Recommended ⌄ / Filters on one row; Sent to You and Watch Together under it.
   Sent to You toggles the sent list (badge when unread); Watch Together opens the sheet with the
   new title and sentence. Top Rated: no shortcuts, Filters stays. Movies and TV.
6. **Reactions.** Tap Like: ❤️ Liked. Long-press and pick each: 👍 Agree, 👎 Disagree,
   😂 Laugh, 😮 Wow, 😢 Sad; tap again to remove. Try a grouped ranking post and the activity
   page. Open "N reactions": the tabs say Liked, Sad.
7. **Notification Settings.** ON switches: Parchment thumb on Maroon, no green. OFF: grey on
   grey. Toggle one and back.
8. **Large text** (Settings → Display → Font size, largest): the four categories fit (they may
   shrink), LEADERBOARD stays on one line, For You's two features stack, Filters drops under
   Recommended.

## Phase B plan (not implemented)

From a read-only audit of the current code. Nothing below is built.

**A. My Lists redesign.** `MyLists` (`src/features/lists/MyLists.tsx`) reads `useMyLists`, an
infinite query over the owner-only RPC `my_lists` (30 a page, keyset on `updated_at`). It
already returns count, privacy, hidden and updated date, plus `posters`: the first four poster
paths, with no media ids or titles, so it cannot drive a tappable rail.
- **Simplest safe path (recommended):** a migration adding `my_lists_preview` (or a
  drop-and-recreate of `my_lists`, as `20261017000100` did) that returns a `preview` of the
  first ~10 items per list as `{media_item_id, title, poster_path, kind}`: one request per page
  of lists, owner-only, so private and link lists preview safely. The row reuses `PosterShelf`
  (`src/ui/components/PosterWall.tsx`: a horizontal rail with a header "All" action and
  per-tile taps) and `Poster`'s missing-art fallback. New List, editing, item ordering,
  privacy and sharing stay on the existing screens.
- **Client-only alternative:** one `list_items_page(p_limit ≈ 10)` per visible list. It works
  today, but it is N+1 requests per page of lists.
- **Limits:** a schema change (migration plus staging), so not an OTA-only change. There is no
  manual ordering of *lists* today (they sort by last update), only of items within one.

**B. Grouped Watchlist activity.** Watchlist adds already post `watchlist_added` feed events, one
per actor and title (`feed_events_watchlist_once`). Reactions and comments are keyed by event id,
so "one shared conversation" requires **one server event per group**: grouping adjacent rows on
the client would split pages and leave each title's reactions on its own event. Not recommended.
- **Server path:** a `watchlist_batch` type plus a membership table with a surrogate key (the
  PGRST201 lesson of `20261022000100`); `set_watchlist` coalescing into the actor's open batch
  inside a window from `app_config`, as `follow_added` does; a reader
  `watchlist_batch_titles(event)` gated on `can_view_profile`.
- **Client:** a poster rail in `FeedCard` (which today renders `tailAction` only without a
  `tail`), capped at ~10 with "and N more" opening a sheet. Written reviews stay ungrouped.
- **Decisions needed first:** backfill of existing singles, the uniqueness index, whether a
  growing batch keeps its `causal_at`, and what removal does to a batch.

**C. Recommendation QA.** The For You wall is `PosterGrid` (`PosterWall.tsx`). Its tiles draw
artwork, the bookmark and the dismiss X only: no title text, rationale or source (`headlineFor`
in `rank.ts` exists and is tested but is not drawn). Generation is client-side
(`use-for-you.ts` → `scoreSlate` → `drawSlate`). There is no runtime fixture or demo mode;
`src/test-utils` fixtures are test-only, and Diagnostics is a read-only report.
- **Safe QA fixture:** a non-release-gated static list of `PosterTile`s rendered through the
  same `PosterGrid` from a dev route or Diagnostics, with local no-op save and dismiss: varied
  genres, saved and unsaved, null artwork, long titles. It needs no server and touches no
  preference data. Until then, the render harness used for this sprint (local mock,
  `scenario: 'foryou'`) is the populated state for design review.
- **Assessment:** the wall needs no material UI change for what it shows today. The one real gap
  is that a tile cannot say *why* it is there; showing rationale or source variety is a product
  decision (a caption from `headlineFor`, say) that would come before any fixture can QA it.

## Production

Nothing here reaches production. Blockers carried forward: founder phone QA of this Preview;
the whole Preview lineage (`85a8a03` → `0681248` → `ed8d410` → `147b55c` → this) is not on
`main`; production runs Android `ec79e181` / iOS `8ea562b7`, so the merged `main` must pass the
cloud workflow's fingerprint gate; and the open items in `ui-cohesion-pass.md` and
`qa-corrections.md` (trailer thumbnails `i.ytimg.com`, the default-date race, the security
record's M-5, M-6 and the M-3 residual, the 200%-text unranked card on 320pt). This sprint adds
no new blocker: it is presentation-only and changes no data, server or native code.
