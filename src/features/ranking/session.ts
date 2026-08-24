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
  /**
   * The transaction was rolled back to break a conflict with a concurrent one.
   *
   * Listed here because `classifyWrite` reads every SQLSTATE it does not know as
   * `unknown`, which is the right default — an unrecognised code could have committed.
   * This one could not: Postgres aborts the transaction that raises it, so nothing it
   * did survives. Left in the default it would set `changed`, and the sheet would tell
   * a reader their ranking may have landed when it certainly did not — the exact
   * mis-statement the “Not sure that landed” branch exists to avoid making.
   *
   * Handled here rather than in `classifyWrite`, which every write in the app shares.
   * Independent review 30b raised it against this path; widening the shared refusal set
   * days before a beta would change reconciliation for the collection writers too, and
   * that is not this run's fence.
   */
  serializationFailure: '40001',
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
  /**
   * **This ranking was the tenth**, and it activated an invitation (PRD §28).
   *
   * The server's word, and it has to be. `_maybe_activate_invite` flips
   * `invite_attributions.activated_at` under a row lock and reports whether *this*
   * transaction was the one that flipped it — so a second device finishing the tenth
   * ranking at the same moment is told false, and so is a retry. Counting rankings on
   * the client instead would emit for accounts with no attribution at all, and would
   * emit again after a reinstall.
   *
   * True for at most one ranking in an account's life, and false for every account that
   * was never invited.
   */
  activated: boolean;
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
  activated?: boolean;
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
    case CODES.serializationFailure:
      // Definitely nothing written, and the session row is untouched — so the answer is
      // to ask again, not to start over. The database's own wording names a transaction
      // isolation level, which is not a sentence for a person.
      return {
        state: 'failed',
        message: 'Something else was changing your rankings at that moment. Try again.',
        restart: false,
      };
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
      // Absent on a backend that predates 20260819000500, which reads as false — the
      // safe direction: an event never sent is an undercount, and one sent on a guess
      // is a number that looks like growth and is not.
      activated: Boolean(data.activated),
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
 * **The outcome the server never established**, which is what `useOperationIntent`
 * needs in order to decide whether to keep an id for the retry.
 *
 * `changed` is set for exactly the answers `write-outcome.ts` cannot prove were a
 * refusal — a dropped connection, an unrecognised SQLSTATE — which is the same
 * question in this file's vocabulary. A refusal releases the id, because the next
 * press is a new intent; an unknown holds it, because the next press is the *same*
 * intent and, since `20260825000200`, the server can recognise it as one and answer
 * with what the lost reply said.
 */
export const outcomeUnknown = (result: SessionStep) =>
  result.state === 'failed' && result.changed === true;

/**
 * **The operation id is a required argument on every wrapper below, and that is
 * deliberate.**
 *
 * All seven RPCs default `p_operation_id` to null, because the friend-beta build
 * installed on real devices calls them without one and must keep working during the
 * window between the backend deploy and the OTA (`20260825000200` §9). The cost of
 * that compatibility is that *omitting the id is a legal call which silently gets no
 * replay protection* — there is no error to notice.
 *
 * So this file refuses to make it optional. A caller that has not thought about what
 * its intent is cannot compile, and `RankingSheet` is the single place that decides
 * where one intent ends and the next begins.
 */

/**
 * Opens a session, or places the title outright when its band is empty — there being
 * nothing to compare it against. Resuming an existing session is the server's decision,
 * not the client's.
 */
export const rankStart = (mediaItemId: string, bucket: BucketId, operationId: string) =>
  call(
    'rank_start',
    { p_media_item_id: mediaItemId, p_bucket: BUCKET_VALUES[bucket], p_operation_id: operationId },
    mediaItemId,
  );

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
export const rankRebucket = (mediaItemId: string, bucket: BucketId, operationId: string) =>
  call(
    'rank_rebucket',
    { p_media_item_id: mediaItemId, p_bucket: BUCKET_VALUES[bucket], p_operation_id: operationId },
    mediaItemId,
  );

