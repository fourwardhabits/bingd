import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_WORLD, generateWorld } from '@/features/recommendations/evaluation/world';

import { validateExport } from './format';
import { holdOut, renderReplay, replay, tasteMatch } from './replay';
import { syntheticExport } from './synthetic';

/**
 * The Recommendation V2 replay (`replay.ts`).
 *
 * Always: the pipeline end to end on a small **synthetic** export (`synthetic.ts`), the
 * holdout, the JS Match, and that the report carries no account key.
 *
 * Only through `run.mjs` (`REC_V2_REPLAY=1`): the replay of a real export at
 * `REC_V2_REPLAY_EXPORT`, or of the full-size synthetic one with `REC_V2_REPLAY_SYNTHETIC=1`.
 * The report goes to stdout, and to `REC_V2_REPLAY_OUT` if set (outside the repository).
 */

const small = { ...DEFAULT_WORLD, titles: 400, people: 160, watchedMedian: 24 };

describe('Recommendation V2 replay', () => {
  it('builds a synthetic export the validator accepts, with whole-show rankers in it', () => {
    const doc = validateExport(
      JSON.parse(JSON.stringify(syntheticExport(generateWorld(small)))),
    );
    expect(doc.rankings.some((r) => r.c === 'tv_shows')).toBe(true);
    expect(doc.rankings.some((r) => r.c === 'tv_seasons')).toBe(true);
  });

  it('holds out the last fifth of each account’s Liked rankings by time, and only those', () => {
    const doc = syntheticExport(generateWorld(small));
    const { accounts } = holdOut(doc);
    expect(accounts.length).toBeGreaterThan(50);
    for (const account of accounts) {
      const all = doc.rankings
        .filter((r) => r.u === account.key)
        .sort((a, b) => a.day - b.day || a.seq - b.seq);
      const loved = all.filter((r) => r.b === 'loved');
      const held = new Set(
        loved.slice(-Math.max(1, Math.round(loved.length * 0.2))).map((r) => r.m),
      );
      expect(account.visible.some((r) => held.has(r.m))).toBe(false);
      expect(account.logged.some((l) => held.has(l.m))).toBe(false);
      expect(account.visible).toHaveLength(all.length - held.size);
      for (const c of ['movies', 'tv_seasons', 'tv_shows']) {
        account.visible
          .filter((r) => r.c === c)
          .sort((a, b) => a.p - b.p)
          .forEach((r, i) => expect(r.p).toBe(i + 1));
      }
    }
  });

  it('computes the WS5 Match: a show and its seasons are one unit', () => {
    const unitOf = (id: string) => id.split('#')[0]!;
    const a = new Map([
      ['x#1', 9],
      ['x#2', 8],
      ['y', 7],
      ['z', 3],
      ['w', 6],
      ['v', 5],
    ]);
    // Six shared rows, five shared units: exactly the threshold.
    expect(tasteMatch(a, a, unitOf)).toEqual({ score: expect.any(Number), units: 5 });
    expect(
      tasteMatch(
        a,
        new Map([
          ['x#1', 9],
          ['x#2', 8],
          ['y', 7],
          ['z', 3],
        ]),
        unitOf,
      ).score,
    ).toBeNull();
    // Identical opinions on n units shrink toward 50 by n/(n+5): 50 + 50 × 5/10 = 75.
    expect(tasteMatch(a, a, unitOf).score).toBe(75);
  });

  it('replays V1 and V2 metadata end to end and prints aggregates only', () => {
    const doc = syntheticExport(generateWorld(small));
    const report = replay(JSON.parse(JSON.stringify(doc)));
    expect(report.results.movies?.all?.v1?.recall50).not.toBeNull();
    expect(report.results.tv?.whole_show_rankers).toBeDefined();
    for (const medium of ['movies', 'tv']) {
      for (const engine of ['v1', 'v2_metadata']) {
        expect(report.results[medium]!.all![engine]!.seenShare?.mean).toBe(0);
      }
    }
    const text = renderReplay(report, 'synthetic smoke');
    expect(text).toMatch(/Not measurable at current scale/);
    // No id of any kind in the report.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  (process.env.REC_V2_REPLAY === '1' ? it : it.skip)(
    'replays an export (run.mjs)',
    () => {
      const synthetic = process.env.REC_V2_REPLAY_SYNTHETIC === '1';
      const path = process.env.REC_V2_REPLAY_EXPORT;
      if (!synthetic && !path) throw new Error('REC_V2_REPLAY_EXPORT is not set');
      const input = synthetic
        ? JSON.parse(
            JSON.stringify(syntheticExport(generateWorld({ ...DEFAULT_WORLD, people: 1200 }))),
          )
        : JSON.parse(readFileSync(path!, 'utf8'));
      // An export may be the row psql printed: `{ "replay": { … } }` or the document itself.
      const document =
        input && typeof input === 'object' && 'replay' in input ? input.replay : input;
      const started = Date.now();
      const text = renderReplay(
        replay(document),
        synthetic ? 'SYNTHETIC export (world.ts), pipeline proof only' : 'real export',
      );
      const out = process.env.REC_V2_REPLAY_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, synthetic ? 'replay-synthetic.md' : 'replay.md'), text);
      }
      // eslint-disable-next-line no-console
      console.log(`${text}\n\nReplayed in ${Date.now() - started} ms.`);
    },
    60 * 60 * 1000,
  );
});
