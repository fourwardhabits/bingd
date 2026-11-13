import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { profileFrom } from '../profile';
import { ENGINES, scoreSlate, tasteFrom, type Candidate } from '../rank';

import {
  evaluate,
  evaluateTv,
  genreEntropy,
  orderingAuc,
  renderReport,
  type CollaborativeInput,
} from './evaluate';
import { profileEntriesOf, scoreWith, tvCollectionOf, wallFor } from './pipeline';
import { ABLATIONS, ALL_VARIANTS, ENGINE_VARIANTS, TV_VARIANTS } from './variants';
import {
  DEFAULT_QUOTAS,
  DEFAULT_WORLD,
  chooseTestReaders,
  generateWorld,
  type Bucket,
  type TestReader,
  type World,
} from './world';

/**
 * The For You offline evaluation (Engine V2, A3). **Synthetic data only.**
 *
 * By default this runs a small smoke world so the harness cannot rot: generation is
 * deterministic, the harness scores named engines exactly as `scoreSlate` does, metrics stay
 * in range, and V2 walls do not move when the follow graph does.
 *
 * `RUN_REC_EVAL=1 npx jest src/features/recommendations/evaluation/evaluation.test.ts
 * --testTimeout=3600000` runs the full evaluation: a 4,000-title,
 * 4,000-person world, 400 stratified test readers, every engine, ablation and sweep, with the
 * collaborative source computed by the real SQL in an ephemeral PGlite database. The report
 * is written to `$REC_EVAL_OUT` (default: the OS temp directory) as JSON and Markdown.
 *
 * Deliberately not an `npm run` alias: `package.json` `scripts` is an input to the Expo
 * runtime fingerprint (`config/push.cjs`), and a new key strands the live binaries' updates.
 */

const FULL = process.env.RUN_REC_EVAL === '1';
const BUCKET_CODE: Record<Bucket, number> = { loved: 0, fine: 1, not_for_me: 2 };

function collaborativeInput(world: World, readers: readonly TestReader[]) {
  const test = new Map(readers.map((reader) => [reader.person, reader]));
  const rankings: [number, number, number, number][] = [];
  for (const person of world.people) {
    for (const row of test.get(person.index)?.ranked ?? person.ranked) {
      rankings.push([person.index, row.title, BUCKET_CODE[row.bucket], row.position]);
    }
  }
  const met: [number, number, number | null][] = readers.flatMap((reader) => [
    ...reader.ranked.map((row): [number, number, number | null] => [
      reader.person,
      row.title,
      BUCKET_CODE[row.bucket],
    ]),
    ...reader.bucketed.map((row): [number, number, number | null] => [
      reader.person,
      row.title,
      BUCKET_CODE[row.bucket],
    ]),
    ...reader.logged.map((title): [number, number, number | null] => [
      reader.person,
      title,
      null,
    ]),
  ]);
  return {
    titles: world.titles.map(({ index, title, language, year, popularity, genres }) => ({
      index,
      title,
      language,
      year,
      popularity,
      genres,
    })),
    people: world.people.map(({ index, visibility }) => ({ index, visibility })),
    rankings,
    met,
    readers: readers.map((reader) => reader.person),
  };
}

type CollaborativeOutput = {
  loadMs: number;
  rankingRows: number;
  totalMs: number;
  readers: Record<string, { rows: [number, number, number][]; neighbours: number; ms: number }>;
};

function runCollaborative(
  world: World,
  readers: readonly TestReader[],
  dir: string,
): CollaborativeInput {
  const input = join(dir, 'world-input.json');
  const output = join(dir, 'collaborative.json');
  writeFileSync(input, JSON.stringify(collaborativeInput(world, readers)));
  const script = resolve(__dirname, '../../../../scripts/rec-eval/collaborative.mjs');
  const run = spawnSync(process.execPath, [script, input, output], {
    stdio: 'inherit',
    timeout: 50 * 60 * 1000,
  });
  if (run.status !== 0) throw new Error(`collaborative.mjs exited ${run.status}`);
  const parsed = JSON.parse(readFileSync(output, 'utf8')) as CollaborativeOutput;
  const out: CollaborativeInput = new Map();
  for (const [person, value] of Object.entries(parsed.readers)) {
    out.set(Number(person), {
      rows: new Map(
        value.rows.map(([title, support, endorsers]) => [title, { support, endorsers }]),
      ),
      neighbours: value.neighbours,
      ms: value.ms,
    });
  }
  return out;
}

