/**
 * The staging QA cohort fixture: pure data plus pure derivations. No network, no clock,
 * no randomness -- `buildPlan()` returns the same value every time, and
 * supabase/tests/staging-qa-cohort.test.mjs holds it to that.
 *
 * Titles are named by a readable key and resolved to `media_items` ids at run time by
 * TMDB id (movies, series) or by (series TMDB id, season number). Every id below was
 * confirmed present with a poster on staging (fjxhcbowoxuzulwirzyr) on 2026-09-13. If
 * one disappears, `qa-cohort.mjs` fails loudly naming it; it never calls the adapter.
 *
 * HOW TO EXTEND: add a title key to MOVIES / SEASONS / SERIES, then place it in a user's
 * `loved` / `fine` / `not_for_me` list (best first) or `watchlist`. Run the unit test --
 * it refuses a watchlist title the same user ranks, a follow that is not in the cohort,
 * and a recommendation between people who do not follow each other both ways.
 */
import { createHash } from 'node:crypto';

export const COHORT_MARKER = 'v1';
export const PROBE_MARKER = 'probe';

/** Fixed namespace for deterministic operation ids. Never change it for v1. */
export const OPERATION_NAMESPACE = '3b0c6f0e-5a7d-4f7e-9c1a-9d2b7f4e1a60';

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/** key -> TMDB movie id. */
export const MOVIES = Object.freeze({
  // The shared core: widely seen, ranked by (nearly) everybody.
  dark_knight: 155,
  inception: 27205,
  interstellar: 157336,
  matrix: 603,
  pulp_fiction: 680,
  shawshank: 278,
  godfather: 238,
  fight_club: 550,
  parasite: 496243,
  endgame: 299534,
  rotk: 122,
  jurassic_park: 329,
  back_to_the_future: 105,
  oppenheimer: 872585,
  barbie: 346698,

  // Blockbuster / sci-fi
  avengers: 24428,
  avatar: 19995,
  mad_max_fury_road: 76341,
  dune: 438631,
  dune_part_two: 693134,
  star_wars: 11,
  empire_strikes_back: 1891,
  terminator_2: 280,
  fellowship: 120,
  harry_potter_1: 671,
  thor_ragnarok: 284053,
  deadpool: 293660,
  oceans_eleven: 161,
  men_in_black: 607,
  blade_runner: 78,
  blade_runner_2049: 335984,
  arrival: 329865,
  the_martian: 286217,
  the_prestige: 1124,
  alien: 348,
  aliens: 679,
  eternal_sunshine: 38,
  her: 152601,
  donnie_darko: 141,
  fifth_element: 18,

  // Horror
  psycho: 539,
  the_shining: 694,
  the_exorcist: 9552,
  halloween: 948,
  jaws: 578,
  scream: 4232,
  saw: 176,
  conjuring_3: 423108,
  insidious_red_door: 614479,
  insidious_2: 91586,
  nosferatu: 426063,
  from_dusk_till_dawn: 755,
  gremlins: 927,
  oldboy: 670,

  // Classic
  citizen_kane: 15,
  vertigo: 426,
  some_like_it_hot: 239,
  lawrence_of_arabia: 947,
  sunset_boulevard: 599,
  roman_holiday: 804,
  dr_strangelove: 935,
  the_apartment: 284,
  casablanca: 289,
  twelve_angry_men: 389,
  godfather_2: 240,
  rear_window: 567,
  seven_samurai: 346,
  wizard_of_oz: 630,

  // Indie / drama
  in_the_mood_for_love: 843,
  mulholland_drive: 1018,
  piano_teacher: 1791,
  call_me_by_your_name: 398818,
  whiplash: 244786,
  amelie: 194,
  grand_budapest: 120467,
  big_lebowski: 115,
  one_battle_after_another: 1054867,
  spotlight: 314365,
  clockwork_orange: 185,
  schindlers_list: 424,
  cuckoos_nest: 510,
  the_departed: 1422,
  intouchables: 77338,
  life_is_beautiful: 637,
  wolf_of_wall_street: 106646,
  truman_show: 37165,

  // Comedy
  groundhog_day: 137,
  ghostbusters: 620,
  the_mask: 854,
  shrek: 808,
  ten_things: 4951,
  up: 14160,
});

