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
 * because the number is the thing that differs between the tiers.
 *
 * **No metric key is ever shown.** `movies-watched` is a name for the code; the reader
 * gets "Watch 50 movies".
 *
 * ---
 *
 * THE THRESHOLDS ARE LONG-TERM ON PURPOSE (founder pass, 2026-08-18)
 *
 * The first set was walkable in an evening, which the founder's device review called
 * exactly right: a Bronze earned by logging ten films is a participation trophy, and a
 * shelf of them is worth nothing. These are set so that Bronze is already something an
 * active reader gets to over months, Silver reads as an enthusiast, and Gold is rare
 * and quite possibly multi-year.
 *
 * They are **not** tuned against the founder's seeded account. Several tiers are
 * deliberately out of reach of any collection that exists today.
 */

/** One watched title, as the awards need it. One row per exact movie or season. */
export type WatchedTitle = {
  mediaItemId: string;
  /** A series is never here: `_assert_loggable` refuses one, so nothing can log it. */
  kind: 'movie' | 'season';
  /** The row's own title. A season's is "Season 1" until `seriesTitle` joins it. */
  title: string;
  /** The parent series, for a season, so a drill-down is not a column of "Season 2". */
  seriesTitle: string | null;
  /** `media_items.season_number`, for the same reason. */
  seasonNumber: number | null;
  /** For the drill-down thumbnail. Null everywhere the catalogue has no artwork. */
  posterPath: string | null;
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
  /**
   * People who joined Bingd on this reader's invitation and then used it.
   *
   * **Not links minted, and the change is the point.** Until 2026-08-18 this counted
   * rows in `invite_link_creations` — the number of times somebody asked for their own
   * link — which is a measure of pressing a button. The founder's instruction is that
   * the award is for bringing people to Bingd, so the metric is now attributed,
   * activated signups: rows in `invite_attributions` where this reader is the inviter
   * and `activated_at` is set.
   *
   * **Nothing writes that column yet**, so the number is a true zero for everybody. See
   * `docs/product/growth-instrumentation.md` and the note in `use-awards.ts`: the
   * semantic is correct now and starts counting the day the redemption path lands, with
   * no client change. What it must never be is a stand-in number that flatters the
   * reader for having opened a share sheet.
   */
  invitedSignups: number;
  /** Comments the reader has written, plus the notes they have made public. */
  writtenCount: number;
  /** Rows in `title_recommendations` the reader sent. */
  recommendationsSent: number;
  /** Reactions other people left on the reader's activity. Never their own. */
  reactionsReceived: number;
  /** Approved follows in both directions, with an account that still exists. */
  mutualFollows: number;
  /**
   * Which of the fields above could not be read.
   *
   * **A count that failed is not a count of zero**, and the difference matters here
   * more than almost anywhere else in the app: zero is a statement about the reader —
   * you have sent no recommendations — and a badge that says it because a request timed
   * out is the app being wrong about somebody in a way they cannot argue with.
   * Independent review 20 found the swallowed error; the founder's Phase 7 asked for
   * exactly this state, and the two agree.
   *
   * `watched` is never in here. It is the one fatal read, because thirteen tracks are
   * meaningless without it and a sheet of thirteen blanks is worse than saying so once.
   */
  unavailable?: ReadonlySet<keyof AwardFacts>;
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
  /**
   * The metric where it depends on which tier is being measured.
   *
   * One track has one: Two-Screen Life caps each side's contribution at the tier, so
   * the number genuinely differs between Bronze and Gold rather than being one value
   * compared against three thresholds. Everything else leaves this unset and is
   * measured once.
   */
  metricAt?: (facts: AwardFacts, tier: AwardTier) => number;
  /**
   * The exact titles behind the number, where the number is made of titles.
   *
   * Present on twelve of the thirteen collection tracks and absent on the seven that
   * count invites, reactions, follows, recommendations, rankings, writing or the
   * watchlist — not because those have no contributors but because Bingd has no
   * privacy-safe surface that lists them, and inventing one for a drill-down would be a
   * social analytics feature arriving through the back door.
   *
   * Genre Gremlin has none either: its number is *genres*, and a list of titles under
   * "8 / 14" would be a list whose length disagrees with the count above it.
   */
  contributors?: (facts: AwardFacts) => WatchedTitle[];
  /** "Watch 50 movies". Imperative, and the thing still to do. */
  next: (threshold: number) => string;
  /** "Watched 1,000 movies". Past, and only ever shown beside a tier already earned. */
  earned: (threshold: number) => string;
  /** Exactly three, lowest first. */
  tiers: [AwardTier, AwardTier, AwardTier];
  /**
   * The fact this track counts, so a read that failed can be told from a zero.
   *
   * One field, never a list: every track reads exactly one of them, which is not a
   * coincidence but the shape that lets `unavailable` be answered without guessing
   * which half of a compound metric went missing.
   */
  needs: keyof AwardFacts;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * `1,000` rather than `1000`.
 *
 * Every threshold in the copy and every count on a row goes through this. Four figures
 * without a separator read as a serial number, and the tiers that matter most are the
 * four-figure ones.
 */
export const count = (n: number): string => n.toLocaleString('en-US');

const moviesIn = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'movie');
const seasonsIn = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'season');

