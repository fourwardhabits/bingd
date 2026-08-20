import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type TasteMatch = {
  /** 0–100, or null when there is not enough overlap to say anything. */
  score: number | null;
  /** How many exact titles both accounts have ranked. */
  commonCount: number;
  /** The threshold below which there is no score. Config, not a constant. */
  minCommon: number;
};

/**
 * How close the viewer's opinions are to one other account's.
 *
 * Everything is decided server-side. This hook sends one uuid and receives three
 * numbers, which is the founder's constraint stated as an interface: the other
 * account's ranking catalogue is never downloaded, and there is no client-side path
 * that could accidentally start doing so.
 *
 * Not fetched for the viewer's own profile, and `taste_match` refuses that case as
 * well — a 100% match with yourself is a tautology, and the founder asked for it to be
 * absent rather than perfect. Two mechanisms because one of them is a *display*
 * decision and the other is what a modified client hits.
 *
 * Keyed by both accounts. The number is symmetric, so a shared key would be tempting
 * and wrong: the query is authorised as the viewer, and a cache entry reachable from
 * a second account signed in on the same device is the defect reviews 6 and 10 found.
 */
export function useTasteMatch(subjectId: string | null, viewerId: string) {
  const enabled = Boolean(subjectId) && subjectId !== viewerId;

  return useQuery({
    queryKey: ['taste-match', viewerId, subjectId],
    enabled,
    queryFn: async (): Promise<TasteMatch> => {
      const { data, error } = await supabase.rpc('taste_match', { p_user_id: subjectId });
      if (error) throw error;

      const row = (data as { score: number | null; common_count: number; min_common: number }[])?.[0];
      return {
        score: row?.score ?? null,
        commonCount: row?.common_count ?? 0,
        minCommon: row?.min_common ?? 5,
      };
    },
  });
}

/**
 * The two short lines that sit under the avatar, or null when there is nothing to say.
 *
 * **`84%` over `Match`, and nothing when there is no number.** The founder's final
 * layout puts this in the avatar's column, beside the name rather than inside it, and
 * that column is about sixty points wide — room for a figure and a word, and not for a
 * sentence. `tasteMatchCopy` below still has the long form and is what a wider surface
 * would use.
 *
 * The insufficient-overlap case returns null here rather than a placeholder. It is the
 * one decision in this pass that removes something a reader could previously see, and
 * the alternative was worse: "Not enough overlap yet" under a 64pt photo wraps to three
 * lines and pushes the whole page down for a state that is not actionable. What must
 * never happen — printing `0%` when the app has no score — is what returning null
 * guarantees.
 */
export function tasteMatchBadge(
  match: TasteMatch | undefined,
): { value: string; label: string } | null {
  if (!match || match.score === null) return null;
  return { value: `${match.score}%`, label: 'Match' };
}

/**
 * The two lines the long form prints, or null when there is nothing to say.
 *
 * Separated from the component so the copy rules are testable without a render, and
 * because the "not enough yet" case has a shape that is easy to get wrong: it must
 * still show the count, or the reader cannot tell whether they are one film away or
 * five.
 */
export function tasteMatchCopy(match: TasteMatch | undefined): { headline: string; detail: string } | null {
  if (!match) return null;

  const titles = `${match.commonCount} ${match.commonCount === 1 ? 'title' : 'titles'} in common`;

  if (match.score === null) {
    // Deliberately not "0% match". An absence of evidence is not a low score, and
    // printing a number here would be the feature's first lie.
    return {
      headline: 'Not enough overlap yet',
      detail:
        match.commonCount === 0
          ? 'Nothing you have both ranked.'
          : `${titles} — ${match.minCommon} needed.`,
    };
  }

  return { headline: `${match.score}% Taste Match`, detail: titles };
}
