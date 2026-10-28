/**
 * The movies the front page's ranking demo draws from. Data only: no logic, no imports.
 *
 * ---------------------------------------------------------------------------
 * WHY A COMMITTED LIST, AND NOT TODAY'S TRENDING
 * ---------------------------------------------------------------------------
 *
 * The demo used to read `trending.movie.day` from Supabase on first use. That made the
 * posters depend on which Supabase project a build was handed, and a build handed none —
 * every branch preview, every local build — showed text tiles instead of posters. The
 * demo's job is to show the interaction in a few seconds, not to report what is trending,
 * so the list is now committed and the page fetches nothing but the poster images.
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
 *
 * **The planned replacement is a monthly generated "most-ranked on bingd" list**, written
 * over this file in this same shape, so `demo.mjs` and the page do not change. "Most
 * ranked" means the movies ranked by the greatest number of **distinct users**, not the
 * most ranking events: one person re-ranking a favourite ten times is one vote. That
 * generator is not built yet; see docs/architecture/web-deployment.md.
 *
 * Poster paths were read on 2026-10-28 from the staging catalogue (`media_items`, a
 * world-readable table, with the public anon key) and every one was checked to resolve
 * on TMDB's CDN. Two films from the earlier fallback list, Get Out and La La Land, are
 * not in that catalogue, and were replaced by Interstellar and Spider-Man: Into the
 * Spider-Verse rather than given a poster path nobody had checked.
 */
export const DEMO_LIST = {
  source: 'curated',
  asOf: '2026-10-28',
  movies: [
    { tmdbId: 329, title: 'Jurassic Park', year: 1993, posterPath: '/d9mtMGQDLANKieb9PbD3yK7xxzo.jpg' },
    { tmdbId: 597, title: 'Titanic', year: 1997, posterPath: '/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg' },
    { tmdbId: 155, title: 'The Dark Knight', year: 2008, posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
    { tmdbId: 862, title: 'Toy Story', year: 1995, posterPath: '/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg' },
    { tmdbId: 27205, title: 'Inception', year: 2010, posterPath: '/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg' },
    { tmdbId: 346698, title: 'Barbie', year: 2023, posterPath: '/iuFNMS8U5cb6xfzi51Dbkovj7vM.jpg' },
    { tmdbId: 603, title: 'The Matrix', year: 1999, posterPath: '/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg' },
    { tmdbId: 496243, title: 'Parasite', year: 2019, posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg' },
    { tmdbId: 157336, title: 'Interstellar', year: 2014, posterPath: '/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg' },
    { tmdbId: 105, title: 'Back to the Future', year: 1985, posterPath: '/vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg' },
    { tmdbId: 129, title: 'Spirited Away', year: 2001, posterPath: '/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg' },
    { tmdbId: 872585, title: 'Oppenheimer', year: 2023, posterPath: '/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg' },
    { tmdbId: 76341, title: 'Mad Max: Fury Road', year: 2015, posterPath: '/ulcAi4dKpAjHwYGS08vNyx9H6I9.jpg' },
    { tmdbId: 680, title: 'Pulp Fiction', year: 1994, posterPath: '/vQWk5YBFWF4bZaofAbv0tShwBvQ.jpg' },
    { tmdbId: 324857, title: 'Spider-Man: Into the Spider-Verse', year: 2018, posterPath: '/iiZZdoQBEYBv6id8su7ImL0oCbD.jpg' },
    { tmdbId: 545611, title: 'Everything Everywhere All at Once', year: 2022, posterPath: '/u68AjlvlutfEIcpmbYpKcdi09ut.jpg' },
  ],
};
