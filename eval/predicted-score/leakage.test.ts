/**
 * The harness is only as honest as what each prediction is allowed to know. These tests pin
 * the three rules in `evidence.ts`: the reader is never their own evidence, nothing after the
 * replayed moment exists, and the populations are the app's own.
 */

import { PRIMARY_CONFIG } from './config';
import { contentSamples, EvidenceCache, othersOpinions } from './evidence';
import { libraryView } from './geometry';
import { listOf, makeSnapshot, rank } from './fixtures';
import { indexSnapshot } from './snapshot';
import { holdoutTasks, replayTasks, type Task } from './tasks';

describe('P1: no future leakage', () => {
  it('trains only on the reader’s titles placed before the target, and hides the rest', () => {
    const ds = indexSnapshot(makeSnapshot({ rankings: listOf('A', 'LLLFFFN', 'a', 10) }));
    const tasks = replayTasks(ds, ['movies']);
    expect(tasks).toHaveLength(6);
    for (const task of tasks) {
      expect(task.asOf).toBe(task.target.t);
      for (const r of task.train.rows) expect(r.t).toBeLessThan(task.target.t);
      expect(task.train.opinions.has(task.target.m)).toBe(false);
      const later = ds.library.get('A|movies')!.filter((r) => r.t > task.target.t);
      for (const r of later) expect(task.hidden.has(r.m)).toBe(true);
      expect(task.hidden.has(task.target.m)).toBe(true);
    }
  });

  it('ignores another person’s ranking of the title made after the moment being replayed', () => {
    const ds = indexSnapshot(
      makeSnapshot({
        rankings: [
          ...listOf('A', 'LLF', 'a', 1),
          rank('A', 'X', 'fine', 4, 50),
          rank('B', 'X', 'not_for_me', 1, 100),
        ],
      }),
    );
    const cache = new EvidenceCache(ds);
    const p1 = replayTasks(ds, ['movies']).find((t) => t.target.m === 'X')!;
    expect(othersOpinions(cache, p1, 'public')).toEqual([]);
    // In P2 the future is visible: that is the leak P2 accepts, and the report says so.
    const p2Ds = indexSnapshot(
      makeSnapshot({
        rankings: [
          ...listOf('A', 'LLFFN', 'a', 1),
          rank('A', 'X', 'not_for_me', 6, 50),
          rank('B', 'X', 'not_for_me', 1, 100),
        ],
      }),
    );
    const p2 = holdoutTasks(p2Ds, ['movies']).find((t) => t.target.m === 'X')!;
    expect(othersOpinions(new EvidenceCache(p2Ds), p2, 'public')).toHaveLength(1);
  });

  it('reads another person’s opinion from their list as it stood then, not as it stands now', () => {
    // B ranked Y at the top of their liked band at t = 10, then three liked titles above it
    // at t = 60..62. Replayed at t = 50, Y is still B's top title.
    const ds = indexSnapshot(
      makeSnapshot({
        rankings: [
          rank('B', 'b0', 'loved', 1, 60),
          rank('B', 'b1', 'loved', 2, 61),
          rank('B', 'b2', 'loved', 3, 62),
          rank('B', 'Y', 'loved', 4, 10),
          rank('B', 'b3', 'fine', 5, 11),
          ...listOf('A', 'LLF', 'a', 1),
          rank('A', 'Y', 'fine', 4, 50),
        ],
      }),
    );
    const cache = new EvidenceCache(ds);
    const p1 = replayTasks(ds, ['movies']).find((t) => t.u === 'A' && t.target.m === 'Y')!;
    const [then] = othersOpinions(cache, p1, 'public');
    expect(then).toMatchObject({ bucket: 'loved', q: 0 });
    const now = cache.viewOf('B', 'movies', null).opinions.get('Y')!;
    expect(now.q).toBe(1);
  });

  it('admits a private account only once the follow was approved', () => {
    const ds = indexSnapshot(
      makeSnapshot({
        users: [{ u: 'C', visibility: 'private' }],
        rankings: [
          ...listOf('A', 'LLF', 'a', 1),
          rank('A', 'X', 'fine', 4, 150),
          rank('C', 'X', 'loved', 1, 5),
        ],
        follows: [{ follower: 'A', followee: 'C', t: 200 }],
      }),
    );
    const cache = new EvidenceCache(ds);
    const p1 = replayTasks(ds, ['movies']).find((t) => t.target.m === 'X')!;
    expect(othersOpinions(cache, p1, 'viewable')).toEqual([]);
    expect(othersOpinions(cache, { ...p1, asOf: null }, 'viewable')).toHaveLength(1);
  });

  it('uses the reader’s own Letterboxd stars only once imported, never the target’s own, never a hidden title’s', () => {
    const genres = ['Drama'];
    const ds = indexSnapshot(
      makeSnapshot({
        rankings: [...listOf('A', 'LLF', 'a', 1), rank('A', 'X', 'fine', 4, 50)],
        stars: [
          { u: 'A', m: 'X', rating: 5, t: 1 },
          { u: 'A', m: 'early', rating: 4, t: 10 },
          { u: 'A', m: 'late', rating: 4, t: 60 },
          { u: 'B', m: 'someone-else', rating: 1, t: 1 },
        ],
        media: ['X', 'early', 'late', 'someone-else', 'a0', 'a1', 'a2'].map((m) => ({
          m,
          kind: 'movie' as const,
          parent: null,
          season: null,
          genres,
          lang: 'en',
          year: 2000,
          popularity: 1,
        })),
        users: [{ u: 'B' }],
      }),
    );
    const cache = new EvidenceCache(ds);
    const task = replayTasks(ds, ['movies']).find((t) => t.target.m === 'X')!;
    const config = { ...PRIMARY_CONFIG, contentTau: 0, contentK: 50 };
    const { samples } = contentSamples(cache, task, config);
    // Three ranked titles (weight = similarity, 0.5 here) plus the one star imported before
    // t = 50 (weight = similarity × ownStarWeight). Not the target's own 5-star, not the star
    // imported at t = 60, and never another account's.
    expect(samples).toHaveLength(4);
    const stars = samples.filter((s) => s.w < 0.5);
    expect(stars).toEqual([
      { bucket: 'loved', q: (5 - 4) / 1.5, w: 0.5 * PRIMARY_CONFIG.ownStarWeight },
    ]);
    // A hidden title's star is not evidence either.
    const hiddenTask: Task = { ...task, hidden: new Set([...task.hidden, 'early']) };
    expect(
      contentSamples(new EvidenceCache(ds), { ...hiddenTask, group: 'x' }, config).samples,
    ).toHaveLength(3);
  });

  it('flags a label whose created_at was reset, and the earlier labels it may have been missing from', () => {
    // a3 (created_at 4) was re-placed. Its first comparison is dated before a1's moment
    // (t = 2) but after a0's (t = 1), so a1 and a2 were replayed without a title that was
    // already there.
    const rows = listOf('A', 'LLFFF', 'a', 1);
    rows[3] = { ...rows[3]!, cmp_earlier: 3, cmp_first: 1.5 };
    const tasks = replayTasks(indexSnapshot(makeSnapshot({ rankings: rows })), ['movies']);
    const by = (m: string) => tasks.find((t) => t.target.m === m)!.flags;
    expect(by('a3').replacedHint).toBe(true);
    expect(by('a1')).toMatchObject({ replacedHint: false, asOfMayMissRows: true });
    expect(by('a2')).toMatchObject({ replacedHint: false, asOfMayMissRows: true });
    expect(by('a4')).toMatchObject({ replacedHint: false, asOfMayMissRows: false });
  });

  it('does not flag a label that predates the re-placed title’s first comparison', () => {
    const rows = listOf('A', 'LLFFF', 'a', 1);
    rows[3] = { ...rows[3]!, cmp_earlier: 3, cmp_first: 2.5 };
    const tasks = replayTasks(indexSnapshot(makeSnapshot({ rankings: rows })), ['movies']);
    const by = (m: string) => tasks.find((t) => t.target.m === m)!.flags;
    expect(by('a1').asOfMayMissRows).toBe(false);
    expect(by('a2').asOfMayMissRows).toBe(true);
  });

  it('errs toward suspicion when the first comparison time is unknown', () => {
    const rows = listOf('A', 'LLFF', 'a', 1);
    rows[2] = { ...rows[2]!, cmp_earlier: 3, cmp_first: null };
    const tasks = replayTasks(indexSnapshot(makeSnapshot({ rankings: rows })), ['movies']);
    expect(tasks.find((t) => t.target.m === 'a1')!.flags.asOfMayMissRows).toBe(true);
  });
});

