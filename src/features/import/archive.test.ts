import {
  DEFAULT_LIMITS,
  NEVER_READ,
  inspect,
  readWanted,
  type ArchiveEntry,
  type ArchiveSource,
} from './archive';
import { REAL_LISTING } from './__fixtures__/real-export';

/** A source that records every path anybody asked it to open. */
function spy(entries: readonly ArchiveEntry[]) {
  const asked: string[] = [];
  const source: ArchiveSource = {
    list: () => entries,
    readEntry: (path) => {
      asked.push(path);
      return `Date,Name,Year,Letterboxd URI\n`;
    },
  };
  return { source, asked };
}

describe('selecting the four permitted files', () => {
  it('finds all four in a real listing', () => {
    const result = inspect(spy(REAL_LISTING).source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found).toEqual({
      'watched.csv': 'watched.csv',
      'ratings.csv': 'ratings.csv',
      'diary.csv': 'diary.csv',
      'watchlist.csv': 'watchlist.csv',
    });
  });

  it('accepts an archive whose contents sit inside a wrapper folder', () => {
    const listing = REAL_LISTING.map((e) => ({ ...e, path: `letterboxd-saisurajkan-2026-09-10/${e.path}` }));
    const result = inspect(spy(listing).source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found['watched.csv']).toBe('letterboxd-saisurajkan-2026-09-10/watched.csv');
  });

  it('is fine with only watched.csv present', () => {
    // A brand-new account has rated nothing and kept no diary. Demanding four files would
    // refuse a valid export.
    const result = inspect(spy([{ path: 'watched.csv', bytes: 100 }]).source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found['ratings.csv']).toBeUndefined();
  });

  it('refuses an archive with no watched.csv as not a Letterboxd export', () => {
    const result = inspect(spy([{ path: 'notes.txt', bytes: 10 }]).source);
    expect(result).toEqual({ ok: false, reason: 'not_letterboxd' });
  });
});

describe('the excluded members are never opened', () => {
  it('asks for exactly four paths and none of the twelve excluded ones', () => {
    // The privacy boundary, asserted rather than described. reviews.csv, comments.csv,
    // profile.csv, three likes files and six deleted/orphaned files are all present in the
    // listing; none may reach `readEntry`.
    const { source, asked } = spy(REAL_LISTING);
    const result = inspect(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    readWanted(source, result.found);

    expect(asked.sort()).toEqual(['diary.csv', 'ratings.csv', 'watched.csv', 'watchlist.csv']);
    for (const forbidden of NEVER_READ) expect(asked).not.toContain(forbidden);
  });

  it('does not let deleted/diary.csv satisfy diary.csv', () => {
    // `endsWith('diary.csv')` is true of `deleted/diary.csv`, and importing that would
    // resurrect entries somebody deliberately deleted. The real archive contains both, so
    // the naive test would silently pick the wrong one on every real import.
    const { source, asked } = spy([
      { path: 'watched.csv', bytes: 100 },
      { path: 'deleted/diary.csv', bytes: 100 },
      { path: 'orphaned/diary.csv', bytes: 100 },
    ]);
    const result = inspect(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.found['diary.csv']).toBeUndefined();

    readWanted(source, result.found);
    expect(asked).toEqual(['watched.csv']);
  });

  it.each([
    'deleted/./diary.csv',
    'deleted//diary.csv',
    'deleted/x/../diary.csv',
    'deleted/2026/diary.csv',
    'DELETED/diary.csv',
    'deleted\\diary.csv',
    '../deleted/diary.csv',
  ])('does not accept %p as diary.csv', (path) => {
    // Every one of these is resolved by a ZIP reader back to the deleted diary, and an
    // earlier version of `isWanted` accepted all of them — it only checked that the last
    // path segment was not literally `deleted`. Independent review found it.
    const { source, asked } = spy([{ path: 'watched.csv', bytes: 100 }, { path, bytes: 100 }]);
    const result = inspect(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.found['diary.csv']).toBeUndefined();
    readWanted(source, result.found);
    expect(asked).toEqual(['watched.csv']);
  });

  it('does not accept a file from a different folder than the export', () => {
    // The four files must come from one archive, not be collected from wherever a matching
    // name happens to appear.
    const result = inspect(spy([
      { path: 'letterboxd-2026-09-10/watched.csv', bytes: 100 },
      { path: 'somewhere-else/diary.csv', bytes: 100 },
    ]).source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.found['diary.csv']).toBeUndefined();
  });

  it('does not let likes/films.csv stand in for anything', () => {
    const result = inspect(spy([
      { path: 'watched.csv', bytes: 10 },
      { path: 'likes/films.csv', bytes: 10 },
    ]).source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.found)).toEqual(['watched.csv']);
  });

  it('reports an absent file as null rather than reading something else', () => {
    const { source } = spy([{ path: 'watched.csv', bytes: 10 }]);
    const result = inspect(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = readWanted(source, result.found);
    expect(text['watched.csv']).not.toBeNull();
    expect(text['ratings.csv']).toBeNull();
    expect(text['diary.csv']).toBeNull();
    expect(text['watchlist.csv']).toBeNull();
  });
});

describe('bounds, applied before anything is decompressed', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `f${i}.csv`, bytes: 10 }));

  it('refuses too many members', () => {
    expect(inspect(spy(many(DEFAULT_LIMITS.maxEntries + 1)).source)).toEqual({
      ok: false,
      reason: 'too_many_entries',
    });
  });

  it('refuses one oversized member', () => {
    expect(
      inspect(spy([
        { path: 'watched.csv', bytes: DEFAULT_LIMITS.maxEntryBytes + 1 },
      ]).source),
    ).toEqual({ ok: false, reason: 'entry_too_large' });
  });

  it('refuses an archive whose members total too much', () => {
    const half = Math.floor(DEFAULT_LIMITS.maxEntryBytes);
    const entries = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.csv`, bytes: half }));
    expect(inspect(spy(entries).source)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses before reading anything at all', () => {
    // The point of bounding a listing rather than a stream: a bomb is a refusal, not an
    // out-of-memory crash on somebody's phone.
    const { source, asked } = spy(many(DEFAULT_LIMITS.maxEntries + 1));
    inspect(source);
    expect(asked).toEqual([]);
  });

  it.each([Number.NaN, -5, Number.POSITIVE_INFINITY])(
    'refuses an entry whose declared size is %p',
    (bytes) => {
      // An undeclared size is an unchecked entry, and an unchecked entry must be refused
      // rather than counted as free. An earlier version clamped these to zero, so an
      // archive declaring 0 for every member — one field edit in an attacker-controlled
      // central directory — sailed past the total and got inflated anyway.
      expect(inspect(spy([{ path: 'watched.csv', bytes }]).source)).toEqual({
        ok: false,
        reason: 'entry_too_large',
      });
    },
  );

  it('accepts a genuinely empty file', () => {
    // Zero is a real, declarable size — half a real export is header-only — so it must not
    // be swept up with the nonsense values above.
    expect(inspect(spy([{ path: 'watched.csv', bytes: 0 }]).source).ok).toBe(true);
  });
});
