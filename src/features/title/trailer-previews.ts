/**
 * **Whether trailer thumbnails load without being asked for** (founder Preview QA,
 * 2026-11-07; production since the release pass the same day).
 *
 * Each still is a request from the device to Google's image host (`i.ytimg.com`), carrying
 * the reader's IP address and the video's id. It is on in every lane now, production
 * included, because the founder approved it **and the disclosures were updated to say so**:
 * the privacy policy's "Who else sees it" names YouTube's image servers (`web/build.mjs`),
 * and `docs/release/store-privacy-inventory.md` lists the request beside TMDB's images.
 * Those ship in the same release and the website deploys from `main` with it; the
 * production update is published only after the live policy has been checked.
 *
 * To turn the stills back into an opt-in (Show previews, once per page), make this return
 * false — the Trailers section still offers the button whenever it does.
 */
export const trailerPreviewsByDefault = (): boolean => true;
