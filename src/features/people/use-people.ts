import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * People discovery (`20260826000500`, founder tranche 2026-08-26 §§10–15).
 *
 * Two suggestion lists behind one shape. Both are read entirely by the server: this
 * file sends a limit and receives identity plus one number, which is the constraint
 * stated as an interface — neither the follow graph nor anybody's ranking catalogue is
 * ever downloaded to be filtered here, and there is no client path that could start.
 *
 * **What is deliberately absent.** No contacts, no address book, no phone numbers. The
 * founder deferred all three explicitly and the requirements for ever building them are
 * written down in `docs/product/prd.md` rather than half-built here.
 */

export type PersonSuggestion = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** True when the account is private, so the control offers Request rather than Follow. */
  isPrivate: boolean;
  /**
   * The one line of context under the handle.
   *
   * Exactly one of the two, because the two modes answer different questions and a
   * row that showed both would be inviting a comparison between a percentage and a
   * count. `names` carries at most three of the mutuals, for the card's line —
   * the full list is `useMutualsWith`, read only when the sheet opens.
   */
  context:
    | { kind: 'mutuals'; count: number; names: string[] }
    /**
     * `shared` is `taste_match`'s own `common_count`, added to the RPC by
     * `20260912000100` so a People row reads `87% Match · 14 shared` — the same line the
     * Leaderboard draws, from the same call, so the two cannot disagree about what
     * "shared" counts.
     *
     * Nullable for one reason and it is not a missing feature: a cache written by a
     * bundle that predates the column has no number, and a row that printed `· null
     * shared` because of it is the defect that only appears on somebody else's phone.
     */
    | { kind: 'match'; score: number; shared: number | null };
};

type Row = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  visibility: string;
};

const identity = (row: Row) => ({
  id: row.user_id,
  username: row.username,
  name: row.display_name || row.username,
  avatarUri: avatarUri(row.avatar_path),
  isPrivate: row.visibility === 'private',
});

/**
 * People followed by the people you follow, most shared connections first.
 *
 * **The mutuals are named now** (`20260827000100`) — the founder reversed the
 * count-only decision after the physical pass: "1 mutual" without a name asks the
 * reader to act on a number. The privacy ground is unchanged, because it never needed
 * to change: every edge counted is one `follows_read` would admit to this caller
 * individually, so the names were always theirs to read one query at a time; the
 * server caps the inline list at three and `mutuals_with` carries the rest.
 *
 * Keyed by the viewer, like every viewer-relative key in this app. The answer is
 * *entirely* about who is asking, and a cache entry reachable from a second account
 * signed in on the same device is the defect reviews 6 and 10 each found somewhere else.
 *
 * A minute of `staleTime`, because a follow graph does not move between two taps and
 * this list is looked at by scrolling past it. `useSocialWrites` invalidates the key
 * whenever it does move, which is what makes a Follow performed *from this list* remove
 * the row rather than leave it sitting there saying Follow.
 */
export function usePeopleMutuals(viewerId: string, enabled = true) {
  return useQuery({
    queryKey: ['people-mutuals', viewerId],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<PersonSuggestion[]> => {
      const { data, error } = await supabase.rpc('people_mutuals', { p_limit: 10 });
      if (error) throw error;

      return ((data ?? []) as (Row & { mutual_count: number; mutual_names: string[] | null })[]).map(
        (row) => ({
          ...identity(row),
          context: {
            kind: 'mutuals' as const,
            count: row.mutual_count,
            names: row.mutual_names ?? [],
          },
        }),
      );
    },
  });
}

/**
 * People whose rankings agree most with yours.
 *
 * **The number is `taste_match`'s own** and is not recomputed here or on the server's
 * side of this call: `people_taste_matches` invokes that function per candidate, so a
 * suggestion showing 87% and the same person's profile showing 87% are the same
 * arithmetic and cannot drift. The founder's rule for this screen was that Bingd has
 * one taste algorithm, and calling it is the only way to keep that true.
 *
 * A candidate with no score is not returned at all — below `taste.min_common` shared
 * titles the calculation refuses, and this screen says nothing rather than guessing.
 */
