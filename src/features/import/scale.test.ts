import { MAX_PAGES, PAGE_ROWS } from '@/lib/read-all';

import { DEFAULT_LIMITS } from './archive';
import { exportBytes, generateExport } from './generate-fixture';
import { normalise } from './letterboxd';

/**
 * The client half of the Collection scale gate.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHAT IT EXPLICITLY DOES NOT
 *
 * Two costs sit between a person and an imported library, and conflating them is how a
 * scale decision gets made against the wrong number:
 *
 *   **Parsing the archive** happens once, on the device, before anything is sent. That is
 *   what this file measures, and it is the only half that can be measured without a
 *   staging backend and a physical phone.
 *
 *   **Reading the collection afterwards** happens on every cold open of the Collection tab
 *   for as long as the account exists. `readAllByKey` pages it a thousand rows at a time,
 *   *serially*, and settles all-or-nothing — so a large library is several back-to-back
 *   round trips before the first poster is drawn. That is the number the release gate
 *   actually turns on, it needs a device and a real backend, and **nothing in this file
 *   speaks to it.**
 *
 * So: passing here is necessary and nowhere near sufficient. The gate is not met until the
 * device measurement exists.
 *
 * ---------------------------------------------------------------------------
 * ON ASSERTING TIMINGS
 *
 * The timing bounds below are deliberately an order of magnitude above what a laptop
 * actually takes. A tight bound in CI is a flaky test that eventually gets deleted, which
 * is worse than no bound; these exist to catch an accidental quadratic, not to characterise
 * performance. The numbers are printed rather than asserted, because the printed number is
 * the thing worth reading.
 */

const SIZES = [2_500, 5_000, 10_000] as const;

/** Generous enough that only an algorithmic regression trips it. */
const CEILING_MS_PER_1K = 2_000;

const NOW = new Date(2026, 8, 11);

describe.each(SIZES)('a synthetic library of %i titles', (titles) => {
  const generated = generateExport({ titles, seed: 7 });
  const bytes = exportBytes(generated);

  const started = Date.now();
  const result = normalise(
    {
      'watched.csv': generated['watched.csv'],
      'ratings.csv': generated['ratings.csv'],
      'diary.csv': generated['diary.csv'],
      'watchlist.csv': generated['watchlist.csv'],
    },
    { now: NOW },
  );
  const elapsed = Date.now() - started;

  it('normalises every title exactly once', () => {
    expect(result.watched).toHaveLength(titles);
    expect(result.counts.watched).toBe(titles);
  });

  it('rates every title, because the generator does', () => {
    expect(result.counts.rated).toBe(titles);
    expect(result.watched.every((t) => t.bucket !== null)).toBe(true);
  });

  it('reads no malformed rows out of a well-formed archive', () => {
    expect(result.counts.malformed).toBe(0);
  });

  it('gives a watch date only to titles with a diary entry', () => {
    // At scale the `Date` trap would show up as thousands of dated titles rather than the
    // handful the diary actually accounts for.
    expect(result.counts.dated).toBeGreaterThan(0);
    expect(result.counts.dated).toBeLessThan(titles);
    expect(result.counts.dated).toBeLessThanOrEqual(result.counts.watches);
  });

  it('keeps every viewing distinct', () => {
    const uris = new Set(result.watches.map((w) => w.diaryUri));
    expect(uris.size).toBe(result.watches.length);
  });

  it('keeps the watchlist and the collection disjoint', () => {
    const watched = new Set(result.watched.map((t) => t.correlation));
    expect(result.watchlist.some((w) => watched.has(w.correlation))).toBe(false);
  });

  it('still handles the awkward titles at scale', () => {
    const names = new Set(result.watched.map((t) => t.name));
    expect(names.has('Crouching Tiger, Hidden Dragon')).toBe(true);
    expect(names.has('Joker: Folie à Deux')).toBe(true);
    expect(names.has('万引き家族')).toBe(true);
  });

  it('stays well inside the archive bounds', () => {
    // The four files we read are a fraction of the archive, so if even the whole export at
    // this size approached the bomb guard the guard would be wrong rather than the library.
    expect(bytes).toBeLessThan(DEFAULT_LIMITS.maxTotalBytes);
  });

  it('parses without an accidental quadratic', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[scale] ${titles} titles · ${(bytes / 1024).toFixed(0)} KiB of CSV · ` +
        `${elapsed} ms to parse and normalise · ${result.counts.watches} viewings`,
    );
    expect(elapsed).toBeLessThan((titles / 1_000) * CEILING_MS_PER_1K);
  });
});

describe('the gate that cannot be run here', () => {
  it('is recorded rather than assumed', () => {
    // A test that asserts a documented fact, so the fact cannot quietly stop being true.
    // `readAllByKey` errors rather than truncating past twelve pages of a thousand, and
    // that ceiling is the one number in the scale question that no measurement can move.
    expect(PAGE_ROWS * MAX_PAGES).toBe(12_000);
    expect(Math.max(...SIZES)).toBeLessThan(PAGE_ROWS * MAX_PAGES);
  });
});
