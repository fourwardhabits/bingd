# Marquee cohesion sprint — Collection, For You, Feed, Leaderboard and secondary screens

Founder brief: "bingd. — UI Cohesion Sprint: Marquee Navigation, Feed, Profile & Secondary
Screens" (2026-11-07), from Android phone QA of the final title refinement Preview. Client-side
UI only: no backend, schema, native, configuration or production change. This file records what
changed, how it was checked, what was published, how to undo it, the research the brief asked
for, and what is left before production.

## Where it comes from

- **Base:** `a37e8f1` on `refine/title-final` (published as `1996619`: Android update
  `01a1b34f-25a8-79b3-8adc-08549f9230ae`, group `29b60018-595c-4862-88c7-5d6c551f2a25`, runtime
  `2503ffaa`), confirmed as the newest Preview with `eas update:list --branch preview` before
  any change. None of it is on `main`.
- **Rollback target, recorded before any change:** group `29b60018`.
- **Branch:** `refine/marquee-cohesion` in `../worktrees/marquee-cohesion` (node_modules junction
  to rc-direction-a). Local only; not pushed, not merged. The only other session (app-f1) was
  idle for a day; this session is the one publisher.

## Phase A — navigation and Feed cohesion

| Commit | Area | What |
| --- | --- | --- |
| `8dc5a02` | Shared | `MediumSelector size="marquee"`, `ContentToolbar`, `FiltersAction`, `PosterGridList header` |
| `e756569` | Collection | Watched ▾ marquee; one toolbar with Filters and Grid / List; it scrolls with the titles |
| `ced10c3` | For You | The same toolbar; quieter Sent to You and Find for a Group; scrolls with the wall |
| `8c597fd` | Feed | One rule and RECENT ACTIVITY after Trending; PEOPLE YOU MAY KNOW at 15pt |
| `78a07a9` | Leaderboard | Gold, silver and bronze medals; ties in a fixed order; the time filter closer |
| `0f3508b` | Title page | 28pt between sections; YouTube's placeholder image kept out of the frame |
| `5d815e7` | Review 1 fixes | Stills decoded at their own size; a long pinned rank widens its column |
| `1ee5646` | Review 2 fix | The toolbar's tools wrap among themselves at the largest text sizes |

### Two kinds of heading

- **Marquee titles** — Watched, Watchlist, Unranked, Recommended, Top Rated — are
  `MediumSelector size="marquee"`: Maroon DM Serif Display at 21pt under 360pt, 22pt on a
  standard phone and 23pt from 412pt, with a Maroon chevron, as one 44pt control. It opens the
  small anchored menu For You already used; the one showing is marked (Parchment and a check),
  in the menu's ordinary type. The title wraps rather than truncating.
- **Section labels** — TRENDING NOW, RECENT ACTIVITY, LEADERBOARD, PEOPLE YOU MAY KNOW — are
  the existing 15pt uppercase Maroon Inter Semibold token (`SectionHeader size="large"`).

### Collection

- The full-width Watched | Watchlist | Unranked control is gone. **Watched ▾** is the left of a
  toolbar (`ContentToolbar`) with **Filters** and the Grid / List glyphs opposite. Unranked is
  offered only while this side has an unranked title, exactly as before, with the same fallback
  to Watched, the same persistence of medium, view mode, filters and sort, and the same re-tap
  of the tab returning to Watched.
