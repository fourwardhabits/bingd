/**
 * The two titles a placement landed between, derived from the canonical ranking.
 *
 * The reveal already states the ordinal — `#3 Movies` — and an ordinal on its own is a
 * number rather than a place. "#3" tells somebody how many titles beat this one; it does
 * not tell them *which*, and the which is the part they have an opinion about. So this
 * reads the two names either side of the subject and hands them back for the reveal to
 * print under the score.
 *
 * Nothing is stored and nothing can drift, for the same reason genre ranks are derived
 * (genre-rank.ts): a second copy of the order would have to be kept in step with every
 * insertion, reorder and rebucket, and the first time it fell behind the app would state
 * two different facts about the same title.
 *
 * **The caller passes one category's rows and only ever gets that category back.**
 * Movies and TV seasons are separate rankings and a position is only meaningful inside
 * its own (PRD §11), so a season can never be named as a film's neighbour — not because
 * this checks, but because the list it is given never contains one.
 */

import { compactName, type NameableTitle } from '@/lib/titles';

export type NeighbourRow = NameableTitle & {
  mediaItemId: string;
  position: number;
};

export type Neighbour = { mediaItemId: string; name: string };

export type RankNeighbours = {
  /** One place better, nearer #1. Null when the subject *is* #1. */
  higher: Neighbour | null;
  /** One place worse. Null when the subject is last. */
  lower: Neighbour | null;
};

const NONE: RankNeighbours = { higher: null, lower: null };

const named = (row: NeighbourRow | undefined): Neighbour | null => {
  if (!row) return null;
  // A season reads as `The Last of Us, S1` and never as its bare season name, which on
  // its own would be the word "Season 2" sitting under somebody's score.
  const name = compactName(row);
  return name ? { mediaItemId: row.mediaItemId, name } : null;
};

/**
 * The rows either side of one title in its own ranked list.
 *
 * Returns neither when the subject is absent, which is the case worth naming: the reveal
 * runs this against the list the placement has just invalidated, so on the render before
 * that refetch resolves the subject genuinely is not there yet. Empty is the honest
 * answer — the alternative is naming the pair that was around the title *before* it
 * moved, which is a wrong claim rather than a missing one.
 */
export function neighboursFor(
  mediaItemId: string,
  rows: readonly NeighbourRow[],
): RankNeighbours {
  // Position order is canonical, and the caller is not required to supply it sorted.
  // Reading a neighbour off an unsorted list is the obvious way to be wrong.
  const ordered = [...rows].sort((a, b) => a.position - b.position);

  const index = ordered.findIndex((row) => row.mediaItemId === mediaItemId);
  if (index === -1) return NONE;

  // By index rather than by `position` arithmetic: the neighbour is whatever is next in
  // the order, whether or not positions happen to run without gaps.
  return { higher: named(ordered[index - 1]), lower: named(ordered[index + 1]) };
}