const movies = (facts: AwardFacts) => moviesIn(facts).length;
const seasons = (facts: AwardFacts) => seasonsIn(facts).length;

/** Titles in a genre, counted once each however many of its names they carry. */
const inGenre = (genres: CanonicalGenre[]) => (facts: AwardFacts) =>
  facts.watched.filter((title) => hasAnyGenre(title.genres, genres));

const nonEnglish = (facts: AwardFacts) =>
  facts.watched.filter((title) => title.language != null && title.language !== 'en');

const beforeMillennium = (facts: AwardFacts) =>
  facts.watched.filter((title) => title.year != null && title.year < 2000);

const tiers = (
  ...list: [[string, string, number], [string, string, number], [string, string, number]]
): [AwardTier, AwardTier, AwardTier] =>
  list.map(([key, label, threshold]) => ({ key, label, threshold })) as [
    AwardTier,
    AwardTier,
    AwardTier,
  ];

/**
 * A genre track, whose seven instances differ only in the genre and the words.
 *
 * Written as one function because the seven were seven near-identical blocks and the
 * difference between them — which genre, which noun — was buried in the repetition. The
 * metric is derived from the contributor list rather than written twice, so the
 * drill-down cannot list a set whose size disagrees with the count above it.
 */
const genreTrack = (config: {
  key: string;
  displayName: string;
  genres: CanonicalGenre[];
  /** "horror titles", "comedies" — the object of "Watch …". */
  noun: (n: number) => string;
  tiers: [AwardTier, AwardTier, AwardTier];
}): AwardTrack => {
  const contributors = inGenre(config.genres);
  return {
    key: config.key,
    needs: 'watched',
    displayName: config.displayName,
    metric: (facts) => contributors(facts).length,
    contributors,
    next: (n) => `Watch ${count(n)} ${config.noun(n)}`,
    earned: (n) => `Watched ${count(n)} ${config.noun(n)}`,
    tiers: config.tiers,
  };
};

/** The progression the founder set for five of the seven genre tracks. */
const genreTiers = (
  labels: [string, string, string],
  keys: [string, string, string],
): [AwardTier, AwardTier, AwardTier] =>
  tiers([keys[0], labels[0], 25], [keys[1], labels[1], 100], [keys[2], labels[2], 300]);

/**
 * Two-Screen Life, as arithmetic rather than as a paragraph.
 *
 * **Capped contribution, not the weaker of the two sides.** The old metric was
 * `min(movies, seasons)`, which meant a reader at four movies and nine seasons saw
 * `4 / 5` with no way to tell what the five was about — and the row needed a sentence
 * saying "the number is whichever side you are further behind on", which is a technical
 * explanation of a badge.
 *
 * Each side counts up to the tier's cap and the two are added, so Bronze at 30 is
 * fifteen films and fifteen seasons, `22 / 30` is a number that goes up whenever either
 * side does, and the goal line — "Watch 15 movies and 15 TV seasons" — says the whole
 * rule in seven words.
 *
 * The cap is half the threshold by construction. Deriving it rather than configuring it
 * separately is what stops the two drifting apart; `awards.test.ts` pins the identity.
 */
const twoScreenAt = (facts: AwardFacts, threshold: number) => {
  const cap = threshold / 2;
  return Math.min(movies(facts), cap) + Math.min(seasons(facts), cap);
};

