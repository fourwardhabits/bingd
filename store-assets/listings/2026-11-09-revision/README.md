# App Store screenshots, proposed revision v2, 2026-11-09

A proposed revision of the six approved cards in [`../2026-11-09/`](../2026-11-09/), plus one candidate card and one optional alternative for card 05. **Not approved, not uploaded.** The approved set in `../2026-11-09/` is unchanged.

v2 follows the founder's correction of v1: the approved phone placement is the baseline, and the text moves down to close the gap. The v1 render is kept in [`v1/`](v1/) for comparison.

## Look at these first

| File                                                                                 | What it is                                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`review/contact-sheet.png`](review/contact-sheet.png)                               | The six proposed cards in store order                                      |
| [`review/browse-size-preview.png`](review/browse-size-preview.png)                   | Proposed vs approved at App Store search-result size (250 px wide)         |
| [`review/before-after/`](review/before-after/)                                       | One sheet per card: approved vs proposed, with the gap measured            |
| [`review/bottom-edges.png`](review/bottom-edges.png)                                 | The bottom 360 px of every card, to check what reaches the edge            |
| [`review/card02-large.png`](review/card02-large.png)                                 | Card 02, full card plus the comparison at 100%                             |
| [`review/alternative-05-balanced.png`](review/alternative-05-balanced.png)           | Card 05: approved, proposed, and the optional balanced layout              |
| [`review/contact-sheet-with-candidate.png`](review/contact-sheet-with-candidate.png) | The six plus the ranking candidate                                         |
| `apple-1206x2622/01-movies-tv.png` … `06-for-you.png`                                | The proposed cards, 1206 × 2622, RGB PNG, no alpha                         |
| `alternatives/05-your-year_ALT-balanced.png`                                         | Optional card 05 alternative, same format                                  |
| `candidate/07-ranked-CANDIDATE.png`                                                  | The ranking candidate, regenerated with the v2 geometry (no other changes) |

## What changed from the approved set

- **Main phone: unchanged.** Same position (frame top y = 783), same size (1015 wide), same crop. QA diffs every main screen against the approved card: the largest difference is 1/255. Its tab bar stays below the card edge, as approved.
- **Headline and subtitle: moved down 112 px**, which closes the subtitle-to-phone gap by about 48%. Copy, fonts, sizes and colours are unchanged.
- **Gold eyebrows: removed**, as in v1. At browse size they are about 4 px tall.
- **Secondary phones (01, 03, 04, 05): 541 → 611 px wide**, which is 60% of the main phone. They keep the approved right edge (x = 1160) and run off the bottom of the card far enough to hide their tab bars (92 px of tab bar, 103 px of screen below the edge). The comments screen on card 03 has no tab bar in the app, so none is shown on any secondary phone. The screens are the same layers, only scaled. QA resamples each one back to the approved size and compares: mean difference 0.35–1.12/255. The card 03 Witcher comments and every privacy blur are intact.
- **Card 02: comparison only.** The 9.8 result phone is removed. _You Can See Everything_, _Inception_, both titles and "Which did you like more?" are fully visible (see `card02-large.png`). The crop is pixel-identical to the founder's prepared layer.

### Measured gaps

Measured from the PNG pixels (`measure.mjs`): clear rows between the last row of subtitle ink and the first row of the main phone's frame.

| Card            | Approved gap | Proposed gap | Reduction |
| --------------- | -----------: | -----------: | --------: |
| 01 Movies + TV  |       231 px |       119 px |     48.5% |
| 02 Head to head |       231 px |       119 px |     48.5% |
| 03 Friends      |       233 px |       121 px |     48.1% |
| 04 Watchlist    |       230 px |       118 px |     48.7% |
| 05 Your year    |       231 px |       119 px |     48.5% |
| 06 For you      |       231 px |       119 px |     48.5% |
| 07 candidate    |            — |       119 px |         — |
| 05 alternative  |       231 px |       119 px |     48.5% |

### Measured phone widths

Measured from the PNG pixels: the width of the black frame, excluding its 1 px outer stroke, so each phone measures 4 px narrower than its nominal size.

| Card           | Approved main / secondary | Ratio | Proposed main / secondary | Ratio |
| -------------- | ------------------------: | ----: | ------------------------: | ----: |
| 01 Movies + TV |             1011 / 541 px | 53.5% |             1011 / 611 px | 60.4% |
| 03 Friends     |             1011 / 541 px | 53.5% |             1011 / 611 px | 60.4% |
| 04 Watchlist   |             1011 / 541 px | 53.5% |             1011 / 611 px | 60.4% |
| 05 Your year   |             1011 / 541 px | 53.5% |             1011 / 611 px | 60.4% |
| 05 alternative |             1011 / 541 px | 53.5% |              956 / 620 px | 64.9% |
| 02, 06         |                   1011 px |     — |                   1011 px |     — |

