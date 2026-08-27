import { languageName } from '@/lib/language';

import { canonicalGenres, hasAnyGenre, type CanonicalGenre } from './genres';

/**
 * The twenty award tracks: every threshold, every metric, and the breakdown behind it.
 *
 * **Nothing outside this file knows a number.** A row renders what `progress.ts` hands
 * it; `progress.ts` reads this table. That is the point of the shape: a threshold in a
 * component is a threshold that disagrees with a test six weeks later.
 *
 * **One evaluator, not two.** Every track's `contributions` returns the rows behind its
 * number, and its metric is the *weight of those rows*. So the count on a row and the
 * list behind it cannot disagree — not because two queries were kept in step, but
 * because there is one. `awards.test.ts` asserts the identity for all twenty.
 *
 * **The copy is a pair of functions rather than a pair of strings.** `next` is what to
 * do and `earned` is what was done, and both take the threshold because the number is
 * the thing that differs between the tiers.
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
 * and quite possibly multi-year. They are **not** tuned against the founder's seeded
 * account.
 */

/** One watched, ranked or saved title, as the awards need it. */
export type WatchedTitle = {
  mediaItemId: string;
  /** A series is never here: `_assert_loggable` refuses one, so nothing can log it. */
  kind: 'movie' | 'season';
  /** The row's own title. A season's is "Season 1" until `seriesTitle` joins it. */
  title: string;
  /** The parent series, for a season, so a row is not a column of "Season 2". */
  seriesTitle: string | null;
  /** `media_items.season_number`, for the same reason. */
  seasonNumber: number | null;
  /** For the drill-down thumbnail. Null everywhere the catalogue has no artwork. */
  posterPath: string | null;
  /**
   * Genres, **with a season's inheritance already applied** (`lib/media-metadata.ts`).
   *
   * Before 2026-08-18 a season carried none at all, which made every genre track and
   * Genre Gremlin movie-only without anything saying so.
   */
  genres: string[];
  /** ISO 639-1, with the same inheritance. */
  language: string | null;
  /** The release year, from `media_items.release_date`. */
  year: number | null;
  /** `user_media.watched_on`, where the reader gave one. */
  watchedOn: string | null;
};

/** A ranked title, with the score the reader's own list gives it. */
export type RankedTitle = WatchedTitle & { score: number };

/** Somebody else, as much of them as the reader is entitled to see. */
export type PersonRef = {
  id: string;
  /** Their display name, or a neutral stand-in when the profile is not visible. */
  name: string;
  /** Null when the account is hidden, suspended or gone. */
  username: string | null;
  avatarPath: string | null;
};

export type ContributionKind = 'comment' | 'note';

/** One thing the reader wrote. The body is deliberately not carried. */
export type WrittenContribution = {
  key: string;
  kind: ContributionKind;
  /** What it was about. Null when the event's title could not be resolved. */
  title: WatchedTitle | null;
  writtenAt: string | null;
};

export type RecommendationSent = {
  key: string;
  title: WatchedTitle | null;
  recipient: PersonRef;
  sentAt: string | null;
};

/** One piece of the reader's activity, and how many reactions it drew. */
export type ReactedItem = {
  key: string;
  title: WatchedTitle | null;
  reactions: number;
};

export type InvitedSignup = {
  person: PersonRef;
  activatedAt: string | null;
};

/**
 * Everything the twenty tracks are allowed to know.
 *
 * Deliberately flat and deliberately assembled at the edge: a track's metric is a pure
 * function of this, which is what lets every threshold be tested without a database.
 */
