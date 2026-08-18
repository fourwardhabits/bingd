import { canonicalGenres, hasAnyGenre, type CanonicalGenre } from './genres';

/**
 * The twenty award tracks, and every threshold in the product.
 *
 * **Nothing outside this file knows a number.** A row renders what `progress.ts` hands
 * it; `progress.ts` reads this table. That is the point of the shape: a threshold in a
 * component is a threshold that disagrees with a test six weeks later.
 *
 * A track is a metric and three tiers. The metric is a function of {@link AwardFacts} —
 * one snapshot of the reader's own canonical data, assembled once by `use-awards.ts` and
 * shared by all twenty, so opening the sheet is a handful of reads rather than twenty.
 *
 * **The copy is here too, and it is a pair of functions rather than a pair of strings.**
 * `next` is what to do and `earned` is what was done, and both take the threshold
 * because two tracks have a tier of one and "Send 1 recommendations" is the kind of
 * thing that makes a person trust nothing else on the screen.
 *
 * **No metric key is ever shown.** `movies-watched` is a name for the code; the reader
 * gets "Watch 10 movies".
 */

/** One watched title, as the awards need it. One row per exact movie or season. */
export type WatchedTitle = {
  mediaItemId: string;
  /** A series is never here: `_assert_loggable` refuses one, so nothing can log it. */
  kind: 'movie' | 'season';
  /** `media_items.genres`, in whichever vocabulary that row happens to carry. */
  genres: string[];
  /** `media_items.original_language`, ISO 639-1. */
  language: string | null;
  /** The release year, from `media_items.release_date`. */
  year: number | null;
};

/**
 * Everything the twenty tracks are allowed to know.
 *
 * Deliberately flat and deliberately counted at the edge: a track's metric is a pure
 * function of this, which is what lets every threshold be tested without a database.
 */
export type AwardFacts = {
  /** Exact movies and seasons in the collection, one entry each. */
  watched: WatchedTitle[];
  /** Rows in `rankings` — exact titles with a position. */
  rankedCount: number;
  /** Rows in `watchlist` now. See Queue Dragon on why "now" and not "ever". */
  watchlistCount: number;
  /** Rows in `invite_link_creations` — links minted, not shares dispatched. */
  invitesCreated: number;
  /** Comments the reader has written, plus the notes they have made public. */
  writtenCount: number;
  /** Rows in `title_recommendations` the reader sent. */
  recommendationsSent: number;
  /** Reactions other people left on the reader's activity. Never their own. */
  reactionsReceived: number;
  /** Approved follows in both directions, with an account that still exists. */
  mutualFollows: number;
};

export type AwardTier = {
  /** Slugged, and half of the badge key. */
  key: string;
  /** What the reader sees: "Bronze", "Jetsetter", "Sob Lord". */
  label: string;
  threshold: number;
};

export type AwardTrack = {
  key: string;
  displayName: string;
  metric: (facts: AwardFacts) => number;
  /** "Watch 10 movies". Imperative, and the thing still to do. */
  next: (threshold: number) => string;
  /** "Watched 150 movies". Past, and only ever shown beside a tier already earned. */
  earned: (threshold: number) => string;
  /** Exactly three, lowest first. */
  tiers: [AwardTier, AwardTier, AwardTier];
  /**
   * One line under the name when the metric is not the obvious reading of it.
   *
   * Only two tracks have one, and both are cases where a reader could reasonably
   * believe a different number is being counted.
   */
  note?: string;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const movies = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'movie').length;
const seasons = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'season').length;

/** Titles in a genre, counted once each however many of its names they carry. */
const inGenre = (genres: CanonicalGenre[]) => (facts: AwardFacts) =>
  facts.watched.filter((title) => hasAnyGenre(title.genres, genres)).length;

const tiers = (
  ...list: [[string, string, number], [string, string, number], [string, string, number]]
): [AwardTier, AwardTier, AwardTier] =>
  list.map(([key, label, threshold]) => ({ key, label, threshold })) as [
    AwardTier,
    AwardTier,
    AwardTier,
  ];

