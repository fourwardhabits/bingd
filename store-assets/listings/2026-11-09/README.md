# App Store screenshots, final, 2026-11-09

The six iPhone screenshots the founder approved for the bingd App Store listing. **Not uploaded.** Uploading them, and the app version they go with, is the founder's step in App Store Connect.

Source: the founder's `bingd_cloud_final_assets_2026-11-09.zip` (sha256 `4f1dd0d5bef36447c7d5af8a68f6bdad54d6149be0e8d76059e5c20867a962c3`). Every file here is a byte-for-byte copy. Nothing was re-rendered, recompressed or re-redacted.

| File                                                  | What it is                                             |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `apple-1206x2622/01-movies-tv.png` … `06-for-you.png` | The six cards, in upload order                         |
| `apple-1206x2622/checksums.json`                      | The founder's sha256 and byte counts for the six       |
| `review/contact_sheet_final.png`                      | The approved lineup, with the selected card 02         |
| `validate.mjs`                                        | Re-checks size, format, alpha and checksums. Read-only |

## Card 02

Card 02 is the alternate the founder selected: the _You Can See Everything_ result phone (9.8, #6 in Movies) sits **in front of** its head-to-head comparison with _Inception_, so the score and title can be read. The first card 02 export, with the result phone behind, is not approved and is not here.

Cards 01 and 03–06 are unchanged from the round the founder approved. Card 03 keeps the original Witcher comments capture with its original blur.

## Validation

`node store-assets/listings/2026-11-09/validate.mjs` passes for all six. Each is 1206 × 2622, PNG, 8-bit RGB with no alpha, and under 3.1 MB. The required iPhone size in [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications) is 6.9" (1206 × 2622 is an accepted size), PNG or JPEG, no alpha, up to ten.

Each PNG has a small EXIF block that holds orientation, 72 dpi and the pixel size. It holds no GPS, device, date or author data. It was left in place, because removing it would change the approved bytes.

## Can the scripts rebuild these?

No. Neither script in this repo reproduces the selected card 02.

- The founder's `build.mjs`, which rendered these cards, lives in the founder's local package and is not in the repo.
- The pipeline in PR #225 (`store-assets/screenshots/`, unmerged) builds its head-to-head card as one comparison phone with no result inset, from an older capture set.

To change a card, edit the founder's source and export again. Then replace the PNG here and its entry in `checksums.json`. No font files are committed.

## Before upload

- These phones show the Android production UI with the Android status and navigation bars cropped off. No iOS capture was used.
- The captures are downscaled phone screenshots (709–945 px wide), upscaled about 1.2–1.4× inside the frame.
- There is no Google Play set here. Play phone screenshots may be at most twice as tall as they are wide ([Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151)), and 1206 × 2622 is 2.17:1, so these cannot be reused for Play as they are.
