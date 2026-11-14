import type { LoggedEntry, RankedEntry } from './use-collection';
import { sortItems } from './filters';
import { filterByMedium, mergeWatched, watchedItems } from './watched-rows';

/**
 * "Encountered two children with the same key."
 *
 * The Collection list is two independently cached queries stitched together, and they
 * are only eventually consistent. Ranking a title invalidates both; whichever refetch
 * lands first is fresh while the other is still stale, and in that window the title is
 * in the ranked list *and* still in the stale unranked list. It rendered twice.
 *
 * These tests are written as that window, because that is the state the bug lives in —
 * not as "does the merge concatenate two disjoint lists", which was never in doubt.
 */

const ranked = (over: Partial<RankedEntry> = {}): RankedEntry => ({
  mediaItemId: 'film-1',
  title: 'Heat',
  year: 1995,
  posterPath: null,
  genres: ['Crime'],
  runtimeMinutes: 170,
  kind: 'movie',
  seriesTitle: null,
  seriesId: null,
  language: null,
  bucket: 'loved',
  position: 1,
  category: 'movies',
  rankedAt: '2026-08-01T00:00:00Z',
  ...over,
});

const logged = (over: Partial<LoggedEntry> = {}): LoggedEntry => ({
  mediaItemId: 'film-2',
  title: 'Sinners',
  year: 2025,
  posterPath: null,
  genres: ['Horror'],
  runtimeMinutes: 137,
  kind: 'movie',
  seriesTitle: null,
  language: null,
  bucket: null,
  watchedOn: null,
  addedAt: '2026-08-01T00:00:00Z',
  ...over,
});

const ids = (rows: { mediaItemId: string }[]) => rows.map((row) => row.mediaItemId);

describe('the window where the two queries disagree', () => {
  it('renders a just-ranked title once, not twice', () => {
    // The ranked query has caught up; the logged query has not, so it still lists
    // the title as unranked. This is the exact state that produced the warning.
    const rows = mergeWatched(
      [ranked()],
      [logged({ mediaItemId: 'film-1', title: 'Heat' })],
      'movies',
    );

    expect(ids(rows)).toEqual(['film-1']);
  });

  it('shows it with its score rather than waiting for the slower query', () => {
    // The ranked entry wins because it is the more advanced state. Taking the
    // unranked copy would show a dashed badge on a title that plainly has a score.
    const rows = mergeWatched([ranked()], [logged({ mediaItemId: 'film-1' })], 'movies');

    expect(rows[0]?.score).toBe(10);
    expect(rows[0]?.bucket).toBe('loved');
  });

  it('produces keys that are unique, which is what the list actually needs', () => {
    const rows = mergeWatched(
      [ranked({ mediaItemId: 'a' }), ranked({ mediaItemId: 'b', position: 2 })],
      [logged({ mediaItemId: 'a' }), logged({ mediaItemId: 'c' })],
      'movies',
    );

    expect(new Set(ids(rows)).size).toBe(rows.length);
    expect(ids(rows)).toEqual(['a', 'b', 'c']);
  });

  it('survives the reverse staleness, where the logged query is the fresh one', () => {
    // A title unranked just now: the ranked list is stale and still has it. It still
    // appears once, and it keeps the ranked reading until the other query lands.
    const rows = mergeWatched([ranked()], [], 'movies');
    expect(ids(rows)).toEqual(['film-1']);
  });
});