/** key -> [TMDB series id, season number]. Seasons are the rankable TV unit. */
export const SEASONS = Object.freeze({
  breaking_bad_s1: [1396, 1],
  breaking_bad_s2: [1396, 2],
  breaking_bad_s3: [1396, 3],
  breaking_bad_s4: [1396, 4],
  breaking_bad_s5: [1396, 5],
  better_call_saul_s1: [60059, 1],
  better_call_saul_s3: [60059, 3],
  game_of_thrones_s1: [1399, 1],
  game_of_thrones_s2: [1399, 2],
  game_of_thrones_s8: [1399, 8],
  stranger_things_s1: [66732, 1],
  stranger_things_s2: [66732, 2],
  stranger_things_s3: [66732, 3],
  the_office_s2: [2316, 2],
  the_office_s3: [2316, 3],
  succession_s1: [76331, 1],
  succession_s2: [76331, 2],
  sopranos_s1: [1398, 1],
  black_mirror_s3: [42009, 3],
  fargo_s1: [60622, 1],
  wednesday_s1: [119051, 1],
  euphoria_s1: [85552, 1],
  the_wire_s1: [1438, 1],
  lost_s1: [4607, 1],
  loki_s1: [84958, 1],
  seinfeld_s4: [1400, 4],
  mad_men_s1: [1104, 1],
  modern_family_s1: [1421, 1],
  ahs_s1: [1413, 1],
  walking_dead_s1: [1402, 1],
});

/** key -> TMDB series id. Only ever watchlisted (a series is not rankable). */
export const SERIES = Object.freeze({
  ted_lasso: 97546,
  the_last_of_us: 100088,
  house_of_the_dragon: 94997,
  silo: 125988,
  the_wire: 1438,
  friends: 1668,
  rick_and_morty: 60625,
  reacher: 108978,
  mad_men: 1104,
});

export const CORE = Object.freeze([
  'dark_knight', 'inception', 'interstellar', 'matrix', 'pulp_fiction', 'shawshank',
  'godfather', 'fight_club', 'parasite', 'endgame', 'rotk', 'jurassic_park',
  'back_to_the_future', 'oppenheimer', 'barbie',
]);

// ---------------------------------------------------------------------------
// People
//
// Each list is best-first. Movies and seasons may be mixed in one list: they are
// separate ranking categories, and the plan splits them preserving order.
// ---------------------------------------------------------------------------

