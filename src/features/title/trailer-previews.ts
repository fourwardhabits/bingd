/**
 * **Whether trailer thumbnails load without being asked for.**
 *
 * Each still is a request from the device to Google's image host (`i.ytimg.com`), carrying
 * the reader's IP address and the video's id. The privacy policy at `https://bingd.app/privacy/`
 * already names YouTube's image servers explicitly (updated 2026-11-07). No new data type is
 * declared for this on either store form — the request is structurally identical to TMDB poster
 * loads. See `docs/release/privacy-decision-matrix.md` §16.
 *
 * Gate history: production kept a manual "Show previews" opt-in (2026-11-07) pending store
 * console verification. This function was changed to return `true` for all lanes on 2026-11-09
 * in preparation for enabling automatic stills in production.
 *
 * **This change is prepared but not yet live in production.** The PR must not be merged and
 * the production OTA must not be published until the founder completes **F-6**: open Play
 * Console → App content → Data safety and choose Option A (no form change; record rationale
 * in the console's optional notes — request carries no declared user-data row, IP is not a
 * bingd data type, TMDB posters load identically undeclared) or Option B (mark App
 * interactions Shared for App functionality and publish the updated form before the OTA).
 * See `docs/release/privacy-decision-matrix.md` §16.
 *
 * Original layout never mounts `TrailerRail`, so it never sends a YouTube image request
 * regardless of this value.
 */
export const trailerPreviewsByDefault = (): boolean => true;
