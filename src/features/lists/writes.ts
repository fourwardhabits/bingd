import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

import type { ListOrderStyle, ListVisibility } from './types';

/**
 * The client half of the list writers (20261010000100).
 *
 * Every RPC takes `p_operation_id` first, and — following `collection/writes.ts`'s rule
 * — **the id belongs to the intent, never to the attempt**. It is passed in by whoever
 * owns the user's action, so a retry after a lost reply carries the same id and the
 * server's ledger can do its job. Generating one in here would defeat the mechanism
 * silently, which is exactly how every writer in this app was broken until review 21i.
 *
 * The answers are statuses rather than raises wherever the person can do something
 * about them — `profile_private` needs a sentence about making the profile public,
 * `list_limit` needs a different one — because a raise carries a SQLSTATE and not an
 * intention.
 */

const CODES = {
  invalidInput: '22023',
  suspended: '42501',
  unauthenticated: '28000',
  notFound: 'P0002',
  rateLimited: '53400',
  /** A declared CHECK: a title over 100 characters, a description over 1000. */
  checkViolation: '23514',
} as const;

export type ListWriteFailure = {
  outcome: 'failed';
  message: string;
  /**
   * The server **may** have written something. True for success and for an unknown
   * outcome alike, which is the asymmetry `lib/write-outcome.ts` exists to keep: the
   * write that committed and could not say so is the one that most needs a refetch.
   */
  changed?: boolean;
};

export type ListWriteResult =
  | { outcome: 'ok' }
  | { outcome: 'already_applied' }
  /** The caller's profile is private, so `public` is not available (§F.3). */
  | { outcome: 'profile_private' }
  /** Past `lists.max_per_user`. A sanity ceiling, not a tier (§P.1). */
  | { outcome: 'list_limit' }
  /** Past `lists.max_items` on this list. */
  | { outcome: 'item_limit' }
  /** The list is hidden by moderation, so its visibility is frozen (§F.10). */
  | { outcome: 'hidden' }
  | ListWriteFailure;

/** True when the caller must reconcile its caches, whatever it is about to show. */
export const mustReconcile = (result: ListWriteResult) =>
  result.outcome !== 'failed' || result.changed === true;

const interpret = (error: { code?: string; message: string } | null): ListWriteFailure | null => {
  if (!error) return null;

  const ambiguous = classifyWrite(error) === 'unknown' ? { changed: true as const } : {};

  switch (error.code) {
    case CODES.suspended:
      return { outcome: 'failed', message: 'Your account cannot make changes right now.' };
    case CODES.unauthenticated:
      return { outcome: 'failed', message: 'Your session expired. Sign in again.' };
    case CODES.notFound:
      return { outcome: 'failed', message: 'That list is no longer available.' };
    case CODES.rateLimited:
      return { outcome: 'failed', message: 'You have made a lot of lists today. Try again later.' };
    case CODES.checkViolation:
      return { outcome: 'failed', message: 'That title or description is too long.' };
    case CODES.invalidInput:
      // The server's own message distinguishes an empty title from an unknown order
      // style from a title that cannot be listed, and the UI has nothing better.
      return { outcome: 'failed', message: error.message };
    default:
      return { outcome: 'failed', message: error.message, ...ambiguous };
  }
};

/** Maps a server `{status}` onto the result union. Unknown statuses read as success. */
const fromStatus = (data: unknown): ListWriteResult => {
  const status = (data as { status?: string } | null)?.status;
  switch (status) {
    case 'already_applied':
      return { outcome: 'already_applied' };
    case 'profile_private':
      return { outcome: 'profile_private' };
    case 'list_limit':
      return { outcome: 'list_limit' };
    case 'item_limit':
      return { outcome: 'item_limit' };
    case 'hidden':
      return { outcome: 'hidden' };
    default:
      return { outcome: 'ok' };
  }
};

export type CreateListResult =
  | {
      outcome: 'ok';
      id: string;
      /**
       * In-app lists owned **before** this one. The source of truth for
       * `would_have_exceeded_3_lists` (§M), and the reason it is returned at all: a
       * later SQL snapshot cannot see a list that was created and then deleted.
       */
      inAppCountBefore: number;
    }
  | Exclude<ListWriteResult, { outcome: 'ok' }>;

export async function createList(input: {
  operationId: string;
  title: string;
  description?: string | null;
  visibility: ListVisibility;
  orderStyle: ListOrderStyle;
  /** A title chosen before the list existed — the ⋯ → Add to list… path with no lists. */
  firstMediaItemId?: string | null;
}): Promise<CreateListResult> {
  const { data, error } = await supabase.rpc('create_list', {
    p_operation_id: input.operationId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_visibility: input.visibility,
    p_order_style: input.orderStyle,
    p_first_media_item_id: input.firstMediaItemId ?? null,
  });

  const failure = interpret(error);
  if (failure) return failure;

  const row = data as { status?: string; id?: string; in_app_count_before?: number } | null;
  const mapped = fromStatus(row);
  if (mapped.outcome !== 'ok' || !row?.id) {
    return mapped as Exclude<ListWriteResult, { outcome: 'ok' }>;
  }

  return { outcome: 'ok', id: row.id, inAppCountBefore: row.in_app_count_before ?? 0 };
}

