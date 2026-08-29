import {
  ACTIVITY_TYPES,
  activityMetadata,
  isWatchActivity,
  tailFor,
  verbFor,
  type ActivityType,
} from './activity';

/**
 * The sentence vocabulary and the standardised subheading.
 * Specification: founder Feed finalization 2026-08-20, items 1, 7, 9, 11, 12.
 */

describe('the activity sentence', () => {
  it('gives every rendered type a verb, so no screen has to guess', () => {
    // The defect this file exists for. `profile.tsx` carried
    // `type === 'title_logged' ? 'watched' : 'ranked'`, so a finished season said
    // "ranked" there and "finished" in the feed. A table with a hole in it is the
    // same bug one type later.
    for (const type of ACTIVITY_TYPES) {
      // Lower-case words, one or more. `goal_completed` is the first verb that is two
      // words — "hit their" — because the possessive belongs with the verb rather than
      // inside the emphasised slot, which holds the goal itself.
      expect(verbFor(type)).toMatch(/^[a-z]+( [a-z]+)*$/);
    }
  });

  it('reads as a sentence for the three watch activities, with nothing after the title', () => {
    expect(verbFor('title_ranked')).toBe('ranked');
    expect(verbFor('title_logged')).toBe('watched');
    expect(verbFor('season_completed')).toBe('finished');

    // "Suraj ranked 21 (2008)" — the object is last, so there is no tail.
    expect(tailFor('title_ranked')).toBeNull();
    expect(tailFor('title_logged')).toBeNull();
    expect(tailFor('season_completed')).toBeNull();
  });

  it('puts the watchlist clause after the title rather than into the verb', () => {
    // The founder's sentence is "Suraj Kandukuri added Dune (2021) to their
    // watchlist". Folding those words into the verb slot — which is what one
    // template for every type forces — gives "added to their watchlist Dune (2021)".
    expect(verbFor('watchlist_added')).toBe('added');
    expect(tailFor('watchlist_added')).toBe('to their watchlist');
  });

  it('composes the founder’s three reference sentences', () => {
    const say = (type: ActivityType, actor: string, title: string) =>
      [actor, verbFor(type), title, tailFor(type)].filter(Boolean).join(' ');

    expect(say('title_ranked', 'Suraj Kandukuri', '21 (2008)')).toBe(
      'Suraj Kandukuri ranked 21 (2008)',
    );
    expect(say('title_ranked', 'Suraj Kandukuri', 'INVINCIBLE, S1 (2021)')).toBe(
      'Suraj Kandukuri ranked INVINCIBLE, S1 (2021)',
    );
    expect(say('watchlist_added', 'Suraj Kandukuri', 'Severance, S2 (2025)')).toBe(
      'Suraj Kandukuri added Severance, S2 (2025) to their watchlist',
    );
  });

  it('treats a watchlist add as something other than a watch', () => {
    // What gates the note and the companions. Both are matched on (actor, title)
    // rather than on the event, so without this a watchlist row for a film its actor
    // later watched would carry that watching's review and tags.
    expect(isWatchActivity('watchlist_added')).toBe(false);
    expect(isWatchActivity('title_ranked')).toBe(true);
    expect(isWatchActivity('title_logged')).toBe(true);
    expect(isWatchActivity('season_completed')).toBe(true);
  });

  it('reads an award as the founder’s sentence, and never as a watch', () => {
    // "Abisola earned the Movie Muncher award" (founder, 2026-08-29). The name still
    // rides alone in the emphasised slot; the article and the noun sit on either side
    // of it, so the object reads as an award rather than as a film — which is what
    // "earned Movie Muncher" did not do.
    //
    // And it is emphatically not a watch claim: the note/companion joins became an
    // allow-list precisely so a new type could not inherit them by omission
    // (20260828000100).
    expect(verbFor('award_earned')).toBe('earned the');
    expect(tailFor('award_earned', 'Movie Muncher')).toBe('award');
    expect(isWatchActivity('award_earned')).toBe(false);
  });

  /**
   * The founder's own caveat: a name that already says "Award" must not produce
   * "earned the … award award". In practice this is the nameless fallback —
   * `use-feed.ts` renders "bingd. Award" for a payload with no `award_name` — which
   * is exactly the degradation path an award renamed or removed upstream takes.
   */
  it('does not say award twice when the name already says it', () => {
    expect(tailFor('award_earned', 'bingd. Award')).toBeNull();
    expect(tailFor('award_earned', 'Lifetime Achievement award')).toBeNull();
    // A name that merely contains the letters is not the same claim.
    expect(tailFor('award_earned', 'Awardless Wonder')).toBe('award');
  });

  /**
   * Every other row hands `tailFor` its title too, rather than branching on the type
   * at four call sites. The name must make no difference to any of them.
   */
  it('ignores the name on every row that is not an award', () => {
    expect(tailFor('title_ranked', 'The Award')).toBeNull();
    expect(tailFor('watchlist_added', 'The Award')).toBe('to their watchlist');
    expect(tailFor('goal_completed', 'The Award')).toBe('🎉');
  });
});