const USERS = [
  {
    name: 'blockbuster_fan',
    displayName: 'QA · Blockbuster fan',
    loved: [
      'dark_knight', 'endgame', 'rotk', 'inception', 'interstellar', 'matrix', 'jurassic_park',
      'back_to_the_future', 'avengers', 'mad_max_fury_road', 'star_wars', 'empire_strikes_back',
      'fellowship', 'dune_part_two', 'terminator_2',
      'game_of_thrones_s1', 'stranger_things_s1',
    ],
    fine: [
      'pulp_fiction', 'oppenheimer', 'shawshank', 'fight_club', 'avatar', 'harry_potter_1',
      'thor_ragnarok', 'deadpool', 'oceans_eleven', 'godfather', 'barbie', 'men_in_black',
      'game_of_thrones_s2',
    ],
    not_for_me: ['parasite', 'game_of_thrones_s8'],
    watchlist: ['blade_runner_2049', 'alien', 'whiplash', 'grand_budapest', 'reacher', 'house_of_the_dragon'],
    follows: ['scifi_fan', 'horror_fan', 'comedy_fan', 'tv_fan'],
  },
  {
    name: 'scifi_fan',
    displayName: 'QA · Sci-fi fan',
    loved: [
      'interstellar', 'inception', 'dark_knight', 'matrix', 'blade_runner_2049', 'arrival',
      'dune_part_two', 'blade_runner', 'endgame', 'rotk', 'back_to_the_future', 'jurassic_park',
      'star_wars', 'empire_strikes_back', 'terminator_2', 'alien',
      'stranger_things_s1', 'black_mirror_s3', 'loki_s1',
    ],
    fine: [
      'oppenheimer', 'fight_club', 'pulp_fiction', 'the_martian', 'the_prestige', 'shawshank',
      'dune', 'godfather', 'eternal_sunshine', 'fifth_element', 'avatar',
      'stranger_things_s2',
    ],
    not_for_me: ['parasite', 'barbie'],
    watchlist: ['whiplash', 'oldboy', 'big_lebowski', 'silo', 'the_last_of_us', 'house_of_the_dragon'],
    follows: ['blockbuster_fan', 'horror_fan', 'tv_fan'],
  },
  {
    name: 'horror_fan',
    displayName: 'QA · Horror fan',
    loved: [
      'the_shining', 'alien', 'the_exorcist', 'psycho', 'halloween', 'jaws', 'parasite',
      'fight_club', 'pulp_fiction', 'oldboy', 'scream', 'dark_knight', 'matrix', 'jurassic_park',
      'nosferatu',
      'ahs_s1', 'stranger_things_s1',
    ],
    fine: [
      'conjuring_3', 'saw', 'insidious_2', 'from_dusk_till_dawn', 'gremlins', 'inception',
      'interstellar', 'shawshank', 'godfather', 'back_to_the_future',
      'walking_dead_s1',
    ],
    not_for_me: ['insidious_red_door', 'endgame', 'rotk', 'oppenheimer', 'barbie'],
    watchlist: ['dune_part_two', 'blade_runner_2049', 'grand_budapest', 'the_last_of_us', 'silo'],
    follows: ['scifi_fan', 'indie_fan'],
  },
  {
    name: 'classic_fan',
    displayName: 'QA · Classic film fan',
    loved: [
      'godfather', 'casablanca', 'citizen_kane', 'godfather_2', 'vertigo', 'twelve_angry_men',
      'lawrence_of_arabia', 'shawshank', 'some_like_it_hot', 'rear_window', 'seven_samurai',
      'parasite', 'sunset_boulevard', 'oppenheimer',
    ],
    fine: [
      'the_apartment', 'roman_holiday', 'dr_strangelove', 'wizard_of_oz', 'psycho', 'interstellar',
      'pulp_fiction', 'rotk', 'back_to_the_future', 'jurassic_park',
    ],
    not_for_me: ['dark_knight', 'inception', 'matrix', 'fight_club', 'endgame', 'barbie'],
    watchlist: ['spotlight', 'grand_budapest', 'whiplash', 'the_wire'],
    follows: ['drama_fan'],
  },
  {
    name: 'indie_fan',
    displayName: 'QA · Indie film fan',
    loved: [
      'in_the_mood_for_love', 'parasite', 'mulholland_drive', 'eternal_sunshine', 'pulp_fiction',
      'her', 'godfather', 'fight_club', 'call_me_by_your_name', 'whiplash', 'barbie', 'oldboy',
      'piano_teacher', 'grand_budapest',
      'fargo_s1', 'euphoria_s1',
    ],
    fine: [
      'amelie', 'big_lebowski', 'one_battle_after_another', 'spotlight', 'clockwork_orange',
      'donnie_darko', 'oppenheimer', 'back_to_the_future', 'dark_knight', 'shawshank', 'matrix',
      'inception',
      'succession_s1',
    ],
    not_for_me: ['interstellar', 'endgame', 'rotk', 'jurassic_park'],
    watchlist: ['blade_runner_2049', 'arrival', 'casablanca', 'the_wire', 'mad_men'],
    follows: ['drama_fan', 'classic_fan'],
  },
  {
    name: 'drama_fan',
    displayName: 'QA · Drama fan',
    loved: [
      'schindlers_list', 'godfather', 'shawshank', 'parasite', 'whiplash', 'twelve_angry_men',
      'cuckoos_nest', 'pulp_fiction', 'spotlight', 'godfather_2', 'oppenheimer', 'the_departed',
      'call_me_by_your_name', 'barbie', 'casablanca',
      'breaking_bad_s1', 'succession_s1', 'sopranos_s1',
    ],
    fine: [
      'intouchables', 'life_is_beautiful', 'wolf_of_wall_street', 'truman_show', 'fight_club',
      'dark_knight', 'inception', 'interstellar', 'rotk', 'back_to_the_future',
      'breaking_bad_s2', 'mad_men_s1', 'succession_s2',
    ],
    not_for_me: ['matrix', 'endgame'],
    watchlist: ['dune_part_two', 'arrival', 'grand_budapest', 'the_last_of_us', 'the_wire', 'ted_lasso'],
    follows: ['indie_fan', 'classic_fan', 'tv_fan'],
  },
  {
    name: 'comedy_fan',
    displayName: 'QA · Comedy fan',
    loved: [
      'groundhog_day', 'big_lebowski', 'back_to_the_future', 'ghostbusters', 'grand_budapest',
      'barbie', 'shrek', 'pulp_fiction', 'some_like_it_hot', 'dr_strangelove', 'jurassic_park',
      'endgame', 'men_in_black', 'the_mask', 'truman_show',
      'the_office_s2', 'seinfeld_s4',
    ],
    fine: [
      'deadpool', 'thor_ragnarok', 'up', 'ten_things', 'gremlins', 'dark_knight', 'inception',
      'matrix', 'fight_club', 'parasite', 'rotk', 'shawshank',
      'the_office_s3', 'modern_family_s1', 'wednesday_s1',
    ],
    not_for_me: ['interstellar', 'godfather', 'oppenheimer'],
    watchlist: ['dune_part_two', 'alien', 'whiplash', 'ted_lasso', 'friends', 'rick_and_morty'],
    follows: ['blockbuster_fan', 'tv_fan', 'drama_fan'],
  },
  {
    name: 'tv_fan',
    displayName: 'QA · TV fan',
    loved: [
      'breaking_bad_s5', 'breaking_bad_s4', 'breaking_bad_s3', 'breaking_bad_s2', 'breaking_bad_s1',
      'better_call_saul_s3', 'succession_s2', 'the_wire_s1', 'sopranos_s1', 'stranger_things_s1',
      'the_office_s2', 'fargo_s1', 'black_mirror_s3', 'succession_s1',
      'dark_knight', 'inception', 'shawshank', 'back_to_the_future',
    ],
    fine: [
      'game_of_thrones_s1', 'game_of_thrones_s2', 'stranger_things_s2', 'lost_s1', 'wednesday_s1',
      'euphoria_s1', 'loki_s1', 'seinfeld_s4', 'the_office_s3',
      'interstellar', 'matrix', 'pulp_fiction', 'godfather', 'parasite', 'endgame',
      'jurassic_park', 'oppenheimer', 'barbie',
    ],
    not_for_me: ['game_of_thrones_s8', 'stranger_things_s3'],
    watchlist: [
      'dune_part_two', 'whiplash', 'grand_budapest', 'arrival', 'casablanca',
      'ted_lasso', 'the_last_of_us', 'house_of_the_dragon',
    ],
    follows: ['drama_fan', 'comedy_fan', 'scifi_fan', 'indie_fan'],
  },
];

