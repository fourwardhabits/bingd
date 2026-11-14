# bingd project rules (Design System v3)

Project-specific guidance for agents changing UI in the bingd repository. It **overrides** the generic
defaults in this skill's `SKILL.md` wherever they differ. bingd already has a design system; you adopt
it and never build a second one ("Adopt Before You Build").

- **The guide:** [`docs/design/design-system.md`](../../../../docs/design/design-system.md) (v3). Every
  value there cites the file and line that implements it.
- **The review checklist:** [`docs/design/ui-review-checklist.md`](../../../../docs/design/ui-review-checklist.md).
- **The PR template:** [`.github/pull_request_template.md`](../../../../.github/pull_request_template.md)
  (its UI section is mandatory for UI changes).
- **Tokens:** `src/ui/tokens/` (`color.ts`, `typography.ts`, `layout.ts`, `theme.ts`), consumed through
  `theme` / `useTheme()`. **Components:** `src/ui/components/`, exported from `src/ui/components/index.ts`.

## The seven requirements

Before you finish any change that a person can see:

1. **Consult `docs/design/design-system.md` before modifying UI.** Read §1 and the sections for what you
   are touching; cite them in the PR.
2. **Find and reuse the canonical component** from the inventory (§17). Search `src/ui/components/index.ts`
   first. Do not copy a component into a feature, and do not hand-roll a button, toggle, chip, sheet,
   header or badge.
3. **Use the established tokens.** No hex literal outside `src/ui/tokens/color.ts` (lint enforces it), no
   raw `fontSize`, no spacing number that is not `theme.space[n]` or a `theme.layout.*` value, no new
   token without a founder decision.
4. **Verify responsive layouts at 320pt width and fontScale 2.** In jest, mock `useWindowDimensions`
   (`{ width: 320, height: 640, fontScale: 2, scale: 2 }`) and assert the row/stack decision and that no
   label is clipped. Pairs stack primary-first; chips wrap; leading text truncates before trailing
   controls.
5. **Test accessibility and interaction states**: `accessibilityRole`, label, `accessibilityState`
   (`selected`, `disabled`, `expanded`, `busy`, `checked`), 44pt targets, and the pressed, disabled,
   loading, selected and error states your change touches.
6. **Provide representative visual evidence in the PR**: screenshots of each changed surface, or named
   layout-test output where jest is the evidence.
7. **Document every justified exception** in the PR (section 7) **and** in the guide section it bends.
   An undocumented exception is a defect.

## Hard rules (design-system.md §17.1)

1. Reuse the shared `Button` kinds (`primary`, `secondary`, `tertiary`, `outline`; sizes `md`, `sm`); no
   one-off primary or secondary styles.
2. Movies/TV = `MediumSelector`; Poster/List = `ViewModeToggle`; no new toggle variants. The Feed's
   `IconToggle` is a legacy exception — never add another caller.
3. Supported browsing surfaces filter with the icon-only `FilterIconButton` (`options-outline`).
4. Edit = square-with-pencil: `EDIT_ICON_NAME` (`'create-outline'`), `EditIcon` / `EditAction`. Never a
   `create-outline` literal.
5. Rerank = `RERANK_ICON` (`'swap-horizontal-outline'`) and `RERANK_LABEL` from
   `src/features/watch-history/rerank.ts`; never `EditIcon`, never `star-outline` (first Rank only).
6. Full-size browsing sheets = `<Sheet size="standard">` (`STANDARD_SHEET_FRACTION` 0.8 × (window − top
   inset)) with `footer={<DismissFooter … />}` (centred quiet Close). Content-sized exceptions only:
   confirmations, menus, inline editors, `LogSheet`, `RankingSheet`, `ReportSheet`, small pickers. Never a
   fixed `maxHeight` on a list.