describe('ordinary shaping', () => {
  it('puts ranked titles first, in the order the query returned', () => {
    const rows = mergeWatched(
      [ranked({ mediaItemId: 'a', position: 1 }), ranked({ mediaItemId: 'b', position: 2 })],
      [logged({ mediaItemId: 'c' })],
      'movies',
    );

    expect(ids(rows)).toEqual(['a', 'b', 'c']);
    expect(rows[2]?.score).toBeNull();
  });

  it('scores against the whole band, not against the rows on screen', () => {
    // Two loved titles: the top takes the band high and the bottom the band low.
    // Scoring the visible slice against itself would give both a 10.
    const rows = mergeWatched(
      [ranked({ mediaItemId: 'a', position: 1 }), ranked({ mediaItemId: 'b', position: 2 })],
      [],
      'movies',
    );

    expect(rows[0]?.score).toBe(10);
    expect(rows[1]?.score).toBe(7);
  });

  it('keeps the unranked side to the medium being shown', () => {
    const rows = mergeWatched(
      [],
      [
        logged({ mediaItemId: 'film', kind: 'movie' }),
        logged({ mediaItemId: 'season', kind: 'season' }),
      ],
      'movies',
    );

    expect(ids(rows)).toEqual(['film']);
  });

  it('carries a ranked season’s show name through', () => {
    const rows = mergeWatched(
      [
        ranked({
          mediaItemId: 's2',
          title: 'Season 2',
          kind: 'season',
          seriesTitle: 'Parks and Recreation',
          category: 'tv_seasons',
        }),
      ],
      [],
      'tv_seasons',
    );

    expect(rows[0]?.seriesTitle).toBe('Parks and Recreation');
  });
});

describe('filterByMedium', () => {
  it('counts a series and its seasons as TV', () => {
    const entries = [
      { kind: 'movie' as const, mediaItemId: 'a' },
      { kind: 'season' as const, mediaItemId: 'b' },
      { kind: 'series' as const, mediaItemId: 'c' },
    ];

    expect(ids(filterByMedium(entries, 'movies'))).toEqual(['a']);
    expect(ids(filterByMedium(entries, 'tv_seasons'))).toEqual(['b', 'c']);
  });
});

/**
 * **The founder's photograph, at its source.**
 *
 * The Collection chip said *Recently watched* and the wall was in rating order. The
 * cause was not the label and not the comparator: `watchedItems` read a ranked title's
 * collection facts out of a map built from its second argument, and its one caller
 * passed the *unranked* list — which by construction contains no ranked title. So every
 * ranked row arrived with a null date, the recency comparator answered 0 for every pair,
 * and the rows kept the order they came in, which is score order.
 *
 * These pin the fix at the level it happened: the facts have to be *on the rows*. A
 * truthful label over dateless rows would have been a different lie.
 */
describe('a ranked title carries its collection facts', () => {
  const heat = ranked({ mediaItemId: 'film-1', title: 'Heat', position: 1 });

  it('finds the watch date and the collection timestamp of a ranked title', () => {
    const items = watchedItems(
      [heat],
      [
        logged({
          mediaItemId: 'film-1',
          watchedOn: '2011-06-02',
          addedAt: '2026-08-30T09:00:00Z',
        }),
      ],
      'movies',
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.watchedOn).toBe('2011-06-02');
    expect(items[0]?.addedAt).toBe('2026-08-30T09:00:00Z');
  });

  it('does not duplicate a title that is both ranked and logged', () => {
    // The whole logged collection now goes in, so the dedup that used to be implicit in
    // the caller's `unranked` slice has to hold here — and it does, on `seen`.
    const items = watchedItems(
      [heat],
      [logged({ mediaItemId: 'film-1' }), logged({ mediaItemId: 'film-2' })],
      'movies',
    );

    expect(ids(items)).toEqual(['film-1', 'film-2']);
  });

  it('still appends the logged titles that have no ranking', () => {
    const items = watchedItems([heat], [logged({ mediaItemId: 'film-9' })], 'movies');

    expect(ids(items)).toEqual(['film-1', 'film-9']);
    expect(items[1]?.score).toBeNull();
  });

  it('still keeps the other medium out', () => {
    const items = watchedItems(
      [heat],
      [logged({ mediaItemId: 'season-1', kind: 'season' })],
      'movies',
    );

    expect(ids(items)).toEqual(['film-1']);
  });

  it('leaves the facts null when the logged read has not landed yet', () => {
    // The two queries settle independently. A ranked row with no collection row in hand
    // is honest about it rather than inventing a date — and `compareItems` sinks it.
    const items = watchedItems([heat], [], 'movies');

    expect(items[0]?.watchedOn).toBeNull();
    expect(items[0]?.addedAt).toBeNull();
  });

  /**
   * The end-to-end shape of the defect: rows that arrive in rating order must not stay
   * in rating order under a Recently-added sort.
   */
  it('orders by collection time rather than by the order the queries returned', () => {
    const items = watchedItems(
      [
        ranked({ mediaItemId: 'best', title: 'Best', position: 1 }),
        ranked({ mediaItemId: 'worst', title: 'Worst', position: 2 }),
      ],
      [
        logged({ mediaItemId: 'best', addedAt: '2020-01-01T00:00:00Z' }),
        logged({ mediaItemId: 'worst', addedAt: '2026-01-01T00:00:00Z' }),
      ],
      'movies',
    );

    // As merged: rating order, best first — the order the old code left standing.
    expect(ids(items)).toEqual(['best', 'worst']);
    // Sorted by when they were added: the later addition leads, whatever it scored.
    expect(ids(sortItems(items, { axis: 'added', direction: 'desc' }))).toEqual([
      'worst',
      'best',
    ]);
    expect(ids(sortItems(items, { axis: 'added', direction: 'asc' }))).toEqual([
      'best',
      'worst',
    ]);
  });
});