export async function updateList(input: {
  operationId: string;
  listId: string;
  /** Omitted means "leave it alone". An empty description clears it; the server coalesces. */
  title?: string | null;
  description?: string | null;
  visibility?: ListVisibility | null;
  orderStyle?: ListOrderStyle | null;
}): Promise<ListWriteResult> {
  const { data, error } = await supabase.rpc('update_list', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_visibility: input.visibility ?? null,
    p_order_style: input.orderStyle ?? null,
  });

  return interpret(error) ?? fromStatus(data);
}

export async function deleteList(input: {
  operationId: string;
  listId: string;
}): Promise<ListWriteResult> {
  const { data, error } = await supabase.rpc('delete_list', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
  });

  return interpret(error) ?? fromStatus(data);
}

export type AddItemResult =
  | { outcome: 'added'; countAfter: number }
  /** The title was already on the list. A double tap, not a failure. */
  | { outcome: 'already'; countAfter: number }
  | Exclude<ListWriteResult, { outcome: 'ok' }>;

export async function addListItem(input: {
  operationId: string;
  listId: string;
  mediaItemId: string;
}): Promise<AddItemResult> {
  const { data, error } = await supabase.rpc('add_list_item', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
    p_media_item_id: input.mediaItemId,
  });

  const failure = interpret(error);
  if (failure) return failure;

  const row = data as { status?: string; count_after?: number } | null;
  const countAfter = row?.count_after ?? 0;

  if (row?.status === 'added') return { outcome: 'added', countAfter };
  if (row?.status === 'already') return { outcome: 'already', countAfter };

  const mapped = fromStatus(row);
  // A replay is answered with the stored answer, which for a first-time add is
  // `added` — so `already_applied` only reaches here from a writer with no stored
  // result, and reads as a benign success.
  return mapped.outcome === 'ok'
    ? { outcome: 'already', countAfter }
    : (mapped as Exclude<ListWriteResult, { outcome: 'ok' }>);
}

export async function removeListItem(input: {
  operationId: string;
  listId: string;
  mediaItemId: string;
}): Promise<ListWriteResult> {
  const { data, error } = await supabase.rpc('remove_list_item', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
    p_media_item_id: input.mediaItemId,
  });

  return interpret(error) ?? fromStatus(data);
}

/**
 * Moves one item to a zero-based index.
 *
 * One item, not an order. Two devices each sending an array would overwrite each other
 * silently; two devices each naming an item resolve to last-move-wins, which is both
 * what a person expects and the whole of the conflict story (§E).
 */
export async function moveListItem(input: {
  operationId: string;
  listId: string;
  mediaItemId: string;
  toIndex: number;
}): Promise<ListWriteResult> {
  const { data, error } = await supabase.rpc('move_list_item', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
    p_media_item_id: input.mediaItemId,
    p_to_index: input.toIndex,
  });

  return interpret(error) ?? fromStatus(data);
}

export type BulkWatchlistResult =
  | { outcome: 'ok'; added: number; skippedSeen: number; skippedPresent: number }
  | Exclude<ListWriteResult, { outcome: 'ok' }>;

/**
 * Every unseen, unsaved title on a readable list, onto the caller's own Watchlist.
 *
 * It writes **no feed events**, which is why it is one RPC rather than a loop over
 * `setWatchlist`: twenty activity rows from one tap is the feature announcing itself,
 * and §K says the bulk add is silent.
 */
export async function addListToWatchlist(input: {
  operationId: string;
  listId: string;
}): Promise<BulkWatchlistResult> {
  const { data, error } = await supabase.rpc('add_list_to_watchlist', {
    p_operation_id: input.operationId,
    p_list_id: input.listId,
  });

  const failure = interpret(error);
  if (failure) return failure;

  const row = data as
    | { status?: string; added?: number; skipped_seen?: number; skipped_present?: number }
    | null;

  const mapped = fromStatus(row);
  if (mapped.outcome !== 'ok' && mapped.outcome !== 'already_applied') {
    return mapped as Exclude<ListWriteResult, { outcome: 'ok' }>;
  }

  return {
    outcome: 'ok',
    added: row?.added ?? 0,
    skippedSeen: row?.skipped_seen ?? 0,
    skippedPresent: row?.skipped_present ?? 0,
  };
}

/**
 * What the bulk add says afterwards.
 *
 * Its own function so the sentence is tested rather than inspected. The second clause
 * appears only when something was actually skipped — "5 you've seen were skipped" under
 * a list nobody has seen any of is a fact about nothing.
 */
export function bulkWatchlistMessage(result: {
  added: number;
  skippedSeen: number;
}): string {
  const added =
    result.added === 0
      ? 'Nothing new to add.'
      : `Added ${result.added} to your Watchlist.`;

  if (result.skippedSeen === 0) return added;

  return `${added} ${result.skippedSeen} you've seen ${
    result.skippedSeen === 1 ? 'was' : 'were'
  } skipped.`;
}
