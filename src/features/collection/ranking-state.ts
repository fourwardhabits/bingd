/**
 * **Three ranking states, one definition** (founder decision, 2026-09-21).
 *
 *   `ranked`      a completed bingd placement exists (a `rankings` row) → the score.
 *   `unfinished`  an opinion exists but no placement: a bucket on `user_media` with no
 *                 `rankings` row. A Letterboxd star rating mapped to a bucket, or an in-app
 *                 ranking whose comparisons were abandoned → **Finish ranking**.
 *   `unranked`    nothing yet (not logged, or logged with no opinion) → **Rank**.
 *
 * Imported star ratings are never auto-placed: a position needs real comparison evidence.
 * The bucket is only a prior, which is exactly why this state says *finish* rather than
 * showing a number. Search, Collection, list rows and the title page all ask this one
 * function, so the same title reads the same everywhere.
 */
export type RankingState = 'ranked' | 'unfinished' | 'unranked';

export function rankingStateOf(input: {
  ranked: boolean;
  bucket: string | null | undefined;
}): RankingState {
  if (input.ranked) return 'ranked';
  return input.bucket ? 'unfinished' : 'unranked';
}
