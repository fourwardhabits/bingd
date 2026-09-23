import type { LoggableTitle } from '@/features/collection/LogSheet';
import type { RankingSubject } from '@/features/ranking/RankingSheet';

import { BUCKET_IDS } from './use-log-state';

/**
 * **The internal ranking state — three states, kept apart on purpose** (founder decisions,
 * 2026-09-21).
 *
 *   `ranked`      a completed bingd placement exists (a `rankings` row).
 *   `unfinished`  an opinion chosen in bingd but no placement: a bucket on `user_media`
 *                 with no `rankings` row — a ranking whose comparisons were left before the
 *                 end. Its session and answers are preserved for a resume.
 *   `unranked`    nothing yet: not logged, or logged with no bucket — which is every
 *                 untouched import, since a Letterboxd star is never a bingd bucket
 *                 (20261018000100).
 *
 * This is NOT what the screen draws. The UI is binary (`rankingPresentationOf`); the three
 * states stay distinct for resuming a session, the ranking queue's priority (an unfinished
 * native placement comes before other unranked titles), analytics, and never opening a
 * second session.
 */
export type RankingState = 'ranked' | 'unfinished' | 'unranked';

export function rankingStateOf(input: {
  ranked: boolean;
  bucket: string | null | undefined;
}): RankingState {
  if (input.ranked) return 'ranked';
  return input.bucket ? 'unfinished' : 'unranked';
}

/**
 * **What the screen draws: ranked, or not** (founder, final UI simplification 2026-09-21).
 * A ranked title shows its score; everything else shows the ordinary unranked treatment
 * (`+` on a compact row, *Rank* on the title page). No surface distinguishes an untouched
 * title, an unranked import and an unfinished ranking.
 */
export type RankingPresentation = 'ranked' | 'unranked';

export const rankingPresentationOf = (state: RankingState): RankingPresentation =>
  state === 'ranked' ? 'ranked' : 'unranked';

/**
 * The ranking subject that **resumes** an unfinished native placement: straight back into
 * comparisons in the bucket the reader already chose, without asking "How was it?" again.
 *
 * `rank_start` resumes the server's existing session for the same bucket — restoring the
 * comparison that was on screen and every answer before it — and only opens a new one when
 * none is left, so this can never create a second session for the title.
 */
export function resumeSubject(title: LoggableTitle, bucket: string): RankingSubject | null {
  const id = BUCKET_IDS[bucket];
  if (!id) return null;
  return {
    id: title.id,
    title: title.title,
    bucket: id,
    posterUri: title.posterUri,
    kind: title.kind,
    mode: 'start',
  };
}
