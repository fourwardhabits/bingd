import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AWARD_COPY } from '../../../supabase/functions/push-sender/award-copy';

import { awardAnnouncement } from './announcement';
import { AWARD_TRACKS } from './tracks';

/**
 * **The award push says what the inbox row says** (founder, physical QA, 2026-09-14).
 *
 * The push sender runs on Deno and cannot import `tracks.ts`, so it reads a table,
 * `supabase/functions/push-sender/award-copy.ts`. That table is not written by hand: it
 * is `awardAnnouncement` evaluated for every tier of every track, which is the same call
 * the inbox row, the feed post and the celebration make. This test is both halves: it
 * fails when the table and the canonical copy disagree, and it rewrites the table when run
 * with `UPDATE_AWARD_PUSH_COPY=1`.
 *
 *   UPDATE_AWARD_PUSH_COPY=1 npx jest src/features/awards/award-push-copy.test.ts
 */

const TABLE = join(__dirname, '../../../supabase/functions/push-sender/award-copy.ts');

const expected = () => {
  const entries: [string, { title: string; achievement: string | null }][] = [];
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

const render = (table: Record<string, { title: string; achievement: string | null }>) => {
  const lines = Object.entries(table).map(
    ([key, value]) =>
      `  ${JSON.stringify(key)}: { title: ${JSON.stringify(value.title)}, achievement: ${JSON.stringify(value.achievement)} },`,
  );
  return [
    '// GENERATED from src/features/awards/announcement.ts (awardAnnouncement over every tier of',
    '// every track in tracks.ts). Do not edit by hand: run',
    '//   UPDATE_AWARD_PUSH_COPY=1 npx jest src/features/awards/award-push-copy.test.ts',
    '// and award-push-copy.test.ts fails whenever this file and the app disagree.',
    '',
    '/** What an earned tier is called, and what was done to earn it, keyed `award:tier`. */',
    'export const AWARD_COPY: Readonly<',
    '  Record<string, { readonly title: string; readonly achievement: string | null }>',
    '> = {',
    ...lines,
    '};',
    '',
  ].join('\n');
};

if (process.env.UPDATE_AWARD_PUSH_COPY === '1') {
  writeFileSync(TABLE, render(expected()));
}

describe('the award push copy', () => {
  it('is awardAnnouncement for every tier of every track, and nothing else', () => {
    expect(AWARD_COPY).toEqual(expected());
  });

  it('is the generated file byte for byte, so nobody edits it by hand', () => {
    expect(readFileSync(TABLE, 'utf8').replace(/\r\n/g, '\n')).toBe(render(expected()));
  });

  it('names Seedling and what earning it took', () => {
    // The founder's own example.
    expect(AWARD_COPY['queue-dragon:seedling']).toEqual({
      title: 'Seedling',
      achievement: 'Kept 25 titles on your watchlist',
    });
  });

  it('never carries the old brand spelling', () => {
    for (const value of Object.values(AWARD_COPY)) {
      expect(`${value.title} ${value.achievement ?? ''}`).not.toMatch(/bingd\.(?!\w)/);
    }
  });
});
