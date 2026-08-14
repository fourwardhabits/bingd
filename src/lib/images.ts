/**
 * Poster paths into something an `<Image>` can load.
 *
 * `media_items.poster_path` holds TMDB's path form — `/qJ2tW6WMUDux911r6m7haRef0WH.jpg` —
 * not a URL, because the size is a display decision and storing one would freeze it. The
 * seed catalogue from Wikidata has no posters at all (data-model.md §5), so every path is
 * null until the TMDB adapter lands; this exists so that the day it does, the value is
 * already carried to the screens instead of being dropped on the way.
 *
 * Sizes are TMDB's own width buckets. w342 is the largest that is still smaller than a
 * phone's row artwork at 3x, and w500 covers the comparison cards.
 */
const BASE = 'https://image.tmdb.org/t/p';

export type PosterSize = 'row' | 'card';

const WIDTH: Record<PosterSize, string> = {
  row: 'w342',
  card: 'w500',
};

export const posterUri = (path: string | null | undefined, size: PosterSize = 'row') =>
  path ? `${BASE}/${WIDTH[size]}${path}` : null;