7. A primary/secondary pair sits side by side when width permits and stacks **primary-first** otherwise;
   decide from `useWindowDimensions`, never `flexWrap`. Use `ActionPair` once #289 lands. `RankingSheet`'s
   measured reveal pair is the one exception (convergence follow-up).
8. Keep Show Ranking, Choose a different file and comparable secondary navigation are quiet, centred
   `Button kind="tertiary"` (usually `tone="secondary" size="sm"` with slop to 44pt).
9. An explicit personal score = filled Maroon `ScoreCircle` / `ScoreBadge`.
10. A calculated season average = outlined circle with "Season Average" under it; no `AVG` inside.
11. A collection poster/row badge for a calculated score = `SN AVG x.x` from `seasonAverageBadgeText`
    (`SeasonAverageBadge`, outlined); an explicit score stays filled.
12. Existing typography tokens, spacing tokens and `theme.layout.minTapTarget` (44pt) only.

## November 2026 decisions (also hard rules)

- DM Serif Display only on approved editorial headings (§3.3); Inter everywhere else; no oversized
  headers.
- Tertiary actions are quiet. Explicit saves use the compact Maroon `SaveButton`.
- Review cards are neutral (raised, hairline, `radius.control`); name, then date, then the review;
  Helpful is a de-emphasised icon (§13).
- No oversized gaps above headers; filter sheets use `theme.layout.section` (`above` 16,
  `headingToControls` 8, `controlsToContent` 12, `between` 24).
- Import screens: short intro, one help `Disclosure`, one upload `Button`, minimal card, notes, an
  Unmatched `Disclosure`, a Done / Rank titles `ActionPair` (§14.3).

## Quick lookup: need → component

| Need                       | Use                                                                              | Never                                                           |
| -------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| An action                  | `Button`                                                                         | A styled `Pressable`                                            |
| Save in a header or editor | `SaveButton`                                                                     | `<Button label="Save">`                                         |
| Two actions                | `ActionPair` (#289) / §6 rule                                                    | Two hand-placed buttons with `flexWrap`                         |
| Close a sheet              | `DismissFooter` (as `footer`) / `SheetDone`                                      | A filled Close                                                  |
| A modal                    | `Sheet` (+ `SheetHeader`, `SheetRow`)                                            | A raw `Modal`                                                   |
| A section title            | `SectionHeader`                                                                  | A bare uppercase `Text`                                         |
| Category choice            | `MediumSelector`                                                                 | A new dropdown                                                  |
| Poster / List              | `ViewModeToggle`                                                                 | `IconToggle`                                                    |
| Filters entry              | `FilterIconButton` in `BrowseControlsRow`                                        | A "Filters" chip                                                |
| A filter value             | `FilterChip` / `ToggleChip` / `SortChip`                                         | A local chip, a pill                                            |
| Score                      | `ScoreCircle` (title page), `ScoreBadge` (rows), `SeasonAverageBadge` (averages) | A grey or coloured circle meaning anything but score / no score |
| A title in a list          | `TitleRow` + `TitleRowActions`                                                   | A custom row trailing                                           |
| Collapsible help           | `Disclosure` (#289)                                                              | A help sheet                                                    |
| Text field                 | `Field`, `SearchField`                                                           | A raw single-line `TextInput`                                   |
| Waiting                    | `SkeletonRow` / `SkeletonGrid`; `LoadingScreen` only while the session resolves  | A spinner in a list                                             |
| Empty                      | `EmptyState` with the right `kind`                                               | One message for all three                                       |
| Crash                      | `ScreenError`                                                                    | A raw error                                                     |

Anything not here: search `src/ui/components/index.ts`, then the guide's §17.12.

## Before you open the PR

- Run the [UI review checklist](../../../../docs/design/ui-review-checklist.md) and fill the PR template's UI
  section.
- Run `npm run typecheck`, `npm run lint` and the focused jest suites; add layout tests at 320pt /
  fontScale 2 for anything that lays out by width.
- Code defects you notice outside your scope: list them in the PR; do not fix them in passing.