export type AwardFacts = {
  /** Exact movies and seasons in the collection, one entry each. */
  watched: WatchedTitle[];
  /** Rows in `rankings` — exact titles with a position — with their derived score. */
  rankings: RankedTitle[];
  /** Rows in `watchlist` now. See Queue Dragon on why "now" and not "ever". */
  watchlist: WatchedTitle[];
  /**
   * People who joined Bingd on this reader's invitation and then used it.
   *
   * **Not links minted.** Until 2026-08-18 this counted `invite_link_creations` — the
   * number of times somebody asked for their own link — which is a measure of pressing
   * a button. It is now attributed, activated signups. **Nothing writes that column
   * yet**, so the list is empty for everybody and the award reads `0 / 3`; the semantic
   * is correct now and starts counting the day the redemption path lands, with no
   * client change. See `docs/product/growth-instrumentation.md`.
   */
  invitedSignups: InvitedSignup[];
  /** Comments the reader has written, plus the notes they have made public. */
  written: WrittenContribution[];
  /** Rows in `title_recommendations` the reader sent. */
  recommendationsSent: RecommendationSent[];
  /** The reader's own activity, folded into what drew reactions. Never their own. */
  reactionsReceived: ReactedItem[];
  /** Approved follows in both directions, with an account that still exists. */
  mutualFollows: PersonRef[];
  /**
   * Which of the fields above could not be read.
   *
   * **A count that failed is not a count of zero**, and the difference matters here
   * more than almost anywhere else in the app: zero is a statement about the reader —
   * you have sent no recommendations — and a badge that says it because a request timed
   * out is the app being wrong about somebody in a way they cannot argue with.
   *
   * `watched` is never in here. It is the one fatal read, because thirteen tracks are
   * meaningless without it and a sheet of thirteen blanks is worse than saying so once.
   */
  unavailable?: ReadonlySet<keyof AwardFacts>;
  /**
   * Which fields the viewer is not entitled to read, on somebody else's sheet.
   *
   * A third state, deliberately distinct from both zero and `unavailable`: sent
   * recommendations and activated invites are two-party facts, so a visitor's read of
   * them is zero rows *by policy* — not a count of nothing and not a failure to ask.
   * The row says so ("Only they can see this one") instead of apologising for a
   * request that behaved exactly as designed, and instead of a retry that cannot
   * change the answer.
   */
  withheld?: ReadonlySet<keyof AwardFacts>;
};

export type AwardTier = {
  /** Slugged, and half of the badge key. */
  key: string;
  /** What the reader sees once it is earned: "Bronze", "Jetsetter", "Sob Lord". */
  label: string;
  threshold: number;
};

/**
 * One line of a drill-down.
 *
 * Deliberately one shape for titles, people and genres alike. Three row types would be
 * three components and three ways for a breakdown to stop matching its number; the
 * fields a given row does not use are simply absent.
 */
export type BreakdownRow = {
  key: string;
  /** The primary line. A compact title, a person's name, a genre. */
  label: string;
  /** Under it: a watch date, a language, a recipient, a contribution type. */
  detail?: string | null;
  /** Right-aligned: a score, a reaction count, how many titles a genre has. */
  value?: string | null;
  posterPath?: string | null;
  avatarPath?: string | null;
  year?: number | null;
  /** Where tapping leads, where anything does. */
  link?: { kind: 'title'; mediaItemId: string } | { kind: 'profile'; username: string } | null;
  /**
   * What this row contributes to the award's number. One unless stated.
   *
   * Heart Magnet's rows weigh their reaction count; Two-Screen Life's weigh nothing
   * past the tier's cap. The sum over every section is the metric, and that is asserted
   * rather than assumed.
   */
  weight?: number;
};

/** A drill-down: one section usually, two where the award genuinely has two halves. */
export type BreakdownSection = {
  /** Absent on a single-section breakdown, where the sheet's own heading is enough. */
  label?: string;
  /** "15 / 15" beside the section label, where a side has a cap of its own. */
  value?: string;
  rows: BreakdownRow[];
};

export type Breakdown = {
  sections: BreakdownSection[];
  /** What the reader is told the list adds up to. Empty means "nothing yet". */
  emptyLabel: string;
};

export const weightOf = (row: BreakdownRow) => row.weight ?? 1;

