# App Store screenshots v3: final copy and upload order, 2026-11-09

The six App Store cards with the founder's final copy, in the new upload order. They use the v2 design unchanged (same phones, screens, crops, blurs and spacing). **For founder approval; not uploaded.** The approved set in `../2026-11-09/` is unchanged.

Earlier renders are kept for comparison: [`v2/`](v2/) (the v2 design with the original copy, PR #244) and [`v1/`](v1/).

## Look at these first

| File                                                               | What it is                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| [`review/contact-sheet.png`](review/contact-sheet.png)             | The six cards in upload order                                                 |
| [`review/browse-first-three.png`](review/browse-first-three.png)   | The first three at App Store search-result size (250 px wide), v3 above v2    |
| [`review/before-after-copy.png`](review/before-after-copy.png)     | Each position's type area, v2 copy vs v3 copy                                 |
| [`review/position-06-layouts.png`](review/position-06-layouts.png) | Position 6 with the new copy in both layouts: v2 and the balanced alternative |
| [`qa/qa-report.md`](qa/qa-report.md)                               | Measured text widths, line counts, spacing, and screen-unchanged checks       |
| [`store-order/`](store-order/)                                     | The six PNGs named in upload order, plus `manifest.json`                      |
| `review/bottom-edges.png`, `review/card02-large.png`               | Supporting QA: what reaches the bottom edge; card 02's comparison at 100%     |

## Upload order and copy

| Position | Card              | Headline (two lines)                   | Subtitle                               |
| -------: | ----------------- | -------------------------------------- | -------------------------------------- |
|        1 | `01-movies-tv`    | Your favorites, / ranked your way      | Movies and TV, scored by your taste    |
|        2 | `02-head-to-head` | Pick a favorite / Build your ranking   | Head-to-head picks shape your list     |
|        3 | `03-friends`      | See their picks / Share your takes     | Follow friends, react, and send recs   |
|        4 | `06-for-you`      | Less scrolling / More watching         | Discover picks shaped by your rankings |
|        5 | `04-watchlist`    | Save it now / Watch it later           | Keep your watchlist and friends’ picks |
|        6 | `05-your-year`    | A little progress / A lot to celebrate | Set watch goals and earn Awards        |

- **Files keep their card names.** `apple-1206x2622/` holds the cards under their original identities (`01-movies-tv.png` … `06-for-you.png`). `store-order/` holds the same bytes named by upload position (`04-for-you__06-for-you.png`, for example), and `store-order/manifest.json` maps each position to its card, copy and sha256.
- **Position 6 has two layouts.** `apple-1206x2622/05-your-year.png` (v2 layout) is the one in `store-order/`. `alternatives/05-your-year_ALT-balanced.png` has the same copy on the balanced layout and is listed in the manifest as an alternative. Neither was chosen over the other here.
- **The ranking candidate is not part of the set** and isn't rendered any more. It is in `v2/candidate/`.
- The subtitle at position 5 uses a typographic apostrophe (friends’) rather than the brief's straight one. Swap it for a straight `'` in `STORE_ORDER` if preferred.

## Typography

Nothing changed: DM Serif Display 107 px headlines, Inter 52 px subtitles, centred, at the v2 baselines. No eyebrows. Every line fits at the existing size, so no typography change was needed.

- **Two lines per headline, one per subtitle.** Each line is rendered on its own with no wrap width, so the renderer can't add a break. QA confirms it from the final pixels: every card has exactly three lines of type, each one line tall.
- **Widths.** The widest headline line is 882 px ("Build your ranking") and the widest subtitle is 977 px ("Discover picks shaped by your rankings"), on a 1206 px card. The original copy's widest were 971 px and 1002 px. The tightest side margin is 114 px.
- **Balance** (shorter headline line ÷ longer): 0.76 to 0.94. The lowest is position 2, "Pick a favorite" (670 px) over "Build your ranking" (882 px), which reads as a deliberate short-over-long pair. The original copy ranged from 0.64 to 0.98.

Full per-line measurements are in [`qa/qa-report.md`](qa/qa-report.md).

## What QA proves

- **Only the type changed.** On every card, rows 700 to 2622 (all the phones, screens, blurs, crops and bottom edges) are byte-for-byte the v2 card. The main screens still match the approved exports (max difference 1/255), and the secondary screens match the approved layers after resampling.
- **The baselines are intact.** Before rendering v3, the script re-renders the approved set (max difference 1/255) and the v2 set (byte-identical to `v2/`).
- **The gaps still meet the target.** The subtitle-to-phone gap is 118 to 120 px against the approved 230 to 233 px, a 48.5% reduction.
- **No bottom bars, nothing clipped, Card 02 intact.** No tab bar is visible on any card, and no type is clipped. Card 02 is still comparison-only, with both films unobstructed.

## Rebuild

```sh
npm ci                                                    # sharp, prettier, and the app's @expo-google-fonts packages
node store-assets/listings/2026-11-09-revision/render.mjs
```

The script stops on the first failure, and its output is byte-identical between runs. It runs these steps in order:

1. Verifies `sources/` against `sources/SOURCES.json`.
2. Re-renders the approved layout and checks it against `../2026-11-09/apple-1206x2622/`.
3. Re-renders v2 and checks it byte-for-byte against `v2/`.
4. Writes the v3 cards, `store-order/` with `manifest.json`, the review sheets, `checksums.json` and the QA reports.

- To change copy or order, edit `STORE_ORDER` in `cards.mjs`. To change the layout, edit `REVISION` or `BALANCED`. The approved copy stays in `cardSpecs().approved` for the two baseline checks.
- `sources/` holds byte copies of the founder's handoff files; each file's origin path and sha256 are in `SOURCES.json`. `lib.mjs` restricts fontconfig to the app's `@expo-google-fonts` packages, so a system-wide Inter can't replace them.

## After approval (not done here)

- Uploading `store-order/` to App Store Connect, in order, is the founder's step.
- **Google Play** needs its own 1080 × 1920 layout. These cards are 2.17:1 and Play allows at most 2:1.
- **Website:** nothing to do. PR #243 is live, and this folder doesn't touch `web/`.
