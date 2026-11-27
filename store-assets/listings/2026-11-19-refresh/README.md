# Store refresh, 2026-11-19

The six approved store cards, rendered for every slot one submission needs, with the card 03 feed swap built in. **Not uploaded.** The plan, access findings and outstanding steps are in [`docs/release/store-refresh-2026-11-19.md`](../../../docs/release/store-refresh-2026-11-19.md).

Basis: PR #245 (v3 copy and upload order, head `a2500485`) with the founder's 2026-11-11 picks: position 6 on the balanced layout, and the typographic apostrophe in "friends’". Nothing is redesigned. `lib.mjs`, `cards.mjs` and `sources/` are byte copies from #245.

| Folder / file                       | What it is                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `apple-1206x2622/`                  | App Store, iPhone with Dynamic Island, medium display (6.3"). The size Apple lists as required |
| `apple-1320x2868/`                  | App Store, iPhone with Dynamic Island, large display (6.9"). Native render, same layout        |
| `play-1080x1920/`                   | Google Play phone screenshots (9:16)                                                           |
| `play-feature-graphic-1024x500.png` | Play feature graphic candidate: centre crop of `store-assets/social/social-banner-master.png`  |
| `review/contact-sheet.png`          | The six App Store cards in upload order                                                        |
| `review/contact-sheet-play.png`     | The six Play cards in upload order                                                             |
| `manifest.json`, `checksums.json`   | Position, card, copy, layout, sha256 and bytes for every file                                  |
| `inputs/card03.json`                | The card 03 swap: crop, redaction boxes, sign-off                                              |
| `metadata/apply-refresh.mjs`        | Applies the name, version and screenshots to a config pulled from the live listing             |

File names are `<position>-<slot>__<card>.png`; upload in file-name order.

## Rebuild

```sh
npm ci
node store-assets/listings/2026-11-19-refresh/refresh.mjs
```

It verifies `sources/`, re-renders the approved lineup and requires it to match the Nov 11 final candidate (Drive, "bingd store screenshots — final candidate 2026-11-11") **byte for byte** at 1206 x 2622 and 1080 x 1920, then writes everything above. Output is byte-identical between runs.

## Card 03: the feed swap (one input missing)

Card 03 still shows the approved Nathan for You feed capture. The founder's Crazy Rich Asians capture, `Screenshot_20261119_160109_bingd.jpg`, is not in the repository or on Drive yet. When it is:

```sh
node store-assets/listings/2026-11-19-refresh/refresh.mjs --card03 <path>/Screenshot_20261119_160109_bingd.jpg
```

1. The first run crops the capture with the approved cards' Android chrome crop (status bar and navigation bar off: rows 3.81 % to 95.41 %, a 1080 x 2144 screen at the approved layer's 1.985 aspect), writes an **unredacted** preview with a 100 px grid to the system temp directory (outside the repo), and stops: the redaction has no sign-off yet.
2. Move the boxes in `inputs/card03.json` over every person's name and avatar on the visible screen (rows 0 to 2006): post authors, "and others" names, engagement names. Titles, posters, scores and timestamps stay. Names get a hard-edged blur box (sigma 12), avatars a soft disc (sigma 10), as on the approved card 03.
3. Re-run, look at `review/card03-redaction-check.png` (redacted, with the boxes outlined), and when nothing identifying is readable set `"reviewed": true` and `"reviewedBy"`. Re-run once more.

That run renders card 03 in all three sizes, checks that everything above the main phone's screen is unchanged, and rewrites the manifest and contact sheets. Commit the redacted layer, `inputs/card03.json`, the three card 03 PNGs, `review/`, `manifest.json` and `checksums.json`. **The raw capture is never committed**: it shows other people's names. Only its sha256 is recorded.

## Card 06

Unchanged. `Screenshot_20261119_160146_bingd.jpg` is not available, and nothing in `02 Screenshots/` is stronger (those are August dev-build captures with placeholder posters).

## Brand

The plain-text name is **bingd**, no period. The wordmark inside the app header in the screenshots is the graphic wordmark and keeps its period. No headline or subtitle on the cards names the app.
