import { strToU8, zipSync } from 'fflate';

import { inspect, readWanted } from './archive';
import { parseCsv } from './csv';
import { DamagedZipError, looksLikeZip, NotAZipError, zipSource } from './zip';

/**
 * The decompressor, and the two things about it that are load-bearing.
 *
 * Most of this file is ordinary round-tripping. Two tests are not: the one that proves the
 * listing pass inflates nothing, and the one that proves the listed size is the
 * uncompressed one. Both of those are guarantees `archive.ts` states in prose and can only
 * *keep* through this module, so they are asserted mechanically rather than by reading the
 * code and believing it.
 */

const build = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const WATCHED = 'Date,Name,Year,Letterboxd URI\n2024-01-02,Shrek,2001,https://boxd.it/2a\n';

/**
 * Rewrites one member's compression method in the central directory to a type no reader
 * supports.
 *
 * This is the lever the "nothing is inflated" test pulls. `unzipSync` reads the method from
 * the central directory and throws `unknown compression type` — but only *after* the filter
 * has returned true for that member. An entry patched this way is therefore free to list
 * and impossible to read, which makes "did it inflate?" an observable fact rather than an
 * assertion about intent.
 */
function breakCompressionMethod(zip: Uint8Array, name: string): Uint8Array {
  const out = zip.slice();
  const wanted = strToU8(name);

  for (let i = 0; i + 46 <= out.length; i++) {
    // 'PK\x01\x02' — a central directory file header.
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b || out[i + 2] !== 0x01 || out[i + 3] !== 0x02) {
      continue;
    }
    const nameLength = out[i + 28]! | (out[i + 29]! << 8);
    if (nameLength !== wanted.length) continue;
    if (!wanted.every((byte, j) => out[i + 46 + j] === byte)) continue;

    // The compression method is a 2-byte field 10 bytes into a central directory header.
    // 14 is LZMA, which `fflate` knows the number of and refuses to decode.
    out[i + 10] = 14;
    out[i + 11] = 0;
    return out;
  }

  throw new Error(`no central directory entry named ${name}`);
}

/**
 * Renames one member in the central directory only, leaving its local header and data alone.
 *
 * Produces a duplicate name, which `zipSync` will not emit and a hand-written archive can.
 * Both names must be the same length: the entry's name-length field is what the reader walks
 * by, so changing it would desynchronise every entry after this one.
 */
function renameInCentralDirectory(zip: Uint8Array, from: string, to: string): Uint8Array {
  const out = zip.slice();
  const before = strToU8(from);
  const after = strToU8(to);
  if (before.length !== after.length) throw new Error('names must be the same length');

  for (let i = 0; i + 46 <= out.length; i++) {
    if (out[i] !== 0x50 || out[i + 1] !== 0x4b || out[i + 2] !== 0x01 || out[i + 3] !== 0x02) {
      continue;
    }
    const nameLength = out[i + 28]! | (out[i + 29]! << 8);
    if (nameLength !== before.length) continue;
    if (!before.every((byte, j) => out[i + 46 + j] === byte)) continue;

    after.forEach((byte, j) => {
      out[i + 46 + j] = byte;
    });
    return out;
  }

  throw new Error(`no central directory entry named ${from}`);
}

describe('looksLikeZip', () => {
  it('accepts an archive', () => {
    expect(looksLikeZip(build({ 'watched.csv': WATCHED }))).toBe(true);
  });

  it('rejects a CSV somebody picked instead of the archive', () => {
    expect(looksLikeZip(strToU8(WATCHED))).toBe(false);
  });

  it('rejects something too short to be an empty archive', () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });
});

