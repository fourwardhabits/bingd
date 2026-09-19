/**
 * The pseudonymised snapshot `export.sql` produces, and the indexes the harness reads it
 * through.
 *
 * Every user and title is a salted key, never an id. Nothing here can name a person or a
 * film, and the report is built only from aggregates over these rows.
 */

import type { Bucket } from '@/features/collection/score';

export type Category = 'movies' | 'tv_seasons';

export const SNAPSHOT_FORMAT = 'bingd-predicted-score-snapshot';
export const SNAPSHOT_VERSION = 1;

export type SnapshotUser = {
  u: string;
  visibility: 'public' | 'private';
  status: 'active' | 'suspended';
  /** How many titles this account imported from Letterboxd. A count, never the titles. */
  imported_titles: number;
};

export type SnapshotRanking = {
  u: string;
  m: string;
  c: Category;
  b: Bucket;
  p: number;
  /** `rankings.created_at`, epoch microseconds. Reset by re-placements until T0. */
  t: number;
  /** Comparisons involving this title within the session window before `t`. */
  cmp_window: number;
  /** Comparisons involving it earlier than that: it was in the list before `t`. */
  cmp_earlier: number;
  /** Comparisons involving it after `t`: it has since been a pivot for other titles. */
  cmp_later: number;
  /**
   * The earliest comparison involving it, epoch microseconds, or null for none. For a
   * re-placed title this is the first sign it was in the list, and therefore the earliest
   * moment a P1 replay that leaves it out may be wrong.
   */
  cmp_first: number | null;
  /** The title also has an `imported_titles` row for this account. */
  imported: boolean;
};

export type SnapshotMedia = {
  m: string;
  kind: 'movie' | 'series' | 'season';
  parent: string | null;
  season: number | null;
  genres: string[];
  lang: string | null;
  year: number | null;
  popularity: number | null;
};

export type SnapshotFollow = { follower: string; followee: string; t: number };
export type SnapshotBlock = { blocker: string; blocked: string };
export type SnapshotSimilar = { m: string; ids: string[] };
/** One account's own Letterboxd star. Only ever used for that same account's predictions. */
export type SnapshotStar = { u: string; m: string; rating: number; t: number };

export type Snapshot = {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  /** Epoch microseconds. */
  exported_at: number;
  includes_letterboxd_stars: boolean;
  users: SnapshotUser[];
  follows: SnapshotFollow[];
  blocks: SnapshotBlock[];
  rankings: SnapshotRanking[];
  media: SnapshotMedia[];
  similar: SnapshotSimilar[];
  stars: SnapshotStar[];
};

const BUCKETS: readonly Bucket[] = ['loved', 'fine', 'not_for_me'];
const CATEGORIES: readonly Category[] = ['movies', 'tv_seasons'];

/**
 * The export arrives in whichever shape it was saved in: the raw JSON document (psql `-At`),
 * the Supabase SQL editor's JSON download (`[{ "snapshot": … }]`), or its CSV download (a
 * `snapshot` header and one quoted cell). All three carry the same document.
 */
