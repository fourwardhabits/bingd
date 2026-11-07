import { lane } from '@/lib/env';

/**
 * **Whether trailer thumbnails load without being asked for** (founder Preview QA and the
 * release pass, 2026-11-07).
 *
 * Each still is a request from the device to Google's image host (`i.ytimg.com`), carrying
 * the reader's IP address and the video's id. The founder approved automatic stills for
 * production *subject to accurate, verified disclosures*. The privacy policy now names
 * YouTube's image servers (`web/build.mjs`, live with this release). The App Store and
 * Google Play privacy answers could not be checked from here — nobody but the founder can
 * open those consoles — so, by the founder's own fallback instruction:
 *
 * - **every lane but production** (Preview, Beta, development) loads the stills with the
 *   page;
 * - **production keeps the opt-in** — Show previews, once per page — until the founder has
 *   confirmed both store forms against `docs/release/store-privacy-inventory.md`. Turning it
 *   on is then this one line (`=> true`), shipped as an ordinary production update.
 *
 * Read per call, so a test can vary the lane.
 */
export const trailerPreviewsByDefault = (): boolean => lane !== 'production';
