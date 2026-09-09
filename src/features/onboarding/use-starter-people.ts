import { useQuery } from '@tanstack/react-query';

import type { PeopleStepVariant } from '@/lib/analytics';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * Step 9's read: the account's social neighbourhood, decided once, on entry.
 *
 * ---------------------------------------------------------------------------
 * THE STATE IS DECIDED BY WHAT THE ACCOUNT HAS, NOT BY A FLAG
 *
 * There is no persona, no signup-source column and no branch on how somebody arrived.
 * The question is asked of the data (`03-social-activation.md` §2):
 *
 * ```
 *   read the account's social neighbourhood
 *     ├─ an inviter exists                → CONNECTED
 *     │    ├─ and mutual candidates exist →   with a short list
 *     │    └─ and none exist              →   with an invite offer
 *     ├─ no inviter, read succeeded       → START YOUR FEED
 *     └─ error                            → COULD NOT LOAD
 * ```
 *
 * ---------------------------------------------------------------------------
 * **A FAILURE RESOLVES TO C AND NEVER TO B**, WHICH IS THE WHOLE POINT
 *
 * This is the one rule in the step worth defending in code rather than in copy. "We could
 * not find out" and "there is nobody" are different sentences, and telling an invited
 * person they are alone because a request timed out is the worst thing this step could
 * say.
 *
 * So this query **throws** on error rather than resolving to an empty list, and the screen
 * draws its own third state from `isError`. That is deliberately the opposite of the
 * `withGrace` habit the flow uses elsewhere: grace is right when the fallback is
 * *harmless*, and here the fallback would be a claim about somebody's friends.
 *
 * It is also why there is one query rather than three. A composite read cannot end up half
 * answered — with an inviter but no mutuals because the second call failed, which would
 * silently downgrade `connected` to `connected_alone` and offer an invite link to somebody
 * whose friends were simply unreachable.
 */

export type StarterPerson = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** True when the account is private, so the control offers Request rather than Follow. */
  isPrivate: boolean;
  context:
    /** A friend of a friend. Only ever reached through an inviter. */
    | { kind: 'mutuals'; count: number; names: string[] }
    /**
     * A stranger who is worth following, described by two counts and never by a score.
     * `shared` is titles this account and the reader have both ranked.
     */
    | { kind: 'starter'; shared: number; ranked: number };
};

export type Inviter = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /**
   * What actually exists between the two accounts, rather than what redemption intended.
   *
   * Read rather than assumed. `20260912000200` makes a **personal** invitation a mutual,
   * approved follow in all four visibility combinations, so this is `mutual` for every
   * account that arrived on one — but a `referral` token still writes a single edge, and
   * an invitee who already followed their inviter keeps whatever they had. The row prints
   * what is true, and the flow does not have to trust a migration to know it.
   */
  connection: 'mutual' | 'following' | 'none';
};

export type StarterPeople = {
  variant: Exclude<PeopleStepVariant, 'could_not_load'>;
  inviter: Inviter | null;
  people: StarterPerson[];
};

type ProfileRow = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: string;
};

type SuggestionRow = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: string;
  shared_count: number;
  ranked_count: number;
};

type MutualRow = Omit<SuggestionRow, 'shared_count' | 'ranked_count'> & {
  mutual_count: number;
  mutual_names: string[] | null;
};

const identity = (row: { user_id: string } & Omit<ProfileRow, 'id'>) => ({
  id: row.user_id,
  username: row.username,
  name: row.display_name || row.username,
  avatarUri: avatarUri(row.avatar_path),
  isPrivate: row.visibility === 'private',
});

/**
 * How many rows the step shows. Three to five, and never a browser.
 *
 * This is not the People surface with a different header: there are no mode chips, no
 * search and no pagination. Somebody in the middle of signing up is being offered a short,
 * considered list, and a scrollable directory at this moment is a decision to make rather
 * than an invitation to accept.
 */
export const STARTER_LIMIT = 5;

