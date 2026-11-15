import { hashUnit, rng, type World } from '@/features/recommendations/evaluation/world';

import type { Category, ReplayExport, ReplayMedia, ReplayRanking } from './format';

/**
 * A replay export built from the A3 synthetic world (`evaluation/world.ts`), in exactly the
 * format `export.sql` emits, so the replay pipeline is proven end to end without a database.
 * **Synthetic**: every account, title and ranking is generated.
 *
 * The world has one kind of title; here every fourth title is a **show** with one to three
 * seasons, and each account ranks a show one of three ways, chosen per account: always whole
 * (`tv_shows`), always by season (`tv_seasons`), or both. So the replay's whole-show slice has
 * members. Ranking order in time is a per-account shuffle: what a person ranks first is not
 * what they like best. Days advance one per three rankings.
 */

const uuidOf = (space: number, index: number) =>
  `00000000-0000-4000-${(0x8000 + space).toString(16)}-${index.toString(16).padStart(12, '0')}`;

export function syntheticExport(world: World, seed = world.config.seed + 7): ReplayExport {
  const r = rng(seed);
  const isShow = (t: number) => t % 4 === 0;
  const seasonsOf = (t: number) => 1 + Math.floor(hashUnit(seed, t, 1) * 3);
  const titleId = (t: number) => uuidOf(0, t);
  const seasonId = (t: number, n: number) => uuidOf(n, t);

  const media: ReplayMedia[] = [];
  for (const t of world.titles) {
    media.push({
      m: titleId(t.index),
      tmdb: 1_000_000 + t.index,
      kind: isShow(t.index) ? 'series' : 'movie',
      parent: null,
      season: null,
      genres: t.genres,
      lang: t.language,
      year: t.year,
      popularity: t.popularity,
      tile: true,
    });
    if (isShow(t.index)) {
      for (let n = 1; n <= seasonsOf(t.index); n += 1) {
        media.push({
          m: seasonId(t.index, n),
          tmdb: null,
          kind: 'season',
          parent: titleId(t.index),
          season: n,
          genres: [],
          lang: t.language,
          year: t.year + n - 1,
          popularity: null,
          tile: false,
        });
      }
    }
  }

  // Random per-run keys, as the SQL's shuffle.
  const order = r.shuffle(world.people.map((p) => p.index));
  const keyOf = new Map(order.map((person, i) => [person, i + 1]));
  const rankings: ReplayRanking[] = [];
  const logged: ReplayExport['logged'] = [];
  const day0 = 20300;
  for (const person of world.people) {
    const u = keyOf.get(person.index)!;
    const style = person.index % 3; // 0 whole show, 1 by season, 2 both
    const rows: Omit<ReplayRanking, 'p' | 'day' | 'seq'>[] = [];
    for (const row of person.ranked) {
      if (!isShow(row.title)) {
        rows.push({ u, m: titleId(row.title), c: 'movies', b: row.bucket });
        continue;
      }
      if (style !== 1) rows.push({ u, m: titleId(row.title), c: 'tv_shows', b: row.bucket });
      if (style !== 0) {
        for (let n = 1; n <= seasonsOf(row.title); n += 1)
          rows.push({ u, m: seasonId(row.title, n), c: 'tv_seasons', b: row.bucket });
      }
    }
    // Positions per category in band order (`person.ranked` is best first).
    const position = new Map<Category, number>();
    const placed = rows.map((row) => {
      const p = (position.get(row.c) ?? 0) + 1;
      position.set(row.c, p);
      return { ...row, p };
    });
    const timeOrder = r.shuffle(placed.map((_, i) => i));
    timeOrder.forEach((i, seq) =>
      rankings.push({ ...placed[i]!, day: day0 + Math.floor(seq / 3), seq: seq + 1 }),
    );
    const loggedTitle = (t: number, b: ReplayRanking['b'] | null) => {
      if (isShow(t) && style === 1) {
        for (let n = 1; n <= seasonsOf(t); n += 1) logged.push({ u, m: seasonId(t, n), b });
      } else {
        logged.push({ u, m: titleId(t), b });
      }
    };
    for (const row of person.bucketed) loggedTitle(row.title, row.bucket);
    for (const t of person.logged) loggedTitle(t, null);
  }

  const kindOf = (t: number) => (isShow(t) ? 'series' : 'movie');
  return {
    format: 'bingd-rec-v2-replay-export',
    version: 1,
    exported_day: day0 + 400,
    users: world.people
      .map((p) => ({ u: keyOf.get(p.index)!, visibility: p.visibility }))
      .sort((a, b) => a.u - b.u),
    rankings,
    logged,
    follows: world.people.flatMap((p) =>
      p.follows.map((f) => ({ follower: keyOf.get(p.index)!, followee: keyOf.get(f)! })),
    ),
    media,
    similar: world.similar.map((list, t) => ({
      m: titleId(t),
      // TMDB answers a show with shows and a film with films.
      ids: list.filter((o) => kindOf(o) === kindOf(t)).map(titleId),
    })),
    trending: [
      {
        list: 'trending.movie.week',
        ids: world.trending.filter((t) => !isShow(t)).map(titleId),
      },
      { list: 'trending.series.week', ids: world.trending.filter(isShow).map(titleId) },
    ],
  };
}
