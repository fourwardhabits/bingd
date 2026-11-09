/**
 * **Whether trailer thumbnails load without being asked for.**
 *
 * Each still is an `expo-image` request from the device to Google's image host
 * (`i.ytimg.com`). It carries the reader's IP address, the platform's User-Agent and the
 * video's id, and no cookie or identifier. TMDB images go out the same way. The privacy policy
 * at `https://bingd.app/privacy/` already describes these requests, and Apple's label needs no
 * change. One Play Data safety question is unresolved: whether that IP must be declared as
 * Approximate location (F-6). No sharing exemption covers automatic loads.
 * See `docs/release/pr239-thumbnail-privacy-review.md`.
 *
 * Production has a manual "Show previews" opt-in (OTA of 2026-11-07). This returns `true` for
 * every lane in preparation for automatic stills, and **is not live in production**: the PR
 * must not be merged and the production OTA must not be published until F-6 is resolved.
 *
 * Original layout never mounts `TrailerRail`, so it never sends a YouTube image request
 * regardless of this value.
 */
export const trailerPreviewsByDefault = (): boolean => true;
