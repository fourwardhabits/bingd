import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';
import type { BucketId } from '@/ui/components';

/**
 * The client half of the ranking session (`ranking.md`, api.md §2).
 *
 * None of these queue. A position comes from the server after a binary search over the
 * user's own list, and there is no honest way to guess one offline — PRD §18 forbids
 * queueing any ranking mutation, and the client does not attempt them rather than
 * pretending (`offline-sync.md` §1).
 */

const BUCKET_VALUES: Record<BucketId, string> = {
  loved: 'loved',
  fine: 'fine',
  notForMe: 'not_for_me',
};

const CODES = {
  /** The session, or a pivot in it, is gone. */
  notFound: 'P0002',
  invalidInput: '22023',
  /** The title already has a position, so `rank_start` refuses (api.md §8, BG409). */
  alreadyRanked: '23505',
  suspended: '42501',
  unauthenticated: '28000',
} as const;

/** One comparison to put on screen: the subject against an incumbent. */
export type Comparison = {
  state: 'comparing';
  sessionId: string;
  /** The title the user is placing. */
  subjectId: string;
  /** The title it is being compared against. Never shown with its rank — see below. */
  pivotId: string;
  /** True when the pivot was reached by skipping rather than by answering. */
  skipped: boolean;
};

export type Placed = {
  state: 'placed';
  position: number;
  category: string;
  bucket: string;
  /**
   * The 0–10 score, computed server-side by `score_for` at finalize and returned
   * alongside the position (20260815010000).
   *
   * Taken from the server rather than derived here, even though `score.ts` could do
   * the arithmetic. The band sizes the client holds are the ones it had *before* this
   * insertion, so deriving locally would either be off by one or need a refetch first
   * — and the number the reveal shows would be a different number from the one
   * written into the feed event for the same moment.
   */
  score: number;
  /**
   * The server's word for "this landed at the midpoint because you skipped too often".
   * It comes from the server so that PRD §10's "you can change this from Rankings" line
   * cannot be shown in the wrong circumstances.
   */
  adjustable: boolean;
};

export type SessionEnded = { state: 'ended' };

export type SessionFailed = {
  state: 'failed';
  message: string;
  /**
   * The session is unusable and the caller should start again rather than retry. Raised
   * when a pivot stops being ranked mid-session — answering it would attribute a judgement
   * to a comparison the user was never shown (api.md §8).
   */
  restart: boolean;
  /**
   * **The collection may have moved anyway.**
   *
   * `rank_answer` records a comparison and, on the last one, finalises the placement —
   * it writes the `rankings` row, the score and the `feed_events` entry, all in the same
   * transaction. So a `rank_answer` that commits and loses its reply is a title that is
   * *placed*, reported here as a failure. The sheet used to invalidate only on `placed`,
   * which left the ranked list, the score denominators, Rating Rascal and the feed all
   * describing the ranking from before the one the reader just finished.
   *
   * Set for any outcome `lib/write-outcome.ts` cannot prove was a refusal. Reviews 21d
   * and 21e established the same thing about `rank_rebucket` and about the collection
   * writers; this is the third member of the family.
   */
  changed?: boolean;
};

export type SessionStep = Comparison | Placed | SessionEnded | SessionFailed;

type RankResponse = {
  done?: boolean;
  session_id?: string;
  pivot?: string;
  position?: number;
  category?: string;
  bucket?: string;
  score?: number;
  adjustable?: boolean;
  cancelled?: boolean;
  skipped?: boolean;
};