/** The number a breakdown claims. Must equal the track's metric, and is tested to. */
export const breakdownTotal = (breakdown: Breakdown): number =>
  breakdown.sections.reduce(
    (total, section) => total + section.rows.reduce((sum, row) => sum + weightOf(row), 0),
    0,
  );

export type AwardTrack = {
  key: string;
  displayName: string;
  /**
   * The rows behind the number, for the tier being worked toward.
   *
   * The tier matters to exactly one track — Two-Screen Life caps each side at it — and
   * is ignored by the other nineteen. Passing it always is cheaper than a second
   * optional hook and makes the capped case ordinary rather than special.
   */
  contributions: (facts: AwardFacts, tier: AwardTier) => Breakdown;
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
  /**
   * True where the tier labels are metals rather than names.
   *
   * It decides what the row is *called*. A creative track is titled by the tier the
   * reader has reached — Dabbler, then Mixer, then Chaos Collector — because that name
   * is the reward. A metal track keeps its family name, because a row headed "Silver"
   * says nothing about what was done and three rows headed "Bronze" say less.
   */
  metalTiers?: boolean;
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

// --- The shapes a breakdown takes ------------------------------------------

/** A title as a row: the show and the season, never a bare "Season 2". */
export function titleRow(title: WatchedTitle, extra: Partial<BreakdownRow> = {}): BreakdownRow {
  return {
    key: title.mediaItemId || `${title.title}-${title.seasonNumber ?? ''}`,
    label: compactLabel(title),
    posterPath: title.posterPath,
    year: title.year,
    link: title.mediaItemId ? { kind: 'title', mediaItemId: title.mediaItemId } : null,
    ...extra,
  };
}

/**
 * `The Last of Us, S1`.
 *
 * The same rule `lib/titles.ts` states, applied to the award's own shape rather than
 * imported, because that helper takes a media row and this takes a `WatchedTitle` — and
 * a season named after its own show ("Chernobyl") must not read "Chernobyl, Chernobyl".
 */
export function compactLabel(title: WatchedTitle): string {
  const own = title.title?.trim() || '';
  if (title.kind !== 'season') return own;
  const series = title.seriesTitle?.trim();
  if (!series) return own;
  if (own.toLowerCase().includes(series.toLowerCase())) return own;
  return title.seasonNumber != null ? `${series}, S${title.seasonNumber}` : `${series}, ${own}`;
}

const personRow = (person: PersonRef, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key: person.id,
  label: person.name,
  detail: person.username ? `@${person.username}` : 'This account is not available to you',
  avatarPath: person.avatarPath,
  link: person.username ? { kind: 'profile', username: person.username } : null,
  ...extra,
});

/** A date as a reader reads one. Absent rather than "Unknown" when there is none. */
const on = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

const titles = (rows: WatchedTitle[], emptyLabel: string, extra?: (t: WatchedTitle) => Partial<BreakdownRow>): Breakdown => ({
  sections: [{ rows: rows.map((title) => titleRow(title, extra?.(title) ?? {})) }],
  emptyLabel,
});

// --- The metrics themselves ------------------------------------------------

const moviesIn = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'movie');
const seasonsIn = (facts: AwardFacts) => facts.watched.filter((t) => t.kind === 'season');

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
 * difference between them — which genre, which noun — was buried in the repetition.
 *
 * **Its drill-down lists movies and seasons together**, which is the whole point of the
 * metadata inheritance this pass added: `The Last of Us, S1` is in Softie Hours because
 * the show is a drama, and the sheet is where a reader can see that it counted.
 */