export function useStarterPeople(userId: string) {
  return useQuery({
    // Keyed by the viewer, like every viewer-relative key in this app: the answer is
    // entirely about who is asking, and a cache entry reachable from a second account on
    // the same device is a defect two independent reviews have already found elsewhere.
    queryKey: ['onboarding-starter-people', userId],
    /**
     * Read once and then left alone.
     *
     * The variant reported to analytics is the branch drawn **on entry**, and following
     * somebody from this screen changes the answer the underlying queries would give — the
     * first follow makes `people_mutuals` reachable and removes a row from
     * `people_starter_suggestions`. A list that re-sorted itself under the reader's thumb
     * as they used it is the same bug the taste flow fixed by taking its entry decision
     * once, one surface over.
     */
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<StarterPeople> => {
      /**
       * Who invited this account, read from the attribution row itself.
       *
       * The invitee is entitled to this: `invite_attributions_read` admits both parties,
       * for exactly this reason. `maybeSingle` because most accounts have no inviter, and
       * that is a fact rather than a failure.
       */
      const { data: attribution, error: attributionError } = await supabase
        .from('invite_attributions')
        .select('inviter_id, profiles:inviter_id (id, username, display_name, avatar_path, visibility)')
        .eq('invitee_id', userId)
        .maybeSingle();
      if (attributionError) throw attributionError;

      const inviterProfile = (attribution?.profiles ?? null) as ProfileRow | null;

      if (inviterProfile) {
        const [{ data: edges, error: edgeError }, { data: mutuals, error: mutualError }] =
          await Promise.all([
            supabase.rpc('follow_state_with', { p_user_ids: [inviterProfile.id] }),
            supabase.rpc('people_mutuals', { p_limit: STARTER_LIMIT }),
          ]);
        if (edgeError) throw edgeError;
        if (mutualError) throw mutualError;

        const edge = ((edges ?? []) as { following: boolean; followed_by: boolean }[])[0];
        const connection: Inviter['connection'] = !edge?.following
          ? 'none'
          : edge.followed_by
            ? 'mutual'
            : 'following';

        const people = ((mutuals ?? []) as MutualRow[])
          // The inviter is already acknowledged at the top of the screen with no control.
          // Repeating them in "People you may know" would be the flow forgetting itself.
          .filter((row) => row.user_id !== inviterProfile.id)
          .map((row) => ({
            ...identity(row),
            context: {
              kind: 'mutuals' as const,
              count: row.mutual_count,
              names: row.mutual_names ?? [],
            },
          }));

        return {
          variant: people.length > 0 ? 'connected' : 'connected_alone',
          inviter: {
            id: inviterProfile.id,
            username: inviterProfile.username,
            name: inviterProfile.display_name || inviterProfile.username,
            avatarUri: avatarUri(inviterProfile.avatar_path),
            connection,
          },
          people,
        };
      }

      const { data: starters, error: starterError } = await supabase.rpc(
        'people_starter_suggestions',
        { p_limit: STARTER_LIMIT },
      );
      if (starterError) throw starterError;

      const people = ((starters ?? []) as SuggestionRow[]).map((row) => ({
        ...identity(row),
        context: {
          kind: 'starter' as const,
          shared: row.shared_count,
          ranked: row.ranked_count,
        },
      }));

      /**
       * Which of the two organic orderings the reader met.
       *
       * Reported so the weekly read can tell a list justified by real overlap from one
       * justified only by activity, because the two are worth very different amounts and
       * a single "organic" number would average them into something meaningless.
       */
      return {
        variant: people.some((person) => person.context.kind === 'starter' && person.context.shared > 0)
          ? 'starter_shared'
          : 'starter_active',
        inviter: null,
        people,
      };
    },
  });
}

/**
 * The one line under a starter suggestion's handle: a fact, never a percentage.
 *
 * | case | line | why |
 * |---|---|---|
 * | overlap exists | `3 shared` | the count is real, and it is the vocabulary the Leaderboard already prints |
 * | no overlap | `Ranked 214 movies` | says why the row is here without claiming anything about taste |
 *
 * `Match TBD` is deliberately not borrowed even though the app has it. On the Leaderboard
 * it means "there is some overlap, just not enough to score", which is a statement about a
 * pair; here there is usually no pair to speak of, and the phrase would imply a comparison
 * nobody ran.
 *
 * Separated from the component so the wording is testable without a render, exactly as
 * `mutualsLine` is.
 */
export function starterLine(context: { shared: number; ranked: number }): string {
  if (context.shared > 0) return `${context.shared} shared`;
  return `Ranked ${context.ranked} ${context.ranked === 1 ? 'movie' : 'movies'}`;
}
