/**
 * The founder's real Letterboxd export, 2026-09-10, verbatim.
 *
 * A free account — which is the fact that settled whether this feature has an audience at
 * all — created 2026-09-06 and exported four days later. Twenty-two watched films, all
 * twenty-two rated, one diary entry, two watchlist items, and every other file in the
 * archive present but header-only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXTURE PROVES, AND WHAT IT CANNOT
 *
 * It is the primary fixture because it is real, and because it happens to carry six traps
 * nobody would have thought to write by hand:
 *
 *   · every `Date` is `2026-09-11` — a day *after* the export was taken, because
 *     Letterboxd stamps in its own timezone. Proof that `Date` is neither a watch date nor
 *     even reliably today.
 *   · *Free Solo* is `boxd.it/iEEq` in watched and ratings and `boxd.it/ggWgth` in the
 *     diary. Proof that the diary URI is a different object.
 *   · the single diary entry is itself a rewatch, so the first viewing has no date
 *     anywhere. Proof that diary rows are not a watch count.
 *   · *Blade Runner 2049* carries a year inside its title.
 *   · three German films are exported under English titles.
 *   · six titles are 2025–2026 and may have no settled release date at the provider.
 *
 * **What it does not cover** is written into `letterboxd.test.ts` as hand-built cases,
 * because the gaps are as instructive as the coverage: there is no unrated watched film,
 * no watchlist row that is also watched, no title containing a comma, no second diary
 * entry, and `likes/films.csv` is empty. The most important of those — a watchlist and
 * watched overlap — is the highest-severity ordering bug in the design and this file
 * cannot exercise it.
 *
 * `profile.csv` is deliberately **not** reproduced here. It carries a username and a
 * pronoun, this feature imports neither, and a fixture is not a reason to check personal
 * fields into a repository.
 */

import type { ArchiveText } from '../archive';

export const REAL_WATCHED_CSV = `Date,Name,Year,Letterboxd URI
2026-09-11,Spider-Man: Brand New Day,2026,https://boxd.it/ACJE
2026-09-11,The Odyssey,2026,https://boxd.it/QFQU
2026-09-11,The Drama,2026,https://boxd.it/OA2w
2026-09-11,Free Solo,2018,https://boxd.it/iEEq
2026-09-11,The Invite,2026,https://boxd.it/zRNY
2026-09-11,Project Hail Mary,2026,https://boxd.it/pEeQ
2026-09-11,Barbie,2023,https://boxd.it/bCLK
2026-09-11,Blade Runner 2049,2017,https://boxd.it/b8wK
2026-09-11,The Big Short,2015,https://boxd.it/ajZw
2026-09-11,Remember the Titans,2000,https://boxd.it/1VLk
2026-09-11,Polite Society,2023,https://boxd.it/AU9u
2026-09-11,Jackass Forever,2022,https://boxd.it/opUg
2026-09-11,The Martian,2015,https://boxd.it/8SeG
2026-09-11,X-Men: The Last Stand,2006,https://boxd.it/1a5Q
2026-09-11,Joker: Folie à Deux,2024,https://boxd.it/xBoE
2026-09-11,Sisi & I,2023,https://boxd.it/yp3Q
2026-09-11,A Woman in Berlin,2008,https://boxd.it/1R8o
2026-09-11,In the Aisles,2018,https://boxd.it/hMNe
2026-09-11,A Silent Voice: The Movie,2016,https://boxd.it/d99c
2026-09-11,Shrek,2001,https://boxd.it/29zi
2026-09-11,Love Letters,2025,https://boxd.it/GlC4
2026-09-11,Slumdog Millionaire,2008,https://boxd.it/1S3E
`;