const genreTrack = (config: {
  key: string;
  displayName: string;
  genres: CanonicalGenre[];
  /** "horror titles", "comedies" — the object of "Watch …". */
  noun: (n: number) => string;
  tiers: [AwardTier, AwardTier, AwardTier];
}): AwardTrack => {
  const matching = inGenre(config.genres);
  return {
    key: config.key,
    needs: 'watched',
    displayName: config.displayName,
    contributions: (facts) =>
      titles(matching(facts), `No ${config.noun(2)} yet.`, (title) => ({
        detail: on(title.watchedOn) ? `Watched ${on(title.watchedOn)}` : null,
      })),
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

export const AWARD_TRACKS: AwardTrack[] = [
  {
    key: 'movie-muncher',
    needs: 'watched',
    displayName: 'Movie Muncher',
    metalTiers: true,
    contributions: (facts) =>
      titles(moviesIn(facts), 'No films logged yet.', (title) => ({
        detail: on(title.watchedOn) ? `Watched ${on(title.watchedOn)}` : null,
      })),
    next: (n) => `Watch ${count(n)} ${plural(n, 'movie', 'movies')}`,
    earned: (n) => `Watched ${count(n)} ${plural(n, 'movie', 'movies')}`,
    tiers: tiers(['bronze', 'Bronze', 50], ['silver', 'Silver', 200], ['gold', 'Gold', 1000]),
  },
  {
    key: 'season-snacker',
    needs: 'watched',
    displayName: 'Season Snacker',
    metalTiers: true,
    contributions: (facts) =>
      titles(seasonsIn(facts), 'No TV seasons logged yet.', (title) => ({
        detail: on(title.watchedOn) ? `Watched ${on(title.watchedOn)}` : null,
      })),
    next: (n) => `Watch ${count(n)} TV ${plural(n, 'season', 'seasons')}`,
    earned: (n) => `Watched ${count(n)} TV ${plural(n, 'season', 'seasons')}`,
    tiers: tiers(['bronze', 'Bronze', 15], ['silver', 'Silver', 60], ['gold', 'Gold', 250]),
  },
  {
    key: 'invite-instigator',
    needs: 'invitedSignups',
    displayName: 'Invite Instigator',
    metalTiers: true,
    // **People, not links.** Opening a share sheet is not an invitation, minting a URL
    // is not an invitation, and sending one is not an invitation either. The only thing
    // worth a badge is somebody arriving — so the drill-down is people, and it is
    // honestly empty until the redemption path exists.
    contributions: (facts) => ({
      sections: [
        {
          rows: facts.invitedSignups.map(({ person, activatedAt }) =>
            personRow(person, {
              detail: on(activatedAt)
                ? `Joined ${on(activatedAt)}`
                : (person.username ? `@${person.username}` : null),
            }),
          ),
        },
      ],
      emptyLabel: 'No activated invites yet.',
    }),
    next: (n) => `Bring ${count(n)} ${plural(n, 'person', 'people')} to bingd.`,
    earned: (n) => `Brought ${count(n)} ${plural(n, 'person', 'people')} to bingd.`,
    tiers: tiers(['bronze', 'Bronze', 3], ['silver', 'Silver', 15], ['gold', 'Gold', 50]),
  },
  {
    key: 'queue-dragon',
    needs: 'watchlist',
    displayName: 'Queue Dragon',
    // The pile being held now, not everything ever added: `set_watchlist(false)` deletes
    // the row, so a lifetime total cannot be recovered. The goal line says "Keep", which
    // is the same fact as an instruction rather than as a footnote.
    contributions: (facts) => titles(facts.watchlist, 'Nothing saved for later yet.'),
    next: (n) => `Keep ${count(n)} ${plural(n, 'title', 'titles')} on your watchlist`,
    earned: (n) => `Kept ${count(n)} ${plural(n, 'title', 'titles')} on your watchlist`,
    tiers: tiers(
      ['seedling', 'Seedling', 25],
      ['hoarder', 'Hoarder', 100],
      ['queue-dragon', 'Queue Dragon', 300],
    ),
  },
  {
    key: 'rating-rascal',
    needs: 'rankings',
    displayName: 'Rating Rascal',
    contributions: (facts) => ({
      sections: [
        {
          rows: facts.rankings.map((title) =>
            titleRow(title, { value: title.score.toFixed(1) }),
          ),
        },
      ],
      emptyLabel: 'Nothing ranked yet.',
    }),
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
    needs: 'written',
    displayName: 'Comment Gremlin',
    /**
     * What the reader wrote, and where.
     *
     * **Never the writing itself.** The award counts that somebody talked; reprinting a
     * note here would be a third surface for it with none of the spoiler masking the
     * other two have, and a comment's body belongs under the activity it answers.
     *
     * One canonical contribution is one row: a public note is one `user_media` row even
     * though it appears on the activity row and in Bingd Reviews, and it is counted
     * where it is stored rather than where it is displayed.
     */
    contributions: (facts) => ({
      sections: [
        {
          rows: facts.written.map((entry) => ({
            key: entry.key,
            label: entry.title ? compactLabel(entry.title) : 'A bingd. activity',
            detail: [entry.kind === 'note' ? 'Review' : 'Comment', on(entry.writtenAt)]
              .filter(Boolean)
              .join(' · '),
            posterPath: entry.title?.posterPath ?? null,
            year: entry.title?.year ?? null,
            link: entry.title?.mediaItemId
              ? { kind: 'title', mediaItemId: entry.title.mediaItemId }
              : null,
          })),
        },
      ],
      emptyLabel: 'Nothing written yet.',
    }),
    next: (n) =>
      `Write ${count(n)} ${plural(n, 'comment or review', 'comments or reviews')}`,
    earned: (n) =>
      `Wrote ${count(n)} ${plural(n, 'comment or review', 'comments or reviews')}`,
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
    // In-app recommendations only. A share off Bingd opens an OS sheet that may be
    // dismissed, and nothing here would ever know — the same rule that keeps Invite
    // Instigator off link creations.
    contributions: (facts) => ({
      sections: [
        {
          rows: facts.recommendationsSent.map((sent) => ({
            key: sent.key,
            label: sent.title ? compactLabel(sent.title) : 'A title',
            detail: [`To ${sent.recipient.name}`, on(sent.sentAt)].filter(Boolean).join(' · '),
            posterPath: sent.title?.posterPath ?? null,
            year: sent.title?.year ?? null,
            link: sent.title?.mediaItemId
              ? { kind: 'title', mediaItemId: sent.title.mediaItemId }
              : null,
          })),
        },
      ],
      emptyLabel: 'Nothing recommended yet.',
    }),
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
    // action in any catalogue, so identical numbers would make it the harder award for
    // a reason that has nothing to do with the reader.
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
    // counted: absent is not evidence of foreign. A season's language is its show's.
    contributions: (facts) =>
      titles(nonEnglish(facts), 'Nothing in another language yet.', (title) => ({
        // The name rather than the code: "ko" is a database value, not a label.
        detail: languageLabel(title.language),
      })),
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
    contributions: (facts) => titles(beforeMillennium(facts), 'Nothing from before 2000 yet.'),
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
    /**
     * **This one counts genres, so its breakdown is genres.**
     *
     * One row per canonical genre the collection touches, with how many titles carry it
     * — which answers the question the number actually raises ("which ten?") rather than
     * listing every title and leaving the reader to count the distinct ones themselves.
     *
     * The vocabulary is `genres.ts` and nothing else: Wikidata gives `12 Angry Men`
     * three labels, and counting those would make one film look like a third of
     * somebody's range. Seasons contribute through their series' genres.
     */
    contributions: (facts) => {
      const byGenre = new Map<CanonicalGenre, number>();
      for (const title of facts.watched) {
        for (const genre of canonicalGenres(title.genres)) {
          byGenre.set(genre, (byGenre.get(genre) ?? 0) + 1);
        }
      }
      return {
        sections: [
          {
            rows: [...byGenre.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
              .map(([genre, titleCount]) => ({
                key: genre,
                label: genre,
                value: `${count(titleCount)} ${plural(titleCount, 'title', 'titles')}`,
              })),
          },
        ],
        emptyLabel: 'No genres counted yet.',
      };
    },
    next: (n) => `Watch ${count(n)} different ${plural(n, 'genre', 'genres')}`,
    earned: (n) => `Watched ${count(n)} different ${plural(n, 'genre', 'genres')}`,
    /**
     * **14 / 16 / 17 over a vocabulary of eighteen**, measured rather than felt.
     *
     * ### The correction that produced these numbers
     *
     * This note previously carried a table of "median units logged to reach N distinct
     * genres" that **nothing reproduced** — a one-off calibration run quoted as a result.
     * The founder's Preview brief then carried a *different* table for the same quantity.
     * Two irreconcilable numbers under the thing the whole ladder rests on.
     *
     * `scripts/awards/genre-ladder-report.mjs` settles it. It reads the seeded catalogue,
     * applies `genres.ts`'s own vocabulary, and simulates acquisition; the vocabulary is
     * held identical to `genres.ts` by a test rather than by good intentions. Both prior
     * tables turn out to be *right about different columns*:
     *
     *   - the old table here is close to the **taste-weighted median** (13/24/54 against a
     *     measured 13/25/56 at 12/14/16), so the earlier audit's method was sound;
     *   - the founder's brief quoted **p10** — the fastest tenth of readers — as though it
     *     were the median. 12 → 9 units, 14 → 15, 16 → 30 are the tenth percentile. The
     *     medians are 15, 27 and 62.
     *
     * **Every number below is the uniform column, which is the slower of the two models at
     * every median.** Independent review caught the report claiming its taste-weighted
     * model was the pessimistic one. It is not, and why is a finding in itself: on a
     * catalogue whose two rarest genres are 6 and 10 rows of 1,814, **scarcity dominates
     * preference**. Disliking documentaries costs a reader almost nothing when there is
     * almost nothing to dislike, while liking anything at all speeds up the first fourteen
     * genres, which are plentiful in every direction.
     *
     * So taste-weighting measures slightly *faster at the median* — though not at every
     * percentile: at 18 genres its p90 runs longer, because the reader who dislikes the
     * tail is the one who waits longest for it. **Neither model bounds real difficulty.**
     * The thresholds were chosen against medians, which is why the median is the
     * comparison stated. What is unmodelled is in the last section here.
     *
     * That correction does not overturn the founder's conclusion; it strengthens it. The
     * old ladder was even easier than the number that prompted the complaint suggested.
     *
     * ### What the old ladder actually cost, in logged units
     *
     * Uniform reader, 20,000 simulated readers, p10 / median / p90:
     *
     * | | Bronze | Silver | Gold |
     * |---|---|---|---|
     * | **12 / 14 / 16 (old)** | 9 / **15** / 26 | 15 / **27** / 51 | 30 / **62** / 128 |
     * | **14 / 16 / 17 (new)** | 15 / **27** / 51 | 30 / **62** / 128 | 49 / **116** / 270 |
     *
     * Every other Gold in this file that counts the watched collection sits at 250–300
     * titles — Time Traveler 300, Globetrotter 250, Cartoon Chaos 250 — and each of those
     * needs a *subset* of them, so the true logged count is higher again. A Gold at a
     * median of 62 units was an order of magnitude out of line with its own family. At 17
     * it is 116, which is still the gentle end of the band and no longer a different sport.
     *
     * ### Why Gold is 17 and not 18, which is the only genuinely close call
     *
     * Seventeen means the reader may miss **any one** genre. Eighteen means they may miss
     * none, and the two the catalogue barely has are Documentary (6 of 1,814 loggable rows)
     * and Animation (10). The simulation prices the difference directly:
     *
     * | step | extra units, p10 / median / p90 |
     * |---|---|
     * | 16 → 17 | 6 / **45** / 183 |
     * | 17 → 18 | 16 / **126** / 448 |
     *
     * At exactly sixteen genres a reader is missing two, and 49% are missing both
     * Documentary and Animation — but the other 51% can finish on Western, Music or War
     * instead. **Seventeen leaves a choice; eighteen names the rarest row in the catalogue
     * and demands it.** That is the line between a long-term achievement and the
     * rare-genre scavenger hunt the brief rules out, and it is why the ceiling is 17 even
     * though 18 is where the vocabulary ends.
     *
     * ### Why Bronze is 14
     *
     * Dabbler at 12 was a median of 15 logged units and a p10 of 9 — the founder's "earned
     * after a handful of ordinary multi-genre titles", almost exactly, because one title
     * carries 2.68 canonical genres on average. At 14 the fastest tenth still needs 15, and
     * the median is 27. Silver at 16 is 2.3× that, and Gold 4.3×: roughly doubling, which
     * is the intended shape. The old ladder's tiers were evenly spaced in *genres* and
     * therefore bunched in effort, because the marginal cost of genre 17 is nothing like
     * the marginal cost of genre 12.
     *
     * ### What is not modelled, and which way it points
     *
     * These numbers are over the 1,814 **seeded** rows. `media_items` grows as the TMDB
     * adapter caches what people search for, and Documentary and Animation are far better
     * represented in TMDB at large than at 6 and 10 rows. That is the largest unmodelled
     * effect and it points toward the tail being **easier** in production than measured
     * here — the safe direction for a threshold to be wrong in.
     *
     * A direction, not a bound. A real reader also logs titles no model here contains, and
     * whether *they* would ever pick a documentary is the thing neither column can answer.
     * **The beta settles that**, which is why the evidence is a script that can be re-run
     * rather than a table quoted once — the failure this whole note exists to correct.
     *
     * ### The catalogue, counted properly
     *
     * The loggable universe is **movies plus seasons** — `_assert_loggable` refuses a
     * series, and a season inherits its series' genres (`lib/media-metadata.ts`). That is
     * 382 + 1,432 = **1,814 rows, of which 1,551 carry at least one canonical genre**.
     * Mean genres per countable row: **2.68**.
     *
     * The tail is genuinely thin, and thinner than the note here used to claim:
     *
     * | | units | | | units |
     * |---|---|---|---|---|
     * | Drama | 1,102 | | War | 69 |
     * | Action | 451 | | Family | 54 |
     * | Thriller | 355 | | Music | 39 |
     * | … | … | | Western | 23 |
     * | Mystery | 124 | | **Animation** | **10** |
     * | History | 108 | | **Documentary** | **6** |
     *
     * **The previous note quoted movie-only figures** — "Documentary is two titles,
     * Animation eight, Western fourteen" — while claiming they were over the 1,814 rows.
     * Those are the counts among the 382 *movies*. The conclusion happened to survive the
     * correction; the reasoning is restated here from the numbers it actually rests on.
     *
     * ### Why the tail table above is the one that decides the ceiling
     *
     * Documentary at 6 rows and Animation at 10 are 0.9% of the loggable catalogue between
     * them. Everything above Western (23) is common enough that a reader meets it without
     * trying. That gap is why the tiers are not evenly spaced: genres 1–14 arrive on their
     * own, 15 and 16 take deliberate breadth, and 17 is the first one that can require
     * looking for something.
     *
     * ### Raising a threshold takes the tier back from anybody below the new one
     *
     * **Independent review 29 named this and it is real.** Awards are computed live from
     * table reads with no unlock ledger (`src/features/awards`), so a tier is not a thing
     * an account *holds* — it is recomputed every time the sheet opens. Moving the
     * threshold does not migrate anybody; it silently un-earns a tier the next time the
     * reader looks. This pass moves all three, so Dabbler goes back for anybody on 12 or
     * 13 distinct genres, Mixer for 14 or 15, and Chaos Collector for exactly 16.
     *
     * Accepted rather than mitigated, for reasons that are specific to right now:
     *
     *   - **The only accounts that exist are the founder's and test users.** There is no
     *     TestFlight build, no Play track and no external tester
     *     (`docs/release/beta-distribution-readiness.md`), so the population this can
     *     take an award from is one person, and that person asked for the change.
     *   - **The alternative is worse and permanent.** Grandfathering needs the durable
     *     unlock ledger that `deferred-roadmap.md` §5 defers — the same ledger award
     *     *notifications* wait on — and building it here to protect one account would be
     *     the scope creep this pass is explicitly not doing.
     *   - It only ever gets more expensive. Any threshold this project wants to correct
     *     should be corrected before there are readers to take it from.
     *
     * **This is the last threshold change that can be made for free**, and the day the
     * ledger lands, changing a tier becomes a migration rather than an edit.
     */
    tiers: tiers(
      ['dabbler', 'Dabbler', 14],
      ['mixer', 'Mixer', 16],
      ['chaos-collector', 'Chaos Collector', 17],
    ),
  },
  {
    key: 'two-screen-life',
    needs: 'watched',
    displayName: 'Two-Screen Life',
    /**
     * **Capped contribution, shown as two halves rather than explained in a sentence.**
     *
     * Each side counts up to half the tier and the two are added, so Bronze is fifteen
     * films and fifteen seasons. The old metric took the weaker side, which meant a
     * reader at four films and nine seasons saw `4 / 5` and needed a footnote saying
     * "the number is whichever side you are further behind on".
     *
     * The drill-down is the footnote's replacement: a Movies section reading `15 / 15`
     * over the films that counted, a TV Seasons section reading `7 / 15` over the
     * seasons, and the arithmetic is self-evident from the two headings. Rows past the
     * cap are not listed, which is also what keeps the sum equal to the number.
     */
    contributions: (facts, tier) => {
      const cap = tier.threshold / 2;
      const movies = moviesIn(facts);
      const seasons = seasonsIn(facts);
      const section = (label: string, rows: WatchedTitle[]): BreakdownSection => ({
        label,
        value: `${count(Math.min(rows.length, cap))} / ${count(cap)}`,
        rows: rows.slice(0, cap).map((title) => titleRow(title)),
      });
      return {
        // "TV", the visible category name — the rows beneath it are still seasons,
        // and the counting sentences below keep the unit because they count units.
        sections: [section('Movies', movies), section('TV', seasons)],
        emptyLabel: 'Nothing on either side yet.',
      };
    },
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
    /**
     * **What was reacted to, not who reacted.**
     *
     * The content-centric reading is the useful one — "The Wolf of Wall Street, 18
     * reactions" tells the reader something about their own taste — and it is the one
     * that discloses nothing. A list of reactors would be a new social surface, and the
     * per-item weight is what keeps the sum equal to the badge's number.
     */
    contributions: (facts) => ({
      sections: [
        {
          rows: facts.reactionsReceived.map((item) => ({
            key: item.key,
            label: item.title ? compactLabel(item.title) : 'A bingd. activity',
            posterPath: item.title?.posterPath ?? null,
            year: item.title?.year ?? null,
            value: `${count(item.reactions)} ${plural(item.reactions, 'reaction', 'reactions')}`,
            weight: item.reactions,
            link: item.title?.mediaItemId
              ? { kind: 'title', mediaItemId: item.title.mediaItemId }
              : null,
          })),
        },
      ],
      emptyLabel: 'No reactions yet.',
    }),
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
    contributions: (facts) => ({
      sections: [{ rows: facts.mutualFollows.map((person) => personRow(person)) }],
      emptyLabel: 'Nobody follows you back yet.',
    }),
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

/**
 * An ISO 639-1 code as a word, for Passport Mode's rows.
 *
 * Falls back to the code uppercased rather than to nothing: a row that said only "Ringu"
 * would leave the reader wondering why it was in this list.
 */
function languageLabel(code: string | null): string | null {
  if (!code) return null;
  // `lib/language.ts`, like every other language label in the app. This was a third
  // copy of `Intl.DisplayNames`, and Hermes does not implement it — so on the founder's
  // Android Preview every row in this breakdown read "KO" or "TE" rather than Korean or
  // Telugu. The uppercase fallback is what made it look intentional.
  return languageName(code) ?? code.toUpperCase();
}