- **Filters** is For You's compact action (`FiltersAction`): the glyph and the word, Maroon with
  a count when filters are on (`Filters · 2`) and a selected state for a screen reader. It opens
  the same sheet as Filter & Sort did, sort first. `Rating ↓` is no longer printed beside it; the
  sheet marks the sort in force and the spoken label says it ("Sorted by Rating, highest
  first"). Shuffle's reshuffle glyph still appears beside it while Shuffle is the sort.
- **It scrolls.** The toolbar, the unranked or refine card and the count row (`25 titles` with
  `My lists ›`) are the head of the list now (FlashList's header, and `PosterGridList`'s new
  full-width header), so the posters get the screen back. The app header and the tab bar stay
  put. While a section loads, fails or is empty the toolbar and its card are drawn above the
  state, so Watchlist is always one tap away.
- On a 320pt phone at the default text size the marquee and every tool share one line; at a
  large text size the tools wrap onto their own line, on the right, and the marquee is never
  cut short.

### For You

- **Recommended ▾ / Top Rated ▾** at the same marquee size, in the same toolbar, with Filters
  and Clear opposite. The medium stays the header's Movies | TV switch.
- **Sent to You and Find for a Group** are kept and made quieter: 34pt drawn (44pt to press), a
  hairline outline instead of the Maroon one, a 16pt glyph that keeps the Maroon, and a 13pt
  medium label in ink. They stack below 340pt or at a large text size, as before. The selected
  Sent to You keeps its Parchment and Maroon outline.
- The toolbar, the request alert and the features are the first thing in the wall's scroller
  and Sent to You's, so they scroll away with the posters; a loading, failed or empty wall
  draws them above it. No Grid / List here, as the brief said.

### Feed, Leaderboard and People

- **RECENT ACTIVITY** after Trending Now: the Feed's own post separator (full-width hairline),
  16pt either side of it, the 15pt label, and the first post 12pt under it (`FeedCard
  leading`; later posts keep their 28pt). The rule is drawn only under a shelf. Score badges,
  reactions, comments, Save, sharing, grouping and data fetching are unchanged, and the
  latest-comment line stays removed.
- **Leaderboard medals:** ranks 1, 2 and 3 are the number inside a 3pt ring of gold, silver or
  bronze — the award tiers' metals (`tier`), which the design system keeps off text and from
  behind it, so the number stays Ink on the row's ground. Fourth onward is the plain number.
  The trophy beside first place is gone, so nothing is said twice.
- **Ties:** the server already computes competition ranking (`rank() over (order by count
  desc)` in `leaderboard`, 20260902000100): equal totals share a rank and the next skips — 1,
  2, 2, 4. Its page is ordered by count, handle, id, but the final select has no `ORDER BY` of
  its own after the lateral join, so arrival order is not promised. The client now restates
  that order (`orderBoard`: rank, then handle, then id) so tied people never swap between
  refreshes. No rank is changed and no tie is broken; tied medal positions share the medal (two
  silvers, then 4th with no bronze).
- **Time filter:** still the This month / All time dropdown, directly under the four category
  segments with no gap of its own (it was 4pt lower).
- **PEOPLE YOU MAY KNOW** moved from 12pt to the 15pt label, fitted to its line beside the
  mode toggle (the LEADERBOARD rule). Its empty state and Find people are unchanged.

### Cinematic title page

- Sections are 28pt apart (20pt before); heading-to-body gaps are unchanged (ABOUT 4pt, others
  8pt). The hero, module, overlap, card, order, Similar and More details are unchanged.
- **Trailer thumbnails, audited:**
  - Before Show previews: 0 requests to `i.ytimg.com`, on opening and on scrolling the whole
    page (counted in the render). The dark Ink frames are that state by design.
  - After Show previews, against the **real** YouTube host: one request per trailer. Two real
    stills (480 wide) drew. The third key in the test data is a removed video: YouTube answers
    it **404 with a grey 120×90 placeholder image**, which the browser decoded and drew as a
    grey YouTube logo in the frame. Fixed: a still whose decoded width is 200 or less is
    treated as missing and the card keeps its Ink frame (`onLoad`), with downscaling off so
    the width is YouTube's (review 1). `onError` still covers a still that fails outright.
  - The opt-in is per title page, as before: a new title page starts without previews. That is
    the likeliest reason the founder keeps seeing dark frames — each page asks again. Keeping
    the choice across pages would mean requests on opening a title, which the brief rules out;
    it is a founder decision (below).
  - Some stills carry black bars of their own (a letterboxed trailer inside YouTube's 4:3
    still); that is the image, not a fault.

## Verification

- **Typecheck:** clean. **Lint:** 0 errors (39 warnings over `app` and `src`, none new).
- **Jest:** 286/286 suites, 5,492 passed, 1 skipped at `1ee5646` (the base: 5,490).
  An earlier full run at `5d815e7` timed out six suites while the fingerprint and a review ran
  beside it; all six passed alone, and the clean run above was afterwards.
- **New and updated tests:**
  - The marquee: Maroon DM Serif at 21–23pt, a 44pt control, a menu with the section showing
    selected, two sections where nothing is unranked, no segmented control left.
  - The toolbar: the marquee, one Filters action and the view glyphs; the sort spoken rather
    than printed; Filters' count, colour and selected state; the tools wrapping (and capped at
    the row) rather than the title; marquee, cards, then count; the marquee and cards above an
    empty collection.
  - For You's quieter features (hairline, 34pt, 13pt ink) and the 12pt seam to the wall.
  - Feed: RECENT ACTIVITY at 15pt as a header, the rule only under a shelf, the first post at
    12pt and later ones at 28pt; PEOPLE YOU MAY KNOW at 15pt, fitted.
  - Leaderboard: gold, silver and bronze rings with the number in Ink; ties sharing a medal (1,
    2, 2, 4); one rank column; a four-digit pinned standing; `orderBoard` by rank, handle, id
    whatever the arrival order, never changing a rank.
  - Title page: 28pt sections; a 120-wide still treated as missing; stills decoded at their
    own size.