export const AWARD_TRACKS: AwardTrack[] = [
  {
    key: 'movie-muncher',
    needs: 'watched',
    displayName: 'Movie Muncher',
    metric: movies,
    contributors: moviesIn,
    next: (n) => `Watch ${count(n)} ${plural(n, 'movie', 'movies')}`,
    earned: (n) => `Watched ${count(n)} ${plural(n, 'movie', 'movies')}`,
    tiers: tiers(['bronze', 'Bronze', 50], ['silver', 'Silver', 200], ['gold', 'Gold', 1000]),
  },
  {
    key: 'season-snacker',
    needs: 'watched',
    displayName: 'Season Snacker',
    metric: seasons,
    contributors: seasonsIn,
    next: (n) => `Watch ${count(n)} TV ${plural(n, 'season', 'seasons')}`,
    earned: (n) => `Watched ${count(n)} TV ${plural(n, 'season', 'seasons')}`,
    tiers: tiers(['bronze', 'Bronze', 15], ['silver', 'Silver', 60], ['gold', 'Gold', 250]),
  },
  {
    key: 'invite-instigator',
    needs: 'invitedSignups',
    displayName: 'Invite Instigator',
    metric: (facts) => facts.invitedSignups,
    // **People, not links.** The founder's instruction of 2026-08-18: opening a share
    // sheet is not an invitation, minting a URL is not an invitation, and sending one is
    // not an invitation either. The only thing worth a badge is somebody arriving. The
    // copy says so plainly, and there is no caveat line under it explaining what the
    // number really counts, because the number now counts what it says.
    next: (n) => `Bring ${count(n)} ${plural(n, 'person', 'people')} to Bingd`,
    earned: (n) => `Brought ${count(n)} ${plural(n, 'person', 'people')} to Bingd`,
    tiers: tiers(['bronze', 'Bronze', 3], ['silver', 'Silver', 15], ['gold', 'Gold', 50]),
  },
  {
    key: 'queue-dragon',
    needs: 'watchlistCount',
    displayName: 'Queue Dragon',
    metric: (facts) => facts.watchlistCount,
    next: (n) => `Keep ${count(n)} ${plural(n, 'title', 'titles')} on your watchlist`,
    earned: (n) => `Kept ${count(n)} ${plural(n, 'title', 'titles')} on your watchlist`,
    tiers: tiers(
      ['seedling', 'Seedling', 25],
      ['hoarder', 'Hoarder', 100],
      ['queue-dragon', 'Queue Dragon', 300],
    ),
    // **The documented compromise, no longer explained on the row.** The brief asked for
    // watchlist *additions* and nothing records one: `set_watchlist(false)` deletes the
    // row, so a lifetime total cannot be recovered. This counts the pile being held now,
    // which is the more Queue Dragon number anyway. The old caveat line — "your
    // watchlist right now, so it goes down when you watch something" — was a technical
    // explanation living in a list somebody scrolls, and the goal line already says
    // "Keep 25 titles on your watchlist". Keep is the whole of it.
  },
  {
    key: 'rating-rascal',
    needs: 'rankedCount',
    displayName: 'Rating Rascal',
    metric: (facts) => facts.rankedCount,
    next: (n) => `Rank ${count(n)} ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Ranked ${count(n)} ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['scribbler', 'Scribbler', 100],
      ['score-goblin', 'Score Goblin', 500],
      ['rank-beast', 'Rank Beast', 2000],
    ),
  },
  {
    key: 'comment-gremlin',
    needs: 'writtenCount',
    displayName: 'Comment Gremlin',
    metric: (facts) => facts.writtenCount,
    next: (n) =>
      `Write ${count(n)} ${plural(n, 'comment or public note', 'comments or public notes')}`,
    earned: (n) =>
      `Wrote ${count(n)} ${plural(n, 'comment or public note', 'comments or public notes')}`,
    tiers: tiers(
      ['whisper', 'Whisper', 20],
      ['chatterbox', 'Chatterbox', 100],
      ['megaphone', 'Megaphone', 500],
    ),
  },
  {
    key: 'hype-courier',
    needs: 'recommendationsSent',
    displayName: 'Hype Courier',
    metric: (facts) => facts.recommendationsSent,
    next: (n) => `Send ${count(n)} ${plural(n, 'recommendation', 'recommendations')}`,
    earned: (n) => `Sent ${count(n)} ${plural(n, 'recommendation', 'recommendations')}`,
    tiers: tiers(
      ['nudge', 'Nudge', 25],
      ['messenger', 'Messenger', 100],
      ['hype-train', 'Hype Train', 500],
    ),
  },
  genreTrack({
    key: 'scream-snack',
    displayName: 'Scream Snack',
    genres: ['Horror'],
    noun: (n) => `horror ${plural(n, 'title', 'titles')}`,
    tiers: genreTiers(
      ['Spooky Sip', 'Slash Snack', 'Nightmare Fuel'],
      ['spooky-sip', 'slash-snack', 'nightmare-fuel'],
    ),
  }),
  genreTrack({
    key: 'lol-mode',
    displayName: 'LOL Mode',
    genres: ['Comedy'],
    noun: (n) => plural(n, 'comedy', 'comedies'),
    tiers: genreTiers(['Giggle', 'Cackle', 'Wheeze'], ['giggle', 'cackle', 'wheeze']),
  }),
  genreTrack({
    key: 'softie-hours',
    displayName: 'Softie Hours',
    // Drama *or* Romance, and a title that is both is one title. The set in `genres.ts`
    // is what makes that true rather than a comment promising it.
    genres: ['Drama', 'Romance'],
    noun: (n) => `drama or romance ${plural(n, 'title', 'titles')}`,
    tiers: genreTiers(['Sniffle', 'Tearjerker', 'Sob Lord'], ['sniffle', 'tearjerker', 'sob-lord']),
  }),
  genreTrack({
    key: 'space-brain',
    displayName: 'Space Brain',
    genres: ['Science Fiction'],
    noun: (n) => `science fiction ${plural(n, 'title', 'titles')}`,
    tiers: genreTiers(
      ['Liftoff', 'Moonwalker', 'Galaxy Mind'],
      ['liftoff', 'moonwalker', 'galaxy-mind'],
    ),
  }),
  genreTrack({
    key: 'boom-club',
    displayName: 'Boom Club',
    genres: ['Action'],
    noun: (n) => `action ${plural(n, 'title', 'titles')}`,
    tiers: genreTiers(['Spark', 'Blast', 'Detonation'], ['spark', 'blast', 'detonation']),
  }),
  genreTrack({
    key: 'toon-bloom',
    displayName: 'Toon Bloom',
    genres: ['Animation'],
    noun: (n) => `animated ${plural(n, 'title', 'titles')}`,
    // Lower than the other genres, deliberately: animation is a smaller shelf than
    // action in any catalogue, so identical numbers would make it the harder award for a
    // reason that has nothing to do with the reader.
    tiers: tiers(
      ['sketch', 'Sketch', 20],
      ['ink-pop', 'Ink Pop', 75],
      ['cartoon-chaos', 'Cartoon Chaos', 250],
    ),
  }),
  genreTrack({
    key: 'truth-worm',
    displayName: 'Truth Worm',
    genres: ['Documentary'],
    noun: (n) => plural(n, 'documentary', 'documentaries'),
    // Lower again, and for the same reason more so.
    tiers: tiers(
      ['curious', 'Curious', 15],
      ['investigator', 'Investigator', 50],
      ['deep-dive', 'Deep Dive', 150],
    ),
  }),
  {
    key: 'passport-mode',
    needs: 'watched',
    displayName: 'Passport Mode',
    // `original_language`, which is a fact about how the thing was made rather than
    // about what a viewer happened to hear. A title with no language recorded is not
    // counted: absent is not evidence of foreign.
    metric: (facts) => nonEnglish(facts).length,
    contributors: nonEnglish,
    next: (n) => `Watch ${count(n)} non-English ${plural(n, 'title', 'titles')}`,
    earned: (n) => `Watched ${count(n)} non-English ${plural(n, 'title', 'titles')}`,
    tiers: tiers(
      ['hitchhiker', 'Hitchhiker', 15],
      ['jetsetter', 'Jetsetter', 75],
      ['globetrotter', 'Globetrotter', 250],
    ),
  },
  {
    key: 'time-hopper',
    needs: 'watched',
    displayName: 'Time Hopper',
    metric: (facts) => beforeMillennium(facts).length,
    contributors: beforeMillennium,
    next: (n) => `Watch ${count(n)} ${plural(n, 'title', 'titles')} released before 2000`,
    earned: (n) => `Watched ${count(n)} ${plural(n, 'title', 'titles')} released before 2000`,
    tiers: tiers(
      ['retro-snack', 'Retro Snack', 25],
      ['vhs-vibes', 'VHS Vibes', 100],
      ['time-traveler', 'Time Traveler', 300],
    ),
  },
  {
    key: 'genre-gremlin',
    needs: 'watched',
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
    next: (n) => `Watch ${count(n)} different ${plural(n, 'genre', 'genres')}`,
    earned: (n) => `Watched ${count(n)} different ${plural(n, 'genre', 'genres')}`,
    /**
     * **Sixteen, and the number was audited rather than picked.**
     *
     * The old top tier was fifteen of eighteen, and the founder's instruction was to
     * stop guessing at it: find the vocabulary the catalogue can actually support and
     * set the tier there, rather than keep a target that is unreachable in practice.
     *
     * All eighteen canonical genres do appear in the seeded catalogue, so eighteen is
     * not *impossible* — but the tail is one or two titles deep. Counted over the 1,814
     * countable rows in `supabase/seed/catalogue.json`: Documentary is carried by two
     * titles, Animation by eight, Western by fourteen. Every other genre has at least
     * twenty-one.
     *
     * So sixteen is the largest tier that never depends on a genre with fewer than
     * fourteen titles behind it: a reader may miss any two of the eighteen and still
     * finish, which means they can skip the two thinnest without the award turning into
     * a hunt for one specific documentary. Eighteen would have been that hunt.
     */
    tiers: tiers(
      ['dabbler', 'Dabbler', 8],
      ['mixer', 'Mixer', 14],
      ['chaos-collector', 'Chaos Collector', 16],
    ),
  },
  {
    key: 'two-screen-life',
    needs: 'watched',
    displayName: 'Two-Screen Life',
    // Bronze's number, so a caller with no tier in hand still gets a real one. Every
    // reader-facing number comes from `metricAt` below.
    metric: (facts) => twoScreenAt(facts, 30),
    metricAt: (facts, tier) => twoScreenAt(facts, tier.threshold),
    // Both halves, movies first. The award is about using Bingd for both, so the list
    // behind it is both — not whichever side happens to be short.
    contributors: (facts) => [...moviesIn(facts), ...seasonsIn(facts)],
    next: (n) => `Watch ${count(n / 2)} movies and ${count(n / 2)} TV seasons`,
    earned: (n) => `Watched ${count(n / 2)} movies and ${count(n / 2)} TV seasons`,
    tiers: tiers(
      ['tourist', 'Tourist', 30],
      ['resident', 'Resident', 100],
      ['mayor', 'Mayor', 300],
    ),
  },
  {
    key: 'heart-magnet',
    needs: 'reactionsReceived',
    displayName: 'Heart Magnet',
    metric: (facts) => facts.reactionsReceived,
    next: (n) => `Get ${count(n)} ${plural(n, 'reaction', 'reactions')} on your activity`,
    earned: (n) => `Got ${count(n)} ${plural(n, 'reaction', 'reactions')} on your activity`,
    tiers: tiers(
      ['warmup', 'Warmup', 50],
      ['favorite', 'Favorite', 250],
      ['scene-stealer', 'Scene Stealer', 1000],
    ),
  },
  {
    key: 'mutual-mania',
    needs: 'mutualFollows',
    displayName: 'Mutual Mania',
    metric: (facts) => facts.mutualFollows,
    // The verb agrees with the noun, so a tier of one does not read "1 person who follow
    // you back". Both halves move together or neither should.
    next: (n) =>
      `Follow ${count(n)} ${plural(n, 'person who follows', 'people who follow')} you back`,
    earned: (n) =>
      `Followed ${count(n)} ${plural(n, 'person who follows', 'people who follow')} you back`,
    tiers: tiers(
      ['hello', 'Hello', 5],
      ['inner-circle', 'Inner Circle', 25],
      ['main-character', 'Main Character', 100],
    ),
  },
];
