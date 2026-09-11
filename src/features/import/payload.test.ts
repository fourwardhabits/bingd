import { generateExport } from './generate-fixture';
import { normalise } from './letterboxd';
import {
  MAX_PAGE_BYTES,
  MAX_PAGE_ROWS,
  MAX_WATCHES_PER_TITLE,
  PAGE_ROWS,
  pageBytes,
  paginate,
  stagingRows,
} from './payload';
import { REAL_EXPORT } from './__fixtures__/real-export';

/**
 * What a page actually weighs — the measurement the server's byte bound is derived from.
 *
 * The founder's instruction was not to invent a limit. So this file measures the real
 * export and three generated libraries, prints the numbers, and asserts that the bound is
 * a stated multiple above the worst page any of them can produce. If a future change makes
 * the payload heavier — a new field, a longer bound on one — the headroom assertion fails
 * and the number has to be re-derived rather than quietly outgrown.
 */

const NOW = new Date(2026, 8, 11);

const library = (titles: number) => {
  const g = generateExport({ titles, seed: 7 });
  return normalise(
    {
      'watched.csv': g['watched.csv'],
      'ratings.csv': g['ratings.csv'],
      'diary.csv': g['diary.csv'],
      'watchlist.csv': g['watchlist.csv'],
    },
    { now: NOW },
  );
};

describe('the shape that crosses the wire', () => {
  const rows = stagingRows(normalise(REAL_EXPORT, { now: NOW }));

  it('carries one row per watched film and one per watchlist film', () => {
    expect(rows.filter((r) => r.kind === 'watched')).toHaveLength(22);
    expect(rows.filter((r) => r.kind === 'watchlist')).toHaveLength(2);
  });

  it('gives a watchlist row nothing but identity', () => {
    const wanted = rows.find((r) => r.kind === 'watchlist')!;
    expect(Object.keys(wanted).sort()).toEqual(['correlation', 'filmUri', 'kind', 'name', 'year']);
  });

  it('attaches each viewing to its own title', () => {
    const freeSolo = rows.find((r) => r.name === 'Free Solo')!;
    expect(freeSolo.watches).toHaveLength(1);
    expect(freeSolo.watches![0]!.diaryUri).toBe('https://boxd.it/ggWgth');
    expect(freeSolo.watches![0]!.isRewatch).toBe(true);
  });

  it('omits the watches key entirely for a film with no diary entry', () => {
    // Not `watches: []`. `jsonb_strip_nulls` on the server drops nulls but keeps an empty
    // array, and an empty array is bytes on the wire for every film in a library that
    // mostly has no diary — which is most of them.
    const shrek = rows.find((r) => r.name === 'Shrek')!;
    expect(shrek).not.toHaveProperty('watches');
  });

  it('never carries a field the server would discard', () => {
    // The RPC projects field by field. Anything here that it does not name is bytes sent
    // for nothing — and, worse, reads as though the import keeps it.
    const allowed = new Set([
      'kind', 'correlation', 'name', 'year', 'filmUri', 'rating', 'bucket', 'watchedOn', 'watches',
    ]);
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
  });
});

