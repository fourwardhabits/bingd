import { strToU8, zipSync, type Zippable } from 'fflate';

import { DEFAULT_LIMITS, WANTED } from './archive';
import { readArchive, type ReadResult } from './read-archive';
import { REAL_EXPORT, REAL_LISTING } from './__fixtures__/real-export';

/**
 * The member-count ceiling, driven end to end over real ZIP bytes.
 *
 * `archive.test.ts` tests the bounds against hand-made listings. This file tests the thing a
 * person actually meets: real archive bytes in, the preview out, through `zipSource`, the
 * bounds, the four-file rule, the parser and the payload. The question it answers is the one
 * the ceiling was raised for: does an export with many extra files still import exactly the
 * same history, and do the bomb guards still refuse what they refused before?
 */

const NOW = new Date('2026-09-12T12:00:00Z');

/** The founder's real export as a ZIP, plus every excluded member from the real listing. */
function founderArchive(extra: Zippable = {}): Uint8Array {
  const files: Zippable = {};
  for (const { path } of REAL_LISTING) {
    const text = (REAL_EXPORT as Record<string, string | null>)[path];
    files[path] = strToU8(text ?? 'Header,Only\n');
  }
  return zipSync({ ...files, ...extra });
}

/**
 * `n` list-shaped files, never meant to be read.
 *
 * The contents are deliberately a plausible film row, so if the four-file rule ever let one
 * through, a film would appear in the preview and the equality tests below would fail.
 */
function listFiles(n: number, folder = 'lists'): Zippable {
  const out: Zippable = {};
  for (let i = 0; i < n; i += 1) {
    out[`${folder}/list-${i}.csv`] = strToU8(
      `Position,Name,Year,URL\n1,Canary Film ${i},1999,https://boxd.it/zz${i}\n`,
    );
  }
  return out;
}

function preview(result: ReadResult) {
  if (!result.ok) throw new Error(`expected a preview, got ${result.reason}`);
  return result.preview;
}

const baseline = preview(readArchive(founderArchive(), { now: NOW }));

describe('a normal current export', () => {
  it('reads as it always has', () => {
    expect(REAL_LISTING.length).toBe(16);
    expect(baseline.normalised.counts.watched).toBe(22);
    expect(baseline.rows.filter((r) => r.kind === 'watchlist')).toHaveLength(2);
  });
});

describe('an export with more than fifty harmless files', () => {
  // 16 + 200 = 216 members: refused as "too big" under the old ceiling of 50.
  const result = readArchive(founderArchive(listFiles(200)), { now: NOW });

  it('is accepted', () => {
    expect(result.ok).toBe(true);
  });

  it('stages exactly the rows the export without them stages', () => {
    // The whole payload, not a count: watched, ratings, buckets, diary viewings and
    // watchlist rows must be identical, so the extra files changed nothing that is sent.
    expect(preview(result).rows).toEqual(baseline.rows);
    expect(preview(result).normalised.counts).toEqual(baseline.normalised.counts);
  });

  it('never lets a list file become a film', () => {
    const names = preview(result).rows.map((r) => r.name);
    expect(names.some((n) => n.startsWith('Canary Film'))).toBe(false);
  });
});

describe('the ceiling itself', () => {
  const base = REAL_LISTING.length;

  it('accepts an archive with exactly the limit', () => {
    const at = readArchive(founderArchive(listFiles(DEFAULT_LIMITS.maxEntries - base)), {
      now: NOW,
    });
    expect(preview(at).rows).toEqual(baseline.rows);
  });

  it('refuses one member over it', () => {
    const over = readArchive(founderArchive(listFiles(DEFAULT_LIMITS.maxEntries - base + 1)), {
      now: NOW,
    });
    expect(over).toEqual({ ok: false, reason: 'too_many_entries' });
  });

  it('is 1,000', () => {
    // Pinned so the number cannot drift without somebody rereading archive.ts's reasoning.
    expect(DEFAULT_LIMITS.maxEntries).toBe(1_000);
  });
});

describe('oversized archives are still refused', () => {
  // Zeros deflate to almost nothing, so each of these is a small file on disk that
  // *declares* a large uncompressed size, which is the shape of a decompression bomb.
  it('refuses one member declaring more than the per-file cap', () => {
    const bomb = founderArchive({
      'reviews.csv': new Uint8Array(DEFAULT_LIMITS.maxEntryBytes + 1),
    });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(readArchive(bomb, { now: NOW })).toEqual({ ok: false, reason: 'entry_too_large' });
  });

  it('refuses members that total more than the whole-archive cap, even unread ones', () => {
    const chunk = Math.floor(DEFAULT_LIMITS.maxTotalBytes / 3) + 1;
    const spread = founderArchive({
      'lists/a.csv': new Uint8Array(chunk),
      'lists/b.csv': new Uint8Array(chunk),
      'lists/c.csv': new Uint8Array(chunk),
    });
    expect(readArchive(spread, { now: NOW })).toEqual({ ok: false, reason: 'too_large' });
  });

  it('keeps the member cap below what the byte caps already allow', () => {
    // The member count is not the bomb guard; if it ever became the only thing between a
    // phone and a large listing, this is where that would show.
    expect(DEFAULT_LIMITS.maxEntries).toBeLessThan(DEFAULT_LIMITS.maxTotalBytes / 1024);
  });
});

describe('the files the importer reads are unchanged', () => {
  it('is still exactly the four', () => {
    expect([...WANTED]).toEqual(['watched.csv', 'ratings.csv', 'diary.csv', 'watchlist.csv']);
  });

  it('reads the root watched.csv, not a list named "Watched", in real export order', () => {
    // A list named "Watched" exports as `lists/watched.csv`. That is two segments, which the
    // "root or one wrapper" rule ACCEPTS. The root file wins only because `inspect` takes the
    // first match in listing order, and a real export (2026-09-21, 18 members) stores the
    // root files before `lists/`. This archive has the same order. Hardening this, so the
    // rule rather than the order decides, belongs to T6c-3 (letterboxd-lists-import.md §0).
    const decoy = founderArchive({
      'lists/watched.csv': strToU8(
        'Date,Name,Year,Letterboxd URI\n2026-09-11,Canary Film,1999,https://boxd.it/zz\n',
      ),
    });
    expect(preview(readArchive(decoy, { now: NOW })).rows).toEqual(baseline.rows);
  });
});