export function usePeopleTasteMatches(viewerId: string, enabled = true) {
  return useQuery({
    queryKey: ['people-taste-matches', viewerId],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<PersonSuggestion[]> => {
      const { data, error } = await supabase.rpc('people_taste_matches', { p_limit: 10 });
      if (error) throw error;

      return (
        (data ?? []) as (Row & { match_score: number; shared_count?: number | null })[]
      ).map((row) => ({
        ...identity(row),
        context: {
          kind: 'match' as const,
          score: row.match_score,
          shared: row.shared_count ?? null,
        },
      }));
    },
  });
}

export type MutualPerson = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
};

/**
 * The server reads at most this many rows for the inspection sheet (`mutuals_with`'s
 * own `limit 30`). Exported so the sheet can *say* when the page is full (review 60b)
 * — the card's count is not capped, and a count of 45 over a silent list of 30 would
 * be the sheet contradicting the line it opened from.
 */
export const MUTUALS_WITH_PAGE = 30;

/**
 * Everybody behind one card's mutual count — the caller's approved followees who
 * follow the subject — read only when the inspection sheet opens.
 *
 * Same predicates as `people_mutuals`' aggregate, so the sheet can never name an edge
 * the count did not include. Keyed by the viewer like every viewer-relative key.
 */
export function useMutualsWith(subjectId: string | null, viewerId: string) {
  return useQuery({
    queryKey: ['mutuals-with', viewerId, subjectId],
    enabled: Boolean(subjectId) && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<MutualPerson[]> => {
      const { data, error } = await supabase.rpc('mutuals_with', { p_subject: subjectId });
      if (error) throw error;

      return ((data ?? []) as Row[]).map((row) => ({
        id: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
      }));
    },
  });
}

/**
 * The one line under a mutual suggestion's handle: who the connection is, not just
 * that one exists. "1 mutual" asked the reader to act on a number; the name is what
 * the number was standing in for. Overflow stays a count — the card is a row, and
 * the full list is the sheet's job.
 *
 * Separated from the component so the wording is testable without a render.
 */
export function mutualsLine(context: { count: number; names: string[] }): string {
  const [first] = context.names;
  // The server always names at least one mutual for a counted row; a bare count is
  // the fallback for a cache written before names existed.
  if (!first) return `${context.count} ${context.count === 1 ? 'mutual' : 'mutuals'}`;
  if (context.count === 1) return `Mutual: ${first}`;
  return `${first} + ${context.count - 1} more`;
}

/**
 * `87% Match · 14 shared`, or `87% Match` on its own.
 *
 * **The same two-part line the Leaderboard and the profile draw**, in the same order and
 * from the same `taste_match` numbers (`LeaderboardView.secondLine`) — the founder's §A6,
 * and the reason it is worth a shared shape rather than a template repeated three times is
 * that "shared" is a count with a definition, and three surfaces printing it are three
 * chances to print a different one.
 *
 * **There is no `Match TBD` here, and that is not an omission.** That phrase means "not
 * enough overlap to score yet", and it cannot occur on this list: `people_taste_matches`
 * returns a candidate only once `taste_match` produced a score, so a row without a
 * percentage is not a row. The low-data semantics are preserved by the row being absent
 * rather than by a placeholder — which is the stronger version of the same rule, because a
 * screen full of `Match TBD` would be the feature looking broken.
 *
 * The count is dropped rather than printed as zero when it is missing, so a cache written
 * before `20260912000100` degrades to the line it always drew instead of to `· null
 * shared`.
 */
export function matchLine(context: { score: number; shared: number | null }): string {
  const percent = `${context.score}% Match`;
  return context.shared === null ? percent : `${percent} · ${context.shared} shared`;
}