describe('P2: held-out labels are excluded from every aggregate', () => {
  const rows = [
    ...listOf('A', 'LLLLLLFFFFNNNN', 'a', 1),
    ...listOf('B', 'LLLLLLFFFFNNNN', 'a', 1),
  ];
  const ds = indexSnapshot(makeSnapshot({ rankings: rows }));

  it('predicts every current ranking exactly once, with the target out of its own training', () => {
    const tasks = holdoutTasks(ds, ['movies']);
    expect(tasks).toHaveLength(rows.length);
    expect(new Set(tasks.map((t) => `${t.u}|${t.target.m}`)).size).toBe(rows.length);
    for (const t of tasks) {
      expect(t.train.opinions.has(t.target.m)).toBe(false);
      for (const m of t.hidden) expect(t.train.opinions.has(m)).toBe(false);
    }
  });

  it('stratifies folds by bucket', () => {
    const tasks = holdoutTasks(ds, ['movies']).filter((t) => t.u === 'A');
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      const perFold = [0, 1, 2, 3, 4].map(
        (f) => tasks.filter((t) => t.fold === f && t.target.b === bucket).length,
      );
      expect(Math.max(...perFold) - Math.min(...perFold)).toBeLessThanOrEqual(1);
    }
  });

  it('never counts the reader among the raters of their own held-out title', () => {
    const cache = new EvidenceCache(ds);
    for (const t of holdoutTasks(ds, ['movies'])) {
      for (const op of othersOpinions(cache, t, 'viewable')) expect(op.v).not.toBe(t.u);
      expect(othersOpinions(cache, t, 'public')).toHaveLength(1);
    }
  });

  it('keeps the held-out fold out of the reader’s side of Taste Match', () => {
    const cache = new EvidenceCache(ds);
    for (const t of holdoutTasks(ds, ['movies'])) {
      const mine = cache.readerScores(t);
      expect(mine.has(t.target.m)).toBe(false);
      for (const m of t.hidden) expect(mine.has(m)).toBe(false);
    }
  });

  it('gives no Taste Match when the only overlap is held out', () => {
    // A and B share exactly five titles, and all five are hidden from A's side.
    const shared = ['s0', 's1', 's2', 's3', 's4'];
    const snapshot = makeSnapshot({
      rankings: [
        ...shared.map((m, i) => rank('A', m, 'loved', i + 1, i)),
        rank('A', 'own', 'loved', 6, 9),
        rank('A', 'X', 'fine', 7, 10),
        ...shared.map((m, i) => rank('B', m, 'loved', i + 1, i)),
        rank('B', 'X', 'loved', 6, 9),
      ],
    });
    const local = indexSnapshot(snapshot);
    const aRows = local.library.get('A|movies')!;
    const task: Task = {
      mode: 'P2',
      u: 'A',
      c: 'movies',
      target: aRows.find((r) => r.m === 'X')!,
      train: libraryView(aRows.filter((r) => r.m === 'own')),
      otherCategory: [],
      asOf: null,
      hidden: new Set([...shared, 'X']),
      group: 'manual',
      fold: 0,
      truth: {
        bucket: 'fine',
        rank: 1,
        bandSize: 0,
        q: 0,
        score: 6.9,
        display: 6.9,
        overall: 1,
      },
      flags: {
        replacedHint: false,
        asOfMayMissRows: false,
        noPlacementEvidence: false,
        firstInBand: true,
      },
    };
    const cache = new EvidenceCache(local);
    expect(cache.tasteMatch(task, 'B')).toBeNull();
    // The same pair with the overlap visible does match.
    const visible: Task = {
      ...task,
      group: 'visible',
      hidden: new Set(['X']),
      train: libraryView(aRows.filter((r) => r.m !== 'X')),
    };
    expect(cache.tasteMatch(visible, 'B')).not.toBeNull();
  });
});

