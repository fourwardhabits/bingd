import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { SEASON_LIST_MAX_AGE_MS, seasonListIsStale, useTitleEnrichment } from './use-enrichment';
import { useSeasonEpisodes } from './use-season-episodes';

// The adapter is the boundary these tests are about: what an enrichment brings back,
// and what — if anything — the Episodes tab has to ask for afterwards.
const mockEnrichTitle = jest.fn();
const mockFetchSeasonEpisodes = jest.fn();

jest.mock('@/lib/tmdb-adapter', () => ({
  enrichTitle: (...args: unknown[]) => mockEnrichTitle(...args),
  fetchSeasonEpisodes: (...args: unknown[]) => mockFetchSeasonEpisodes(...args),
}));

/**
 * When a series' season list is worth reading again.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT THIS FILE PINS
 *
 * Founder acceptance, 2026-08-30: a series showing fewer seasons than it has. Tracing it
 * found that a season list is written exactly once — by whichever enrichment first
 * reaches the series — and then never revisited. The client's own gate was "this series
 * has no seasons at all", and `media_refresh_due`, which exists for the general version
 * of the problem, is drained by no schedule. So a show that gained a season after
 * somebody first opened it stayed short of it permanently.
 *
 * (The particular show in the report is not one of those: TMDB publishes JUJUTSU KAISEN
 * as a single 59-episode Season 1 and has no Season 2 under `/tv/95479`, so no ingestion
 * rule can produce one. The defect underneath it is real and is what this asserts.)
 *
 * The signal is the **newest** `fetched_at` across the season rows, which independent
 * review 77 corrected from the oldest. The oldest reads better as semantics and does not
 * terminate: `tmdb_upsert_seasons` writes the seasons the provider named and is silent
 * about the rest, so a season TMDB has since dropped keeps its old timestamp forever, the
 * minimum never moves, and every open of that series spends a request that cannot change
 * anything. The fourth test below is that scenario.
 */

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('seasonListIsStale', () => {
  it('is false for a list written inside the window', () => {
    expect(seasonListIsStale([{ fetched_at: at(DAY) }, { fetched_at: at(2 * DAY) }])).toBe(false);
  });

  it('is true once the list is past the window', () => {
    expect(seasonListIsStale([{ fetched_at: at(SEASON_LIST_MAX_AGE_MS + 1000) }])).toBe(true);
  });

  it('is false for a series with no seasons at all', () => {
    // That is the other gate's question — `hasNoSeasons` — and answering it here as well
    // would make one mount ask the provider twice.
    expect(seasonListIsStale([])).toBe(false);
  });

  it('reads the newest row, so a list that has just been written is not asked for again', () => {
    // Review 77's scenario, and the reason this is the newest rather than the oldest. The
    // first row is a season the provider has stopped naming, so nothing will ever move
    // its timestamp — reading the minimum would make this series permanently stale and
    // spend one provider request on every single open of it, forever, to no effect.
    const seasons = [
      { fetched_at: at(300 * DAY) }, // dropped from the provider's answer long ago
      { fetched_at: at(1000) }, // written a moment ago by the latest read
    ];
    expect(seasonListIsStale(seasons)).toBe(false);
  });

  it('is stale when every row is old, which is the case the founder met', () => {
    const seasons = [{ fetched_at: at(30 * DAY) }, { fetched_at: at(31 * DAY) }];
    expect(seasonListIsStale(seasons)).toBe(true);
  });

  it('treats a missing or unreadable timestamp as stale', () => {
    // Asking once more is one provider request. A rule that quietly stopped asking is
    // the defect being replaced.
    expect(seasonListIsStale([{ fetched_at: null }])).toBe(true);
    expect(seasonListIsStale([{ fetched_at: 'not a date' }])).toBe(true);
    expect(seasonListIsStale([{}])).toBe(true);
  });

  it('takes the clock as an argument, so the window is testable at its edge', () => {
    const written = Date.parse('2026-08-01T00:00:00.000Z');
    const seasons = [{ fetched_at: '2026-08-01T00:00:00.000Z' }];
    expect(seasonListIsStale(seasons, written + SEASON_LIST_MAX_AGE_MS)).toBe(false);
    expect(seasonListIsStale(seasons, written + SEASON_LIST_MAX_AGE_MS + 1)).toBe(true);
  });

  it('is a week, and not the 150-day descriptive window', () => {
    // `tmdb.metadata_max_age_days` governs a poster, an overview and a genre list, which
    // are stable for months. A season list is the one field on a series that grows, and
    // judging it by the descriptive window would leave a show that gained a season in
    // September still short of it in February.
    expect(SEASON_LIST_MAX_AGE_MS).toBe(7 * DAY);
  });
});

