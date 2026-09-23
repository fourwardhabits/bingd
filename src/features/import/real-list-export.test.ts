import { strToU8, zipSync, type Zippable } from 'fflate';

import { REAL_EXPORT, REAL_LISTING } from './__fixtures__/real-export';
import {
  REAL_LIST_EXPORT_LISTING,
  REAL_LIST_ONE_CSV,
  REAL_LIST_TWO_CSV,
  REAL_LISTS,
} from './__fixtures__/real-list-export';
import { readArchive } from './read-archive';

/**
 * What a real "Letterboxd list export v7" file looks like, pinned, and proof that today's
 * importer ignores it.
 *
 * No list importer exists yet (T6c, `docs/product/letterboxd-lists-import.md`). This file
 * records the format so that one is built against real bytes rather than a guess. It also
 * guards the current contract: list files are never read.
 */

const lines = (csv: string) => csv.split('\r\n');

describe.each([
  ['one', REAL_LIST_ONE_CSV, 4],
  ['two', REAL_LIST_TWO_CSV, 3],
])('real list %s', (_, csv, items) => {
  it('uses CRLF throughout, with no BOM and no bare LF', () => {
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('opens with the version line, then one metadata row, a blank line, then items', () => {
    const l = lines(csv);
    expect(l[0]).toBe('Letterboxd list export v7');
    expect(l[1]).toBe('Date,Name,Tags,URL,Description');
    expect(l[2]).toMatch(/^\d{4}-\d{2}-\d{2},[^,]+,,https:\/\/boxd\.it\/\w+,$/);
    expect(l[3]).toBe('');
    expect(l[4]).toBe('Position,Name,Year,URL,Description');
  });

  it('numbers its items 1..N in file order, each with a boxd.it film URI', () => {
    const rows = lines(csv)
      .slice(5)
      .filter((row) => row !== '');
    expect(rows).toHaveLength(items);
    rows.forEach((row, i) => {
      expect(row).toMatch(new RegExp(`^${i + 1},.+,\\d{4},https://boxd\\.it/\\w+,$`));
    });
  });

  it('carries no ranked or visibility column anywhere', () => {
    expect(csv).not.toMatch(/rank|visib|privacy|public|private|shared/i);
  });
});

describe('the real list export and the current importer', () => {
  it('shares a film URI namespace with watched.csv', () => {
    // Free Solo is boxd.it/iEEq in both files, so a list item's URL is a film URI.
    expect(REAL_LIST_ONE_CSV).toContain('Free Solo,2018,https://boxd.it/iEEq,');
    expect(REAL_EXPORT['watched.csv']).toContain('Free Solo,2018,https://boxd.it/iEEq');
  });

  it('stores the root files before lists/, with no wrapper and no directory entries', () => {
    const paths = REAL_LIST_EXPORT_LISTING.map((e) => e.path);
    expect(paths.indexOf('watched.csv')).toBeLessThan(paths.indexOf('lists/fixtureone.csv'));
    expect(paths.every((p) => !p.endsWith('/'))).toBe(true);
    expect(paths.filter((p) => p.startsWith('lists/'))).toEqual(Object.keys(REAL_LISTS));
  });

  it('imports exactly the same history with the lists present as without them', () => {
    const history: Zippable = {};
    for (const { path } of REAL_LISTING) {
      const text = (REAL_EXPORT as Record<string, string | null>)[path];
      history[path] = strToU8(text ?? 'Header,Only\n');
    }
    const lists: Zippable = Object.fromEntries(
      Object.entries(REAL_LISTS).map(([path, csv]) => [path, strToU8(csv)]),
    );
    const now = new Date('2026-09-22T12:00:00Z');

    const without = readArchive(zipSync(history), { now });
    const withLists = readArchive(zipSync({ ...history, ...lists }), { now });

    expect(without.ok && withLists.ok).toBe(true);
    if (!without.ok || !withLists.ok) return;
    expect(withLists.preview.rows).toEqual(without.preview.rows);
    const names = withLists.preview.rows.map((r) => r.name);
    expect(names).not.toContain('Batman');
  });
});