export const AWARD_TRACKS: AwardTrack[] = [
  {
    key: 'movie-muncher',
    displayName: 'Movie Muncher',
    metric: movies,
    next: (n) => `Watch ${n} ${plural(n, 'movie', 'movies')}`,
    earned: (n) => `Watched ${n} ${plural(n, 'movie', 'movies')}`,
    tiers: tiers(['bronze', 'Bronze', 10], ['silver', 'Silver', 50], ['gold', 'Gold', 150]),
  },
  {
    key: 'season-snacker',
    displayName: 'Season Snacker',
    metric: seasons,
    next: (n) => `Watch ${n} TV ${plural(n, 'season', 'seasons')}`,
    earned: (n) => `Watched ${n} TV ${plural(n, 'season', 'seasons')}`,
    tiers: tiers(['bronze', 'Bronze', 3], ['silver', 'Silver', 15], ['gold', 'Gold', 40]),
  },
  {
    key: 'invite-instigator',
    displayName: 'Invite Instigator',
    metric: (facts) => facts.invitesCreated,
    next: (n) => `Make your invite link ${n} ${plural(n, 'time', 'times')}`,
    earned: (n) => `Made your invite link ${n} ${plural(n, 'time', 'times')}`,
    tiers: tiers(['bronze', 'Bronze', 1], ['silver', 'Silver', 5], ['gold', 'Gold', 15]),
    // The honest version, and the founder was explicit about it. Opening a share sheet
    // is not an invitation sent and this never calls it one: an OS sheet can be
    // dismissed and nothing on this device would know. `invite_link_creations` records
    // the one stage that is measurable today (`growth-instrumentation.md` §1).
    note: 'Counts links you made. Bingd cannot see whether they were opened.',
  },
  {
    key: 'queue-dragon',
    displayName: 'Queue Dragon',
    metric: (facts) => facts.watchlistCount,
    next: (n) => `Keep ${n} ${plural(n, 'title', 'titles')} on your watchlist`,
    earned: (n) => `Kept ${n} ${plural(n, 'title', 'titles')} on your watchlist`,
    tiers: tiers(
      ['seedling', 'Seedling', 10],
      ['hoarder', 'Hoarder', 40],
      ['queue-dragon', 'Queue Dragon', 100],
    ),
    // **The documented compromise.** The brief asked for watchlist *additions*, and
    // nothing records one: `set_watchlist(false)` deletes the row, so a title added and
    // removed leaves nothing behind and a lifetime total cannot be recovered. The
    // choices were to invent history, to add a ledger table for one badge, or to count
    // what the database actually holds. This counts what it holds, and says so. A
    // pile you keep is the more Queue Dragon number anyway.
    note: 'Your watchlist right now, so it goes down when you watch something.',
  },
  {
    key: 'rating-rascal',
    displayName: 'Rating Rascal',
    metric: (facts) => facts.rankedCount,
    next: (n) => `Rank ${n} ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Ranked ${n} ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['scribbler', 'Scribbler', 25],
      ['score-goblin', 'Score Goblin', 100],
      ['rank-beast', 'Rank Beast', 300],
    ),
  },
  {
    key: 'comment-gremlin',
    displayName: 'Comment Gremlin',
    metric: (facts) => facts.writtenCount,
    next: (n) => `Write ${n} ${plural(n, 'comment or public note', 'comments or public notes')}`,
    earned: (n) => `Wrote ${n} ${plural(n, 'comment or public note', 'comments or public notes')}`,
    tiers: tiers(
      ['whisper', 'Whisper', 5],
      ['chatterbox', 'Chatterbox', 25],
      ['megaphone', 'Megaphone', 75],
    ),
  },
  {
    key: 'hype-courier',
    displayName: 'Hype Courier',
    metric: (facts) => facts.recommendationsSent,
    next: (n) => `Send ${n} ${plural(n, 'recommendation', 'recommendations')}`,
    earned: (n) => `Sent ${n} ${plural(n, 'recommendation', 'recommendations')}`,
    tiers: tiers(
      ['nudge', 'Nudge', 3],
      ['messenger', 'Messenger', 15],
      ['hype-train', 'Hype Train', 50],
    ),
  },
  {
    key: 'scream-snack',
    displayName: 'Scream Snack',
    metric: inGenre(['Horror']),
    next: (n) => `Watch ${n} horror ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} horror ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['spooky-sip', 'Spooky Sip', 5],
      ['slash-snack', 'Slash Snack', 20],
      ['nightmare-fuel', 'Nightmare Fuel', 50],
    ),
  },
  {
    key: 'lol-mode',
    displayName: 'LOL Mode',
    metric: inGenre(['Comedy']),
    next: (n) => `Watch ${n} ${plural(n, 'comedy', 'comedies')}`,
    earned: (n) => `Watched ${n} ${plural(n, 'comedy', 'comedies')}`,
    tiers: tiers(['giggle', 'Giggle', 5], ['cackle', 'Cackle', 20], ['wheeze', 'Wheeze', 50]),
  },
  {
    key: 'softie-hours',
    displayName: 'Softie Hours',
    // Drama *or* Romance, and a title that is both is one title. The set in
    // `genres.ts` is what makes that true rather than a comment promising it.
    metric: inGenre(['Drama', 'Romance']),
    next: (n) => `Watch ${n} drama or romance ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} drama or romance ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['sniffle', 'Sniffle', 5],
      ['tearjerker', 'Tearjerker', 20],
      ['sob-lord', 'Sob Lord', 50],
    ),
  },
  {
    key: 'space-brain',
    displayName: 'Space Brain',
    metric: inGenre(['Science Fiction']),
    next: (n) => `Watch ${n} science fiction ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} science fiction ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['liftoff', 'Liftoff', 5],
      ['moonwalker', 'Moonwalker', 20],
      ['galaxy-mind', 'Galaxy Mind', 50],
    ),
  },
  {
    key: 'boom-club',
    displayName: 'Boom Club',
    metric: inGenre(['Action']),
    next: (n) => `Watch ${n} action ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} action ${plural(n, 'title', 'titles')}`,
    tiers: tiers(['spark', 'Spark', 5], ['blast', 'Blast', 20], ['detonation', 'Detonation', 50]),
  },
  {
    key: 'toon-bloom',
    displayName: 'Toon Bloom',
    metric: inGenre(['Animation']),
    next: (n) => `Watch ${n} animated ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} animated ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['sketch', 'Sketch', 3],
      ['ink-pop', 'Ink Pop', 15],
      ['cartoon-chaos', 'Cartoon Chaos', 40],
    ),
  },
  {
    key: 'truth-worm',
    displayName: 'Truth Worm',
    metric: inGenre(['Documentary']),
    next: (n) => `Watch ${n} ${plural(n, 'documentary', 'documentaries')}`,
    earned: (n) => `Watched ${n} ${plural(n, 'documentary', 'documentaries')}`,
    tiers: tiers(
      ['curious', 'Curious', 3],
      ['investigator', 'Investigator', 10],
      ['deep-dive', 'Deep Dive', 30],
    ),
  },
  {
    key: 'passport-mode',
    displayName: 'Passport Mode',
    // `original_language`, which is a fact about how the thing was made rather than
    // about what a viewer happened to hear. A title with no language recorded is not
    // counted: absent is not evidence of foreign.
    metric: (facts) =>
      facts.watched.filter((title) => title.language != null && title.language !== 'en').length,
    next: (n) => `Watch ${n} non-English ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${n} non-English ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['hitchhiker', 'Hitchhiker', 5],
      ['jetsetter', 'Jetsetter', 20],
      ['globetrotter', 'Globetrotter', 60],
    ),
  },
  {
    key: 'time-hopper',
    displayName: 'Time Hopper',
    metric: (facts) => facts.watched.filter((title) => title.year != null && title.year < 2000).length,
    next: (n) => `Watch ${n} ${plural(n, 'title', 'titles')} released before 2000`,
    earned: (n) => `Watched ${n} ${plural(n, 'title', 'titles')} released before 2000`,
    tiers: tiers(
      ['retro-snack', 'Retro Snack', 5],
      ['vhs-vibes', 'VHS Vibes', 20],
      ['time-traveler', 'Time Traveler', 50],
    ),
  },
  {
    key: 'genre-gremlin',
    displayName: 'Genre Gremlin',
    // How many of the eighteen in `genres.ts`, not how many raw labels. Wikidata hands
    // `12 Angry Men` three of its own, and counting those would make one film look like
    // a third of somebody's range.
    metric: (facts) => {
      const found = new Set<CanonicalGenre>();
      for (const title of facts.watched) {
        for (const genre of canonicalGenres(title.genres)) found.add(genre);
      }
      return found.size;
    },
    next: (n) => `Watch ${n} different ${plural(n, 'genre', 'genres')}`,
    earned: (n) => `Watched ${n} different ${plural(n, 'genre', 'genres')}`,
    tiers: tiers(
      ['dabbler', 'Dabbler', 5],
      ['mixer', 'Mixer', 10],
      ['chaos-collector', 'Chaos Collector', 15],
    ),
  },
  {
    key: 'two-screen-life',
    displayName: 'Two-Screen Life',
    // **The dual requirement, as one number.** The tier wants five movies *and* five
    // seasons, so the metric is the weaker of the two: at four movies and nine seasons
    // it reads 4 / 5, which is both the truth and the thing to do about it. A row
    // showing "4 / 5 · 9 / 5" would be arithmetic on a list somebody is scrolling.
    metric: (facts) => Math.min(movies(facts), seasons(facts)),
    next: (n) => `Watch ${n} movies and ${n} TV seasons`,
    earned: (n) => `Watched ${n} movies and ${n} TV seasons`,
    tiers: tiers(['tourist', 'Tourist', 5], ['resident', 'Resident', 15], ['mayor', 'Mayor', 40]),
    note: 'The number is whichever side you are further behind on.',
  },
  {
    key: 'heart-magnet',
    displayName: 'Heart Magnet',
    metric: (facts) => facts.reactionsReceived,
    next: (n) => `Get ${n} ${plural(n, 'reaction', 'reactions')} on your activity`,
    earned: (n) => `Got ${n} ${plural(n, 'reaction', 'reactions')} on your activity`,
    tiers: tiers(
      ['warmup', 'Warmup', 10],
      ['favorite', 'Favorite', 50],
      ['scene-stealer', 'Scene Stealer', 200],
    ),
  },
  {
    key: 'mutual-mania',
    displayName: 'Mutual Mania',
    metric: (facts) => facts.mutualFollows,
    // The verb agrees with the noun, so a tier of one does not read "1 person who
    // follow you back". Both halves move together or neither should.
    next: (n) => `Follow ${n} ${plural(n, 'person who follows', 'people who follow')} you back`,
    earned: (n) =>
      `Followed ${n} ${plural(n, 'person who follows', 'people who follow')} you back`,
    tiers: tiers(
      ['hello', 'Hello', 1],
      ['inner-circle', 'Inner Circle', 10],
      ['main-character', 'Main Character', 50],
    ),
  },
];