- **Real-app renders** (react-native-web against the local mock; 320, 360 and 412pt; 200% and
  300% text through the render-only patch): Collection on Watched, Watchlist, Unranked and TV,
  the open menu, List and Poster, scrolled, and the sheet; For You on Recommended and Top
  Rated with its menu; Feed with and without a shelf; the Leaderboard with ties at 320 and
  360; People; the title page; trailers against the real YouTube host.
  - The toolbar is 52pt from the header's foot at every width, the marquee at x = 16, the last
    glyph's edge on the gutter. After scrolling 420pt the toolbar is off the top (y −359).
  - At 200% on 320pt the tools wrap onto their own line under Watched; at 300% with a filter
    and Shuffle they wrap among themselves and the right-most target ends at 316.
  - The render's text-scale patch cannot scale a style with an explicit font size, so the
    marquee shows at its base size there; on a phone it scales like every other Text.
- **Trailer privacy:** 0 requests to `i.ytimg.com` on opening and after scrolling the whole
  page; 3 after Show previews, one per trailer.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout gives `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` at `5d815e7` and at
  `1ee5646`, the installed Preview APK's runtime. Only `app/` and `src/` changed.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, three passes against `a37e8f1`.
Reports are in `.agent-workflow/codex-reviews/mc-review{1,2,3}.md` (gitignored).

1. **Needs attention, two MEDIUM, fixed in `5d815e7`.**
   - Expo Image downscales on Android by default, so on a low-density screen a real 480px
     still could decode at the card's width and fail the placeholder check. Stills now decode
     at their own size (`allowDownscaling={false}`).
   - The pinned You row's rank sat in a fixed 26pt column, so a standing of 1,000 would wrap.
     The column is a minimum width now.
2. **Needs attention, one MEDIUM, fixed in `1ee5646`.** At about 300% text on a 320dp phone a
   filter count plus Shuffle made the tools wider than the row, pushing List view outside the
   list's clipped bounds. The tools are capped at the row and wrap among themselves.
3. **Approve, no material findings.**

No HIGH or CRITICAL finding at any pass. Codex's own Jest run is blocked by its read-only
sandbox; the suite above is the implementer's. Codex did not exercise native touch.

## Android Preview