describe('For You offline evaluation (synthetic)', () => {
  const small = { ...DEFAULT_WORLD, titles: 500, people: 400, watchedMedian: 24 };
  const quotas = {
    mainstream: 6,
    polyglot: 4,
    minority: 5,
    non_english: 3,
    classic: 3,
    niche: 3,
    cold_start: 3,
    cold_start_3: 2,
    cold_start_0: 2,
  };

  it('generates the same world for the same seed, and a different one for another', () => {
    const a = generateWorld(small);
    const b = generateWorld(small);
    expect(JSON.stringify(a.people.map((p) => p.ranked))).toBe(
      JSON.stringify(b.people.map((p) => p.ranked)),
    );
    const c = generateWorld({ ...small, seed: small.seed + 1 });
    expect(JSON.stringify(c.people.map((p) => p.ranked))).not.toBe(
      JSON.stringify(a.people.map((p) => p.ranked)),
    );
    // Rankings are contiguous and in band order, like the app's.
    for (const person of a.people) {
      person.ranked.forEach((row, i) => expect(row.position).toBe(i + 1));
      const order = person.ranked.map((row) =>
        ['loved', 'fine', 'not_for_me'].indexOf(row.bucket),
      );
      expect([...order].sort((x, y) => x - y)).toEqual(order);
    }
  });

  it('holds evidence out of every input', () => {
    const world = generateWorld(small);
    for (const reader of chooseTestReaders(world, quotas)) {
      const hidden = new Set(reader.hidden.map((row) => row.title));
      const inputs = [
        ...reader.ranked.map((row) => row.title),
        ...reader.bucketed.map((row) => row.title),
        ...reader.logged,
      ];
      expect(inputs.some((t) => hidden.has(t))).toBe(false);
      if (reader.stratum === 'cold_start') expect(reader.ranked).toHaveLength(5);
      if (reader.stratum === 'cold_start_3') expect(reader.ranked).toHaveLength(3);
      if (reader.stratum === 'cold_start_0') expect(reader.ranked).toHaveLength(0);
    }
  });

  it('scores a named engine exactly as scoreSlate does', () => {
    const world = generateWorld(small);
    const [reader] = chooseTestReaders(world, quotas);
    const profile = profileFrom(profileEntriesOf(world, reader!));
    const candidates: Candidate[] = world.titles.slice(0, 80).map((t) => ({
      mediaItemId: t.id,
      title: t.title,
      year: t.year,
      posterPath: null,
      kind: 'movie',
      genres: t.genres,
      language: t.language,
      popularity: t.popularity,
    }));
    const taste = tasteFrom([]);
    const exclude = new Set(['title-3']);
    const variant = ENGINE_VARIANTS.find((v) => v.id === 'v2_metadata')!;
    const ours = scoreWith(variant, candidates, [], taste, exclude, profile);
    const shipped = scoreSlate({
      candidates,
      anchors: [],
      taste,
      exclude,
      engine: 'v2_metadata',
      profile,
    });
    expect(ours.map((s) => s.explanation.total)).toEqual(
      shipped.map((s) => s.explanation.total),
    );
    expect(ours[0]!.explanation.engine).toBe('v2_metadata');
    expect(shipped[0]!.explanation.engine).toBe(ENGINES.v2_metadata.version);
  });

  it('produces bounded metrics, labels itself synthetic, and V2 ignores the follow graph', () => {
    const world = generateWorld(small);
    const readers = chooseTestReaders(world, quotas);
    const report = evaluate(world, readers, new Map(), [...ENGINE_VARIANTS, ABLATIONS[0]!]);
    expect(report.following.v2WallsChanged).toBe(0);
    for (const id of ['v1', 'v2_metadata', 'v2_hybrid']) {
      const all = report.results[id]!.all!;
      for (const key of [
        'recall',
        'ndcg',
        'utility',
        'nonEnglishShare',
        'dislikedShare',
      ] as const) {
        const value = all[key]?.mean;
        if (value == null) continue;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    expect(renderReport(report)).toMatch(/SYNTHETIC DATA/);
  });

  it('computes the reconcile metrics from first principles', () => {
    expect(
      orderingAuc(
        new Map([
          [1, 0.9],
          [2, 0.1],
          [3, 0.5],
        ]),
        [1],
        [2, 3],
      ),
    ).toBe(1);
    expect(
      orderingAuc(
        new Map([
          [1, 0.5],
          [2, 0.5],
        ]),
        [1],
        [2],
      ),
    ).toBe(0.5);
    expect(orderingAuc(new Map([[1, 0.5]]), [1], [])).toBeNull();
    expect(genreEntropy([['Drama'], ['Drama']])).toBe(0);
    expect(genreEntropy([['Drama'], ['Comedy']])).toBeCloseTo(1);
    expect(genreEntropy([['Drama', 'Comedy']])).toBeCloseTo(1);
  });

  it('draws recall@50 from the same draw the wall is the prefix of', () => {
    const world = generateWorld(small);
    const readers = chooseTestReaders(world, quotas).slice(0, 4);
    for (const reader of readers) {
      for (const variant of ENGINE_VARIANTS) {
        const input = {
          world,
          reader,
          variant,
          collaborative: new Map(),
          anchorSeed: 11,
          drawSeed: 11 * 7919,
        };
        const { wall, extended } = wallFor(input);
        expect(extended.slice(0, wall.length).map((s) => s.mediaItemId)).toEqual(
          wall.map((s) => s.mediaItemId),
        );
        expect(extended.length).toBeGreaterThanOrEqual(wall.length);
      }
    }
  });

  it('records TV in the shapes it claims, with one series as one unit', () => {
    const world = generateWorld(small);
    const reader = chooseTestReaders(world, quotas).find((r) => r.ranked.length >= 8)!;
    const whole = tvCollectionOf(world, reader, 'whole_show');
    expect(whole.seasons).toHaveLength(0);
    expect(whole.shows).toHaveLength(reader.ranked.length);
    whole.shows.forEach((row, i) => expect(row.position).toBe(i + 1));
    const bySeason = tvCollectionOf(world, reader, 'by_season');
    expect(bySeason.shows).toHaveLength(0);
    expect(bySeason.seasons.length).toBeGreaterThanOrEqual(reader.ranked.length);
    expect(new Set(bySeason.seasons.map((row) => row.seriesId)).size).toBe(
      reader.ranked.length,
    );
    const both = tvCollectionOf(world, reader, 'show_and_seasons');
    expect(both.shows).toHaveLength(reader.ranked.length);
    expect(both.seasons).toHaveLength(2 * reader.ranked.length);
  });

  it('splits pool recall by source, and the Films-social prototype changes nothing on TV', () => {
    const world = generateWorld(small);
    const readers = chooseTestReaders(world, quotas)
      .filter((r) => r.ranked.length >= 8)
      .slice(0, 6);
    const report = evaluate(world, readers, new Map(), ENGINE_VARIANTS);
    for (const id of ['v1', 'v2_metadata', 'v2_metadata_social']) {
      const all = report.results[id]!.all!;
      const parts = (
        [
          'poolViaAnchored',
          'poolViaSocial',
          'poolViaCollaborative',
          'poolViaCatalogue',
          'poolViaTrending',
        ] as const
      )
        .map((key) => all[key]?.mean ?? 0)
        .reduce((a, b) => a + b, 0);
      expect(parts).toBeCloseTo(all.poolRecall?.mean ?? 0, 10);
    }
    expect(report.results.v2_metadata!.all!.poolViaSocial?.mean).toBe(0);
    const tv = evaluateTv(world, readers, new Map(), TV_VARIANTS, ['whole_show']);
    const meta = tv.results.whole_show!.v2_metadata!;
    const proto = tv.results.whole_show!.v2_metadata_social!;
    for (const key of Object.keys(meta) as (keyof typeof meta)[]) {
      if (key === 'ms') continue;
      expect(proto[key]?.mean).toBe(meta[key]?.mean);
    }
  });

  it('reads whole-show rankings into the V2 profile only after the reconcile', () => {
    const world = generateWorld(small);
    const readers = chooseTestReaders(world, quotas)
      .filter((r) => r.ranked.length >= 8)
      .slice(0, 3);
    const report = evaluateTv(world, readers, new Map(), TV_VARIANTS, [
      'whole_show',
      'show_and_seasons',
    ]);
    // A whole-show ranker's profile is empty of TV without the fix, so their walls differ.
    const fixed = report.results.whole_show!.v2_metadata!;
    const before = report.results.whole_show!['v2m-pre-ws5']!;
    expect(fixed.utility?.mean).not.toBe(before.utility?.mean);
    for (const shape of report.shapes) {
      for (const id of ['v1', 'v2_metadata', 'v2_hybrid']) {
        const row = report.results[shape]![id]!;
        for (const key of ['recall', 'recall50', 'utility', 'nonEnglishShare'] as const) {
          const value = row[key]?.mean;
          if (value == null) continue;
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
        // Exclusion holds on TV too: nothing the reader met reaches the wall.
        expect(row.seenShare?.mean).toBe(0);
      }
    }
  });

  (FULL ? it : it.skip)(
    'full evaluation',
    () => {
      const out = process.env.REC_EVAL_OUT ?? join(tmpdir(), 'rec-eval');
      mkdirSync(out, { recursive: true });
      const started = Date.now();
      const world = generateWorld(DEFAULT_WORLD);
      const readers = chooseTestReaders(world, DEFAULT_QUOTAS);
      const generatedMs = Date.now() - started;
      const collaborative = runCollaborative(world, readers, out);
      const report = evaluate(world, readers, collaborative, ALL_VARIANTS);
      const tvStarted = Date.now();
      const tv = evaluateTv(world, readers, collaborative, TV_VARIANTS);
      const tvMs = Date.now() - tvStarted;
      const markdown = renderReport(report, tv);
      writeFileSync(join(out, 'report.json'), JSON.stringify({ ...report, tv, tvMs }, null, 2));
      writeFileSync(join(out, 'report.md'), markdown);
      // eslint-disable-next-line no-console
      console.log(
        `${markdown}\n\nWorld generated in ${generatedMs} ms; total ${Date.now() - started} ms. Written to ${out}.`,
      );
      expect(report.following.v2WallsChanged).toBe(0);
      for (const id of ['v1', 'v2_metadata', 'v2_hybrid'])
        expect(report.results[id]!.all!.seenShare?.mean).toBe(0);
    },
    3 * 60 * 60 * 1000,
  );
});
