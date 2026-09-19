/**
 * Hand-built snapshots for the unit tests. Small enough to reason about line by line.
 */

import type { Bucket } from '@/features/collection/score';

import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  validateSnapshot,
  type Category,
  type Snapshot,
  type SnapshotMedia,
  type SnapshotRanking,
  type SnapshotUser,
} from './snapshot';

export const rank = (
  u: string,
  m: string,
  b: Bucket,
  p: number,
  t: number,
  extra: Partial<SnapshotRanking> = {},
): SnapshotRanking => ({
  u,
  m,
  c: 'movies',
  b,
  p,
  t,
  cmp_window: 2,
  cmp_earlier: 0,
  cmp_later: 0,
  cmp_first: null,
  imported: false,
  ...extra,
});

export const film = (
  m: string,
  genres: string[] = ['Drama'],
  extra: Partial<SnapshotMedia> = {},
): SnapshotMedia => ({
  m,
  kind: 'movie',
  parent: null,
  season: null,
  genres,
  lang: 'en',
  year: 2000,
  popularity: 10,
  ...extra,
});

/**
 * One person's list from a bucket string, top to bottom: `'LLLFFN'` is three liked, two fine
 * and one disliked. Titles are `${prefix}${i}` and were placed at times `t0 + i`.
 */
export function listOf(
  u: string,
  buckets: string,
  prefix = 'm',
  t0 = 1,
  c: Category = 'movies',
): SnapshotRanking[] {
  const map: Record<string, Bucket> = { L: 'loved', F: 'fine', N: 'not_for_me' };
  return [...buckets].map((ch, i) => ({
    ...rank(u, `${prefix}${i}`, map[ch]!, i + 1, t0 + i),
    c,
  }));
}

export function makeSnapshot(parts: {
  rankings: SnapshotRanking[];
  users?: Partial<SnapshotUser>[];
  media?: SnapshotMedia[];
  follows?: Snapshot['follows'];
  blocks?: Snapshot['blocks'];
  similar?: Snapshot['similar'];
  stars?: Snapshot['stars'];
}): Snapshot {
  const declared = new Map((parts.users ?? []).map((u) => [u.u!, u]));
  const keys = new Set([...declared.keys(), ...parts.rankings.map((r) => r.u)]);
  const users = [...keys].map((u) => ({
    u,
    visibility: 'public' as const,
    status: 'active' as const,
    imported_titles: 0,
    ...declared.get(u),
  }));
  const mediaKeys = new Set([
    ...parts.rankings.map((r) => r.m),
    ...(parts.stars ?? []).map((s) => s.m),
  ]);
  const media = new Map((parts.media ?? []).map((m) => [m.m, m]));
  for (const m of mediaKeys) if (!media.has(m)) media.set(m, film(m));
  return validateSnapshot({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exported_at: 1_000_000,
    includes_letterboxd_stars: (parts.stars ?? []).length > 0,
    users,
    follows: parts.follows ?? [],
    blocks: parts.blocks ?? [],
    rankings: parts.rankings,
    media: [...media.values()],
    similar: parts.similar ?? [],
    stars: parts.stars ?? [],
  });
}
