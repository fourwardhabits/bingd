import * as Crypto from 'expo-crypto';

import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';
import type { BucketId } from '@/ui/components';

/**
 * The client half of the collection writers (20260813002300).
 *
 * Every one of them takes an operation id as its first argument and records it in
 * `processed_operations`, so a retry of the same intent is answered
 * `{"status":"already_applied"}` rather than applied twice. That only works if the id
 * belongs to the *intent* and not to the attempt: generating a fresh one inside the retry
 * would defeat the entire mechanism, which is why `newOperationId` is called by the caller
 * that owns the user's action and passed in, never called in here.
 */

/** A v4 uuid from the platform CSPRNG. */
export const newOperationId = () => Crypto.randomUUID();

/**
 * The database's bucket names. The UI's `notForMe` is camel case because it is a
 * TypeScript identifier; the enum value is `not_for_me`. Mapping them in one place beats
 * discovering the mismatch as a 22P02 at runtime.
 */
const BUCKET_VALUES: Record<BucketId, string> = {
  loved: 'loved',
  fine: 'fine',
  notForMe: 'not_for_me',
};

/**
 * SQLSTATEs, not messages, for the same reason as `create-profile.ts`: the messages are
 * for whoever reads the logs and get reworded, and matching on them fails silently.
 */
const CODES = {
  /** Raised by the writers' own validation: a series, a future date, an over-long note. */
  invalidInput: '22023',
  /** assert_can_write on a suspended account. */
  suspended: '42501',
  unauthenticated: '28000',
  /**
   * _assert_unranked: the title already has a position, so the bucket cannot move
   * without re-ranking. `save_note` uses the same SQLSTATE for its conflict, which is
   * why this module maps it per function rather than globally.
   */
  ranked: '55000',
  /** No such title, or nothing to change. */
  notFound: 'P0002',
} as const;

export type WriteResult =
  | { outcome: 'ok' }
  /** The server had already applied this operation id. Treated as success. */
  | { outcome: 'already_applied' }
  /** Refused because ranking owns the bucket now; the user must re-rank to change it. */
  | { outcome: 'ranked' }
  /**
   * `changed` means **the server may already have written something**, so the caller
   * still has caches to reconcile even though it is about to show an error.
   *
   * Two ways it gets set, and reviews 21c, 21d and 21e each sharpened the second:
   *
   * - a writer that is more than one request failed after an earlier one landed;
   * - **the outcome of this request is unknown** — `lib/write-outcome.ts` classifies
   *   that, and the rule is *not* "the error has no code". 21d's version tested for a
   *   SQLSTATE, and 21e answered it with `08007 transaction_resolution_unknown`: a
   *   SQLSTATE whose entire meaning is that the commit outcome is unknown. Only a code
   *   this app raises on purpose proves a refusal. Everything else may have landed.
   *
   * Absent means the server answered no, which stays the ordinary case.
   *
   * **`mustReconcile` below is how a caller should read this.** Testing
   * `outcome === 'failed'` first and returning is the bug review 21e found in four
   * separate screens.
   */
  | { outcome: 'failed'; message: string; changed?: boolean };

/**
 * Whether the caller must reconcile the canonical state this write touches, whatever it
 * is about to put on screen.
 *
 * **True on success and true on an unknown failure.** Four callers reconciled on success
 * and returned early on failure, so the one case that most needed a refetch — a write
 * that committed and could not say so — was the only one that never got one (independent
 * review 21e, Major 3). Reading the flag through a named function is what makes the next
 * caller do it too.
 */
export const mustReconcile = (result: WriteResult) =>
  result.outcome !== 'failed' || result.changed === true;

const interpret = (error: { code?: string; message: string } | null): WriteResult => {
  if (!error) return { outcome: 'ok' };

  /**
   * **Classified before it is worded**, because those are two different questions.
   *
   * `classifyWrite` answers "did this commit"; the switch below answers "what does the
   * person read". They used to be one expression keyed on `error.code`, which is how the
   * default branch came to read every coded error as a definite rollback.
   */
  const ambiguous = classifyWrite(error) === 'unknown' ? { changed: true as const } : {};

  switch (error.code) {
    case CODES.ranked:
      return { outcome: 'ranked' };
    case CODES.invalidInput:
      // The server's message is the useful one here — it distinguishes a series from a
      // future date from an over-long note, and the UI has nothing better to say.
      return { outcome: 'failed', message: error.message };
    case CODES.suspended:
      return { outcome: 'failed', message: 'Your account cannot make changes right now.' };
    case CODES.unauthenticated:
      return { outcome: 'failed', message: 'Your session expired. Sign in again.' };
    case CODES.notFound:
      return { outcome: 'failed', message: 'That title is no longer in the catalogue.' };
    default:
      // Everything the five above do not name: an unrecognised SQLSTATE, the `08`
      // connection class, a dropped socket, a gateway's HTML. `ambiguous` is empty only
      // for a code `REFUSAL_CODES` recognises, which is the one thing that proves the
      // server declined.
      return { outcome: 'failed', message: error.message, ...ambiguous };
  }
};