/**
 * Seeding the Episodes tab out of the enrichment that was happening anyway.
 *
 * The whole economics of the Episodes tab is here. A season page enriches on mount,
 * that enrichment reads `/tv/{series}/season/{n}`, and the adapter now returns the
 * episodes it used to count and discard. Writing them into the cache is what makes
 * opening the tab cost nothing; the tab's own fetch is a fallback that should almost
 * never run.
 *
 * These are the two failure modes worth pinning: seeding silently not happening, and
 * the fallback racing the seed and spending a second provider request for the same
 * data.
 */
describe('a season enrichment and the Episodes cache', () => {
  const EPISODES = [
    {
      episode_number: 1,
      title: 'Winter Is Coming',
      air_date: '2011-04-17',
      runtime_minutes: 62,
      still_path: '/still1.jpg',
      overview: 'Lord Eddard Stark is troubled by reports.',
    },
  ];

  const season = {
    id: 'season-1',
    kind: 'season' as const,
    tmdb_id: null,
    poster_path: null,
    overview: null,
    runtime_minutes: null,
  };

  beforeEach(() => {
    mockEnrichTitle.mockReset();
    mockFetchSeasonEpisodes.mockReset();
    mockFetchSeasonEpisodes.mockResolvedValue([]);
  });

  it('writes the episodes the detail response carried straight into the cache', async () => {
    mockEnrichTitle.mockResolvedValue({ enriched: true, episodes: EPISODES });

    // Read through the tab's own hook rather than off the client, and disabled,
    // which is the state a season page is in before the reader looks at Episodes.
    // A disabled query still serves what the cache holds, which is the whole point.
    const { result } = await renderHookWithProviders(() => {
      useTitleEnrichment(season);
      return useSeasonEpisodes('season-1', false);
    });

    await waitFor(() => expect(result.current.data).toEqual(EPISODES));
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });

  it('serves a tab opened later out of the seed, without going back to the provider', async () => {
    // The ordinary journey, one step apart from the race below: the page settles, and
    // some seconds later the reader opens Episodes. `setQueryData` leaves the entry
    // fresh for an hour, so enabling the query finds an answer rather than a gap.
    // `invalidateQueries` here would have marked it stale and sent the tab to
    // re-fetch data it was already holding.
    mockEnrichTitle.mockResolvedValue({ enriched: true, episodes: EPISODES });

    let tabIsOpen = false;
    const { result, rerender } = await renderHookWithProviders(() => {
      const { enriching } = useTitleEnrichment(season);
      return useSeasonEpisodes('season-1', tabIsOpen && !enriching);
    });

    await waitFor(() => expect(result.current.data).toEqual(EPISODES));

    tabIsOpen = true;
    await rerender({});

    expect(result.current.data).toEqual(EPISODES);
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });

  it('does not race the seed with a second request for the same episodes', async () => {
    // The gate this exists for. `useSeasonEpisodes` is enabled only while no
    // enrichment is running, and `enriching` has to be true on the very first render
    // for that to hold — one render claiming otherwise is enough for the tab to fire
    // a request alongside the enrichment that was about to seed it.
    mockEnrichTitle.mockResolvedValue({ enriched: true, episodes: EPISODES });

    const { result } = await renderHookWithProviders(() => {
      const { enriching } = useTitleEnrichment(season);
      const episodes = useSeasonEpisodes('season-1', !enriching);
      return { enriching, episodes };
    });

    await waitFor(() => expect(result.current.episodes.data).toEqual(EPISODES));
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });

  it('leaves the cache alone for a film, which has no episodes to send', async () => {
    mockEnrichTitle.mockResolvedValue({ enriched: true });

    const { client } = await renderHookWithProviders(() =>
      useTitleEnrichment({ ...season, id: 'film-1', kind: 'movie', tmdb_id: 27205 }),
    );

    await waitFor(() => expect(mockEnrichTitle).toHaveBeenCalledWith('film-1'));
    expect(client.getQueryData(['episodes', 'film-1'])).toBeUndefined();
  });

  it('seeds nothing when the adapter has not been redeployed yet', async () => {
    // A deployed function that predates this feature answers `{ enriched: true }` and
    // no episodes. Guarding on the array rather than on the title's kind is what
    // makes that a fallback rather than a crash or an empty tab.
    mockEnrichTitle.mockResolvedValue({ enriched: true });

    const { client } = await renderHookWithProviders(() => useTitleEnrichment(season));

    await waitFor(() => expect(mockEnrichTitle).toHaveBeenCalledWith('season-1'));
    expect(client.getQueryData(['episodes', 'season-1'])).toBeUndefined();
  });

  it('lets the fallback run once a failed enrichment has settled', async () => {
    // Enrichment fails silently by design, so the tab must not stay gated behind it.
    // `enriching` has to go false on rejection as well as on success.
    mockEnrichTitle.mockRejectedValue(new Error('BG502'));
    mockFetchSeasonEpisodes.mockResolvedValue(EPISODES);

    const { result } = await renderHookWithProviders(() => {
      const { enriching } = useTitleEnrichment(season);
      const episodes = useSeasonEpisodes('season-1', !enriching);
      return { enriching, episodes };
    });

    await waitFor(() => expect(result.current.enriching).toBe(false));
    await waitFor(() => expect(result.current.episodes.data).toEqual(EPISODES));
    expect(mockFetchSeasonEpisodes).toHaveBeenCalledWith('season-1');
  });

  it('stops enriching even when the effect was superseded mid-request', async () => {
    // The gate's one way to jam. An effect re-run cancels the request in flight, and
    // the re-run then finds the id already attempted and does nothing — so if the
    // attempt is only marked finished when it was not cancelled, nothing ever marks
    // it, `enriching` stays true for good, and the Episodes tab sits behind a
    // permanent skeleton waiting on a request that finished long ago.
    let finish: (value: unknown) => void = () => {};
    mockEnrichTitle.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    // Not thin, so `needed` is driven entirely by the second argument and can be made
    // to flip while the request is open. A season is always thin and cannot.
    const complete = {
      id: 'film-9',
      kind: 'movie' as const,
      tmdb_id: 27205,
      poster_path: '/p.jpg',
      overview: 'Something.',
      runtime_minutes: 148,
    };

    let alsoWhen = true;
    const { result, rerender } = await renderHookWithProviders(() =>
      useTitleEnrichment(complete, alsoWhen),
    );

    expect(result.current.enriching).toBe(true);
    expect(mockEnrichTitle).toHaveBeenCalledTimes(1);

    alsoWhen = false;
    await rerender({});
    alsoWhen = true;
    await rerender({});

    // Still exactly one request: `attempted` is doing its job.
    expect(mockEnrichTitle).toHaveBeenCalledTimes(1);

    finish({ enriched: true });

    await waitFor(() => expect(result.current.enriching).toBe(false));
  });

  it('reports that it is enriching for as long as the request is in flight', async () => {
    // The property the gate depends on, asserted on its own so a refactor back to a
    // `useState(false)` that the effect flips fails here rather than silently
    // doubling the provider requests a season page makes.
    //
    // The enrichment is held open deliberately. A resolved promise settles inside the
    // `act` that renders the hook, so every observable state would already be the
    // final one and there would be nothing to assert about the window in between.
    let finish: (value: unknown) => void = () => {};
    mockEnrichTitle.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const { result } = await renderHookWithProviders(() => {
      const { enriching } = useTitleEnrichment(season);
      return { enriching, episodes: useSeasonEpisodes('season-1', !enriching) };
    });

    expect(result.current.enriching).toBe(true);
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();

    finish({ enriched: true, episodes: EPISODES });

    await waitFor(() => expect(result.current.enriching).toBe(false));
    expect(result.current.episodes.data).toEqual(EPISODES);
    expect(mockFetchSeasonEpisodes).not.toHaveBeenCalled();
  });
});