| | Phase A |
| --- | --- |
| Published | 2026-11-07, this session the only publisher |
| Commit | `688a007` (code `1ee5646`) |
| Update group | `404c12c7-6397-4cc5-9c23-e81c190d5b20` |
| Android update | `01a1b44e-c3f9-766b-821b-636fcb402ba9` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` |
| Branch / platform | `preview`, Android only |
| Previous (rollback) | `29b60018-595c-4862-88c7-5d6c551f2a25` |

## Rollback

```
npx eas update:republish --group 29b60018-595c-4862-88c7-5d6c551f2a25 --non-interactive
```

This returns the Preview channel to the final title refinement (`1996619`). Run it from
`../worktrees/visual2-preview-publish`.

## Phone QA checklist

Relaunch once after the update. Cinematic title page: Labs → Cinematic.

1. **Collection:** Watched ▾ in Maroon serif at the left, Filters and the two view glyphs at
   the right, on one line. Tap Watched ▾: Watched, Watchlist (and Unranked when there is one),
   the current one checked. Switch to Watchlist and back; switch Movies and TV.
2. **Scroll Collection:** the toolbar, the card and the count scroll away with the posters;
   the bingd. header and the tab bar stay. Leave the tab and come back: same section, medium,
   view, filters and sort.
3. **Filters:** opens the sheet with the sort first and the current sort marked. Choose a
   genre and Apply: the button reads `Filters · 1` in Maroon. Shuffle: the reshuffle glyph
   appears beside Filters.
4. **For You:** Recommended ▾ the same size and colour as Watched ▾, Filters opposite; Sent to
   You and Find for a Group smaller and quieter; both still work. Top Rated hides them. The
   toolbar scrolls away with the wall.
5. **Feed:** under Trending one thin rule, then RECENT ACTIVITY, then the first post close
   beneath it. Score badges still lower right.
6. **Leaderboard:** gold, silver and bronze rings around 1, 2 and 3; 4 onward plain. A tie
   shows two of the same medal. This month ▾ sits right under the four categories.
7. **People:** PEOPLE YOU MAY KNOW the same size as LEADERBOARD.
8. **Title page:** a little more space between sections, none inside them.
9. **Trailers:** dark frames until Show previews. Tap it: stills fade in. A removed video keeps
   its dark frame (not a grey YouTube logo). A new title page asks again.
10. **Largest system font:** Collection and For You — the tools drop to a line of their own,
    the marquee is never cut short.

## Phase B — secondary screens

Begun after the Phase A Preview; recorded here when it is published.

## Phase C — research only (nothing built, no migration)

### Ten titles added to a Watchlist: what the Feed does today

1. **Ten additions make ten cards.** `set_watchlist` (latest definition
   `supabase/migrations/20260820000300_a_watchlist_add_is_activity.sql:161-213`) inserts one
   `feed_events` row of type `watchlist_added` per addition. The partial unique index
   `feed_events_watchlist_once (actor_id, media_item_id) where type = 'watchlist_added'`
   (lines 130-132) makes it one event per person and title, ever, so removing and re-adding
   a title does not post twice. Saving a whole list to the watchlist (`add_list_to_watchlist`)
   posts nothing, and imports are silenced by `feed_events_silent_during_import`.
2. **No grouping exists for watchlist events**, on the server or the client, in Preview or
   production. The client reads them as plain rows (`src/features/feed/activity.ts`) and
   draws each as a one-title `FeedCard`. Two groupings exist for other types and are the
   precedents:
   - `ranking_batch` (20261020000100, 20261022000100, 20261023000100): a client-minted
     "sitting" id, a hidden `ranking_batch_draft` row updated in place, members in
     `feed_ranking_titles`, and `rank_batch_finalize` dating the post (`causal_at` and
     `created_at`) when it is published. Single posts the sitting duplicated are absorbed.
   - `follow_added`: a 60-minute window (`feed.follow_aggregation_minutes`) whose
     `causal_at` is set once and never moved.
3. **Order:** `causal_at desc, causal_step desc, id asc`, 20 rows a page, a three-key cursor,
   pages de-duplicated by id (`src/features/feed/use-feed.ts`).
4. **Reactions and comments attach to one `feed_event_id`** (reactions PK
   `(feed_event_id, user_id)`; comments FK), both `on delete cascade`.
5. **Removal and privacy:** removing a title deletes the watchlist row and leaves the event
   standing. Privacy is applied when the feed is read: `feed_events_read` is
   `can_i_view(actor_id)` (private accounts, blocks, suspensions); reactions and comments
   re-check the actor. There is no separate watchlist-visibility setting.
6. **One card cannot show several posters today.** `FeedCard` takes one `artwork`; the
   ranking sitting's "and N more" opens a vertical sheet (`RankingBatchSheet`). A horizontal
   poster rail exists elsewhere and could be reused (`PosterWall`, `ProfileLists`).
7. **What one scrollable grouped post needs:**
   - A new type (`watchlist_batch`, and a `_draft` if it follows the sitting pattern) in
     `feed_events_known_type`; a member table `feed_watchlist_titles` (surrogate key,
     `unique(event_id, media_item_id)`, no policy) and a definer reader gated on
     `can_view_profile`, modelled on `ranking_batch_titles`.
   - **A server-side grouping rule**: watchlist adds come from many screens, so there is no
     client "sitting". Either a window (the follow rule) or a quiet period with a scheduled
     publish (the draft rule), with a per-actor advisory lock.
   - The once-per-title rule kept across singles and batches.
   - A client card with a horizontal poster rail, each poster opening its title, with its
     own save state.
8. **History:** leave existing `watchlist_added` rows as they are. Merging them would delete
   them and, by cascade, their reactions and comments. Old single cards and new grouped
   ones would sit side by side, as the ranking sitting did (forward-only).
9. **No duplicates, no reordering:** never move the time of a row readers can already see.
   Bumping `causal_at` breaks the cursor (a row skipped until refresh, or shown twice
   higher up). Either fix the time at the first addition (later additions join an older
   card) or keep the batch hidden as a draft and date it when it is published.
   **The decision this needs from the founder:** a reaction or comment on a grouped post is
   about the batch, not any one title. That is the product question to settle first.

### Scrollable posters on My Lists (and in the Feed)

- `my_lists` and `profile_lists` (20261010000100) return `posters text[]`, the **first four**
  posters in list order (`limit 4`). `my_lists` answers only for the owner; `profile_lists`
  returns public, unhidden lists behind `can_view_profile`.
- `list_items_page` returns up to 100 items a page with privacy through `_list_readable`
  (owner always; others refused for hidden, private, blocked or inactive-owner lists;
  link-only readable by anyone). Using it for previews is safe but costs one request per
  list, with per-row seen/watchlist checks a preview does not need.
- **To build a rail of 10–20 posters per list:** a `p_posters` argument (clamped, about 20)
  on `my_lists` and `profile_lists`, or one batch function `list_preview_posters(list_ids,
  n)` that runs `_list_readable` for every id with a cap on ids. Keep `profile_lists`'
  filters exactly. **In the Feed** it needs its own check: list events are not drawn in the
  Feed yet, and `feed_events_read` checks the actor, not the list — a link-only, private or
  hidden list must never show its posters there.
- Nothing here was built: the My Lists index uses the four posters it already receives.

## Founder decisions

- **Trailer previews across pages.** Today Show previews is per title page. Remembering it for
  the session, or as a setting, would remove the dark frames after the first tap but makes
  requests to YouTube on opening later titles.
- **Grouped Watchlist posts** need a product decision first: a reaction or comment on a grouped
  post is about the batch, not one title (Phase C).

## Remaining before production

Not production. Before it:
- Founder phone QA of this Preview.
- The whole Preview chain is unmerged. `refine/marquee-cohesion` stacks on
  `refine/title-final`, `refine/title-cinematic` and the branches before them. The merged
  `main` has to pass the production fingerprint check.
- A separate decision to switch the Cinematic layout on for production.
- The earlier open items still apply: the trailer-thumbnail entry in the privacy inventory
  (no new request here: still opt-in, the same host and image), the default-date race, and
  security items M-5, M-6 and the M-3 residual.
- The Feed ranking nudge (final title refinement) and grouped Watchlist posts (Phase C) are
  proposals and need their own approval.