export function parseSnapshotText(text: string): Snapshot {
  const trimmed = text.replace(/^﻿/, '').trim();
  let document: unknown;

  if (trimmed.startsWith('{')) {
    document = JSON.parse(trimmed);
  } else if (trimmed.startsWith('[')) {
    const rows = JSON.parse(trimmed) as unknown;
    const first = Array.isArray(rows)
      ? (rows[0] as { snapshot?: unknown } | undefined)
      : undefined;
    if (!first || first.snapshot === undefined) {
      throw new Error(
        'snapshot: a JSON array export must hold one row with a `snapshot` column',
      );
    }
    document = typeof first.snapshot === 'string' ? JSON.parse(first.snapshot) : first.snapshot;
  } else {
    const newline = trimmed.indexOf('\n');
    const header = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
    if (header.replace(/"/g, '') !== 'snapshot' || newline === -1) {
      throw new Error(
        'snapshot: expected JSON, or a CSV export with a single `snapshot` column',
      );
    }
    let cell = trimmed.slice(newline + 1).trim();
    if (cell.startsWith('"') && cell.endsWith('"'))
      cell = cell.slice(1, -1).replace(/""/g, '"');
    document = JSON.parse(cell);
  }

  return validateSnapshot(document);
}

const fail = (what: string): never => {
  throw new Error(`snapshot: ${what}`);
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const asArray = (v: unknown, name: string): unknown[] =>
  Array.isArray(v) ? v : fail(`\`${name}\` must be an array`);

/** Checks shape and invariants, and refuses anything that would make a metric silently wrong. */
export function validateSnapshot(input: unknown): Snapshot {
  if (typeof input !== 'object' || input === null) fail('not an object');
  const doc = input as Record<string, unknown>;
  if (doc.format !== SNAPSHOT_FORMAT) fail(`format must be ${SNAPSHOT_FORMAT}`);
  if (doc.version !== SNAPSHOT_VERSION) fail(`version must be ${SNAPSHOT_VERSION}`);
  if (!isNumber(doc.exported_at)) fail('exported_at must be epoch microseconds');

  const users = asArray(doc.users, 'users').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.u)) fail('user without a key');
    if (r.visibility !== 'public' && r.visibility !== 'private') fail('bad visibility');
    if (r.status !== 'active' && r.status !== 'suspended') fail('bad status');
    return {
      u: r.u as string,
      visibility: r.visibility as SnapshotUser['visibility'],
      status: r.status as SnapshotUser['status'],
      imported_titles: isNumber(r.imported_titles) ? r.imported_titles : 0,
    };
  });
  const known = new Set(users.map((u) => u.u));

  const rankings = asArray(doc.rankings, 'rankings').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.u) || !known.has(r.u)) fail('ranking for an unknown user');
    if (!isString(r.m)) fail('ranking without a title key');
    if (!CATEGORIES.includes(r.c as Category)) fail('bad category');
    if (!BUCKETS.includes(r.b as Bucket)) fail('bad bucket');
    if (!isNumber(r.p) || r.p < 1 || !Number.isInteger(r.p)) fail('bad position');
    if (!isNumber(r.t)) fail('bad created_at');
    return {
      u: r.u as string,
      m: r.m as string,
      c: r.c as Category,
      b: r.b as Bucket,
      p: r.p as number,
      t: r.t as number,
      cmp_window: isNumber(r.cmp_window) ? r.cmp_window : 0,
      cmp_earlier: isNumber(r.cmp_earlier) ? r.cmp_earlier : 0,
      cmp_later: isNumber(r.cmp_later) ? r.cmp_later : 0,
      cmp_first: isNumber(r.cmp_first) ? r.cmp_first : null,
      imported: r.imported === true,
    };
  });

  // I1 and I2 (ranking.md): positions are exactly 1..n and the bands are contiguous. The
  // truth this harness scores against is the band geometry, so a snapshot that breaks it
  // cannot be evaluated. Refused rather than repaired.
  const groups = new Map<string, SnapshotRanking[]>();
  for (const r of rankings) {
    const key = `${r.u}|${r.c}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.p - b.p);
    list.forEach((r, i) => {
      if (r.p !== i + 1) fail('positions are not exactly 1..n within a user and category');
      const prev = list[i - 1];
      if (prev && BUCKETS.indexOf(prev.b) > BUCKETS.indexOf(r.b))
        fail('bands are not contiguous');
    });
  }

  const media = asArray(doc.media, 'media').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.m)) fail('media without a key');
    return {
      m: r.m as string,
      kind: (['movie', 'series', 'season'].includes(r.kind as string)
        ? r.kind
        : fail('bad media kind')) as SnapshotMedia['kind'],
      parent: isString(r.parent) ? r.parent : null,
      season: isNumber(r.season) ? r.season : null,
      genres: Array.isArray(r.genres) ? r.genres.filter(isString) : [],
      lang: isString(r.lang) ? r.lang : null,
      year: isNumber(r.year) ? r.year : null,
      popularity: isNumber(r.popularity) ? r.popularity : null,
    };
  });

  const follows = asArray(doc.follows ?? [], 'follows').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.follower) || !isString(r.followee)) fail('bad follow');
    return {
      follower: r.follower as string,
      followee: r.followee as string,
      t: isNumber(r.t) ? r.t : 0,
    };
  });
  const blocks = asArray(doc.blocks ?? [], 'blocks').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.blocker) || !isString(r.blocked)) fail('bad block');
    return { blocker: r.blocker as string, blocked: r.blocked as string };
  });
  const similar = asArray(doc.similar ?? [], 'similar').map((raw) => {
    const r = raw as Record<string, unknown>;
    if (!isString(r.m)) fail('bad similar row');
    return { m: r.m as string, ids: Array.isArray(r.ids) ? r.ids.filter(isString) : [] };
  });
  const includesStars = doc.includes_letterboxd_stars === true;
  const stars = includesStars
    ? asArray(doc.stars ?? [], 'stars').map((raw) => {
        const r = raw as Record<string, unknown>;
        if (!isString(r.u) || !isString(r.m) || !isNumber(r.rating)) fail('bad star');
        if ((r.rating as number) < 0.5 || (r.rating as number) > 5) fail('star out of range');
        return {
          u: r.u as string,
          m: r.m as string,
          rating: r.rating as number,
          t: isNumber(r.t) ? r.t : 0,
        };
      })
    : [];

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exported_at: doc.exported_at as number,
    includes_letterboxd_stars: includesStars,
    users,
    follows,
    blocks,
    rankings,
    media,
    similar,
    stars,
  };
}

/** The snapshot, indexed the ways the harness asks of it. Built once, read many times. */
export type Dataset = {
  snapshot: Snapshot;
  users: Map<string, SnapshotUser>;
  /** follower → followee → approved at. */
  following: Map<string, Map<string, number>>;
  blocked: Set<string>;
  /** `${u}|${c}` → that user's rankings in that category, by position. */
  library: Map<string, SnapshotRanking[]>;
  /** u → every ranking that user holds, in both categories. */
  byUser: Map<string, SnapshotRanking[]>;
  /** m → every ranking of that title. */
  raters: Map<string, SnapshotRanking[]>;
  media: Map<string, SnapshotMedia>;
  similar: Map<string, Set<string>>;
  stars: Map<string, SnapshotStar[]>;
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function indexSnapshot(snapshot: Snapshot): Dataset {
  const following = new Map<string, Map<string, number>>();
  for (const f of snapshot.follows) {
    const inner = following.get(f.follower) ?? new Map<string, number>();
    inner.set(f.followee, f.t);
    following.set(f.follower, inner);
  }
  const blocked = new Set<string>();
  for (const b of snapshot.blocks) {
    blocked.add(`${b.blocker}|${b.blocked}`);
    blocked.add(`${b.blocked}|${b.blocker}`);
  }
  const library = new Map<string, SnapshotRanking[]>();
  const byUser = new Map<string, SnapshotRanking[]>();
  const raters = new Map<string, SnapshotRanking[]>();
  for (const r of snapshot.rankings) {
    push(library, `${r.u}|${r.c}`, r);
    push(byUser, r.u, r);
    push(raters, r.m, r);
  }
  for (const list of library.values()) list.sort((a, b) => a.p - b.p);
  const stars = new Map<string, SnapshotStar[]>();
  for (const s of snapshot.stars) push(stars, s.u, s);

  return {
    snapshot,
    users: new Map(snapshot.users.map((u) => [u.u, u])),
    following,
    blocked,
    library,
    byUser,
    raters,
    media: new Map(snapshot.media.map((m) => [m.m, m])),
    similar: new Map(snapshot.similar.map((s) => [s.m, new Set(s.ids)])),
    stars,
  };
}
