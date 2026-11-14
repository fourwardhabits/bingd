import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_WORLD, generateWorld } from '@/features/recommendations/evaluation/world';

import {
  validateExport,
  type ReplayExport,
  type ReplayMedia,
  type ReplayRanking,
} from './format';
import {
  SOCIAL_LIMIT,
  holdOut,
  renderReplay,
  replay,
  socialMirror,
  tasteMatch,
  worldOf,
} from './replay';
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
    // Pool recall splits by source into parts that sum to it.
    for (const medium of ['movies', 'tv']) {
      for (const engine of ['v1', 'v2_metadata', 'v2_metadata_social']) {
        const row = report.results[medium]!.all![engine]!;
        const parts =
          (row.poolViaAnchors?.mean ?? 0) +
          (row.poolViaSocial?.mean ?? 0) +
          (row.poolViaTrending?.mean ?? 0) +
          (row.poolViaCatalogue?.mean ?? 0);
        expect(parts).toBeCloseTo(row.poolRecall?.mean ?? 0, 10);
      }
    }
    // The prototype's TV wall is V2 metadata's, metric for metric; only its Films wall differs.
    const tvMeta = report.results.tv!.all!.v2_metadata!;
    const tvProto = report.results.tv!.all!.v2_metadata_social!;
    for (const key of Object.keys(tvMeta) as (keyof typeof tvMeta)[]) {
      expect(tvProto[key]?.mean).toBe(tvMeta[key]?.mean);
    }
    expect(report.results.movies!.all!.v2_metadata!.poolViaSocial?.mean).toBe(0);
    expect(report.results.movies!.all!.v2_metadata_social!.poolViaSocial?.mean).toBeGreaterThan(
      0,
    );
    const text = renderReplay(report, 'synthetic smoke');
    expect(text).toMatch(/Not measurable at current scale/);
    expect(text).toMatch(/Pool recall by source/);
    // No id of any kind in the report.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('mirrors social_candidates as the SQL does: raw ids, one global limit, then the wall', () => {
    /**
     * Followees whose Liked rankings span both media, sized so the earlier per-wall mirror and
     * the server's one global limit of 40 disagree on **both** walls:
     *
     *   - 15 seasons of show X, each Liked by followees 4 and 5 (count 2, ids `a…`);
     *   - 30 films, each Liked by followees 2 and 3 (count 2, ids `b…`);
     *   - 15 films Liked by followee 2 alone (count 1, ids `d…`);
     *   - one season of show Y, Liked by followee 6 alone (count 1, id `9…`).
     *
     * The server ranks 45 rows at count 2 — seasons first on the id tie-break — and keeps 40: all
     * 15 seasons and the first 25 `b…` films. The old mirror filtered by medium first, so its
     * Films wall took all 30 `b…` films and 10 `d…` films (40), and its TV wall rolled seasons up
     * before counting and kept Y beside X.
     */
    const id = (prefix: string, n: number) =>
      `${prefix}${n.toString(16).padStart(7, '0')}-0000-4000-8000-000000000000`;
    const media = (
      m: string,
      kind: ReplayMedia['kind'],
      parent: string | null = null,
    ): ReplayMedia => ({
      m,
      tmdb: null,
      kind,
      parent,
      season: kind === 'season' ? 1 : null,
      genres: ['Drama'],
      lang: 'en',
      year: 2016,
      popularity: 100,
      tile: kind !== 'season',
    });
    const showX = id('e', 1);
    const showY = id('f', 1);
    const seasonsX = Array.from({ length: 15 }, (_, i) => id('a', i));
    const seasonY = id('9', 0);
    const shared = Array.from({ length: 30 }, (_, i) => id('b', i));
    const single = Array.from({ length: 15 }, (_, i) => id('d', i));
    const own = [id('c', 1), id('c', 2)];

    const rankings: ReplayRanking[] = [];
    const love = (u: number, ids: readonly string[], c: ReplayRanking['c']) =>
      ids.forEach((m, i) => rankings.push({ u, m, c, b: 'loved', p: i + 1, day: 1, seq: i }));
    // The reader: two Liked films, the later held out.
    rankings.push({ u: 1, m: own[0]!, c: 'movies', b: 'loved', p: 1, day: 1, seq: 0 });
    rankings.push({ u: 1, m: own[1]!, c: 'movies', b: 'loved', p: 2, day: 2, seq: 0 });
    love(2, [...shared, ...single, own[0]!], 'movies');
    love(3, [...shared, own[0]!], 'movies');
    love(4, seasonsX, 'tv_seasons');
    love(5, seasonsX, 'tv_seasons');
    love(6, [seasonY], 'tv_seasons');

    const doc: ReplayExport = validateExport({
      format: 'bingd-rec-v2-replay-export',
      version: 1,
      exported_day: 3,
      users: [1, 2, 3, 4, 5, 6].map((u) => ({ u, visibility: 'public' })),
      rankings,
      logged: [],
      follows: [2, 3, 4, 5, 6].map((followee) => ({ follower: 1, followee })),
      media: [
        media(showX, 'series'),
        media(showY, 'series'),
        ...seasonsX.map((m) => media(m, 'season', showX)),
        media(seasonY, 'season', showY),
        ...[...shared, ...single, ...own].map((m) => media(m, 'movie')),
      ],
      similar: [],
      trending: [],
    });
    const w = worldOf(doc);
    const reader = holdOut(doc).accounts.find((a) => a.key === 1)!;
    expect(reader.visible.map((r) => r.m)).toEqual([own[0]]);

    const films = socialMirror(reader, w, 'movies');
    // 25, not 40: the seasons took fifteen of the server's forty.
    expect(films).toEqual(shared.slice(0, SOCIAL_LIMIT - seasonsX.length));
    expect(films.some((m) => single.includes(m))).toBe(false);
    // What the reader has visibly ranked is excluded by the server, however many endorse it.
    expect(films).not.toContain(own[0]);

    // One show, not two: Y's lone season was below the global cut.
    expect(socialMirror(reader, w, 'tv')).toEqual([showX]);
  });

  (process.env.REC_V2_REPLAY === '1' ? it : it.skip)(
    'REPLAY_EXPORT_RUNNER: replays an export (run.mjs)',
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
