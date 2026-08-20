import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CANONICAL_GENRES, canonicalGenres, readCatalogue, simulate } from './genre-ladder-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENRES_TS = readFileSync(join(ROOT, 'src', 'features', 'awards', 'genres.ts'), 'utf8');

/**
 * The ladder report is evidence, so the things it could quietly be wrong about are tested.
 *
 * Genre Gremlin's thresholds were set from this script's output. That makes it a source of
 * truth for a product decision, and a source of truth nothing checks is the situation the
 * rebalance was correcting in the first place — the note it replaced quoted a calibration
 * run that no longer reproduced, and the founder's brief quoted a percentile as a median.
 *
 * Two risks are specific and both are covered here:
 *
 *   1. **The vocabulary is duplicated.** The script is `.mjs` and cannot import the app's
 *      TypeScript, so it carries its own copy of the eighteen genres and their patterns.
 *      A copy that drifts would produce numbers about a vocabulary the app does not use.
 *   2. **The catalogue is parsed out of a SQL migration** by regex. A parser that silently
 *      matched fewer rows would make every genre look rarer and every threshold look
 *      harder — in the direction that would wrongly justify a lower ceiling.
 */

describe('the vocabulary matches the app', () => {
  it('lists the same eighteen genres, in the same order', () => {
    const block = GENRES_TS.match(/export const CANONICAL_GENRES = \[(.*?)\] as const;/s);
    assert.ok(block, 'could not find CANONICAL_GENRES in genres.ts');
    const fromApp = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(CANONICAL_GENRES, fromApp);
  });

  it('classifies both catalogue vocabularies the way the app does', () => {
    // The cases `genres.ts` calls out by name: Wikidata's verbose lower-case labels and
    // TMDB's own names have to land on the same canonical genre.
    assert.deepEqual([...canonicalGenres(['drama film'])], ['Drama']);
    assert.deepEqual([...canonicalGenres(['Drama'])], ['Drama']);
    assert.deepEqual([...canonicalGenres(['science fiction film'])], ['Science Fiction']);
    assert.deepEqual([...canonicalGenres(['sci-fi'])], ['Science Fiction']);
    assert.deepEqual([...canonicalGenres(['documentary television program'])], ['Documentary']);
    assert.deepEqual([...canonicalGenres(['anime'])], ['Animation']);
    // One title, one genre, however many names it has for it.
    assert.deepEqual([...canonicalGenres(['comedy drama', 'romantic comedy film'])].sort(), [
      'Comedy',
      'Drama',
      'Romance',
    ]);
    // The two `genres.ts` guards against by word boundary.
    assert.deepEqual([...canonicalGenres(['warm family drama'])].sort(), ['Drama', 'Family']);
    // A label the vocabulary does not know contributes nothing rather than a new genre.
    assert.deepEqual([...canonicalGenres(['huis-clos film'])], []);
  });
});

