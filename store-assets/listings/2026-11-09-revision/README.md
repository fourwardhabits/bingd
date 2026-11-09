# App Store screenshots, proposed revision, 2026-11-09

A proposed revision of the six approved cards in [`../2026-11-09/`](../2026-11-09/), plus one candidate card. **Not approved, not uploaded.** The approved set in `../2026-11-09/` is unchanged.

## Look at these first

| File                                                                                 | What it is                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`review/contact-sheet.png`](review/contact-sheet.png)                               | The six proposed cards in store order                              |
| [`review/browse-size-preview.png`](review/browse-size-preview.png)                   | Proposed vs approved at App Store search-result size (250 px wide) |
| [`review/card02-large.png`](review/card02-large.png)                                 | Revised card 02, full card plus the comparison at 100%             |
| [`review/before-after/`](review/before-after/)                                       | One sheet per card: approved vs proposed, with the gap measured    |
| [`review/contact-sheet-with-candidate.png`](review/contact-sheet-with-candidate.png) | The six plus the ranking candidate                                 |
| [`candidate/07-ranked-CANDIDATE.png`](candidate/07-ranked-CANDIDATE.png)             | The ranking-payoff candidate, full size                            |
| `apple-1206x2622/01-movies-tv.png` … `06-for-you.png`                                | The proposed cards, 1206 × 2622, RGB PNG, no alpha                 |

## What changed

- **Card 02.** The 9.8 result phone is gone, since it covered _Inception_. The card is now a single phone showing the real _You Can See Everything_ vs _Inception_ comparison (`1000087685.jpg`). Both posters, both titles and "Which did you like more?" are fully visible. The crop is the founder's own Android chrome crop. It is pixel-identical to the approved `02-head-to-head__secondary-screen.png` layer.
- **Gold eyebrows removed** on all six cards (HOW IT WORKS, MOVIES + TV, FRIENDS and the rest). No eyebrow variant was made. At browse size the eyebrows are about 4 px tall and unreadable (see the approved rows in `browse-size-preview.png`), so keeping them would cost space and add nothing.
- **Subtitle-to-phone gap closed by about 50%.** Both phones move up 121 px and the text moves up 6 px. Nothing is rescaled. The main phone now ends on its own tab bar at the card's bottom edge. Any higher and the frame would show empty space under the tab bar. The secondary phones move up by the same 121 px, so what they cover is unchanged.
- **Everything else is unchanged:** copy, fonts, colours, phone frames, shadows, background, and every screen pixel, including the card 03 Witcher comments and all privacy blurs. QA checks this by diffing each screen against the approved card shifted by 121 px. The largest difference is 1/255.

### Measured gaps

Measured from the PNG pixels (`measure.mjs`): clear rows between the last row of subtitle ink and the first row of the main phone's frame.

| Card            | Approved gap | Proposed gap | Reduction |
| --------------- | -----------: | -----------: | --------: |
| 01 Movies + TV  |       231 px |       116 px |     49.8% |
| 02 Head to head |       231 px |       116 px |     49.8% |
| 03 Friends      |       233 px |       118 px |     49.4% |
| 04 Watchlist    |       230 px |       115 px |     50.0% |
| 05 Your year    |       231 px |       116 px |     49.8% |
| 06 For you      |       231 px |       116 px |     49.8% |
| 07 candidate    |            — |       116 px |         — |

The type now starts at y = 219, the headline cap top. In the approved cards the eyebrow started at y = 153 and the headline cap top was at y = 225. The phone frames' tops move from y = 785 to y = 664.

## The ranking candidate: recommendation is to defer

"Your favorites, ranked / Every comparison sharpens your list" shows the real ranked Movies list (`references/new-ranking-list-source.jpg`). It has the same nine films in the same order with the same scores (10.0, 10.0, 9.9, 9.9, 9.9, 9.8, 9.8, 9.8, 9.7), and the Android bars are cropped.

My recommendation is to **defer** it, and not to swap it in or add it now:

- **It repeats card 01.** Card 01's main phone is the same Watched collection in grid view: _The Wolf of Wall Street_ 10.0, _Inception_, _The Social Network_, _The Dark Knight_ 9.9, and so on. Placed after card 02, two of the first three cards would show the same list.
- **It doesn't fit as a replacement.** It can't replace card 01 without losing the Movies + TV message, and it can't replace card 02, which explains how ranking works.
- **A 7th card wouldn't be seen.** Search results show only the first three cards, so it would add little and it would duplicate card 01.
- **When to revisit:** when card 01 is next reworked, for example to lead with TV. The candidate could then become card 03, directly after head-to-head, and complete the comparison-then-ranking story within the first three cards.

## Rebuild

```sh
npm ci                                                    # sharp + the app's @expo-google-fonts packages
node store-assets/listings/2026-11-09-revision/render.mjs
```

That one command:

1. Verifies `sources/` against `sources/SOURCES.json`.
2. Re-renders the approved layout and checks it against the approved exports in `../2026-11-09/apple-1206x2622/`. Currently the largest difference anywhere on any card is 1/255.
3. Writes the proposed cards, the candidate, every sheet in `review/`, `checksums.json` and `qa/qa-report.json`.

It stops on the first failure. Output is byte-identical between runs.

- `sources/` holds byte copies of the founder's handoff `bingd_recomposition_editable_handoff_2026-11-09.zip`: the prepared, already-redacted screen layers and three raw captures. Each file's origin path and sha256 are in `SOURCES.json`.
- Fonts are DM Serif Display and Inter from the app's own `@expo-google-fonts` packages (OFL). `lib.mjs` restricts fontconfig to those packages. Without that, a system-wide "Inter" can silently replace them, and the type no longer matches the approved exports.
- To change the layout, edit `REVISION` in `cards.mjs`. To change copy or screens, edit `cardSpecs`.

## Remaining issues

- On cards 01, 03, 04, 06 and the candidate, the tab-bar labels end about 16 px above the card's bottom edge. That is where the founder's Android crop ends, so there is no more app pixel data below them. It reads as a phone running off the edge, but it is tighter than the approved cards, where the tab bar was hidden.
- Card 05's newly visible Awards footer cuts through the "Hello" row. This is the app's real rendering, and the approved layer has it too.
- As in the approved set, the small phones on cards 01, 03, 04 and 05 cover part of the main phone's posters, scores and Award counts.

## After approval (not done here)

- Copy the six chosen PNGs to a listing folder with checksums. Uploading them to App Store Connect is the founder's step.
- **Google Play** needs its own 1080 × 1920 layout. A 1206 × 2622 card is 2.17:1, and Play allows at most 2:1, so the cards can't simply be scaled. The phone would need a smaller frame or a deeper crop.
- **Website:** nothing to do. The PR #240 website slots use clean app screenshots, not these cards.
