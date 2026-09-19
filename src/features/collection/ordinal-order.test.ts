import { applyFilters, emptyFilters, sortItems, type CollectionItem } from './filters';
import { formatScore } from './score';
import type { RankedEntry } from './use-collection';
import { watchedItems } from './watched-rows';

/**
 * Scores can collide. Ordinal positions cannot.
 *
 * The founder's report, 2026-09-19: Like Mike was picked over George of the Jungle and over
 * Puss in Boots, and Elf was picked over Like Mike. All four print 8.5, and the Collection
 * drew them George, Puss, Elf, Like Mike. Separately, The Dark Knight was picked over The
 * Odyssey, both print 10.0, and The Odyssey was drawn first.
 *
 * Nothing about the stored ranking was wrong. The Rating order compared the one-decimal
 * score and, on an equal one, fell through to the media item id — so the four 8.5s came out
 * in uuid order. The ids below are chosen so that uuid order is exactly the order the
 * founder saw; every assertion here fails against that comparator.
 *
 * A loved band of 100 steps 3.0 / 99 ≈ 0.03 per title, so positions 49–52 all round to 8.5
 * and positions 1–2 both round to 10.0. The fixture is the whole band, because a score is
 * only a score against every title in its band.
 */

const BAND = 100;

// Ascending id order: Odyssey < Dark Knight, George < Puss < Elf < Like Mike — the screenshot.
const ID = {
  darkKnight: '0b000000-0000-4000-8000-000000000001',
  odyssey: '0a000000-0000-4000-8000-000000000002',
  elf: '3e000000-0000-4000-8000-000000000049',
  likeMike: '4c000000-0000-4000-8000-000000000050',
  puss: '2b000000-0000-4000-8000-000000000051',
  george: '1a000000-0000-4000-8000-000000000052',
} as const;

// The pairwise answers, as positions: Dark Knight > Odyssey at the top of the scale;
// Elf > Like Mike > Puss and Like Mike > George. George against Puss was never asked, so
// either order is valid — this ranking happens to hold Puss above George.
const PLACED: Record<number, { id: string; title: string; genres?: string[] }> = {
  1: { id: ID.darkKnight, title: 'The Dark Knight', genres: ['Action', 'Crime'] },
  2: { id: ID.odyssey, title: 'The Odyssey', genres: ['Action', 'Adventure'] },
  49: { id: ID.elf, title: 'Elf', genres: ['Comedy', 'Family'] },
  50: { id: ID.likeMike, title: 'Like Mike', genres: ['Comedy', 'Family'] },
  51: { id: ID.puss, title: 'Puss in Boots', genres: ['Animation', 'Family'] },
  52: { id: ID.george, title: 'George of the Jungle', genres: ['Comedy', 'Family'] },
};

const entry = (position: number, category: RankedEntry['category'] = 'movies'): RankedEntry => {
  const placed = PLACED[position];
  return {
    // Fillers sort after every named id, so none of them can be what decides a test.
    mediaItemId: placed?.id ?? `f${String(position).padStart(7, '0')}-0000-4000-8000-000000000000`,
    title: placed?.title ?? `Filler ${position}`,
    year: 2000,
    posterPath: null,
    genres: placed?.genres ?? ['Drama'],
    runtimeMinutes: 100,
    kind: category === 'movies' ? 'movie' : 'season',
    seriesTitle: null,
    seriesId: null,
    language: 'en',
    bucket: 'loved',
    position,
    category,
    rankedAt: '2026-09-01T00:00:00Z',
  };
};

/** The ranked query's answer: the whole category, in position order. */
const band = (category: RankedEntry['category'] = 'movies') =>
  Array.from({ length: BAND }, (_, i) => entry(i + 1, category));

const medium = (category: RankedEntry['category']) => (category === 'movies' ? 'movies' : 'tv_seasons');

const items = (category: RankedEntry['category'] = 'movies') =>
  watchedItems(band(category), [], medium(category));

const named = new Set<string>(Object.values(ID));
const only = (rows: CollectionItem[]) => rows.filter((row) => named.has(row.mediaItemId));
const titles = (rows: CollectionItem[]) => only(rows).map((row) => row.title);
const shown = (rows: CollectionItem[], id: string) =>
  formatScore(rows.find((row) => row.mediaItemId === id)?.score ?? NaN);