**Why 60% and not more:** with the main phone fixed where it was approved, every extra pixel of secondary width covers more of the main screen. On card 03, a 625 px secondary (62%) already covers the end of the "RECENT ACTIVITY" header; at 615 px (nominal) the phone's corner just clears it. All four dual-phone cards use the same secondary size, so 60% is the ceiling.

## Card 05 alternative (optional)

At 60%, card 05's secondary covers the ends of two Award names on the main phone ("Hype Courie…", "Heart Magne…"). In the approved card all names were readable. Going further toward 65–70% makes this worse, so the 60–70% target isn't fully legible on card 05 with the approved proportions.

`alternatives/05-your-year_ALT-balanced.png` shrinks the main phone to 960 px (nominal) and moves it left to x = 40, with a 624 px secondary (65% measured). Every Award name is readable, and the top of the "Done" button is visible beside the secondary. It is the only card with a non-approved main phone, so it is offered for comparison, not as part of the set.

## Visual QA

Checked at full resolution and at 250 px wide (`browse-size-preview.png`, `bottom-edges.png`).

| Card            | Bottom bar visible?                                                                                    | Important content clipped?                                                                            | Overlap hiding critical UI?                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 Movies + TV  | No. A thin white strip of the main tab bar's background shows at the edge, no icons, same as approved. | No.                                                                                                   | Only grid posters: the secondary covers the right column and part of the middle one, slightly more than approved. The left column and its scores are clear. |
| 02 Head to head | No.                                                                                                    | Undo and Can't decide are cut about 9 px at the bottom edge, same as approved. Labels fully readable. | None. Single phone; both choices, titles and the question unobstructed.                                                                                     |
| 03 Friends      | No. The comments screen has none; the main tab bar is off-card as approved.                            | No. The comment input and "Contains spoilers" are visible; the "RECENT ACTIVITY" header is clear.     | Only the right end of the activity rows (episode metadata), as approved.                                                                                    |
| 04 Watchlist    | No.                                                                                                    | No.                                                                                                   | Only watchlist posters: the right column and part of the middle one, slightly more than approved.                                                           |
| 05 Your year    | No.                                                                                                    | The Done button is below the edge (its outline just shows), as approved.                              | Yes, minor: the ends of "Hype Courier" and "Heart Magnet" and the Award "Next:" lines are covered. See the alternative.                                     |
| 06 For you      | No. Thin strip of tab-bar background only, as approved.                                                | No.                                                                                                   | None. Single phone.                                                                                                                                         |
| 05 alternative  | No.                                                                                                    | No. "Done" is partly visible beside the secondary.                                                    | "Next:" lines are cut at the secondary's edge; all Award names readable.                                                                                    |
| 07 candidate    | No.                                                                                                    | No.                                                                                                   | None. Single phone.                                                                                                                                         |

Automated checks (`qa/qa-report.json`), all passing: format (1206 × 2622, PNG, 3 channels, no alpha, sRGB), gap reduction between 45% and 55%, measured secondary ratio between 60% and 70%, main screen identical to the approved card, secondary content matching the approved layer after resampling, and each secondary tab bar fully below the card edge.

## The ranking candidate: recommendation is still to defer

Same reasoning as v1. It shows the same Watched collection as card 01, so two of the first three cards would repeat the list. It can't replace 01 or 02 without losing their message, and as a 7th card it wouldn't be seen in search results. Revisit when card 01 is next reworked. It was regenerated with the v2 type position only.

## Rebuild

```sh
npm ci                                                    # sharp + the app's @expo-google-fonts packages
node store-assets/listings/2026-11-09-revision/render.mjs
```

That one command:

1. Verifies `sources/` against `sources/SOURCES.json`.
2. Re-renders the approved layout and checks it against the approved exports in `../2026-11-09/apple-1206x2622/`. The largest difference anywhere on any card is 1/255.
3. Writes the proposed cards, the candidate, the alternative, every sheet in `review/`, `checksums.json` and `qa/qa-report.json`.

It stops on the first failure. Output is byte-identical between runs.

- `sources/` holds byte copies of the founder's handoff `bingd_recomposition_editable_handoff_2026-11-09.zip`: the prepared, already-redacted screen layers and three raw captures. Each file's origin path and sha256 are in `SOURCES.json`.
- Fonts are DM Serif Display and Inter from the app's own `@expo-google-fonts` packages (OFL). `lib.mjs` restricts fontconfig to those packages, so a system-wide "Inter" can't replace them.
- To change the layout, edit `REVISION` (or `BALANCED`) in `cards.mjs`. To change copy or screens, edit `cardSpecs`.
- `v1/` is a static copy of the first render (phones moved up 121 px) and is not rebuilt.

## After approval (not done here)

- Copy the six chosen PNGs to a listing folder with checksums. Uploading them to App Store Connect is the founder's step.
- **Google Play** needs its own 1080 × 1920 layout. A 1206 × 2622 card is 2.17:1, and Play allows at most 2:1, so the cards can't simply be scaled. The phone would need a smaller frame or a deeper crop.
- **Website:** nothing to do. The PR #240 website slots use clean app screenshots, not these cards.