/** One exact title between two people who follow each other, so it is delivered. */
const RECOMMENDATIONS = [
  { from: 'scifi_fan', to: 'blockbuster_fan', title: 'arrival' },
  { from: 'blockbuster_fan', to: 'scifi_fan', title: 'mad_max_fury_road' },
  { from: 'drama_fan', to: 'tv_fan', title: 'spotlight' },
  { from: 'tv_fan', to: 'drama_fan', title: 'better_call_saul_s1' },
  { from: 'indie_fan', to: 'drama_fan', title: 'in_the_mood_for_love' },
  { from: 'classic_fan', to: 'drama_fan', title: 'sunset_boulevard' },
  { from: 'comedy_fan', to: 'tv_fan', title: 'groundhog_day' },
  { from: 'horror_fan', to: 'scifi_fan', title: 'the_shining' },
];

/** The ephemeral groups verify asks Group Picks about. Members are the caller's followees. */
const GROUPS = {
  movies: { caller: 'blockbuster_fan', members: ['scifi_fan', 'horror_fan', 'comedy_fan', 'tv_fan'] },
  tv: { caller: 'tv_fan', members: ['drama_fan', 'comedy_fan', 'scifi_fan', 'indie_fan'] },
};

/** Taste pairs verify compares: every `similar` pair should out-match every `dissimilar` one. */
const PAIRS = {
  similar: [['blockbuster_fan', 'scifi_fan'], ['indie_fan', 'drama_fan']],
  dissimilar: [['blockbuster_fan', 'classic_fan'], ['comedy_fan', 'classic_fan']],
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export const BUCKETS = Object.freeze(['loved', 'fine', 'not_for_me']);

export function titleSpec(key) {
  if (Object.hasOwn(MOVIES, key)) return { key, kind: 'movie', tmdbId: MOVIES[key], category: 'movies' };
  if (Object.hasOwn(SEASONS, key)) {
    const [tmdbId, season] = SEASONS[key];
    return { key, kind: 'season', tmdbId, season, category: 'tv_seasons' };
  }
  if (Object.hasOwn(SERIES, key)) return { key, kind: 'series', tmdbId: SERIES[key], category: null };
  throw new Error(`unknown title key: ${key}`);
}

export const usernameFor = (name) => `qa_${name}`;
export const cohortEmail = (name) => `qa-cohort+${name}@example.com`;

/** A name-based (v5-shaped) UUID: SHA-1 over the namespace bytes and the name. */
export function operationId(...parts) {
  const ns = Buffer.from(OPERATION_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(parts.join(':'), 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The whole fixture, normalised. Rankings come out in insertion order (bucket order,
 * then best first) with their intended band rank per category, so the seeder can
 * both answer comparisons and check the positions it ended with.
 */
export function buildPlan() {
  const users = USERS.map((u) => {
    const rankings = [];
    const bands = { movies: {}, tv_seasons: {} };
    for (const bucket of BUCKETS) {
      for (const key of u[bucket]) {
        const spec = titleSpec(key);
        if (spec.kind === 'series') throw new Error(`${u.name} ranks a series: ${key}`);
        const band = (bands[spec.category][bucket] ??= []);
        band.push(key);
        rankings.push({ key, bucket, category: spec.category, bandRank: band.length });
      }
    }
    // Expected absolute position: bands are loved, then fine, then not_for_me.
    for (const r of rankings) {
      let offset = 0;
      for (const b of BUCKETS) {
        if (b === r.bucket) break;
        offset += bands[r.category][b]?.length ?? 0;
      }
      r.position = offset + r.bandRank;
      r.bandSize = bands[r.category][r.bucket].length;
    }
    return {
      name: u.name,
      username: usernameFor(u.name),
      email: cohortEmail(u.name),
      displayName: u.displayName,
      rankings,
      bands,
      watchlist: [...u.watchlist],
      follows: u.follows.map(usernameFor),
    };
  });

  const recommendations = RECOMMENDATIONS.map((r) => ({
    from: usernameFor(r.from),
    to: usernameFor(r.to),
    title: r.title,
  }));
  const groups = Object.fromEntries(
    Object.entries(GROUPS).map(([medium, g]) => [
      medium,
      { caller: usernameFor(g.caller), members: g.members.map(usernameFor) },
    ]),
  );
  const pairs = Object.fromEntries(
    Object.entries(PAIRS).map(([k, list]) => [k, list.map(([a, b]) => [usernameFor(a), usernameFor(b)])]),
  );

  const keys = new Set();
  for (const u of users) {
    for (const r of u.rankings) keys.add(r.key);
    for (const w of u.watchlist) keys.add(w);
  }
  for (const r of recommendations) keys.add(r.title);
  const titles = [...keys].sort().map(titleSpec);

  return { marker: COHORT_MARKER, users, recommendations, groups, pairs, core: [...CORE], titles };
}

// ---------------------------------------------------------------------------
// Pure mirrors of the server arithmetic, for tests and for explaining verify
// ---------------------------------------------------------------------------

/** Mirrors score_for (20260815010000). */
export function scoreFor(bucket, bandRank, bandSize) {
  const high = bucket === 'loved' ? 10.0 : bucket === 'fine' ? 6.9 : 3.4;
  const low = bucket === 'loved' ? 7.0 : bucket === 'fine' ? 3.5 : 0.0;
  let v;
  if (bandSize <= 1 || bandRank <= 1) v = high;
  else if (bandRank >= bandSize) v = low;
  else v = high - ((bandRank - 1) * (high - low)) / (bandSize - 1);
  return Math.round(v * 10) / 10;
}

export function intendedScores(user) {
  return new Map(user.rankings.map((r) => [r.key, scoreFor(r.bucket, r.bandRank, r.bandSize)]));
}

export function sharedRankings(a, b) {
  const mine = new Set(a.rankings.map((r) => r.key));
  return b.rankings.map((r) => r.key).filter((k) => mine.has(k));
}

function midranks(values) {
  const sorted = values.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j += 1;
    const rank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) out[sorted[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Mirrors taste_match (20260827001000) over the intended scores. */
export function predictTasteMatch(a, b, { minCommon = 5, shrinkPrior = 5 } = {}) {
  const sa = intendedScores(a);
  const sb = intendedScores(b);
  const shared = sharedRankings(a, b);
  const n = shared.length;
  if (n < minCommon) return { score: null, common: n };
  const xs = shared.map((k) => sa.get(k));
  const ys = shared.map((k) => sb.get(k));
  const meanGap = xs.reduce((s, x, i) => s + Math.abs(x - ys[i]), 0) / n;
  const proximity = Math.max(0, Math.min(100, 100 * (1 - meanGap / 7)));
  const rho = pearson(midranks(xs), midranks(ys));
  const agreement = rho === null ? null : 50 * (rho + 1);
  const w = 0.25 * Math.max(0, Math.min(1, (n - 8) / 12));
  const blend = agreement === null ? proximity : (1 - w) * proximity + w * agreement;
  return { score: Math.round(50 + (blend - 50) * (n / (n + shrinkPrior))), common: n };
}

/** Rater counts per movie/season key across the cohort. */
export function raterCounts(plan) {
  const counts = new Map();
  for (const u of plan.users) for (const r of u.rankings) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  return counts;
}

/** A one-screen summary for --dry-run and the docs. */
export function summarize(plan) {
  const counts = raterCounts(plan);
  const lines = [];
  lines.push(`cohort ${plan.marker}: ${plan.users.length} users, ${plan.titles.length} distinct titles`);
  for (const u of plan.users) {
    const movies = u.rankings.filter((r) => r.category === 'movies').length;
    const seasons = u.rankings.length - movies;
    lines.push(
      `  ${u.username.padEnd(20)} movies ${String(movies).padStart(2)}  seasons ${String(seasons).padStart(2)}` +
        `  watchlist ${String(u.watchlist.length).padStart(2)}  follows ${u.follows.map((f) => f.slice(3)).join(', ')}`,
    );
  }
  const wide = [...counts].filter(([, n]) => n >= 5).length;
  lines.push(`  core ${plan.core.length} titles; ${wide} titles ranked by >= 5 cohort users`);
  lines.push(`  groups: movies ${plan.groups.movies.caller} + ${plan.groups.movies.members.join(', ')}`);
  lines.push(`          tv     ${plan.groups.tv.caller} + ${plan.groups.tv.members.join(', ')}`);
  lines.push(`  recommendations: ${plan.recommendations.map((r) => `${r.from.slice(3)}->${r.to.slice(3)}:${r.title}`).join(', ')}`);
  return lines.join('\n');
}
