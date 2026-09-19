import { listOf, makeSnapshot, rank } from './fixtures';
import {
  parseSnapshotText,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  validateSnapshot,
} from './snapshot';
import { productionLikeOptions, richOptions, syntheticSnapshot } from './synthetic';

const minimal = () => makeSnapshot({ rankings: listOf('A', 'LLF', 'a', 1) });

describe('reading the export in whichever shape it was saved', () => {
  it('reads the raw document psql -At prints', () => {
    expect(parseSnapshotText(JSON.stringify(minimal())).rankings).toHaveLength(3);
  });

  it('reads the SQL editor’s JSON download, with the document as an object or as text', () => {
    const doc = minimal();
    expect(parseSnapshotText(JSON.stringify([{ snapshot: doc }])).rankings).toHaveLength(3);
    expect(
      parseSnapshotText(JSON.stringify([{ snapshot: JSON.stringify(doc) }])).rankings,
    ).toHaveLength(3);
  });

  it('reads the SQL editor’s CSV download: one header, one quoted cell', () => {
    const cell = JSON.stringify(minimal()).replace(/"/g, '""');
    expect(parseSnapshotText(`snapshot\n"${cell}"\n`).rankings).toHaveLength(3);
    expect(parseSnapshotText(`﻿"snapshot"\r\n"${cell}"`).rankings).toHaveLength(3);
  });

  it('refuses anything else', () => {
    expect(() => parseSnapshotText('hello')).toThrow('snapshot');
    expect(() => parseSnapshotText('[]')).toThrow('one row');
  });
});

describe('refusing a snapshot that cannot be evaluated', () => {
  const base = () => JSON.parse(JSON.stringify(minimal()));

  it('refuses the wrong format or version', () => {
    expect(() => validateSnapshot({ ...base(), format: 'other' })).toThrow('format');
    expect(() => validateSnapshot({ ...base(), version: SNAPSHOT_VERSION + 1 })).toThrow(
      'version',
    );
    expect(base().format).toBe(SNAPSHOT_FORMAT);
  });

  it('refuses positions that are not exactly 1..n (I1)', () => {
    const doc = base();
    doc.rankings[2].p = 5;
    expect(() => validateSnapshot(doc)).toThrow('1..n');
  });

  it('refuses bands that are not contiguous (I2)', () => {
    const doc = base();
    doc.rankings[0].b = 'fine';
    expect(() => validateSnapshot(doc)).toThrow('contiguous');
  });

  it('refuses a ranking for an account the snapshot does not list', () => {
    const doc = base();
    doc.rankings.push(rank('ghost', 'x', 'loved', 1, 1));
    expect(() => validateSnapshot(doc)).toThrow('unknown user');
  });

  it('drops stars when the export says it did not include them', () => {
    const doc = {
      ...base(),
      includes_letterboxd_stars: false,
      stars: [{ u: 'A', m: 'a0', rating: 4, t: 1 }],
    };
    expect(validateSnapshot(doc).stars).toEqual([]);
  });
});

describe('the synthetic cohorts are valid snapshots', () => {
  it.each([
    ['production-like', productionLikeOptions()],
    ['rich', richOptions(3, 12)],
  ])('%s', (_, options) => {
    const snapshot = syntheticSnapshot(options);
    expect(() => validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(syntheticSnapshot(options)).toEqual(snapshot);
  });

  it('shapes the production-like cohort on the documented 2026-09-13 aggregate', () => {
    const s = syntheticSnapshot(productionLikeOptions());
    const movieRaters = new Map<string, number>();
    for (const r of s.rankings)
      if (r.c === 'movies') movieRaters.set(r.u, (movieRaters.get(r.u) ?? 0) + 1);
    expect(movieRaters.size).toBe(31);
    expect([...movieRaters.values()].filter((n) => n === 5)).toHaveLength(12);
    expect([...movieRaters.values()].filter((n) => n >= 10)).toHaveLength(7);
  });
});