describe('zipSource', () => {
  it('refuses bytes that are not an archive, before scanning them', () => {
    expect(() => zipSource(strToU8(WATCHED))).toThrow(NotAZipError);
  });

  it('lists every member with its path', () => {
    const source = zipSource(build({ 'watched.csv': WATCHED, 'reviews.csv': 'Date\n' }));
    expect(source.list().map((e) => e.path).sort()).toEqual(['reviews.csv', 'watched.csv']);
  });

  it('reports the uncompressed size, not the compressed one', () => {
    // 20,000 identical bytes deflate to a couple of hundred. If this read fflate's `size`
    // — which is the *compressed* length despite the name — the number below would be two
    // orders of magnitude small, and every bound in `archive.ts` would be measuring the
    // one figure a decompression bomb makes tiny on purpose.
    const source = zipSource(build({ 'watched.csv': 'a'.repeat(20_000) }));
    const entry = source.list()[0]!;
    expect(entry.bytes).toBe(20_000);
  });

  it('inflates nothing while listing', () => {
    // The privacy guarantee, as a fact rather than a claim. `reviews.csv` cannot be
    // decompressed by anybody; listing the archive is fine, which is only possible if the
    // listing pass never asked for its bytes.
    const zip = breakCompressionMethod(
      build({ 'watched.csv': WATCHED, 'reviews.csv': 'Date,Review\n2024-01-02,private\n' }),
      'reviews.csv',
    );
    const source = zipSource(zip);

    expect(source.list().map((e) => e.path).sort()).toEqual(['reviews.csv', 'watched.csv']);
    // And the excluded file really is the unreadable one, so the test above is not passing
    // because the archive happens to be readable throughout.
    expect(() => source.readEntry('reviews.csv')).toThrow(DamagedZipError);
    expect(source.readEntry('watched.csv')).toBe(WATCHED);
  });

  it('reads a member back exactly', () => {
    const source = zipSource(build({ 'watched.csv': WATCHED }));
    expect(source.readEntry('watched.csv')).toBe(WATCHED);
  });

  it('never lets a byte-order mark reach a header name, whoever strips it', () => {
    // **This is asserted at the header rather than at the decoder, because which of the two
    // strips the mark is not a fact about our code.** `strFromU8` uses `TextDecoder` when the
    // runtime has one, and a default `TextDecoder` consumes a leading BOM; where there is
    // none it falls back to its own decoder, which does not. Hermes' coverage of
    // `TextDecoder` is therefore the difference between the two behaviours, and asserting
    // either one here would pin this test to the engine the test runner happens to use.
    //
    // What must be true in both worlds is that no header is ever named `\uFEFFDate`, which
    // `parseCsv` guarantees by stripping the mark if it is still there. So the assertion is
    // the one thing neither path may break.
    const source = zipSource(build({ 'watched.csv': `\uFEFF${WATCHED}` }));
    const text = source.readEntry('watched.csv');

    expect(parseCsv(text).headers[0]).toBe('Date');
    expect(text).toContain('Shrek');
  });

  it('decodes UTF-8 rather than bytes', () => {
    const source = zipSource(build({ 'watched.csv': 'Name\nAmélie\n' }));
    expect(source.readEntry('watched.csv')).toContain('Amélie');
  });

  it('refuses an archive it cannot walk', () => {
    const zip = build({ 'watched.csv': WATCHED });
    // Destroy the end-of-central-directory record the reader navigates by, while leaving
    // the local header signature intact so it still claims to be an archive.
    const damaged = zip.slice(0, zip.length - 8);
    expect(() => zipSource(damaged).list()).toThrow(DamagedZipError);
  });

  it('reads the first of two members with the same name', () => {
    // `inspect` picks a path with `find`, so a duplicate name must resolve to the same
    // member here. Otherwise the file checked against the bounds and the file actually read
    // are different ones — which is the guarantee inverted, in an archive somebody could
    // write on purpose.
    //
    // `zipSync` will not emit a duplicate, so the archive is built honestly and then its
    // second central directory entry is renamed onto the first's name. Both entries still
    // point at their own local headers and their own data, which is the shape a
    // hand-written archive would have.
    const zip = renameInCentralDirectory(
      build({ '1.csv': 'first', '2.csv': 'second' }),
      '2.csv',
      '1.csv',
    );
    const source = zipSource(zip);

    expect(source.list().map((e) => e.path)).toEqual(['1.csv', '1.csv']);
    expect(source.readEntry('1.csv')).toBe('first');
  });
});

describe('driving archive.ts with a real archive', () => {
  const full = () =>
    build({
      'letterboxd-someone-2026-09-11/watched.csv': WATCHED,
      'letterboxd-someone-2026-09-11/ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-02,Shrek,2001,https://boxd.it/2a,4.5\n',
      'letterboxd-someone-2026-09-11/watchlist.csv': 'Date,Name,Year,Letterboxd URI\n2024-02-02,Dune,2021,https://boxd.it/2b\n',
      'letterboxd-someone-2026-09-11/reviews.csv': 'Date,Name,Review\n2024-01-02,Shrek,a private review\n',
      'letterboxd-someone-2026-09-11/deleted/diary.csv': 'Date,Name\n2024-01-02,Deleted\n',
      'letterboxd-someone-2026-09-11/profile.csv': 'Username\nsomeone\n',
    });

  it('finds the wanted files under a wrapper folder', () => {
    const found = inspect(zipSource(full()));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.found['watched.csv']).toBe('letterboxd-someone-2026-09-11/watched.csv');
    expect(found.found['ratings.csv']).toBe('letterboxd-someone-2026-09-11/ratings.csv');
    // Absent from this archive, and legitimately absent from real ones.
    expect(found.found['diary.csv']).toBeUndefined();
  });

  it('reads the four and never asks for the rest', () => {
    const source = zipSource(full());
    const asked: string[] = [];
    const watched = {
      list: () => source.list(),
      readEntry: (path: string) => {
        asked.push(path);
        return source.readEntry(path);
      },
    };

    const found = inspect(watched);
    if (!found.ok) throw new Error('expected a Letterboxd archive');
    const text = readWanted(watched, found.found);

    expect(text['watched.csv']).toBe(WATCHED);
    expect(text['diary.csv']).toBeNull();
    // Nothing from `deleted/`, `reviews.csv` or `profile.csv` was ever requested.
    expect(asked.sort()).toEqual([
      'letterboxd-someone-2026-09-11/ratings.csv',
      'letterboxd-someone-2026-09-11/watched.csv',
      'letterboxd-someone-2026-09-11/watchlist.csv',
    ]);
  });

  it('refuses an archive that is not a Letterboxd export', () => {
    const found = inspect(zipSource(build({ 'notes.txt': 'hello', 'photo.jpg': 'x' })));
    expect(found).toEqual({ ok: false, reason: 'not_letterboxd' });
  });
});
