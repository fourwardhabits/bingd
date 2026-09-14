import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AWARD_COPY,
  AWARD_TRACK_NAMES,
} from '../../../supabase/functions/push-sender/award-copy';

import { awardAnnouncement } from './announcement';
import { AWARD_TRACKS } from './tracks';

/**
 * **The award push says what the inbox row says** (founder, physical QA, 2026-09-14).
 *
 * The push sender runs on Deno and cannot import `tracks.ts`, so it reads a table,
 * `supabase/functions/push-sender/award-copy.ts`. That table is not written by hand: it
 * is `awardAnnouncement` evaluated for every tier of every track, which is the same call
 * the inbox row, the feed post and the celebration make, plus each track's name and
 * whether its tiers are metals, which is what `awardAnnouncement` falls back on for a tier
 * it does not know. This test is both halves: it fails when the table and the canonical
 * copy disagree, and it rewrites the table when run with `UPDATE_AWARD_PUSH_COPY=1`.
 *
 *   UPDATE_AWARD_PUSH_COPY=1 npx jest src/features/awards/award-push-copy.test.ts
 */

const TABLE = join(__dirname, '../../../supabase/functions/push-sender/award-copy.ts');

type Copy = { title: string; achievement: string | null };
type TrackName = { displayName: string; metalTiers: boolean };

const expectedCopy = (): Record<string, Copy> => {
  const entries: [string, Copy][] = [];
  for (const track of AWARD_TRACKS) {
    for (const tier of track.tiers) {
      entries.push([
        `${track.key}:${tier.key}`,
        awardAnnouncement({ key: track.key, tierKey: tier.key }),
      ]);
    }
  }
  return Object.fromEntries(entries);
};

const expectedNames = (): Record<string, TrackName> =>
  Object.fromEntries(
    AWARD_TRACKS.map((track) => [
      track.key,
      { displayName: track.displayName, metalTiers: Boolean(track.metalTiers) },
    ]),
  );

const render = (copy: Record<string, Copy>, names: Record<string, TrackName>) =>
  [
    '// GENERATED from src/features/awards/announcement.ts and tracks.ts. Do not edit by hand:',
    '//   UPDATE_AWARD_PUSH_COPY=1 npx jest src/features/awards/award-push-copy.test.ts',
    '// award-push-copy.test.ts fails whenever this file and the app disagree.',
    '',
    '/** What an earned tier is called, and what was done to earn it, keyed `award:tier`. */',
    'export const AWARD_COPY: Readonly<',
    '  Record<string, { readonly title: string; readonly achievement: string | null }>',
    '> = {',
    ...Object.entries(copy).map(
      ([key, value]) =>
        `  ${JSON.stringify(key)}: { title: ${JSON.stringify(value.title)}, achievement: ${JSON.stringify(value.achievement)} },`,
    ),
    '};',
    '',
    '/** Each track’s name, and whether its tiers are metals (titled by the track). */',
    'export const AWARD_TRACK_NAMES: Readonly<',
    '  Record<string, { readonly displayName: string; readonly metalTiers: boolean }>',
    '> = {',
    ...Object.entries(names).map(
      ([key, value]) =>
        `  ${JSON.stringify(key)}: { displayName: ${JSON.stringify(value.displayName)}, metalTiers: ${value.metalTiers} },`,
    ),
    '};',
    '',
  ].join('\n');

if (process.env.UPDATE_AWARD_PUSH_COPY === '1') {
  writeFileSync(TABLE, render(expectedCopy(), expectedNames()));
}

describe('the award push copy', () => {
  it('is awardAnnouncement for every tier of every track, and nothing else', () => {
    expect(AWARD_COPY).toEqual(expectedCopy());
  });

  it('carries every track’s name and metal flag, for the fallback', () => {
    expect(AWARD_TRACK_NAMES).toEqual(expectedNames());
  });

  it('is the generated file byte for byte, so nobody edits it by hand', () => {
    expect(readFileSync(TABLE, 'utf8').replace(/\r\n/g, '\n')).toBe(
      render(expectedCopy(), expectedNames()),
    );
  });

  it('names Seedling and what earning it took', () => {
    // The founder's own example.
    expect(AWARD_COPY['queue-dragon:seedling']).toEqual({
      title: 'Seedling',
      achievement: 'Kept 25 titles on your watchlist',
    });
  });

  it('keys every award and tier with a slug, which is all a push tap will route', () => {
    // `hrefForPush` refuses anything else, so a key that is not a slug would open the
    // Awards list instead of its celebration.
    for (const key of Object.keys(AWARD_COPY)) {
      const [award, tier] = key.split(':');
      expect(award).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(tier).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('never carries the old brand spelling', () => {
    for (const value of Object.values(AWARD_COPY)) {
      expect(`${value.title} ${value.achievement ?? ''}`).not.toMatch(/bingd\.(?!\w)/);
    }
  });
});
