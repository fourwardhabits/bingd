import * as Crypto from 'expo-crypto';

import { supabase } from '@/lib/supabase';
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
  | { outcome: 'failed'; message: string };

const interpret = (error: { code?: string; message: string } | null): WriteResult => {
  if (!error) return { outcome: 'ok' };

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
      return { outcome: 'failed', message: error.message };
  }
};

/** `{"status":"already_applied"}` is a success the caller may want to distinguish. */
const statusOf = (data: unknown): WriteResult =>
  (data as { status?: string } | null)?.status === 'already_applied'
    ? { outcome: 'already_applied' }
    : { outcome: 'ok' };

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
}): Promise<WriteResult & { noteVersion?: string }> {
  const { data, error } = await supabase.rpc('log_watched', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_watched_on: input.watchedOn ?? null,
    p_note: input.note ?? null,
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
}): Promise<WriteResult & { noteVersion?: string }> {
  const { data, error } = await supabase.rpc('save_note', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_note: input.note,
    p_base_updated_at: input.baseVersion ?? null,
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

/** The local calendar date, formatted the way the database wants it. */
export const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
