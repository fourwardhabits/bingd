# UI cohesion pass — Android Preview record

Founder brief: "bingd. — Final UI Cohesion & Immersive Experience Pass" (2026-11-06), with the
overnight handoff that followed it. This file records what changed, how it was checked, what
was published, how to undo it, and what is left before production.

## Where it comes from

- **Base:** `3ba2b6f` on `refine/post-qa-2`, the Sprint 2 docs head. Its code is `0f82e93`,
  published as `0681248` (Android update `01a1ac31-f3b8-70c5-a7d9-093506ec9909`, group
  `1f99a23b-01d4-497e-b89b-15470b53f393`, runtime `2503ffaa`). None of it is on `main`.
- **Branch:** `refine/ui-cohesion` in `../worktrees/ui-cohesion`. Local only; not pushed, not
  merged.
- **Commits:**
  - `e02ce38` part 1: Collection tabs and toolbar, Movies | TV in the header, Feed and
    ranking-sheet corrections.
  - `94ca0f7` part 2: the immersive opening screen, review identity in the preview.
  - `af67e01` review1 fixes: My lists in every state; a header that wraps.
  - `0c49ec9` render fixes: the field continues the band without a seam; Edit ranking is
    never cut.
  - `8e6eef8` review2 fix: Sort and Filter scroll together in the sheet.
  - This record.

## Component map (Phase 1)

| Area | Files |
| --- | --- |
| Shared header | `src/ui/components/AppHeader.tsx`, each tab in `app/(tabs)/` |
| Collection navigation | `app/(tabs)/collection.tsx`, `src/ui/components/SegmentedTabs.tsx` (`nav` variant) |
| Collection toolbar and sheet | `src/features/collection/CollectionView.tsx`, `CollectionFilterSheet.tsx`, `src/ui/components/IconToggle.tsx` (`quiet`), `SortControl.tsx` (`SortMenu`, reused) |
| For You medium switch | `app/(tabs)/recommendations.tsx`, `src/ui/components/CompactSwitch.tsx` (reused unchanged) |
| Immersive title opening | `src/features/title/ImmersiveHero.tsx`, `app/title/[id].tsx` |
| Feed card | `src/features/feed/FeedCard.tsx`, `use-reactions.ts` |
| Ranking-start sheet | `src/features/collection/LogSheet.tsx`, `src/ui/components/BucketChip.tsx`, `Sheet.tsx` (read, unchanged) |
| Reviews preview | `src/features/title/TitleReviews.tsx`, `app/title/[id].tsx` |

