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
 * WHAT THE LINE SAYS NOW, AND WHY IT CHANGED TWICE
 *
 * It started as a badge under the avatar that drew a percentage or nothing. On a friend
 * beta "nothing" is nearly every profile — `taste.min_common` is five *exactly shared*
 * rankings — so the founder's report was that Match is missing, and the cause was a
 * sixty-point column with no room to explain itself. It moved under the handle and grew
 * four states, three of which were sentences.
 *
 * The founder's 2026-08-28 §2 replaces those sentences with one compact form that
 * carries the **evidence** beside the number:
 *
 *     89% Match · 42 shared
 *     Match TBD · 3 shared
 *
 * The reasoning is that the number alone was never the whole answer. "How much weight
 * should I give this person's recommendation" depends on the score *and* on how much
 * agreement it was measured over, and since `20260827001000` the score itself is shrunk
 * toward 50 by exactly that count — so a reader seeing 89% has been told something the
 * evidence count is the other half of. Putting them together is what makes the shrink
 * legible instead of mysterious.
 *
 * ---------------------------------------------------------------------------
 * `MATCH TBD` IS NOT THE PLACEHOLDER THE FOUNDER RULED OUT
 *
 * An earlier instruction forbade `TBD` and this file enforced it. That rule was about a
 * **placeholder percentage** — `0% Match` on a pair with no evidence, which is a lie
 * told in the units of the answer. `Match TBD` is in different units: it says there is
 * no number yet, which is true, and it says it in a form that keeps the line's shape
 * stable so the row does not reflow when the number arrives. The founder has asked for
 * it explicitly and it is not the thing the old rule protected against. **No percentage
 * is ever invented**, and that is still asserted.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE OLD THREE SENTENCES WENT
 *
 * Into the sheet. The distinction between "the *viewer* has ranked too little" and
 * "there is simply no overlap" is real, and telling somebody to rank more when ranking
 * more cannot help is the mistake this module was written to avoid — but it is a
 * *second* sentence, and §3 says the profile treatment stays compact. So the line is
 * always the compact pair, and `explanation.nudge` carries the advice to the sheet that
 * opens when the line is tapped, where there is room for it and where it is only read by
 * somebody who asked.
 */

/** Which of the two compact forms this is. Drives the tone, and nothing else. */
export type TasteMatchKind = 'match' | 'tbd';

export type TasteMatchLine = {
  kind: TasteMatchKind;
  /** `89% Match · 42 shared`, or `Match TBD · 3 shared`. */
  label: string;
  /** The two paragraphs and the optional nudge, for the sheet behind the line. */
  explanation: {
    match: string;
    shared: string;
    /**
     * Present only in the one branch where "rank more" is true: the subject has ranked
     * plenty and the viewer has not, so every missing shared title is one the *viewer*
     * has yet to rank. Absent when the subject is the short side, or when both have
     * ranked plenty and simply have not overlapped — in both of those, ranking more is
     * a guess dressed as an instruction.
     */
    nudge: string | null;
  };
};

/**
 * The compact line, or null when there is nothing honest to put in it.
 *
 * Null covers three genuinely different absences and they are deliberately collapsed:
 * the reader's own profile (a 100% match with your own catalogue is a tautology, and
 * `taste_match` refuses the case as well), an answer still in flight, and a profile
 * whose counts this viewer is not entitled to. In all three the right render is no line
 * at all rather than a line that changes its mind under the reader.
 *
 * **The counts are only needed for the nudge.** The compact label is derivable from
 * `match` alone; `viewerRanked` and `subjectRanked` decide which side is short, which
 * only the sheet says out loud. They are still required rather than optional, because a
 * line drawn before they arrive would open a sheet whose advice was decided by an
 * absence — and the two profiles that call this have both numbers on screen already.
 */
export function tasteMatchLine({
  match,
  isSelf,
  viewerRanked,
  subjectRanked,
  name,
}: {
  match: TasteMatch | undefined;
  /** A 100% match with your own catalogue is a tautology; the RPC refuses it too. */
  isSelf: boolean;
  /** How many titles the viewer has ranked. Undefined while their collection loads. */
  viewerRanked: number | undefined;
  /** How many the subject has ranked, or undefined on a profile with no visible stats. */
  subjectRanked: number | undefined;
  /** The subject's display name, for copy that names a person rather than "them". */
  name: string;
}): TasteMatchLine | null {
  if (isSelf || !match) return null;
  if (viewerRanked === undefined || subjectRanked === undefined) return null;

  // "shared" is not pluralised. It is a count of a thing the label does not name —
  // `42 shared` reads as an adjective over the titles, and `42 shareds` is not English.
  const shared = `${match.commonCount} shared`;

  const explanation = {
    match:
      `How similarly you and ${name} rate titles you've both ranked. ` +
      'More shared titles makes the Match more reliable.',
    shared: `Titles you and ${name} have both ranked.`,
    nudge:
      match.score === null && subjectRanked >= match.minCommon && viewerRanked < match.minCommon
        ? 'Rank a few more titles and this will fill in.'
        : null,
  };

  if (match.score !== null) {
    return { kind: 'match', label: `${match.score}% Match · ${shared}`, explanation };
  }

  return { kind: 'tbd', label: `Match TBD · ${shared}`, explanation };
}

/**
 * The badge that sat under the avatar. **Kept, and used by neither profile.**
 *
 * Retained rather than deleted because it is the only form that fits a sixty-point
 * column, and the rule it encodes — a number or nothing, never `0%` — is the one this
 * feature must never lose whatever shape the line takes.
 */
export function tasteMatchBadge(
  match: TasteMatch | undefined,
): { value: string; label: string } | null {
  if (!match || match.score === null) return null;
  return { value: `${match.score}%`, label: 'Match' };
}
