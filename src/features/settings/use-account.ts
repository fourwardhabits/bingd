import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { newOperationId } from '@/features/collection/writes';
import { diagnose } from '@/lib/diagnose';
import { supabase } from '@/lib/supabase';

export type AccountWriteResult =
  | { ok: true; avatarsRemaining?: number }
  | { ok: false; message: string };

/**
 * The writers behind Settings.
 *
 * Every one of them is an entry point to machinery that already existed and had none
 * (20260817000600): the rename triggers, the visibility column `can_view_profile` has
 * read since day one, the `read_at` column declared with the notifications table, and
 * a cascade every foreign key was given a deliberate rule for. Nothing here decides
 * anything the database has not already decided.
 *
 * One `busy` for all of them rather than a `useMutation` each, following
 * `useSocialWrites`: they are mutually exclusive by construction — each sits behind a
 * control this flag disables — so separate pending flags would be several ways to
 * express one fact.
 *
 * No optimism anywhere, for the same reason the social writes have none. A handle that
 * shows as changed and silently reverts is worse than one that takes a beat, and
 * `deleteAccount` reporting success it did not have is the one statement this surface
 * must never make.
 */
export function useAccountWrites() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const run = async (
    fn: () => PromiseLike<{ data?: unknown; error: unknown }>,
    invalidate: unknown[][] = [],
  ): Promise<AccountWriteResult> => {
    if (busy) return { ok: false, message: 'One at a time.' };
    setBusy(true);
    try {
      const { data, error } = await fn();
      if (error) {
        const message =
          diagnose(error) ??
          (error instanceof Error ? error.message : 'Something went wrong. Try again.');
        return { ok: false, message };
      }
      await Promise.all(
        invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      // Only `delete_account` returns this, and only it needs to: it cannot remove
      // storage objects — Supabase refuses direct deletion from storage tables — so it
      // counts what is left and the screen tells the person rather than claiming a
      // completeness nothing could deliver.
      const remaining = (data as { avatars_remaining?: number } | null)?.avatars_remaining;
      return { ok: true, avatarsRemaining: typeof remaining === 'number' ? remaining : undefined };
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,

    /**
     * The whole editable profile, in one call because it is one transaction.
     *
     * It replaced `updateProfile` and `changeUsername`, which were two calls behind two
     * buttons — and the founder's correction is that this exposes a seam a reader does
     * not have: "my profile" is one thing, and a screen with two saves can leave the
     * name written and the handle refused. `save_profile` cannot.
     *
     * `undefined` leaves a field alone, which is what lets the screen send only what
     * changed. The bio is the exception: `''` clears it, because null already means
     * "do not touch" and there is no third value.
     */
    saveProfile: (fields: { displayName?: string; username?: string; bio?: string }) =>
      run(
        () =>
          supabase.rpc('save_profile', {
            p_operation_id: newOperationId(),
            p_display_name: fields.displayName ?? null,
            p_username: fields.username ?? null,
            p_bio: fields.bio ?? null,
          }),
        // The name and the bio render on every social surface, so the invalidation is
        // broad for the same reason a follow's is: enumerating the surfaces precisely
        // would be a list to keep in step with every future feature.
        [['profile'], ['feed'], ['actor-activity'], ['user-search'], ['comments'], ['public-profile']],
      ),

    setVisibility: (visibility: 'public' | 'private') =>
      run(
        () =>
          supabase.rpc('set_profile_visibility', {
            p_operation_id: newOperationId(),
            p_visibility: visibility,
          }),
        // Going public approves everybody waiting, so the relationship caches and the
        // inbox both change even though the caller only touched a switch.
        [['profile'], ['relationships'], ['notifications'], ['profile-follows']],
      ),

    /**
     * Permanent, and it takes the caller's own handle to prove they meant it.
     *
     * Nothing is invalidated afterwards, deliberately: the account is gone, the session
     * is about to be ended by the caller, and warming a cache for a profile that no
     * longer exists would only produce a screen full of errors on the way out.
     */
    deleteAccount: (confirmation: string) =>
      run(() => supabase.rpc('delete_account', { p_confirmation: confirmation })),
  };
}
