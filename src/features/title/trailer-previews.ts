/**
 * **Whether trailer thumbnails load without being asked for.**
 *
 * Each still is an `expo-image` request from the device to Google's image host
 * (`i.ytimg.com`). It carries the reader's IP address, the platform's User-Agent and the
 * video's id. Android sends no cookie or app/account identifier on this path; iOS uses the
 * shared cookie store if one exists for the host. TMDB images go out the same way. The
 * privacy policy at `https://bingd.app/privacy/` already describes these requests, and
 * Apple's label needs no change. One Play Data safety question is an open privacy follow-up,
 * not a compliance determination: whether that IP must be declared as Approximate location
 * (F-6). See `docs/release/pr239-thumbnail-privacy-review.md`.
 *
 * This returns `true` for every lane, production included: stills load with the Cinematic
 * page, with no "Show previews" tap. It reached production in the OTA of 2026-11-09 (merge
 * `19362af`), which the founder chose to ship under the existing Play declaration while F-6
 * stays open. See `docs/release/production-state.md`.
 *
 * Original layout never mounts `TrailerRail`, so it never sends a YouTube image request
 * regardless of this value.
 */
export const trailerPreviewsByDefault = (): boolean => true;