describe('the standardised subheading', () => {
  it('reads rating · runtime · two genres for a movie', () => {
    expect(
      activityMetadata({
        kind: 'movie',
        certification: 'PG-13',
        runtimeMinutes: 148,
        genres: ['Science Fiction', 'Adventure'],
      }),
    ).toBe('PG-13 · 148m · Science Fiction · Adventure');
  });

  it('reads rating · episodes · two genres for a season', () => {
    expect(
      activityMetadata({
        kind: 'season',
        certification: null,
        episodeCount: 8,
        genres: [],
        parent: { certification: 'TV-MA', genres: ['Action', 'Animation'] },
      }),
    ).toBe('TV-MA · 8 episodes · Action · Animation');
  });

  it('inherits a season’s rating and genres from the series that publishes them', () => {
    // Not a nicety: `tmdb_upsert_seasons` writes neither, and TMDB puts the content
    // rating on the series. Without the fall-through, half the catalogue's feed rows
    // would carry a bare episode count.
    const line = activityMetadata({
      kind: 'season',
      genres: null,
      certification: null,
      episodeCount: 9,
      parent: { genres: ['Drama'], certification: 'TV-MA' },
    });
    expect(line).toBe('TV-MA · 9 episodes · Drama');
  });

  it('never shows a season a runtime, even when one is sitting on the row', () => {
    // The failure the founder ruled out. A series' `runtime_minutes` is
    // `episode_run_time[0]` — one episode — so printing it where a reader scans for
    // "how long is this" describes a twenty-hour season as 50 minutes.
    expect(
      activityMetadata({
        kind: 'season',
        certification: 'TV-MA',
        runtimeMinutes: 50,
        episodeCount: 8,
        genres: ['Action'],
      }),
    ).toBe('TV-MA · 8 episodes · Action');

    // And not as a fallback either, when the count is the thing that is missing.
    expect(
      activityMetadata({
        kind: 'season',
        certification: 'TV-MA',
        runtimeMinutes: 50,
        episodeCount: null,
        genres: ['Action'],
      }),
    ).toBe('TV-MA · Action');
  });

  it('gives a series no length at all, since neither number it holds is one', () => {
    // Reachable only through `watchlist_added`: `set_watchlist` is the one collection
    // write that accepts a whole show.
    expect(
      activityMetadata({
        kind: 'series',
        certification: 'TV-MA',
        runtimeMinutes: 50,
        genres: ['Drama', 'Thriller', 'Mystery'],
      }),
    ).toBe('TV-MA · Drama · Thriller');
  });

  it('stops at two genres, because the line is the subordinate one on the row', () => {
    expect(
      activityMetadata({
        kind: 'movie',
        certification: 'R',
        runtimeMinutes: 139,
        genres: ['Drama', 'Thriller', 'Crime', 'Mystery'],
      }),
    ).toBe('R · 139m · Drama · Thriller');
  });

  it('drops a missing part with its separator rather than naming the absence', () => {
    // `Unknown · 148m` and a leading `· ` are both explicitly out. An absent rating is
    // an absent segment.
    expect(
      activityMetadata({
        kind: 'movie',
        certification: null,
        runtimeMinutes: 148,
        genres: ['Science Fiction', 'Adventure'],
      }),
    ).toBe('148m · Science Fiction · Adventure');

    expect(
      activityMetadata({
        kind: 'movie',
        certification: 'PG-13',
        runtimeMinutes: null,
        genres: ['Science Fiction'],
      }),
    ).toBe('PG-13 · Science Fiction');

    expect(
      activityMetadata({ kind: 'movie', certification: 'PG-13', runtimeMinutes: null, genres: [] }),
    ).toBe('PG-13');
  });

  it('never emits a malformed separator, whichever parts are missing', () => {
    const shapes = [
      { certification: null, runtimeMinutes: null, genres: ['Drama'] },
      { certification: 'R', runtimeMinutes: null, genres: [] },
      { certification: null, runtimeMinutes: 100, genres: [] },
      { certification: null, runtimeMinutes: null, genres: ['A', 'B'] },
    ];
    for (const shape of shapes) {
      const line = activityMetadata({ kind: 'movie', ...shape }) as string;
      expect(line).not.toMatch(/^\s*·/);
      expect(line).not.toMatch(/·\s*$/);
      expect(line).not.toMatch(/·\s*·/);
      expect(line).not.toMatch(/Unknown|null|undefined|NaN/);
    }
  });

  it('renders nothing at all rather than an empty line', () => {
    expect(
      activityMetadata({ kind: 'movie', certification: null, runtimeMinutes: null, genres: [] }),
    ).toBeNull();
    expect(activityMetadata({ kind: null })).toBeNull();
  });

  it('treats zero episodes as unaired rather than as a fact about the show', () => {
    expect(
      activityMetadata({ kind: 'season', certification: 'TV-14', episodeCount: 0, genres: [] }),
    ).toBe('TV-14');
    // One reads as one.
    expect(
      activityMetadata({ kind: 'season', certification: null, episodeCount: 1, genres: [] }),
    ).toBe('1 episode');
  });
});
