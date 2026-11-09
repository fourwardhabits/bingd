/**
 * **Whether trailer thumbnails load without being asked for.**
 *
 * Each still is a request from the device to Google's image host (`i.ytimg.com`), carrying
 * the reader's IP address and the video's id. The privacy policy at `https://bingd.app/privacy/`
 * already names YouTube's image servers explicitly (updated 2026-11-07). No new data type is
 * declared for this on either store form — the request is structurally identical to TMDB poster
 * loads. See `docs/release/privacy-decision-matrix.md` §16.
 *
 * Gate history: production kept a manual "Show previews" opt-in (2026-11-07) until the store
 * console forms were verified. The founder confirmed Play Console "No data shared with third
 * parties" remains accurate for automatic loads (F-6 in the decision matrix), and this line
 * was changed to `true` (2026-11-09).
 *
 * Original layout never mounts `TrailerRail`, so it never sends a YouTube image request
 * regardless of this value.
 */
export const trailerPreviewsByDefault = (): boolean => true;
