import { lane } from '@/lib/env';

/**
 * **Whether trailer thumbnails load without being asked for** (founder Preview QA,
 * 2026-11-07).
 *
 * The founder wants YouTube's stills on the Trailers section by default. Each still is a
 * request from the device to Google's image host (`i.ytimg.com`), carrying the reader's IP
 * address and the video's id — a third party the privacy policy and the store disclosures
 * do not name today: they say images load from TMDB's servers. So the default is per lane:
 *
 * - **Every lane but production** (Preview, Beta, development) loads them with the page.
 * - **Production keeps the opt-in** — Show previews, once per page — until the policy at
 *   bingd.app/privacy and the App Store / Play disclosures name YouTube's image host and the
 *   founder approves turning this on. The proposed wording is in
 *   `docs/release/marquee-cohesion.md` ("Trailer thumbnails by default").
 *
 * The Trailers section is drawn only on the Cinematic title page, which production does not
 * offer yet (`isTitleLayoutAvailable`), so production makes no request to YouTube either way
 * today. Read per call, so a test can vary the lane.
 */
export const trailerPreviewsByDefault = (): boolean => lane !== 'production';