const HIGHEST = { axis: 'rating', direction: 'desc' } as const;
const LOWEST = { axis: 'rating', direction: 'asc' } as const;

describe('an equal printed score is not a tie', () => {
  it('prints the same 8.5 on all four, and the same 10.0 on both — the tie is real on screen', () => {
    // Asserted before the order, so the order tests below cannot pass on a fixture whose
    // scores never collided.
    const rows = items();
    expect([ID.elf, ID.likeMike, ID.puss, ID.george].map((id) => shown(rows, id))).toEqual([
      '8.5',
      '8.5',
      '8.5',
      '8.5',
    ]);
    expect([ID.darkKnight, ID.odyssey].map((id) => shown(rows, id))).toEqual(['10.0', '10.0']);
  });

  it('keeps every pairwise answer when the Rating order is highest first', () => {
    expect(titles(sortItems(items(), HIGHEST))).toEqual([
      'The Dark Knight',
      'The Odyssey',
      'Elf',
      'Like Mike',
      'Puss in Boots',
      'George of the Jungle',
    ]);
  });

  it('reverses exactly, and still by ordinal, when the order is lowest first', () => {
    expect(titles(sortItems(items(), LOWEST))).toEqual([
      'George of the Jungle',
      'Puss in Boots',
      'Like Mike',
      'Elf',
      'The Odyssey',
      'The Dark Knight',
    ]);
  });

  it('is the same order whatever order the rows arrive in', () => {
    const rows = items();
    const expected = sortItems(rows, HIGHEST).map((row) => row.mediaItemId);
    // The whole list, not just the named six: a comparator that is not total would let
    // arrival order leak back in on the fillers too.
    expect(sortItems([...rows].reverse(), HIGHEST).map((row) => row.mediaItemId)).toEqual(expected);
    expect(sortItems(rows, HIGHEST).map((row) => row.position)).toEqual(
      Array.from({ length: BAND }, (_, i) => i + 1),
    );
  });

  it('holds for a TV seasons ranking exactly as for films', () => {
    expect(titles(sortItems(items('tv_seasons'), HIGHEST))).toEqual([
      'The Dark Knight',
      'The Odyssey',
      'Elf',
      'Like Mike',
      'Puss in Boots',
      'George of the Jungle',
    ]);
  });
});

describe('a filter narrows the list without reordering what is left', () => {
  it('keeps the relative ordinal order of the titles a genre filter lets through', () => {
    const filters = { ...emptyFilters(), genres: ['Comedy'] };
    // Puss in Boots is not a Comedy here, so it drops out; the rest keep their order.
    expect(titles(sortItems(applyFilters(items(), filters), HIGHEST))).toEqual([
      'Elf',
      'Like Mike',
      'George of the Jungle',
    ]);
  });

  it('keeps it under a bucket filter, which every one of them passes', () => {
    const filters = { ...emptyFilters(), buckets: ['loved' as const] };
    expect(titles(sortItems(applyFilters(items(), filters), HIGHEST))).toEqual([
      'The Dark Knight',
      'The Odyssey',
      'Elf',
      'Like Mike',
      'Puss in Boots',
      'George of the Jungle',
    ]);
  });
});

describe('what is not ranked still sorts as before', () => {
  it('sinks unranked rows below every ranked one, in both directions', () => {
    const rows = watchedItems(
      band(),
      [
        {
          mediaItemId: '00000000-0000-4000-8000-00000000dead',
          title: 'Logged Only',
          seriesTitle: null,
          year: 2001,
          posterPath: null,
          genres: ['Drama'],
          runtimeMinutes: 90,
          kind: 'movie',
          language: 'en',
          bucket: null,
          watchedOn: null,
          addedAt: '2026-09-01T00:00:00Z',
        },
      ],
      'movies',
    );
    expect(sortItems(rows, HIGHEST).at(-1)?.title).toBe('Logged Only');
    expect(sortItems(rows, LOWEST).at(-1)?.title).toBe('Logged Only');
  });
});