/** `{"status":"already_applied"}` is a success the caller may want to distinguish. */
const statusOf = (data: unknown): WriteResult =>
  (data as { status?: string } | null)?.status === 'already_applied'
    ? { outcome: 'already_applied' }
    : { outcome: 'ok' };

/**
 * Who may read a note.
 *
 * Sent on every write the user makes from the note editor, rather than left to the
 * server's default, because the editor shows the current setting: the state the user
 * saw is then the state that gets stored, and neither side has to infer the other's
 * intent. Omitting it means "leave whatever is there alone", which is what a caller
 * that is not editing visibility wants (20260816000000 §1).
 */
export type NoteVisibility = 'public' | 'private';

/**
 * Bucketing implies logging: `set_bucket` creates the `user_media` row when absent, so one
 * tap is one round trip. It deliberately does **not** start comparisons — that is a
 * separate action the user takes on purpose (PRD §11, api.md §1).
 */
export async function setBucket(input: {
  operationId: string;
  mediaItemId: string;
  bucket: BucketId;
}): Promise<WriteResult> {
  const { data, error } = await supabase.rpc('set_bucket', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_bucket: BUCKET_VALUES[input.bucket],
  });

  return error ? interpret(error) : statusOf(data);
}

/**
 * A watch date, a note, or both.
 *
 * `watchedOn` is a local calendar date as `YYYY-MM-DD` and not a timestamp: what the user
 * means by "last night" is a date in their own timezone, and sending an instant would let
 * the server's UTC day disagree with the one they were looking at.
 *
 * Omitting a field leaves the stored value alone rather than clearing it — the server
 * coalesces — so this cannot be used to erase a note. Clearing one goes through
 * `saveNote` with an empty string.
 */
export async function logWatched(input: {
  operationId: string;
  mediaItemId: string;
  watchedOn?: string | null;
  note?: string | null;
  noteVisibility?: NoteVisibility | null;
  noteSpoilers?: boolean | null;
}): Promise<WriteResult & { noteVersion?: string }> {
  const { data, error } = await supabase.rpc('log_watched', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_watched_on: input.watchedOn ?? null,
    p_note: input.note ?? null,
    p_note_visibility: input.noteVisibility ?? null,
    p_note_spoilers: input.noteSpoilers ?? null,
  });

  if (error) return interpret(error);

  const result = data as { status?: string; note_version?: string } | null;
  return { ...statusOf(data), noteVersion: result?.note_version };
}

/**
 * Writes a note, including clearing one.
 *
 * Separate from `log_watched` because that one coalesces: it can create a note and can
 * never erase one, so a user deleting their note through it would watch the old text
 * come back on the next read. `save_note` assigns directly.
 *
 * `baseVersion` is the `note_updated_at` the edit was based on. When it disagrees with
 * the stored one the server refuses with 55000 rather than overwriting, which is the
 * mechanism behind offline-sync.md §5's "local drafts are never silently overwritten".
 * Null skips the check and is only correct where no version was ever issued.
 *
 * Requires the row to exist — `P0002` otherwise. Use `logWatched` to create it.
 */
export async function saveNote(input: {
  operationId: string;
  mediaItemId: string;
  note: string;
  baseVersion?: string | null;
  noteVisibility?: NoteVisibility | null;
  noteSpoilers?: boolean | null;
}): Promise<WriteResult & { noteVersion?: string }> {
  const { data, error } = await supabase.rpc('save_note', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_note: input.note,
    p_base_updated_at: input.baseVersion ?? null,
    p_note_visibility: input.noteVisibility ?? null,
    p_note_spoilers: input.noteSpoilers ?? null,
  });

  if (error) {
    // save_note reuses 55000 for its conflict, where `interpret` reads it as "ranking
    // owns this". A note has nothing to do with ranking, so it is mapped here instead.
    if (error.code === CODES.ranked) {
      return {
        outcome: 'failed',
        message: 'This note changed somewhere else. Reopen it to see the latest.',
      };
    }
    return interpret(error);
  }

  const result = data as { status?: string; note_version?: string } | null;
  return { ...statusOf(data), noteVersion: result?.note_version };
}