describe('the catalogue it counts', () => {
  const catalogue = readCatalogue();

  it('reads the loggable universe: movies and seasons, never series', () => {
    /**
     * **Exact counts, not lower bounds, and independent review is why.**
     *
     * This asserted `> 300` movies and `> 1000` seasons, which a parser could satisfy while
     * silently dropping hundreds of rows — and dropping rows is not a neutral error here.
     * Fewer rows makes every genre look rarer, the tail look thinner, and a *lower* Gold
     * ceiling look better justified than it is. The failure mode of this parser points
     * directly at the decision it feeds, so the test has to be exact.
     *
     * These are the seeded catalogue's real counts. If the seed migration legitimately
     * gains titles, update them deliberately and re-run the report — the thresholds rest
     * on this number.
     */
    assert.equal(catalogue.movieCount, 382);
    assert.equal(catalogue.seriesCount, 196);
    assert.equal(catalogue.seasonCount, 1432);
    // A series is watchlistable but never loggable (PRD §10, `_assert_loggable`), so it is
    // not a unit: counting series would inflate the common genres and make the ladder look
    // easier than it is.
    assert.equal(catalogue.units.length, 1814);
    assert.equal(catalogue.units.length, catalogue.movieCount + catalogue.seasonCount);
  });

  it('parses a genre off every row that has one, rather than most of them', () => {
    /**
     * The other half of the same risk, and asserted exactly for the same reason: a row can
     * be found while its `array[...]::text[]` literal is missed, which loses genres without
     * losing units. A rounded mean was the first attempt and review was right that it is
     * too weak — dropping a few dozen associations still rounds to 2.68.
     *
     * So this is the **total number of (unit, canonical genre) pairs**, which is the
     * quantity the whole simulation walks. Nothing can be dropped from it silently.
     */
    const countable = catalogue.units.filter((unit) => unit.genres.size > 0);
    assert.equal(countable.length, 1551);

    const total = countable.reduce((sum, unit) => sum + unit.genres.size, 0);
    assert.equal(total, 4160);
    // 2.68 per countable unit, which is the figure the entry tier's "a handful of ordinary
    // multi-genre titles" argument rests on. Derived here rather than asserted separately,
    // so there is one number to keep true.
    assert.equal(Math.round((total / countable.length) * 100) / 100, 2.68);
  });

  it('counts every canonical genre exactly, because the two rarest set the ceiling', () => {
    // Gold is 17 rather than 18 because Documentary and Animation are 6 and 10 rows. An
    // ordering assertion would survive both of those numbers halving; these will not.
    const counts = new Map(CANONICAL_GENRES.map((genre) => [genre, 0]));
    for (const unit of catalogue.units) {
      for (const genre of unit.genres) counts.set(genre, counts.get(genre) + 1);
    }
    assert.deepEqual(
      Object.fromEntries([...counts].sort((a, b) => a[1] - b[1])),
      {
        Documentary: 6,
        Animation: 10,
        Western: 23,
        Music: 39,
        Family: 54,
        War: 69,
        History: 108,
        Romance: 112,
        Mystery: 124,
        Horror: 146,
        Crime: 266,
        Fantasy: 269,
        'Science Fiction': 340,
        Adventure: 343,
        Comedy: 343,
        Thriller: 355,
        Action: 451,
        Drama: 1102,
      },
    );
  });

  it('gives seasons their series genres, which is where most of the catalogue is', () => {
    // Seasons are four fifths of the loggable rows and carry no genres of their own. If
    // the inheritance were dropped the simulation would be a movies-only one wearing the
    // whole catalogue's name — the exact error the note this replaced had made.
    // Exact, like the counts above: a proportional bound would survive the parent join
    // silently losing a quarter of the seasons.
    const seasons = catalogue.units.filter((unit) => unit.kind === 'season');
    const movies = catalogue.units.filter((unit) => unit.kind === 'movie');
    assert.equal(seasons.filter((unit) => unit.genres.size > 0).length, 1171);
    assert.equal(movies.filter((unit) => unit.genres.size > 0).length, 380);
  });

  it('finds the thin tail the top tier rests on', () => {
    const counts = new Map(CANONICAL_GENRES.map((genre) => [genre, 0]));
    for (const unit of catalogue.units) {
      for (const genre of unit.genres) counts.set(genre, counts.get(genre) + 1);
    }
    // The two rarest are the reason Gold is 17 rather than 18. Asserted as an ordering
    // rather than as exact counts, so enriching the catalogue does not fail the suite —
    // but a parser change that made them disappear entirely would.
    const rarest = [...counts.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([g]) => g);
    assert.deepEqual(rarest.sort(), ['Animation', 'Documentary']);
    assert.ok(counts.get('Drama') > 1000, 'Drama should dominate a catalogue like this one');
  });
});

describe('the simulation behind the thresholds', () => {
  const catalogue = readCatalogue();

  it('is deterministic, so a quoted number can be re-derived', () => {
    const a = simulate(catalogue.units, { samples: 400, targets: [14, 16, 17], seed: 1 });
    const b = simulate(catalogue.units, { samples: 400, targets: [14, 16, 17], seed: 1 });
    assert.deepEqual(a, b);
  });

  it('gets harder with every extra genre, and sharply so at the end', () => {
    const rows = simulate(catalogue.units, {
      samples: 2000,
      targets: [12, 14, 16, 17, 18],
      seed: 20260820,
    });
    const median = Object.fromEntries(rows.map((row) => [row.genres, row.median]));

    for (const [lower, higher] of [[12, 14], [14, 16], [16, 17], [17, 18]]) {
      assert.ok(
        median[higher] > median[lower],
        `${higher} genres should cost more than ${lower}: ${median[higher]} vs ${median[lower]}`,
      );
    }
    // The claim the ladder is built on: the step to the last genre is the expensive one,
    // which is why Gold sits at 17 and the tiers are not evenly spaced.
    assert.ok(
      median[18] - median[17] > median[17] - median[16],
      'the 18th genre should be the most expensive step of all',
    );
  });

  it('places the chosen ladder where the threshold note says it does', () => {
    // The numbers quoted in `src/features/awards/tracks.ts`. Bounds rather than equalities
    // so a sampling change reports rather than flakes, but tight enough that the note
    // cannot drift away from the code without this failing.
    const rows = simulate(catalogue.units, { samples: 4000, targets: [14, 16, 17], seed: 20260820 });
    const [bronze, silver, gold] = rows;

    assert.ok(bronze.median >= 20 && bronze.median <= 35, `Bronze median ${bronze.median}`);
    assert.ok(silver.median >= 50 && silver.median <= 75, `Silver median ${silver.median}`);
    assert.ok(gold.median >= 95 && gold.median <= 140, `Gold median ${gold.median}`);

    // Every tier reachable by everybody who keeps logging: a threshold nobody can reach
    // is not a hard award, it is a broken one.
    for (const row of rows) assert.equal(row.unreachablePct, 0);
  });
});