describe('populations mirror the app', () => {
  const ds = indexSnapshot(
    makeSnapshot({
      users: [
        { u: 'pub' },
        { u: 'priv', visibility: 'private' },
        { u: 'privFollowed', visibility: 'private' },
        { u: 'susp', status: 'suspended' },
        { u: 'blocker' },
      ],
      rankings: [
        ...listOf('A', 'LLF', 'a', 1),
        rank('A', 'X', 'fine', 4, 9),
        ...['pub', 'priv', 'privFollowed', 'susp', 'blocker'].map((u) =>
          rank(u, 'X', 'loved', 1, 1),
        ),
      ],
      follows: [{ follower: 'A', followee: 'privFollowed', t: 0 }],
      blocks: [{ blocker: 'blocker', blocked: 'A' }],
    }),
  );
  const x = replayTasks(ds, ['movies']).find((t) => t.target.m === 'X')!;
  const cache = new EvidenceCache(ds);

  it('community: public, active, not blocked either way', () => {
    expect(othersOpinions(cache, { ...x, asOf: null }, 'public').map((o) => o.v)).toEqual([
      'pub',
    ]);
  });

  it('neighbours: can_view_profile — public or approvedly followed, active, not blocked', () => {
    expect(
      othersOpinions(cache, { ...x, asOf: null }, 'viewable')
        .map((o) => o.v)
        .sort(),
    ).toEqual(['privFollowed', 'pub']);
  });
});
