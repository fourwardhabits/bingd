import { newOperationId, interpret, type WriteResult } from '@/features/collection/writes';
import { supabase } from '@/lib/supabase';
import type { BucketId } from '@/ui/components';

import type { WatchBasis } from './watch-history';

/**
 * The watch-history writers (§D.5).
 *
 * Every one of them is an RPC added by `20261003000100` or `20261005000100`, and every
 * one takes a `basis` — the thing the old surface could not say. `log_watched(date)` is
 * what a client called when it had no way to distinguish a date the reader chose from
 * one the sheet defaulted, and §C.3.8 is the cost of that silence: every in-app date in
 * the product is of unknown provenance, and nothing can find the ones that were
 * fabricated because nothing recorded that they were.
 *
 * **These functions never guess.** `today_default` is only sent when the sheet actually
 * offered Today and the reader kept it; `reader` only when they chose. Nothing here ever
 * sends `diary`: that basis belongs to the importer and the server refuses it from a
 * client.
 */

const statusOf = (data: unknown): WriteResult =>
  (data as { status?: string } | null)?.status === 'already_applied'
    ? { outcome: 'already_applied' }
    : { outcome: 'ok' };

const BUCKET_VALUES: Record<BucketId, string> = {
  loved: 'loved',
  fine: 'fine',
  notForMe: 'not_for_me',
};

/**
 * The normal log, in one call.
 *
 * Replaces LogSheet's `set_bucket` followed by a read-back followed by
 * `log_watched(today)`, and the residual race between them that the sheet's own comment
 * named as accepted: "the instant between that answer and the write — a date recorded on
 * another device in that gap needs a server-side conditional write, which the beta
 * accepts as a residual risk". The condition — *only when this call creates the seen
 * row* — is now evaluated inside the lock.
 *
 * On a title that is already seen it sets the bucket and **ignores the date**, which is
 * §D.6 path 3 enforced in the server: ranking a title says it was seen, not when.
 */
export async function logTitle(input: {
  operationId: string;
  mediaItemId: string;
  bucket: BucketId;
  watchedOn: string | null;
  basis: Exclude<WatchBasis, 'diary'>;
}): Promise<WriteResult & { watchEventId?: string; created?: boolean }> {
  const { data, error } = await supabase.rpc('log_title', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_bucket: BUCKET_VALUES[input.bucket],
    p_watched_on: input.watchedOn,
    p_basis: input.basis,
  });

  if (error) return interpret(error);
  const row = data as { watch_event_id?: string; created?: boolean } | null;
  return { ...statusOf(data), watchEventId: row?.watch_event_id, created: row?.created };
}

/**
 * The When row, on a title with **exactly one** viewing.
 *
 * The server refuses `P0001 multiple_watches` when there are several, and the sheet then
 * shows `Watched 3 times ›` in place of the date row (§J.2). That refusal is the product
 * decision made structural: one date control cannot honestly represent six viewings, and
 * silently editing "the latest one" is a write nobody could predict from the screen they
 * were looking at.
 */
export async function setWatchDate(input: {
  operationId: string;
  mediaItemId: string;
  watchedOn: string | null;
  basis: Exclude<WatchBasis, 'diary'>;
}): Promise<WriteResult & { multiple?: boolean }> {
  const { data, error } = await supabase.rpc('set_watch_date', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_watched_on: input.watchedOn,
    p_basis: input.basis,
  });

  if (error) {
    // `P0001 multiple_watches` is an answer, not a failure: it tells the sheet which
    // control to draw. Distinguished here rather than by matching the message upstream.
    if (error.code === 'P0001' && String(error.message).includes('multiple_watches')) {
      return { ...interpret(error), multiple: true };
    }
    return interpret(error);
  }
  return statusOf(data);
}

/** Another viewing of a title already in the collection (§D.5). */
export async function logRewatch(input: {
  operationId: string;
  mediaItemId: string;
  watchedOn: string | null;
  basis: Exclude<WatchBasis, 'diary'>;
}): Promise<WriteResult & { watchEventId?: string; watchCount?: number; posted?: boolean }> {
  const { data, error } = await supabase.rpc('log_rewatch', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_watched_on: input.watchedOn,
    p_basis: input.basis,
  });

  if (error) return interpret(error);
  const row = data as
    | { watch_event_id?: string; watch_count?: number; posted?: boolean }
    | null;
  return {
    ...statusOf(data),
    watchEventId: row?.watch_event_id,
    watchCount: row?.watch_count,
    posted: row?.posted,
  };
}

/** One row's date, changed or cleared. It never creates a viewing (§D.5). */
export async function editWatchEvent(input: {
  operationId: string;
  watchEventId: string;
  watchedOn: string | null;
  basis: Extract<WatchBasis, 'reader' | 'none'>;
}): Promise<WriteResult> {
  const { data, error } = await supabase.rpc('edit_watch_event', {
    p_operation_id: input.operationId,
    p_watch_event_id: input.watchEventId,
    p_watched_on: input.watchedOn,
    p_basis: input.basis,
  });

  return error ? interpret(error) : statusOf(data);
}

/**
 * One viewing, removed.
 *
 * `lastWatch` is the server refusing to leave a collection row with no viewing behind it
 * (`P0001 last_watch`). The screen turns that into *Remove from collection…* rather than
 * an error: the reader asked to undo the only record of having watched it, and what they
 * mean is the title should not be in the collection.
 */
export async function deleteWatchEvent(input: {
  operationId: string;
  watchEventId: string;
}): Promise<WriteResult & { lastWatch?: boolean; watchCount?: number }> {
  const { data, error } = await supabase.rpc('delete_watch_event', {
    p_operation_id: input.operationId,
    p_watch_event_id: input.watchEventId,
  });

  if (error) {
    if (error.code === 'P0001' && String(error.message).includes('last_watch')) {
      return { ...interpret(error), lastWatch: true };
    }
    return interpret(error);
  }
  const row = data as { watch_count?: number } | null;
  return { ...statusOf(data), watchCount: row?.watch_count };
}

export { newOperationId };
