import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { diagnose } from '@/lib/diagnose';
import { supabase } from '@/lib/supabase';
import { answerWasLost, useOperationIntent } from '@/lib/operation-intent';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

export type AccountWriteResult =
  | { ok: true; avatarsRemaining?: number }
  /**
   * `changed` means **the write may have happened anyway** — the same flag, and the same
   * rule, as `collection/writes.ts`. Absent means the server answered no, with a
   * SQLSTATE this app raises on purpose (`lib/write-outcome.ts`).
   *
   * `saveProfile` and `setVisibility` reconcile their own caches on it and callers need
   * nothing. **`deleteAccount` is different**, and independent review 21f found it: it
   * has no caches, it is terminal, and what it changes is whether the account exists at
   * all. Its caller has to act on this rather than show an error over a deleted account.
   */
  | { ok: false; message: string; changed?: boolean };

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
  const withIntent = useOperationIntent();

  const run = async (
    fn: () => PromiseLike<{ data?: unknown; error: unknown }>,
    invalidate: unknown[][] = [],
  ): Promise<AccountWriteResult> => {
    if (busy) return { ok: false, message: 'One at a time.' };
    setBusy(true);
    try {
      const { data, error } = await fn();

    /**
     * **Reconciled on an unknown outcome as well as on a commit.**
     *
     * A handle or a visibility that is saved and cannot say so is the worst version of this:
     * the person is told it failed, tries the same value again, and `save_profile` answers
     * 23505 because the first attempt is already stored under their own account. `lib/write-outcome.ts` is what separates a refusal this app raises on
     * purpose — which proves nothing was written — from a dropped socket, a timeout, or
     * an `08007` out of the pooler, any of which can carry a committed transaction. This
     * helper used to return on any error and refresh only afterwards, which is the defect
     * independent review 21e found in four screens; it is the same defect here.
     */
      if (mustReconcile(classifyWrite(error as { code?: string }))) {
        await Promise.all(
          invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }

      if (error) {
        const message =
          diagnose(error) ??
          (error instanceof Error ? error.message : 'Something went wrong. Try again.');
        return { ok: false, message, changed: classifyWrite(error as { code?: string }) === 'unknown' };
      }
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
          /**
           * **The intent is the values being saved**, so they are the key
           * (`lib/operation-intent.ts`).
           *
           * `save_profile` assigns, so the row converges — but it is rate-limited, and
           * this is the sequence independent review 21j named: the save commits, the
           * reply is lost, the form stays up with an error, Save is tapped again, and a
           * fresh id spends a second `profile.max_edits_per_day` slot. Repeat that and
           * the ceiling arrives early — a refusal shown to somebody whose true count
           * would still have allowed it.
           *
           * Changing a field before retrying is a different intent and correctly takes a
           * new id, because the field values are what the key is made of.
           */
          withIntent(
            `save_profile:${JSON.stringify(fields)}`,
            (operationId) =>
              supabase.rpc('save_profile', {
                p_operation_id: operationId,
                p_display_name: fields.displayName ?? null,
                p_username: fields.username ?? null,
                p_bio: fields.bio ?? null,
              }),
            answerWasLost,
          ),
        // The name and the bio render on every social surface, so the invalidation is
        // broad for the same reason a follow's is: enumerating the surfaces precisely
        // would be a list to keep in step with every future feature.
        //
        // **`my-profile` is the signed-in account's own row** — what `useCurrentProfile`
        // hands every screen in the app — and it was missing. `['profile']` does not
        // reach it: that key is `['profile', username]` and this one is
        // `['my-profile', userId]` (`lib/query.ts`). Settings invalidated it itself, on
        // success only, so a `save_profile` that committed and lost its reply left the
        // whole app showing the old handle *and* the person retrying into a 23505
        // raised by their own stored name. That is the review 21e defect with the
        // longest reach, and it is fixed here rather than in the screen so that every
        // caller of this writer gets it.
        [
          ['my-profile'],
          ['profile'],
          ['feed'],
          ['actor-activity'],
          ['user-search'],
          ['comments'],
          ['public-profile'],
        ],
      ),

    setVisibility: (visibility: 'public' | 'private') =>
      run(
        () =>
          // Rate-limited like the save above, and the switch is if anything easier to
          // press twice. The value is the intent.
          withIntent(
            `set_profile_visibility:${visibility}`,
            (operationId) =>
              supabase.rpc('set_profile_visibility', {
                p_operation_id: operationId,
                p_visibility: visibility,
              }),
            answerWasLost,
          ),
        // Going public approves everybody waiting, so the relationship caches and the
        // inbox both change even though the caller only touched a switch. `my-profile`
        // for the same reason as above: the switch renders from the reader's own row.
        [['my-profile'], ['profile'], ['relationships'], ['notifications'], ['profile-follows']],
      ),

    /**
     * Permanent, and it takes the caller's own handle to prove they meant it.
     *
     * Nothing is invalidated afterwards, deliberately: the account is gone, the session
     * is about to be ended by the caller, and warming a cache for a profile that no
     * longer exists would only produce a screen full of errors on the way out.
     *
     * **So the ambiguity has to travel instead of being reconciled here.** There is no
     * cache that answers "does this account still exist" — the answer is on the server,
     * and the way to get it is to ask the function again. `delete_account` is idempotent
     * *by nature* rather than by operation id (`20260817000700`): with the profile
     * already gone it returns `already_applied` before it even checks the confirmation,
     * because the ledger that would record the claim is deleted by the operation itself.
     * The caller in `app/settings/account.tsx` is what uses that.
     */
    deleteAccount: (confirmation: string) =>
      run(() => supabase.rpc('delete_account', { p_confirmation: confirmation })),
  };
}