Constraints found: none needing a migration, native rebuild, security change or product
decision. Two were layout facts, handled in code: a press never answers outside its parent
on Android (the header's 34pt right box would have cut the 44pt Movies | TV halves), and the
log sheet was already content-driven (no snap points, no minimum height).

## What changed for a reader

### Collection
- **Tabs, not a dropdown:** Watched | Watchlist | Unranked in equal full-width columns, Inter
  Medium 15pt, the chosen one in Maroon over a thin Maroon rule the width of its word, the
  others in secondary Ink. No pill, outline or fill. Unranked appears only while this side has
  an unranked title, exactly as before; with two tabs they share the whole width.
- **Movies | TV in the header's right corner**, the same switch and state it always was, not
  repeated below.
- **One quiet toolbar:** `Filter & Sort` (icon and words, with what is in force beside it in
  tertiary text — `Rating ↓`, or `Rating ↓ · 2 filters` in Maroon) on the left, and bare Grid /
  List glyphs on the right (Maroon when chosen, each a 44pt target).
- **One sheet:** Sort first (the segment's own axes; applies on the press, stays open, a second
  press reverses, Shuffle again reshuffles), then Filter with its existing sections and its
  Clear all / Apply. Filters still wait for Apply, as they always did; sort still does not.
- **Count row:** `37 titles` on the left and `My lists ›` on the right. My lists pushes the
  existing My lists screen (`/lists?entry=collection`), with every list feature intact. It is
  also drawn above an empty collection, while a segment loads and when its read fails.
- **Lists is no longer a mode of this tab.** A device that had Lists remembered opens on
  Movies.

### Header on every main tab
- Feed: the bell. Collection and For You: Movies | TV. Profile: the gear only (its second bell
  is gone; the inbox is Feed's bell). Search: nothing.
- The logo sits where it did on every tab. At the largest text sizes on a narrow phone the
  switch moves to its own line in the header rather than overlapping the logo.

### Cinematic Editorial title page (Labs → Title page → Cinematic, Preview only)
- **One opening screen:** the hero is as tall as the visible area. It holds the artwork, the
  floating card and a small chevron; About starts below the fold.
- **The picture continues to the foot of the screen:** the sharp band (16:9 made a quarter
  taller, growing toward 40% of the screen but never past 1.4× the 16:9 frame), then the same
  image mirrored at the band's edge, blurred and darkened, behind the card and the chevron.
  The band darkens into its foot and the field eases out of a slightly darker seam, so the
  sharp-to-soft change happens in shadow. No milky gradient, no flat stripe, no repeat, no
  second picture, no artwork behind About.
- **The card sits in the lower part,** 12pt from each side; spare height splits 3:2 above and
  below it. A long title, a watch date, large text or stacked scores make it taller and the
  spare space shrinks to nothing; the page then simply scrolls.
- **The chevron** scrolls smoothly to the first section under the opening screen. No snapping.
- **Poster-only titles** keep the upright sharp poster on its blurred field; **no artwork**
  keeps Parchment with the initials frame and a secondary-Ink chevron.
- The card itself is unchanged.

### Feed
- No line between the reaction summary and Like / Comment / Save / Share.
- 28pt above each post (was 16); one hairline between posts, as before.
- The laughing reaction reads **Laugh** in the picker, on the control, in the reactor list and
  in every spoken label. The stored kind is still `funny`.

### Ranking-start sheet
- Order above the buckets: Who I watched with, Watch date, Note — each with its own panel.
- Bucket labels in Inter Regular; circles, tints, colours, sizes and semantics unchanged.
- Height: the sheet was already content-driven. The content's own 16pt under the labels, on top
  of the sheet's 16pt plus the navigation inset, is now 4pt; the safe-area padding is
  untouched. After a ranking (the Done state) nothing changed.

### Reviews preview (after Cast)
- Every review names its author: avatar, name, date and score, in the shape the sheet uses.
- Somebody else's review has its thumbs-up Helpful under it, as its own control (the same
  write, guard and optimistic update as the sheet); tapping the opinion still opens the sheet.
- Your review shows your picture, "Your review", your name and the date; still no score (it is
  the card's) and no Helpful (the server refuses a self-vote), with its Edit.
- See all, the sheet, its sorts, Helpful, reporting, editing and permissions are unchanged.
  Lower tabs stay Similar | Trailers | Details.

## Deviations from the brief

- **The reviewer's own score is not shown on "Your review".** Sprint 2 pinned that decision
  with a test (your score is the card's, a screen above), and this brief does not ask for it.
- **Lists' entry point is `My lists ›` on the count row** rather than an overflow menu: a
  labelled link is the most findable secondary entry that adds no row and no hidden control.
- **The ranking sheet's height was already content-driven;** only the extra content margin
  under the labels was removed, as the brief allows when the sheet is already compact.
- **Two small changes outside the listed areas, both to meet the brief's "never clip" rule:**
  the floating card's Rank / Edit ranking may take the card's width (icons wrap under it)
  instead of truncating at large text, and the Filter & Sort sheet's Clear all / Apply row
  wraps at extreme text sizes. Neither changes behaviour.

## Verification

- **Typecheck:** clean.
- **Lint:** 0 errors, 81 warnings; the base has 82, and no changed file gained one.
- **Jest:** 280/280 suites, 5,401 passed, 1 skipped (the same env-gated skip as the base,
  which ran 5,354). New or rewritten tests:
  - `CollectionToolbar.test.tsx` (new): the toolbar's two groups, the status line, Grid / List,
    the sheet's Sort-then-Filter parts, sort applied live and reversed, drafts until Apply,
    Clear all, reshuffle, per-segment axes, one shared scroller.
  - `CollectionScreen.test.tsx`: helpers moved from the dropdown to the tabs; the way to Lists
    (not a tab, a link that pushes with `entry=collection`, present when empty, while
    loading, on a failed read and on the Watchlist; a stored `lists` opens Movies); one
    switch, in the header; equal Maroon tabs; the tab kept across Movies / TV.
  - `ImmersiveHero.test.tsx` (new): fills the viewport; module, spare space and chevron in
    order; 12pt insets; chevron 44pt and scrolling; band heights at 320/360/412; the
    reflected tiles; the cross-fade; poster-only and no-artwork fallbacks.
  - `TitleScreen.test.tsx`: the opening screen at a measured height with About below it;
    Edit ranking never truncated in the card.
  - `TitleReviews.test.tsx`: author identity, Helpful from the preview without opening the
    sheet, the marked state, Your review with name and no score or Helpful.
  - `CinematicFeed.test.tsx`: no line between summary and actions, 28pt above a post, Laugh.
  - `LogSheet.test.tsx`: Who, date, note, then buckets; 4pt under the labels; Done state
    unchanged.
  - `AppHeader.test.tsx`, `ProfileScreen.test.tsx`, `for-you-controls.test.tsx`,
    `BucketChoices.test.tsx`: the 44pt right box, the wrap, Profile without a bell, For You's
    one switch in the header, Inter Regular labels.
- **Runtime:** `eas fingerprint:generate --platform android --build-profile preview` in the
  real-`npm ci` checkout gives `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` at `94ca0f7`,
  `0c49ec9` and `8e6eef8` — the installed Preview APK's runtime. Only `app/` and `src/` files
  changed: no migration, native dependency, config, backend, ranking or security change.
- **Real-app renders** (react-native-web against the local mock, Chrome at 320×640, 360×780,
  375×667 and 412×915; 200% and 300% text through the render-only scale patch): Collection
  (two and three tabs, Watched, Watchlist, TV, Grid and List, the sheet, My lists pushing
  `/lists?entry=collection`), For You, Feed, Profile, Search headers, six title pages
  (backdrop, off-centre backdrop, poster-only, unranked, no artwork, TV season), the chevron
  (scrolls About to just under the bar), the reviews preview, and the ranking sheet. They
  found the seam and the truncated Edit ranking fixed in `0c49ec9`.
- **Not seen on a device.** Web blur fades its own edges, so the seam under the band can only
  be judged on the phone. iOS was not checked.

## Independent review

Codex (`codex-companion adversarial-review`), read-only, three passes. Reports are in
`.agent-workflow/codex-reviews/ui-cohesion-review{1,2,3}.md` (gitignored).

1. **`3ba2b6f..94ca0f7` — needs attention, two MEDIUM, both fixed in `af67e01`:**
   - My lists disappeared while a segment loaded or failed: now drawn in every state.
   - Movies | TV could overflow beside the logo at 200% text on 320–360pt: the header row
     wraps and its right side keeps its own width, so the switch moves to its own line.
   - It confirmed no migration, dependency, config, backend, ranking or security change.
2. **Whole branch at `0c49ec9` — needs attention, one MEDIUM, fixed in `8e6eef8`:** the Sort
   section outside the filter scroller could take the whole sheet at large text; Sort and
   Filter now share one scroller. Both review1 fixes were confirmed complete.
3. **`0c49ec9..8e6eef8` — approve, no material findings;** the no-sort callers (For You, Group
   Picks) are unchanged.

No HIGH or CRITICAL finding was raised at any pass. Codex's own Jest run is blocked by its
read-only sandbox, as before; the suite above is the implementer's.

## Android Preview

**Live on 2026-11-06**, published by this session as the one publisher from the real-`npm ci`
checkout `../worktrees/visual2-preview-publish` (left detached at `ed8d410`). Verified with
`eas update:view`; no iOS group was published.

| | |
| --- | --- |
| Channel / branch | `preview` |
| Platform | Android only |
| Update group | `2724ce75-6244-460e-8488-1a1a62a35b84` |
| Android update | `01a1b04b-158b-7ac7-8cd8-fe5fec5cd9a1` |
| Runtime | `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543` (the installed Preview APK's) |
| Source commit | `ed8d410da35f92401f5cf6a5cb5951323f9ef38d` (code `8e6eef8` plus this record) |
| Rollback group | `1f99a23b-01d4-497e-b89b-15470b53f393` (Sprint 2, `0681248`), still listed |
| Dashboard | https://expo.dev/accounts/fourward/projects/bingd/updates/2724ce75-6244-460e-8488-1a1a62a35b84 |

## Rollback

Nothing here needs a data rollback: this pass writes no new server state, and the only device
state it touches is that a remembered `lists` Collection mode is now read as Movies.

1. **The whole pass, on every Preview phone:** republish the Sprint 2 group.

   ```sh
   npx eas update:republish --group 1f99a23b-01d4-497e-b89b-15470b53f393 --message "rollback: before the UI cohesion pass"
   ```

   Phones take it at their next launch, back on `0681248`. The groups before it, `8272a1af`
   and `4212ffa9`, are still listed too.
2. **The title page only, on one phone:** Settings → Labs → Title page → Original. The
   Original page is untouched by this pass.
3. **One area, keeping the rest:** revert its commit on this branch and publish again. Part 1
   (`e02ce38`) is Collection, the header, Feed and the ranking sheet; part 2 (`94ca0f7`) is the
   opening screen and the reviews preview; `af67e01`, `0c49ec9` and `8e6eef8` are their fixes.

**Limits:** an OTA applies at the next launch; republishing works only onto runtime `2503ffaa`;
there is no iOS Preview binary on this runtime.

## Phone QA checklist

Differences from the current Preview first. Android, Labs → Title page → Cinematic for 4–6.

1. **Collection header and tabs.** Movies | TV top right, once; Watched | Watchlist | Unranked
   below in equal columns, the chosen one Maroon and underlined. Try a side with nothing
   unranked (two tabs, full width), then rank the last unranked title (Unranked goes, you land
   on Watched).
2. **Filter & Sort.** One action, status beside it. In the sheet: Sort first (tap Title twice —
   it reverses and the wall changes behind the sheet), then a filter and Apply (`2 of N`, the
   status turns Maroon), then Clear all and Apply. Try Watchlist (no Rating sort) and Shuffle
   (the shuffle glyph in the toolbar reshuffles).
3. **Grid / List and My lists.** Switch views; relaunch (the view is remembered). Tap
   `My lists ›` (your lists, New list, a list's detail, back to Collection).
4. **The opening screen.** On a backdrop title: picture, card in the lower part, chevron, and
   no About until you scroll. **Look hard at the line where the sharp picture meets the soft
   field** — it should soften, not cut (web renders could not show this truthfully). Tap the
   chevron (About arrives under the bar). Then a poster-only title, a title with no artwork,
   and a TV season.
5. **Large text.** System font size up: the card grows, nothing clips, Edit ranking stays
   whole, the page scrolls; Collection's header may put Movies | TV on its own line.
6. **Reviews after Cast.** Names, faces, dates and scores; tap Helpful on a review (it fills,
   the count moves, the sheet does not open); tap the review (the sheet opens); your own
   review shows your name and Edit review.
7. **Feed.** No line between the reaction summary and the actions; more space before the next
   post. Long-press Like: the picker says Laugh; react with it; the control and the reactor
   list say Laugh.
8. **Ranking sheet.** Rank an unranked title: Who I watched with, Watch date, Note, then the
   three buckets in regular weight, and the sheet ends just under them (check with gesture
   navigation and with three-button navigation). Open Note, type, dismiss the keyboard, close
   and reopen: the note is kept.
9. **Headers elsewhere.** Feed has the bell (it opens the inbox); Profile has the gear only;
   Search has nothing; For You has Movies | TV top right and Recommended ▾ below.

## Production

Nothing here reaches production. This section is preparation only.

**Blockers before production:**
- **The founder's phone QA** of this Preview, and explicit production design approval of the
  Feed, Collection and the Cinematic Editorial title page.
- **The branch is not on `main`.** It sits on the Preview lineage (`85a8a03` → `0681248` →
  this), none of it merged. Production ships from `main` through `docs/release/cloud-ota.md`.
- **The production runtime is not this Preview's.** Production 1.1.0 runs Android `ec79e181`
  and iOS `8ea562b7` (`config/live-runtimes.json`); Preview runs `2503ffaa`. This pass changes
  only JS in `app/` and `src/`, which the fingerprint does not hash, but the merged `main`
  must still pass the cloud workflow's fingerprint gate before any production OTA.
- **Open items carried from earlier records:** the trailer-thumbnail privacy inventory item
  (`i.ytimg.com`), the default-date fill race, and the security record's open M-5, M-6 and
  M-3 residual (`docs/release/security-remediation-2026-11-01.md`).

**iOS considerations (not checked on a device; no iOS Preview binary on this runtime):**
- The opening screen uses `experimental_backgroundImage` gradients and expo-image `blurRadius`,
  both supported on iOS; the reflected tiles rely on a view transform, not on the bitmap.
- iOS's top bar is 44pt rather than 56pt, and the hero reads it from `Platform`.
- The Reviews sheet's Edit hand-off waits for `onDismissed` on iOS; this pass did not touch it.
- iOS text sizes go further than Android's: the header wrap and the unclamped Rank control
  are what keep them inside their parents, and are worth a look at the largest size.

**Making Cinematic Editorial the single production page, with no public selector:**
1. After approval, change `useTitleLayout()` in `src/features/title/title-layout.ts` so that
   production returns `immersive` unconditionally, and keep the Labs row hidden there
   (`isTitleLayoutAvailable()` stays `lane !== 'production'`, so no selector appears). Preview
   keeps the Labs row and Original as its in-app fallback while it is still useful.
2. Ship that one-line change in the production OTA, through the cloud workflow.
3. **Rollback:** one OTA that restores `return isTitleLayoutAvailable() ? stored : 'original'`;
   the page is chosen on the device, so no data, migration or build is involved. An optional
   no-OTA kill switch could read a key from the existing `app_config` table; it needs no
   migration but needs founder approval, and is not built.
4. After a stable period, delete the Original branch of `app/title/[id].tsx` and the switch.

**Production release plan (when approved):** merge the Preview lineage into `main` by PR,
re-run the full suite there, run the cloud OTA workflow (fingerprint gate against
`config/live-runtimes.json`), publish to production for both platforms, verify with
`eas update:view`, and scan logs with `scripts/ota-log-scan.mjs`. **Rollback:** republish the
previous production group (Android `04afb993`, iOS `ffbb473c`, the security OTA from
`eab83c9`; recorded by the unmerged PR #224, not yet in `production-state.md`), following `docs/release/safe-update-runbook.md`.
