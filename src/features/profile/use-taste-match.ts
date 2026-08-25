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
 * The one line under a handle, as a decision rather than as a render.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A BADGE THAT SOMETIMES SHOWED NOTHING
 *
 * The founder's report was that Match is **missing** when visiting somebody's profile,
 * and the cause was not a wiring bug: the number was drawn under the avatar and
 * `tasteMatchBadge` returned null whenever `taste_match` had no score. On a friend beta
 * where nobody has ranked much, that is nearly always — `taste.min_common` is five
 * *exactly shared* titles, both accounts having ranked the same film or the same season
 * — so the feature was invisible on every profile that mattered, with nothing on screen
 * to say why or what would fix it.
 *
 * Silence was the right call for a badge stacked in a sixty-point column. It is the
 * wrong call under a handle, where there is a line's width and the reader is looking at
 * the person the number is about.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STATES, AND WHY THE INSUFFICIENT ONE IS TWO
 *
 *   `match`     — a score. `87% Match`.
 *   `rank-more` — the *viewer* has not ranked enough for any overlap to be likely.
 *   `too-few`   — the overlap is short for a reason ranking more will not reliably fix.
 *   null        — say nothing: the reader's own profile, or an answer not yet in.
 *
 * The founder's instruction is precise about the split: do not tell somebody to rank
 * more when ranking more will not unlock it. `common_count` alone cannot tell the two
 * apart — an intersection of two says nothing about which side is short — so this takes
 * both catalogues' sizes, which every caller already has on screen: the subject's from
 * `rankedMovies + rankedSeasons`, the viewer's from their own logged collection.
 *
 *   subject below the minimum   → `too-few`. Nothing the viewer ranks can reach five
 *                                 shared titles with somebody who has ranked three.
 *   viewer below the minimum    → `rank-more`. This is the one case where the advice is
 *                                 true, and it is the common one on a new account.
 *   both above, overlap short   → `too-few`. Both have ranked plenty and have not
 *                                 happened to watch the same things; "rank more" would
 *                                 be a guess dressed as an instruction.
 *
 * **No number is invented for the nudge.** "Rank 3 more titles" would be a lie in every
 * branch — the gap is in *shared* titles, and three arbitrary films may share none of
 * them — so the copy says what is true and stops. And `TBD` appears nowhere: a
 * placeholder percentage is the one thing the founder ruled out explicitly, and an
 * absence of evidence is not a low score.
 */
export type TasteMatchState =
  | { kind: 'match'; label: string }
  | { kind: 'rank-more'; label: string }
  | { kind: 'too-few'; label: string }
  | null;

export function tasteMatchState({
  match,
  isSelf,
  viewerRanked,
  subjectRanked,
}: {
  match: TasteMatch | undefined;
  /** A 100% match with your own catalogue is a tautology; the RPC refuses it too. */
  isSelf: boolean;
  /** How many titles the viewer has ranked. Undefined while their collection loads. */
  viewerRanked: number | undefined;
  /** How many the subject has ranked, or undefined on a profile with no visible stats. */
  subjectRanked: number | undefined;
}): TasteMatchState {
  if (isSelf || !match) return null;
  if (match.score !== null) return { kind: 'match', label: `${match.score}% Match` };

  // Nobody has looked yet on one side or the other. Nothing rather than a guess: the
  // line appears once when there is something true to put in it, instead of changing
  // its mind under the reader.
  if (viewerRanked === undefined || subjectRanked === undefined) return null;

  if (subjectRanked >= match.minCommon && viewerRanked < match.minCommon) {
    return { kind: 'rank-more', label: 'Rank more to see Match' };
  }

  return { kind: 'too-few', label: 'Not enough shared taste yet' };
}

/**
 * The two short lines that sat under the avatar. **Kept for the compact case and no
 * longer used by either profile**, both of which now put `tasteMatchState` under the
 * handle instead.
 *
 * Retained rather than deleted because it is the only form that fits a sixty-point
 * column, and the rule it encodes — a number or nothing, never `0%` — is the one this
 * feature must never lose.
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