const fail = (error: { code?: string; message: string }): SessionFailed => {
  // Every branch below is a refusal this app raises on purpose except the default, and
  // the default is where a dropped connection or an `08007` arrives.
  const ambiguous = classifyWrite(error) === 'unknown' ? { changed: true as const } : {};

  switch (error.code) {
    case CODES.notFound:
      return {
        state: 'failed',
        message: 'That ranking session has ended. Start again.',
        restart: true,
      };
    case CODES.invalidInput:
      // Includes the pivot that stopped being ranked while it was on screen.
      return { state: 'failed', message: error.message, restart: true };
    case CODES.alreadyRanked:
      // The database's own text names rank_rebucket, which is an internal function and not
      // a sentence to show anybody. Rebucketing from the collection is the way out.
      return {
        state: 'failed',
        message: 'This already has a position. Move it from your collection instead.',
        restart: false,
      };
    case CODES.suspended:
      return {
        state: 'failed',
        message: 'Your account cannot make changes right now.',
        restart: false,
      };
    case CODES.unauthenticated:
      return { state: 'failed', message: 'Your session expired. Sign in again.', restart: false };
    default:
      return { state: 'failed', message: error.message, restart: false, ...ambiguous };
  }
};

const step = (data: RankResponse | null, subjectId: string): SessionStep => {
  // A 200 with an unusable body. The request was *answered*, so whatever it did is
  // committed — which makes this the one failure here that is certainly a change.
  if (!data)
    return { state: 'failed', message: 'The server said nothing.', restart: true, changed: true };

  if (data.done) {
    return {
      state: 'placed',
      position: data.position ?? 0,
      category: data.category ?? '',
      bucket: data.bucket ?? '',
      score: data.score ?? 0,
      adjustable: Boolean(data.adjustable),
    };
  }

  // rank_back at the first comparison deletes the session and returns here. There is
  // nothing further back to go, and the title keeps its bucket.
  if (data.cancelled || !data.session_id || !data.pivot) return { state: 'ended' };

  return {
    state: 'comparing',
    sessionId: data.session_id,
    subjectId,
    pivotId: data.pivot,
    skipped: Boolean(data.skipped),
  };
};

const call = async (fn: string, args: Record<string, unknown>, subjectId: string) => {
  const { data, error } = await supabase.rpc(fn, args);
  return error ? fail(error) : step(data as RankResponse | null, subjectId);
};

/**
 * Opens a session, or places the title outright when its band is empty — there being
 * nothing to compare it against. Resuming an existing session is the server's decision,
 * not the client's.
 */
export const rankStart = (mediaItemId: string, bucket: BucketId) =>
  call('rank_start', { p_media_item_id: mediaItemId, p_bucket: BUCKET_VALUES[bucket] }, mediaItemId);

/**
 * Moves an already-ranked title into a different band, and opens the session that
 * places it there.
 *
 * It lives beside `rankStart` rather than with the collection writes because it *is*
 * one: the RPC ends with `return rank_start(...)`, so it answers with the same
 * `SessionStep` shape and the sheet drives it identically from there.
 *
 * The position is genuinely discarded — the server unranks first, then recomputes the
 * band bounds, then inserts fresh. PRD §10 requires that a bucket change re-runs
 * comparisons rather than estimating a new position, so this cannot be made cheaper.
 * That is why the caller confirms with the user before reaching it.
 */
export const rankRebucket = (mediaItemId: string, bucket: BucketId) =>
  call(
    'rank_rebucket',
    { p_media_item_id: mediaItemId, p_bucket: BUCKET_VALUES[bucket] },
    mediaItemId,
  );

export const rankAnswer = (sessionId: string, winnerId: string, subjectId: string) =>
  call('rank_answer', { p_session_id: sessionId, p_winner: winnerId }, subjectId);

/** Re-anchors to a different opponent. The third skip places at the midpoint. */
export const rankSkip = (sessionId: string, subjectId: string) =>
  call('rank_skip', { p_session_id: sessionId }, subjectId);

/** One comparison back. At the first, the session ends and the title stays Logged. */
export const rankBack = (sessionId: string, subjectId: string) =>
  call('rank_back', { p_session_id: sessionId }, subjectId);

/** Leaves the session. The bucket survives and the answers already given are kept. */
export async function rankCancel(sessionId: string): Promise<SessionStep> {
  const { error } = await supabase.rpc('rank_cancel', { p_session_id: sessionId });
  // Already gone is the outcome the caller wanted.
  if (error && error.code !== CODES.notFound) return fail(error);
  return { state: 'ended' };
}
