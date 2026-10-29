/**
 * The movies the front page's ranking demo draws from. Data only: no logic, no imports.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LIST IS OPTIMISED FOR
 * ---------------------------------------------------------------------------
 *
 * Not a history of cinema. One question: **how likely is an everyday movie fan to have
 * seen both films on screen?** So (founder QA, 2026-10-28):
 *
 *   - 12–16 movies, about 80% from 2000 or later, at most two earlier classics, and
 *     several from the last five to eight years;
 *   - recognition over critical prestige;
 *   - one film per franchise;
 *   - broad genre coverage, so the demo can pair films from different genre families
 *     (`demo.mjs` prefers that), because "a comedy or an action movie?" is an easier,
 *     more expressive pick than two near-identical superhero films.
 *
 * `router.test.mjs` holds the list to those numbers.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, WHICH IS THE CONTRACT
 * ---------------------------------------------------------------------------
 *
 *   source      what the list is. `'curated'` today.
 *   asOf        the day the list was written, YYYY-MM-DD.
 *   movies      in the order the demo offers them, each:
 *                 tmdbId      TMDB's movie id, a positive integer
 *                 title       as TMDB names it
 *                 year        the release year
 *                 posterPath  TMDB's `poster_path`, e.g. `/abc.jpg` — a path, never a URL.
 *                             `demo.mjs` turns it into a URL through `posterUrl`, so
 *                             nothing in this file can point an `img` anywhere but TMDB.
 *                 family      one genre family, used only to choose pairs and never shown:
 *                             action, comedy, drama, thriller (horror and thriller),
 *                             scifi, animation or romance.
 *
 * **The planned replacement is a monthly generated "most-ranked on bingd" list**, written
 * over this file in this same shape, so `demo.mjs` and the page do not change. Its
 * candidates are the movies ranked by the greatest number of **distinct users**, not the
 * most ranking events; the constraints above are then applied before it is committed.
 * Nothing in the browser ever reads ranking data. See docs/architecture/web-deployment.md.
 *
 * Poster paths were read on 2026-10-28 from the staging catalogue (`media_items`, a
 * world-readable table, with the public anon key) and every one was checked to resolve
 * on TMDB's CDN. Films missing from that catalogue were left out rather than given a
 * poster path nobody had checked.
 */
export const DEMO_LIST = {
  source: 'curated',
  asOf: '2026-10-28',
  movies: [
    { tmdbId: 346698, title: 'Barbie', year: 2023, posterPath: '/iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg', family: 'comedy' },
    { tmdbId: 299534, title: 'Avengers: Endgame', year: 2019, posterPath: '/ulzhLuWrPK07P1YkdWQLZnQh1JL.jpg', family: 'action' },
    { tmdbId: 597, title: 'Titanic', year: 1997, posterPath: '/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg', family: 'romance' },
    { tmdbId: 138843, title: 'The Conjuring', year: 2013, posterPath: '/wVYREutTvI2tmxr6ujrHT704wGF.jpg', family: 'thriller' },
    { tmdbId: 808, title: 'Shrek', year: 2001, posterPath: '/iB64vpL3dIObOtMZgX3RqdVdQDc.jpg', family: 'animation' },
    { tmdbId: 872585, title: 'Oppenheimer', year: 2023, posterPath: '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg', family: 'drama' },
    { tmdbId: 19995, title: 'Avatar', year: 2009, posterPath: '/gKY6q7SjCkAU6FqvqWybDYgUKIF.jpg', family: 'scifi' },
    { tmdbId: 72105, title: 'Ted', year: 2012, posterPath: '/1QVZXQQHCEIj8lyUhdBYd2qOYtq.jpg', family: 'comedy' },
    { tmdbId: 155, title: 'The Dark Knight', year: 2008, posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', family: 'action' },
    { tmdbId: 8966, title: 'Twilight', year: 2008, posterPath: '/3Gkb6jm6962ADUPaCBqzz9CTbn9.jpg', family: 'romance' },
    { tmdbId: 496243, title: 'Parasite', year: 2019, posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg', family: 'thriller' },
    { tmdbId: 269149, title: 'Zootopia', year: 2016, posterPath: '/hlK0e0wAQ3VLuJcsfIYPvb4JVud.jpg', family: 'animation' },
    { tmdbId: 106646, title: 'The Wolf of Wall Street', year: 2013, posterPath: '/kW9LmvYHAaS9iA0tHmZVq8hQYoq.jpg', family: 'drama' },
    { tmdbId: 438631, title: 'Dune', year: 2021, posterPath: '/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg', family: 'scifi' },
  ],
};
