import { imdbSyntheticBytes } from './__fixtures__/imdb-synthetic';
import { decodeCsv, normaliseImdb, type ImdbTitle } from './imdb';
import { buildImdbOutcomes, outcomeCounts, type UnresolvedRows } from './outcomes';
import type { ImportCounts } from './use-import';

/**
 * Which title goes under which heading (`outcomes.ts`), on the synthetic export:
 *
 *   movies  tt9000001 Lantern, 05 Paper Birds, 06 Old Mill, 07 Quiet Christmas,
 *           08 Midnight Revue, 10 Untitled Fog Project, 11 Too Loud
 *   shows   tt9000002 Harbour Lights (2011), 03 Seven Winters (2019, mini), 14 The Long Valley
 *   episode tt9000004 Harbour Lights: Pilot
 *   other   tt9000009 Starfall Quest (video game)
 */

const parsed = (): readonly ImdbTitle[] => {
  const result = normaliseImdb(decodeCsv(imdbSyntheticBytes()), {
    now: new Date('2026-11-13T00:00:00Z'),
  });
  if (!result.ok) throw new Error('fixture did not parse');
  return result.normalised.titles;
};

const ready = (rows: { name: string; year: number | null }[]): UnresolvedRows => ({
  state: 'ready',
  rows,
});

/** A job where every show matched, one movie did not, and every type landed as typed. */
const clean: ImportCounts = {
  watched: 6,
  unmatched: 1,
  unsupported: 5,
  unsupported_tv: 3,
  unsupported_episode: 1,
};

const section = (sections: ReturnType<typeof buildImdbOutcomes>, id: string) =>
  sections.find((s) => s.id === id);

describe('the headings and their counts', () => {
  it('reads the summary’s own numbers, other being what is left of unsupported', () => {
    expect(
      outcomeCounts({
        ambiguous: 2,
        unmatched: 6,
        stragglers: 1,
        unsupported: 148,
        unsupported_tv: 139,
        unsupported_episode: 7,
      }),
    ).toEqual({ unmatched: 9, tv: 139, episodes: 7, other: 2 });
  });

  it('has a section only for a heading with something in it', () => {
    const sections = buildImdbOutcomes({
      counts: { watched: 3 },
      session: parsed(),
      unresolved: ready([]),
    });
    expect(sections).toEqual([]);
  });
});

describe('the import just sent, with the parse in memory', () => {
  it('lists every heading by title, and each list is exactly its count', () => {
    const sections = buildImdbOutcomes({
      counts: clean,
      session: parsed(),
      unresolved: ready([{ name: 'Too Loud', year: 2003 }]),
    });
    for (const s of sections) expect(s.titles?.length).toBe(s.count);
    expect(section(sections, 'tv')?.titles?.map((t) => t.name)).toEqual([
      'Harbour Lights',
      'Seven Winters',
      'The Long Valley',
    ]);
    expect(section(sections, 'episodes')?.titles?.map((t) => t.name)).toEqual([
      'Harbour Lights: Pilot',
    ]);
    expect(section(sections, 'other')?.titles?.map((t) => t.titleType)).toEqual(['videogame']);
    // The parse still holds the tt id, so it is shown; the server's row never had it back.
    expect(section(sections, 'unmatched')?.titles).toEqual([
      expect.objectContaining({ name: 'Too Loud', year: 2003, imdbId: 'tt9000011' }),
    ]);
  });

  it('takes a show that was not found out of TV shows, because it is under Couldn’t match', () => {
    const sections = buildImdbOutcomes({
      counts: { ...clean, unmatched: 2, unsupported: 4, unsupported_tv: 2 },
      session: parsed(),
      unresolved: ready([
        { name: 'Too Loud', year: 2003 },
        { name: 'The Long Valley', year: null },
      ]),
    });
    expect(section(sections, 'tv')?.titles?.map((t) => t.imdbId)).toEqual([
      'tt9000002',
      'tt9000003',
    ]);
    expect(section(sections, 'unmatched')?.titles?.map((t) => t.name)).toEqual([
      'The Long Valley',
      'Too Loud',
    ]);
  });

  it('waits for the server before splitting the shows, rather than guessing', () => {
    const sections = buildImdbOutcomes({
      counts: { ...clean, unmatched: 2, unsupported: 4, unsupported_tv: 2 },
      session: parsed(),
      unresolved: { state: 'loading' },
    });
    expect(section(sections, 'tv')).toEqual({ id: 'tv', count: 2, titles: null });
    expect(section(sections, 'unmatched')?.titles).toBeNull();
    // Episodes and other types need nothing from the server.
    expect(section(sections, 'episodes')?.titles).toHaveLength(1);
  });

  it('shows no list that does not add up: an id TMDB files as an episode is not knowable', () => {
    // One movie came back from the provider as an episode: "other" is 2 on the server, and
    // the parse has one game. The client cannot say which movie it was, so: count only.
    const sections = buildImdbOutcomes({
      counts: { ...clean, watched: 5, unsupported: 6 },
      session: parsed(),
      unresolved: ready([{ name: 'Too Loud', year: 2003 }]),
    });
    expect(section(sections, 'other')).toEqual({ id: 'other', count: 2, titles: null });
    expect(section(sections, 'tv')?.titles).toHaveLength(3);
  });

  it('shows no unmatched list when the server holds fewer rows than its count', () => {
    const sections = buildImdbOutcomes({
      counts: { ...clean, unmatched: 2 },
      session: parsed(),
      unresolved: ready([{ name: 'Too Loud', year: 2003 }]),
    });
    expect(section(sections, 'unmatched')?.titles).toBeNull();
  });

  it('never puts a tt id on an unmatched row the parse cannot name uniquely', () => {
    const twin = { ...parsed()[0]!, imdbId: 'tt9999999' };
    const sections = buildImdbOutcomes({
      counts: { unmatched: 1 },
      session: [...parsed(), twin],
      unresolved: ready([{ name: twin.name, year: twin.year }]),
    });
    expect(section(sections, 'unmatched')?.titles?.[0]?.imdbId).toBeNull();
  });

  it('sorts by name, ignoring case', () => {
    const sections = buildImdbOutcomes({
      counts: { unmatched: 3 },
      session: null,
      unresolved: ready([
        { name: 'zebra', year: 2001 },
        { name: 'Apple', year: 2002 },
        { name: 'mango', year: null },
      ]),
    });
    expect(section(sections, 'unmatched')?.titles?.map((t) => t.name)).toEqual([
      'Apple',
      'mango',
      'zebra',
    ]);
  });
});

describe('after a restart, or a job started elsewhere', () => {
  it('lists Couldn’t match from the server, without tt ids, and keeps the rest as counts', () => {
    const sections = buildImdbOutcomes({
      counts: clean,
      session: null,
      unresolved: ready([{ name: 'Too Loud', year: 2003 }]),
    });
    expect(section(sections, 'unmatched')?.titles).toEqual([
      expect.objectContaining({ name: 'Too Loud', imdbId: null, titleType: null }),
    ]);
    expect(section(sections, 'tv')?.titles).toBeNull();
    expect(section(sections, 'episodes')?.titles).toBeNull();
    expect(section(sections, 'other')?.titles).toBeNull();
    expect(sections.map((s) => s.count)).toEqual([1, 3, 1, 1]);
  });

  it('keeps every count when the server rows cannot be read', () => {
    const sections = buildImdbOutcomes({
      counts: clean,
      session: null,
      unresolved: { state: 'unavailable' },
    });
    expect(sections.every((s) => s.titles === null)).toBe(true);
    expect(sections.reduce((n, s) => n + s.count, 0)).toBe(6);
  });
});