/**
 * **Candidate A** (founder brief §4, 2026-11-14): TV is two rankings, seasons and whole
 * shows, drawn as one flat grid. A show stands for itself only while none of its seasons is
 * ranked, and every row is scored against its own pool's bands.
 */
describe('TV seasons and whole shows in one collection', () => {
  const show = (id: string, over: Partial<RankedEntry> = {}) =>
    ranked({
      mediaItemId: id,
      title: id,
      kind: 'series',
      category: 'tv_shows',
      runtimeMinutes: null,
      ...over,
    });
  const season = (id: string, seriesId: string, n: number, over: Partial<RankedEntry> = {}) =>
    ranked({
      mediaItemId: id,
      title: `Season ${n}`,
      kind: 'season',
      category: 'tv_seasons',
      seriesId,
      seriesTitle: seriesId,
      seasonNumber: n,
      runtimeMinutes: null,
      ...over,
    });
  const tv = (seasons: RankedEntry[], shows: RankedEntry[], log: LoggedEntry[] = []) =>
    watchedItems(seasons, log, 'tv_seasons', shows);

  /**
   * **One poster per series** (WS-TVC, founder spec t168u §2, replacing Candidate A). The
   * poster is the series, its score the explicit show ranking or else the mean of the
   * ranked seasons; seasons are never posters here.
   */
  it('draws the show alone when only the show is ranked', () => {
    const items = tv([], [show('shameless')]);
    expect(ids(items)).toEqual(['shameless']);
    expect(items[0]).toMatchObject({
      kind: 'series',
      score: 10,
      category: 'tv_shows',
      showScore: { source: 'explicit', n: 1, sumTenths: 100 },
    });
  });

  it('draws the series, not S1, when only S1 is ranked', () => {
    const items = tv([season('s1', 'shameless', 1)], []);
    expect(ids(items)).toEqual(['shameless']);
    expect(items[0]).toMatchObject({
      kind: 'series',
      title: 'shameless',
      score: 10,
      showScore: { source: 'average', n: 1, rankedSeasonCount: 1 },
    });
  });

  it('draws one poster for S1 and S2, at their mean', () => {
    const items = tv(
      [season('s1', 'shameless', 1), season('s2', 'shameless', 2, { position: 2 })],
      [],
    );
    expect(ids(items)).toEqual(['shameless']);
    // 10.0 and 7.0 in a loved band of two.
    expect(items[0]).toMatchObject({ score: 8.5, showScore: { source: 'average', n: 2 } });
  });

  it('draws one poster at the explicit score when the show and a season are both ranked', () => {
    const items = tv(
      [season('s1', 'shameless', 1), season('s2', 'shameless', 2, { position: 2 })],
      [show('shameless', { bucket: 'fine' })],
    );
    expect(ids(items)).toEqual(['shameless']);
    expect(items[0]).toMatchObject({
      score: 6.9,
      showScore: { source: 'explicit', rankedSeasonCount: 2 },
    });
  });

  it('draws every series once, however many seasons each has', () => {
    const items = tv(
      [
        season('s4', 'shameless', 4),
        season('s5', 'shameless', 5, { position: 2 }),
        season('s10', 'shameless', 10, { position: 3 }),
        season('b1', 'barry', 1, { position: 4 }),
      ],
      [show('shameless'), show('other', { position: 2 })],
    );
    expect(ids(items).sort()).toEqual(['barry', 'other', 'shameless']);
  });

  it('absorbs the logged show and its logged seasons into the ranked poster', () => {
    const items = tv(
      [season('s1', 'shameless', 1)],
      [],
      [
        logged({ mediaItemId: 'shameless', kind: 'series', title: 'Shameless', bucket: 'loved' }),
        logged({ mediaItemId: 's1', kind: 'season', seriesId: 'shameless', bucket: 'loved' }),
        logged({ mediaItemId: 's2', kind: 'season', seriesId: 'shameless', bucket: null }),
      ],
    );
    expect(ids(items)).toEqual(['shameless']);
  });

  it('draws one unranked poster per series for logged TV nobody ranked', () => {
    const items = tv(
      [],
      [],
      [
        logged({
          mediaItemId: 'x2',
          kind: 'season',
          seriesId: 'x',
          seriesTitle: 'Show X',
          seasonNumber: 2,
          watchedOn: '2026-03-01',
        }),
        logged({
          mediaItemId: 'x1',
          kind: 'season',
          seriesId: 'x',
          seriesTitle: 'Show X',
          seasonNumber: 1,
          watchedOn: '2026-05-01',
        }),
      ],
    );
    expect(ids(items)).toEqual(['x']);
    expect(items[0]).toMatchObject({
      kind: 'series',
      title: 'Show X',
      score: null,
      // The series' latest watch, whichever season it was.
      watchedOn: '2026-05-01',
      unfinished: false,
    });
  });

  it('scores each pool against its own bands, never pooled', () => {
    // Two loved seasons of `a` and one loved show `b`. Pooled, the show would share a band
    // of three and score below 10; on its own it is a band of one and scores the high.
    const items = tv(
      [season('s1', 'a', 1), season('s2', 'a', 2, { position: 2 })],
      [show('b')],
    );
    const by = new Map(items.map((item) => [item.mediaItemId, item.score]));
    expect(by.get('b')).toBe(10);
    expect(by.get('a')).toBe(8.5);
  });

  it('puts no artificial score on a show nobody ranked', () => {
    const items = tv([], [], [logged({ mediaItemId: 'a', kind: 'series', bucket: null })]);
    expect(items[0]).toMatchObject({ mediaItemId: 'a', score: null });
    expect(items[0]?.showScore ?? null).toBeNull();
  });

  it('orders by the exact effective score, then explicit before average, in both directions', () => {
    // `a` averages 10.0 and 7.0 = 8.5 exactly; `b` is an explicit show in a loved band of
    // three at rank 2 = 8.5. Equal, so the explicit show leads either way.
    const items = tv(
      [season('a1', 'a', 1), season('a2', 'a', 2, { position: 2 })],
      [show('x'), show('b', { position: 2 }), show('y', { position: 3 })],
    );
    const desc = ids(sortItems(items, { axis: 'rating', direction: 'desc' }));
    expect(desc.indexOf('b')).toBeLessThan(desc.indexOf('a'));
    const asc = ids(sortItems(items, { axis: 'rating', direction: 'asc' }));
    expect(asc.indexOf('b')).toBeLessThan(asc.indexOf('a'));
  });

  it('keeps Movies to films, and gives Movies no shows even if some are passed', () => {
    const items = watchedItems([ranked()], [], 'movies');
    expect(ids(items)).toEqual(['film-1']);
  });
});
