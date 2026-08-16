/**
 * Genre ranks, derived from the canonical ranking.
 *
 * The reveal shows the score as the hero and a line of context beneath it —
 * `#6 Movies · #2 Comedy`. The overall ordinal is `rankings.position` and needs no
 * work. A genre rank is the same order *filtered*: take the user's ranked titles in
 * this category, keep the ones carrying the genre, and read off the index.
 *
 * Nothing is stored and nothing can drift. There is no `genre_rankings` table and
 * there must not be one: a second stored order would have to be kept in step with
 * every insertion, every reorder and every rebucket, and the first time it fell
 * behind the app would state two different facts about the same title. This is the
 * same reasoning that keeps the score itself derived (score.ts).
 */

export type RankedRow = {
  mediaItemId: string;
  position: number;
  genres: readonly string[];
};

export type GenreRank = { genre: string; rank: number; total: number };

/**
 * Below this, a genre rank is noise rather than information.
 *
 * "#1 Comedy" out of two comedies says nothing about the film and quite a lot about
 * how little the user has ranked. Provisional, and the sort of number that should
 * move once there is real usage to look at.
 */
export const MIN_GENRE_SIZE = 5;

/** How many genre lines the reveal will show. */
export const MAX_GENRE_LINES = 2;

/**
 * The strongest genre placements for one title.
 *
 * Ordered by how high the title sits *relative to* the genre's size, so a #2 of 40
 * outranks a #1 of 6. Sorting by the bare ordinal would put every small genre first
 * and always show the least meaningful line.
 */
export function genreRanksFor(
  mediaItemId: string,
  rows: readonly RankedRow[],
  limit = MAX_GENRE_LINES,
): GenreRank[] {
  const subject = rows.find((row) => row.mediaItemId === mediaItemId);
  if (!subject) return [];

  // Position order is the canonical order; the caller is not required to supply it
  // sorted, and reading a rank off an unsorted list is the obvious way to be wrong.
  const ordered = [...rows].sort((a, b) => a.position - b.position);

  const ranks: GenreRank[] = [];
  for (const genre of subject.genres) {
    const inGenre = ordered.filter((row) => row.genres.includes(genre));
    if (inGenre.length < MIN_GENRE_SIZE) continue;

    const index = inGenre.findIndex((row) => row.mediaItemId === mediaItemId);
    if (index === -1) continue;

    ranks.push({ genre, rank: index + 1, total: inGenre.length });
  }

  return ranks.sort((a, b) => a.rank / a.total - b.rank / b.total).slice(0, limit);
}

/** `#2 Comedy`. The denominator is deliberately absent — it is on the title page. */
export const formatGenreRank = (entry: GenreRank) => `#${entry.rank} ${entry.genre}`;
