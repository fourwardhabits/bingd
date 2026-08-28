import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANONICAL_GENRES } from './genres';
import { AWARD_TRACKS } from './tracks';

/**
 * The server's copy of the award ladder, held to the client's original.
 *
 * `tracks.ts`'s header says no second copy of a threshold may exist, and
 * `20260828000100_an_award_that_says_so.sql` violates that on purpose: the unlock
 * detector runs where the facts change, which is the server, and it cannot import
 * TypeScript. This file is the price of the copy — the migration's seeded
 * `award_tiers` and `award_genre_patterns` rows are parsed out of the SQL source
 * and compared with `AWARD_TRACKS` and `genres.ts`, so a tuned threshold, a
 * renamed tier or an edited pattern that touches only one side fails CI instead
 * of shipping a ledger that disagrees with the sheet. The same move
 * `genre-ladder-report.test.mjs` already makes for its own copy.
 *
 * Pattern EXECUTION parity — that `\y` behaves as `\b` did over real labels — is
 * asserted against a live Postgres in `supabase/tests/award-unlocks.test.mjs`;
 * this file pins that the pattern TEXT is the mechanical translation and nothing
 * more.
 */

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260828000100_an_award_that_says_so.sql'),
  'utf8',
);

const GENRES_TS = readFileSync(join(__dirname, 'genres.ts'), 'utf8');

type SeededTier = {
  awardKey: string;
  tierIndex: number;
  tierKey: string;
  tierLabel: string;
  displayName: string;
  threshold: number;
  social: boolean;
};

/** The 60 seeded rows, in file order. */
function seededTiers(): SeededTier[] {
  const block = MIGRATION.match(
    /insert into award_tiers \(award_key, tier_index, tier_key, tier_label, display_name, threshold, social\) values\s*([\s\S]*?);/,
  );
  if (!block) throw new Error('award_tiers seed not found in the migration');

  const rows = [
    ...block[1]!.matchAll(
      /\('([a-z-]+)',\s*(\d),\s*'([a-z-]+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(true|false)\)/g,
    ),
  ];
  return rows.map((row) => ({
    awardKey: row[1]!,
    tierIndex: Number(row[2]),
    tierKey: row[3]!,
    tierLabel: row[4]!,
    displayName: row[5]!,
    threshold: Number(row[6]),
    social: row[7] === 'true',
  }));
}

/** The 18 seeded patterns, keyed by canonical name, SQL quote-doubling undone. */
function seededPatterns(): Map<string, string> {
  const block = MIGRATION.match(
    /insert into award_genre_patterns \(canonical, pattern\) values\s*([\s\S]*?);/,
  );
  if (!block) throw new Error('award_genre_patterns seed not found in the migration');

  const rows = [...block[1]!.matchAll(/\('([^']+)',\s*'((?:[^']|'')+)'\)/g)];
  return new Map(rows.map((row) => [row[1]!, row[2]!.replaceAll("''", "'")]));
}

/** genres.ts's PATTERNS entries, as regex source text, keyed by canonical name. */
function clientPatterns(): Map<string, string> {
  const block = GENRES_TS.match(/const PATTERNS: Record<CanonicalGenre, RegExp> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('PATTERNS not found in genres.ts');

  const rows = [...block[1]!.matchAll(/^\s*'?([A-Za-z ]+)'?:\s*\/(.+)\/,\s*$/gm)];
  return new Map(rows.map((row) => [row[1]!.trim(), row[2]!]));
}

describe('the seeded award ladder is tracks.ts', () => {
  const seeded = seededTiers();

  it('carries all sixty tiers, in ladder order, and nothing else', () => {
    expect(seeded).toHaveLength(60);

    const fromTracks = AWARD_TRACKS.flatMap((track) =>
      track.tiers.map((tier, index) => ({
        awardKey: track.key,
        tierIndex: index + 1,
        tierKey: tier.key,
        tierLabel: tier.label,
        displayName: track.displayName,
        threshold: tier.threshold,
        social: track.key !== 'hype-courier',
      })),
    );

    expect(seeded).toEqual(fromTracks);
  });

  it('keeps Hype Courier, and only Hype Courier, off the feed', () => {
    // Its progress is withheld from visitors, so a public post announcing the
    // crossing would disclose the number the product refuses to show. Every other
    // track is public progress and posts.
    const silent = [...new Set(seeded.filter((t) => !t.social).map((t) => t.awardKey))];
    expect(silent).toEqual(['hype-courier']);
  });
});

describe('the seeded genre vocabulary is genres.ts', () => {
  it('covers exactly the eighteen canonical genres', () => {
    expect([...seededPatterns().keys()].sort()).toEqual([...CANONICAL_GENRES].sort());
  });

  it('is the mechanical \\b → \\y translation of each pattern, character for character', () => {
    const client = clientPatterns();
    expect([...client.keys()].sort()).toEqual([...CANONICAL_GENRES].sort());

    for (const [canonical, source] of client) {
      const expected = source.replaceAll('\\b', '\\y');
      expect(seededPatterns().get(canonical)).toBe(expected);
    }
  });
});