/**
 * Ranks an already-ranked title **again, inside the band it is already in**.
 *
 * The founder reproduced this on the device: a Loved title, Change your rating, Loved
 * — and nothing happened. `LogSheet` read “same bucket” as “no change” and returned
 * before anything ran. It is not no change: a reader who re-opens a rating they have
 * already given is saying the *position* is wrong, which is the one thing re-selecting
 * the bucket ought to fix.
 *
 * `rank_rebucket` cannot do it. It raises 22023 on a bucket that is not moving, by
 * design — it exists to change a band. So there is now a `rank_again` RPC that drops
 * the position and opens a fresh session in the same band, in one transaction. The
 * server recomputes the band bounds inside its start, so the title re-enters
 * comparison against its own bucket exactly as a rebucket does against the new one.
 * The bucket never moves; the ordinal and the score may.
 *
 * **It used to be two calls from here, and that was the honest cost at the time.**
 * `rank_unrank` then `rank_start`, with no transaction around them: an unrank that
 * landed and a start that did not left the title logged, in the same bucket, without a
 * position. Nobody's data was ever wrong — the app has a name and a queue for that
 * state (`unranked_queue`) — but a reader who pressed one button and lost their
 * network in the middle got half of what they asked for, and the only repair was to
 * notice and press it again. The alternative was a migration to a ranking function,
 * and a beta already installed on two devices was not the moment to attempt one.
 *
 * `20260825000200` is that migration, and this is now a single call. If the session
 * cannot be opened, the position it was replacing is still there.
 *
 * A title that is not ranked is still not an error: it means the title lost its
 * position between the screen reading it and this call, which is the state this call
 * was trying to reach. The server takes the same reading, so there is no `P0002` to
 * absorb here any more.
 */
export const rankAgain = (mediaItemId: string, bucket: BucketId, operationId: string) =>
  call(
    'rank_again',
    { p_media_item_id: mediaItemId, p_bucket: BUCKET_VALUES[bucket], p_operation_id: operationId },
    mediaItemId,
  );

export const rankAnswer = (
  sessionId: string,
  winnerId: string,
  subjectId: string,
  operationId: string,
) =>
  call(
    'rank_answer',
    { p_session_id: sessionId, p_winner: winnerId, p_operation_id: operationId },
    subjectId,
  );

/** Re-anchors to a different opponent. The third skip places at the midpoint. */
export const rankSkip = (sessionId: string, subjectId: string, operationId: string) =>
  call('rank_skip', { p_session_id: sessionId, p_operation_id: operationId }, subjectId);

/** One comparison back. At the first, the session ends and the title stays Logged. */
export const rankBack = (sessionId: string, subjectId: string, operationId: string) =>
  call('rank_back', { p_session_id: sessionId, p_operation_id: operationId }, subjectId);

/**
 * Leaves the session. The bucket survives and the answers already given are kept.
 *
 * **The one mutating call in this file with no operation id**, and it is deliberate
 * rather than an oversight. `rank_cancel` deletes a session by id: a replay names an id
 * that is already gone — deleted by the first attempt, or by the finalise that beat it —
 * and raises `P0002`, which the line below has always read as the outcome the caller
 * wanted. A later session for the same title carries a different id and cannot be hit.
 * There is no observable a second attempt changes, which is the test
 * `lib/operation-intent.ts` sets for whether an id is worth having.
 *
 * It does take the media lock server-side (`20260825000200`), because deleting a session
 * out from under an answer that is mid-flight is a different problem from replaying one.
 */
export async function rankCancel(sessionId: string): Promise<SessionStep> {
  const { error } = await supabase.rpc('rank_cancel', { p_session_id: sessionId });
  // Already gone is the outcome the caller wanted.
  if (error && error.code !== CODES.notFound) return fail(error);
  return { state: 'ended' };
}
