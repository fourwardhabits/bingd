/**
 * The replay export's shape, and the one validator both sides use (`export.test.mjs` against
 * the SQL's real output, `replay.ts` against whatever file it is handed).
 *
 * **No imports**, deliberately: `export.test.mjs` runs under plain `node --test`, which strips
 * the types from this file and cannot resolve the app's `@/` aliases.
 *
 * The validator is also the privacy contract. Every section's keys are an exact allowlist, so
 * an export that grew a column — a username, a timestamp, a note — is refused rather than read.
 */

export type Bucket = 'loved' | 'fine' | 'not_for_me';
export type Category = 'movies' | 'tv_seasons' | 'tv_shows';

export type ReplayUser = { u: number; visibility: 'public' | 'private' };
export type ReplayRanking = {
  u: number;
  m: string;
  c: Category;
  b: Bucket;
  p: number;
  day: number;
  seq: number;
};
export type ReplayLogged = { u: number; m: string; b: Bucket | null };
export type ReplayFollow = { follower: number; followee: number };
export type ReplayMedia = {
  m: string;
  tmdb: number | null;
  kind: 'movie' | 'series' | 'season';
  parent: string | null;
  season: number | null;
  genres: string[];
  lang: string | null;
  year: number | null;
  popularity: number | null;
  tile: boolean;
};
export type ReplayList = { m: string; ids: string[] };
export type ReplayTrending = { list: string; ids: string[] };

export type ReplayExport = {
  format: 'bingd-rec-v2-replay-export';
  version: 1;
  exported_day: number;
  users: ReplayUser[];
  rankings: ReplayRanking[];
  logged: ReplayLogged[];
  follows: ReplayFollow[];
  media: ReplayMedia[];
  similar: ReplayList[];
  trending: ReplayTrending[];
};

/** Exactly these keys, per section. Anything else is refused. */
export const ALLOWED_KEYS = {
  top: [
    'format',
    'version',
    'exported_day',
    'users',
    'rankings',
    'logged',
    'follows',
    'media',
    'similar',
    'trending',
  ],
  users: ['u', 'visibility'],
  rankings: ['u', 'm', 'c', 'b', 'p', 'day', 'seq'],
  logged: ['u', 'm', 'b'],
  follows: ['follower', 'followee'],
  media: [
    'm',
    'tmdb',
    'kind',
    'parent',
    'season',
    'genres',
    'lang',
    'year',
    'popularity',
    'tile',
  ],
  similar: ['m', 'ids'],
  trending: ['list', 'ids'],
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKETS = new Set(['loved', 'fine', 'not_for_me']);
const CATEGORIES = new Set(['movies', 'tv_seasons', 'tv_shows']);

function fail(message: string): never {
  throw new Error(`rec-v2-replay export: ${message}`);
}

function keysExactly(section: string, row: unknown, allowed: readonly string[]) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    fail(`${section}: a row is not an object`);
  const keys = Object.keys(row as object).sort();
  const want = [...allowed].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    fail(`${section}: keys ${JSON.stringify(keys)} are not exactly ${JSON.stringify(want)}`);
  }
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

export function validateExport(input: unknown): ReplayExport {
  keysExactly('top', input, ALLOWED_KEYS.top);
  const doc = input as ReplayExport;
  if (doc.format !== 'bingd-rec-v2-replay-export' || doc.version !== 1)
    fail('not a version-1 replay export');
  if (!isInt(doc.exported_day)) fail('exported_day is not a day number');
  for (const section of [
    'users',
    'rankings',
    'logged',
    'follows',
    'media',
    'similar',
    'trending',
  ] as const) {
    if (!Array.isArray(doc[section])) fail(`${section} is not an array`);
    for (const row of doc[section] as unknown[])
      keysExactly(section, row, ALLOWED_KEYS[section]);
  }
  const users = new Set<number>();
  for (const u of doc.users) {
    if (!isInt(u.u) || u.u < 1) fail('a user key is not a positive integer');
    if (u.visibility !== 'public' && u.visibility !== 'private')
      fail('a visibility is not public/private');
    users.add(u.u);
  }
  if (users.size !== doc.users.length) fail('user keys are not unique');
  for (const r of doc.rankings) {
    if (!users.has(r.u)) fail('a ranking belongs to no exported user');
    if (!UUID.test(r.m)) fail('a ranking media id is not a uuid');
    if (!CATEGORIES.has(r.c) || !BUCKETS.has(r.b))
      fail('a ranking category or bucket is unknown');
    if (!isInt(r.p) || !isInt(r.day) || !isInt(r.seq))
      fail('a ranking position, day or seq is not an integer');
  }
  for (const l of doc.logged) {
    if (!users.has(l.u) || !UUID.test(l.m)) fail('a logged row is malformed');
    if (l.b != null && !BUCKETS.has(l.b)) fail('a logged bucket is unknown');
  }
  for (const f of doc.follows)
    if (!users.has(f.follower) || !users.has(f.followee)) fail('a follow is malformed');
  for (const m of doc.media) {
    if (!UUID.test(m.m) || (m.parent != null && !UUID.test(m.parent)))
      fail('a media id is not a uuid');
    if (!['movie', 'series', 'season'].includes(m.kind)) fail('a media kind is unknown');
    if (!Array.isArray(m.genres) || m.genres.some((g) => typeof g !== 'string'))
      fail('media genres are not strings');
  }
  for (const s of [...doc.similar, ...doc.trending]) {
    if (!Array.isArray(s.ids) || s.ids.some((id) => !UUID.test(id)))
      fail('a list holds a non-uuid id');
  }
  return doc;
}