export const REAL_RATINGS_CSV = `Date,Name,Year,Letterboxd URI,Rating
2026-09-11,Spider-Man: Brand New Day,2026,https://boxd.it/ACJE,4.5
2026-09-11,The Odyssey,2026,https://boxd.it/QFQU,4
2026-09-11,The Drama,2026,https://boxd.it/OA2w,3
2026-09-11,Free Solo,2018,https://boxd.it/iEEq,5
2026-09-11,The Invite,2026,https://boxd.it/zRNY,3
2026-09-11,Project Hail Mary,2026,https://boxd.it/pEeQ,3.5
2026-09-11,Barbie,2023,https://boxd.it/bCLK,3
2026-09-11,Blade Runner 2049,2017,https://boxd.it/b8wK,5
2026-09-11,The Big Short,2015,https://boxd.it/ajZw,4.5
2026-09-11,Remember the Titans,2000,https://boxd.it/1VLk,4.5
2026-09-11,Polite Society,2023,https://boxd.it/AU9u,2.5
2026-09-11,Jackass Forever,2022,https://boxd.it/opUg,2.5
2026-09-11,The Martian,2015,https://boxd.it/8SeG,2
2026-09-11,X-Men: The Last Stand,2006,https://boxd.it/1a5Q,3
2026-09-11,Joker: Folie à Deux,2024,https://boxd.it/xBoE,3
2026-09-11,Sisi & I,2023,https://boxd.it/yp3Q,1.5
2026-09-11,A Woman in Berlin,2008,https://boxd.it/1R8o,2
2026-09-11,In the Aisles,2018,https://boxd.it/hMNe,2
2026-09-11,A Silent Voice: The Movie,2016,https://boxd.it/d99c,4
2026-09-11,Shrek,2001,https://boxd.it/29zi,3
2026-09-11,Love Letters,2025,https://boxd.it/GlC4,1
2026-09-11,Slumdog Millionaire,2008,https://boxd.it/1S3E,3.5
`;

/** One entry, and it is a rewatch — so the first viewing of Free Solo has no date at all. */
export const REAL_DIARY_CSV = `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2026-09-11,Free Solo,2018,https://boxd.it/ggWgth,5,Yes,,2026-09-10
`;

export const REAL_WATCHLIST_CSV = `Date,Name,Year,Letterboxd URI
2026-09-11,Obsession,2025,https://boxd.it/PNqo
2026-09-11,Coyote vs. Acme,2026,https://boxd.it/JHdm
`;

export const REAL_EXPORT: ArchiveText = {
  'watched.csv': REAL_WATCHED_CSV,
  'ratings.csv': REAL_RATINGS_CSV,
  'diary.csv': REAL_DIARY_CSV,
  'watchlist.csv': REAL_WATCHLIST_CSV,
};

/**
 * The complete archive listing, including every file this import refuses to open.
 *
 * Reproduced because the refusal is the point: `archive.test.ts` hands this to a reader
 * that records every path asked for, and asserts that the twelve excluded members were
 * never among them. A listing without them could not prove anything.
 *
 * Sizes are plausible rather than measured — nothing here tests byte accuracy, only the
 * bounds and the selection.
 */
export const REAL_LISTING = [
  { path: 'profile.csv', bytes: 180 },
  { path: 'watched.csv', bytes: 1_400 },
  { path: 'ratings.csv', bytes: 1_500 },
  { path: 'diary.csv', bytes: 120 },
  { path: 'reviews.csv', bytes: 90 },
  { path: 'watchlist.csv', bytes: 140 },
  { path: 'comments.csv', bytes: 30 },
  { path: 'deleted/diary.csv', bytes: 80 },
  { path: 'deleted/reviews.csv', bytes: 90 },
  { path: 'deleted/comments.csv', bytes: 30 },
  { path: 'orphaned/diary.csv', bytes: 80 },
  { path: 'orphaned/reviews.csv', bytes: 90 },
  { path: 'orphaned/comments.csv', bytes: 30 },
  { path: 'likes/films.csv', bytes: 40 },
  { path: 'likes/reviews.csv', bytes: 20 },
  { path: 'likes/lists.csv', bytes: 20 },
] as const;
