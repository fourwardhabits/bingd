# UI review checklist

**Applies to:** every pull request that changes something a person sees.
**Source of truth:** [Design System v3](./design-system.md). This checklist only turns its rules into
yes/no questions; where they disagree, the guide wins and this file is the bug.
**Used by:** the UI section of [`.github/pull_request_template.md`](../../.github/pull_request_template.md),
and agents through `.agents/skills/expo-design-system/references/bingd-design-system-v3.md`.

Answer each item **yes**, **no** or **n/a**. A **no** is allowed only as a documented exception: name it
in the PR's section 7 and in the guide section the item points to. "It looked fine on my phone" is not an
exception.

---

## A. Process (the seven requirements)

| # | Check | How to verify |
|---|---|---|
| A1 | I read [`design-system.md`](./design-system.md) before modifying UI. | The PR links the guide sections it relied on. |
| A2 | Every control, sheet, header, badge and row I added is the canonical component from the inventory (§17), not a copy. | `git diff` adds no new `Pressable` + `Text` pair that restyles a button, toggle, chip or badge. Grep the diff for `borderRadius`, `backgroundColor` and `fontSize` in feature files and justify each. |
| A3 | Every colour, size, space and type value comes from a token. | No hex literal outside `src/ui/tokens/color.ts` (lint enforces it). No raw `fontSize`, no spacing number that is not `theme.space[n]`, `theme.layout.*` or derived from one. |
| A4 | The layout works at **320pt** width and at **fontScale 2**. | A jest render at `width: 320` and `fontScale: 2` (mock `useWindowDimensions`), or simulator screenshots at the smallest phone with the largest accessibility text size. Pairs stack primary-first; nothing truncates mid-word; chips wrap. |
| A5 | Accessibility and interaction states are tested. | Tests assert `accessibilityRole`, the label, `accessibilityState` (selected / disabled / expanded / busy), and the pressed, disabled, loading and error states that the change touches. Tap targets are 44pt (§7). |
| A6 | The PR carries representative visual evidence. | Screenshots of each changed surface (both platforms where they differ), or named layout test output where jest is the evidence. |
| A7 | Every justified exception is written down twice. | The PR's section 7 names it and the reason; the guide gains or updates the exception in the matching section. |

## B. The twelve component rules

| # | Check | How to verify |
|---|---|---|
| B1 | Buttons use the shared `Button` kinds (`primary`, `secondary`, `tertiary`, `outline`); no one-off primary or secondary style. | Grep the diff for `semantic.action` used as a `backgroundColor` outside `src/ui/components/`. Each new action is `<Button kind=…>` (or `SaveButton` / `MiniButton` where §5 says so). |
| B2 | Movies / TV is `MediumSelector`; Poster / List is `ViewModeToggle`; no new toggle variant. | No new two-option toggle component. `IconToggle` is not added to a new surface (the Feed caller is the legacy exception, §8). |
| B3 | A supported browsing surface filters with the icon-only `FilterIconButton` (`options-outline`). | The control comes from `FilterIconButton`, `FiltersAction` or `BrowseControlsRow`; no labelled "Filters" chip on a browsing surface. |
| B4 | Edit is the square-with-pencil glyph (`EDIT_ICON_NAME` = `create-outline`) via `EditIcon` / `EditAction`. | Grep the diff for `'create-outline'`, `'pencil'`, `'pencil-outline'`: the only hit is `EditIcon.tsx`. |
| B5 | Rerank is the horizontal bidirectional arrows (`RERANK_ICON` = `swap-horizontal-outline`) and never `EditIcon`. | The rerank entry imports `RERANK_ICON` / `RERANK_LABEL` from `src/features/watch-history/rerank.ts`; no `star-outline` or edit glyph on a rerank. |
| B6 | A full-size browsing sheet is `<Sheet size="standard">` with the centred quiet Close `DismissFooter`; a content-sized sheet is one of the listed exceptions. | The diff's new or changed `Sheet` either passes `size="standard"` or is a confirmation, menu, inline editor, `LogSheet`, `RankingSheet`, `ReportSheet` or a small picker (§10). |
| B7 | A primary/secondary pair sits side by side when both labels fit, and stacks primary-first when they do not. | A test at 390pt asserts one row; a test at 320pt / fontScale 2 asserts a column with the primary first. The decision reads the window width, never `flexWrap` (§6). |
| B8 | Keep Show Ranking, Choose a different file and comparable secondary navigation are quiet centred `Button kind="tertiary"` actions. | The element is `kind="tertiary"`, centred in its own row, with a 44pt target. |
| B9 | An explicit personal score is a filled Maroon `ScoreCircle`. | `variant` is the filled variant; the fill is `semantic.score`. |
| B10 | A calculated season average is an outlined circle with "Season Average" beneath it and no "AVG" inside. | `ScoreCircle` outlined variant with its caption; grep the diff for `AVG` inside a circle. |
| B11 | A collection poster badge for a calculated score reads `SN AVG x.x` (`seasonAverageBadgeText`, outlined); an explicit score stays filled. | The tile's badge text comes from `seasonAverageBadgeText`; no hand-built "AVG" string. |
| B12 | Only existing typography tokens, spacing tokens and `minTapTarget` (44pt) are used. | No new `typography` key, no new `space` key, no tap target under 44pt without `hitSlop` that reaches it (`touch-targets.test.tsx` pattern). |

## C. November 2026 decisions

| # | Check | How to verify |
|---|---|---|
| C1 | DM Serif Display appears only on approved editorial headings; everything else is Inter; no oversized header. | New `Text` uses `title1` / `title2` / `display` only where §3 lists it. |
| C2 | Tertiary actions are quiet: no fill, no border, `text.secondary`-weight presence. | `kind="tertiary"`; it is not the visually dominant control. |
| C3 | A header save is the compact Maroon `SaveButton`, not a full-size `Button`. | §5. |
| C4 | Review cards are neutral; name, then date, then the review; Helpful is de-emphasised. | §13. |
| C5 | No oversized gap above a header; a filter sheet's first section uses `theme.layout.section.above`. | §4, `CollectionFilterSheet.spacing.test.tsx` pattern. |
| C6 | An import screen follows the import pattern (short intro, one help disclosure, one upload control, minimal card, notes, Unmatched disclosure, Done / Rank titles pair). | §14. |
| C7 | Any new exception to a shared pair (like `RankingSheet`'s measured Update / Keep pair) is recorded with a convergence follow-up. | §6. |

## D. General hygiene

| # | Check | How to verify |
|---|---|---|
| D1 | Loading, empty, failure and success states exist for every new data surface. | §15: skeleton on first load, the three empty kinds, `ScreenError` with retry. |
| D2 | Colour is never the only signal. | Selected states also change border, fill or glyph and announce `selected`. |
| D3 | Both platforms checked where behaviour differs (Android hit-slop clipping, edge-to-edge bottom inset, `statusBarTranslucent` sheets). | §16. |