describe('how much a page weighs', () => {
  const measured: { label: string; rows: number; bytes: number; worstPage: number }[] = [];

  const measure = (label: string, rows: ReturnType<typeof stagingRows>) => {
    const pages = paginate(rows, { maxRows: MAX_PAGE_ROWS, maxBytes: MAX_PAGE_BYTES });
    const worstPage = Math.max(...pages.map(pageBytes));
    measured.push({ label, rows: rows.length, bytes: pageBytes(rows), worstPage });
    return worstPage;
  };

  it('measures the real export and three generated libraries', () => {
    measure('real export', stagingRows(normalise(REAL_EXPORT, { now: NOW })));
    for (const n of [500, 2_500, 10_000]) measure(`generated ${n}`, stagingRows(library(n)));

    for (const m of measured) {
      // eslint-disable-next-line no-console
      console.log(
        `[payload] ${m.label.padEnd(16)} ${String(m.rows).padStart(6)} rows · ` +
          `${(m.bytes / 1024).toFixed(0).padStart(6)} KiB total · ` +
          `${(m.bytes / m.rows).toFixed(0).padStart(4)} B/row · ` +
          `worst ${MAX_PAGE_ROWS}-row page ${(m.worstPage / 1024).toFixed(0)} KiB`,
      );
    }
    expect(measured).toHaveLength(4);
  });

  it('leaves at least eight times headroom under the byte bound', () => {
    // The derivation, asserted. A new field or a wider length cap that ate this margin
    // would fail here rather than silently making the bound tight.
    const worst = Math.max(...measured.map((m) => m.worstPage));
    expect(worst).toBeGreaterThan(0);
    expect(MAX_PAGE_BYTES / worst).toBeGreaterThan(8);
  });

  it('keeps a client page well inside both bounds', () => {
    const pages = paginate(stagingRows(library(10_000)));
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(PAGE_ROWS);
      expect(pageBytes(page)).toBeLessThan(MAX_PAGE_BYTES);
    }
  });
});

describe('paginate', () => {
  const row = (i: number, over: Record<string, unknown> = {}) => ({
    kind: 'watched' as const,
    correlation: `film ${i}|2001`,
    name: `Film ${i}`,
    year: 2001,
    filmUri: `https://boxd.it/f${i}`,
    ...over,
  });

  it('splits on the row bound', () => {
    const pages = paginate(Array.from({ length: 1_200 }, (_, i) => row(i)));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toHaveLength(PAGE_ROWS);
    expect(pages[2]).toHaveLength(200);
  });

  it('splits on the byte bound before the row bound when a row is fat', () => {
    const fat = Array.from({ length: 20 }, (_, i) => row(i, { name: 'x'.repeat(10_000) }));
    const pages = paginate(fat, { maxRows: 500, maxBytes: 50_000 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(pageBytes(page)).toBeLessThanOrEqual(50_000 + 10_100);
  });

  it('emits an oversized single row alone rather than losing it', () => {
    // Every field the server keeps is length-capped there, so this row is not actually
    // refusable — dropping it here would lose a film for being unusual.
    const pages = paginate([row(0, { name: 'x'.repeat(60_000) }), row(1)], { maxBytes: 1_000 });
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(1);
  });

  it('returns nothing for nothing', () => {
    expect(paginate([])).toEqual([]);
  });
});

describe('viewings per title', () => {
  it('carries every viewing a real diary has', () => {
    const rows = stagingRows(normalise(REAL_EXPORT, { now: NOW }));
    const total = rows.reduce((n, r) => n + (r.watches?.length ?? 0), 0);
    expect(total).toBe(1);
  });

  it('caps a title at a number no diary reaches, keeping the most recent', () => {
    // One pathological row must not be able to consume a whole page's budget.
    const watches = Array.from({ length: MAX_WATCHES_PER_TITLE + 50 }, (_, i) => ({
      correlation: 'many|2001',
      diaryUri: `https://boxd.it/m${i}`,
      watchedOn: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      isRewatch: i > 0,
    }));

    const rows = stagingRows({
      watched: [{
        correlation: 'many|2001', name: 'Many', year: 2001,
        filmUri: null, rating: 5, bucket: 'loved', watchedOn: '2024-01-01',
      }],
      watchlist: [],
      watches,
      counts: {
        watched: 1, watchlist: 0, rated: 1, dated: 1, watches: watches.length,
        malformed: 0, damagedFiles: 0, watchlistAlreadyWatched: 0,
      },
    });

    expect(rows[0]!.watches).toHaveLength(MAX_WATCHES_PER_TITLE);
    const kept = rows[0]!.watches!.map((w) => w.watchedOn);
    expect(kept[0]!).toBe([...kept].sort().reverse()[0]!);
  });
});
