import { SEASON_LIST_MAX_AGE_MS, seasonListIsStale } from './use-enrichment';

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