/**
 * Adds or removes a title from the watchlist.
 *
 * This accepts movies, series, and seasons. Series are intentionally allowed here:
 * "want to watch this show" is coherent even though logging/ranking requires season-level
 * granularity.
 */
export async function setWatchlist(input: {
  operationId: string;
  mediaItemId: string;
  present: boolean;
}): Promise<WriteResult> {
  const { data, error } = await supabase.rpc('set_watchlist', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_present: input.present,
  });

  return error ? interpret(error) : statusOf(data);
}

/**
 * Takes a title's position away and leaves the rest of the collection alone.
 *
 * `rank_unrank` (20260813000700) deletes the row and closes the gap behind it, so
 * everything below moves up one and the band stays contiguous. The `user_media` row
 * survives: the person still watched it, they simply no longer have it placed. That is
 * the whole point of offering this separately from removal — an accidental comparison
 * is a mistake about an ordering, not about having seen the film.
 *
 * No operation id, because the server's function does not take one. It is idempotent by
 * shape rather than by ledger: a second call finds nothing to delete and answers P0002,
 * which reads here as "it is already not ranked" and is mapped to success by the caller
 * rather than surfaced as a failure the user cannot act on.
 */
export async function unrank(mediaItemId: string): Promise<WriteResult> {
  const { error } = await supabase.rpc('rank_unrank', { p_media_item_id: mediaItemId });

  // P0002 from this function means "there was no ranking to remove", which is the state
  // the caller asked for. `interpret` reads that code as a missing catalogue row, which
  // is right for every other writer and wrong here, so it is answered before it gets there.
  if (error?.code === CODES.notFound) return { outcome: 'ok' };
  return interpret(error);
}

/**
 * Removes a title from the collection outright.
 *
 * `unlog` refuses a ranked title — `_assert_unranked` — which is deliberate on the
 * server and awkward on the client, because "remove this from my collection" is one
 * intent to the person pressing it. So the two steps are joined here rather than in the
 * screen: unrank first if it is ranked, then delete the row. Both are the user's own
 * data and both are already granted; there is no new function and no migration behind
 * this.
 *
 * The operation id belongs to the *intent*, so a retry of the same removal is answered
 * `already_applied` rather than applied twice — which is why it is passed in rather than
 * minted here (see the module header).
 *
 * **The activity goes with it, and the server does that.** `unlog` deletes the caller's
 * `title_ranked`, `title_logged` and `season_completed` events for the title, and their
 * reactions and comments cascade (`20260818000100`). It was a known gap until then: the
 * collection said the title was gone and the feed went on saying it was ranked. Nothing
 * here filters for it, deliberately — a rule enforced by a client predicate is a rule
 * the next client forgets.
 */
export async function removeFromCollection(input: {
  operationId: string;
  mediaItemId: string;
  /** Skips a pointless round trip for a title that was never ranked. */
  wasRanked: boolean;
}): Promise<WriteResult> {
  let removedRanking = false;

  if (input.wasRanked) {
    // A refusal here stops the delete rather than being retried into it: `unlog` would
    // only refuse in turn, and reporting the second refusal would name the wrong cause.
    // `unrank` already carries `changed` when its own outcome was unknown, so a caller
    // reading the result through `mustReconcile` refreshes on the way out either way.
    const cleared = await unrank(input.mediaItemId);
    if (cleared.outcome === 'failed') return cleared;
    removedRanking = true;
  }

  const { data, error } = await supabase.rpc('unlog', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
  });

  const result = error ? interpret(error) : statusOf(data);
  if (result.outcome !== 'failed') return result;

  /**
   * **This is two writes, so it has a middle** — and the middle turned out to have a
   * middle of its own.
   *
   * Review 21c found the first half: `rank_unrank` succeeds, `unlog` fails, the ranking
   * is gone and the title is still logged, and the caller skips invalidation because the
   * result says `failed`. Review 21d found that `changed` as I first wrote it only
   * described **acknowledged** success. A request can commit and lose its reply, and the
   * client cannot tell that apart from a refusal — so `rank_unrank` committing and then
   * timing out came back as a plain failure with nothing to say the ranking had gone.
   *
   * Review 21e then found that 21d's distinction was itself too generous. "A SQLSTATE
   * means the server answered" is false for `08007 transaction_resolution_unknown` and
   * for the rest of the `08` connection class. The rule that survives is in
   * `lib/write-outcome.ts`: **only a code this app raises on purpose proves a refusal**.
   * So `unlog`'s own ambiguity is already on `result`, and all this line adds is the
   * ranking that certainly went.
   */
  return removedRanking ? { ...result, changed: true } : result;
}

/** The local calendar date, formatted the way the database wants it. */
export const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
