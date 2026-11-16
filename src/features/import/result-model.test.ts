import {
  alreadyHere,
  alreadyInBingd,
  bucketTotal,
  importedTitles,
  resultHeadline,
  resultModel,
  resultSummary,
  somethingArrived,
} from './result-model';

/**
 * `resultModel` (IMP1113-UI §D, I3): the server's counts renamed into the results' buckets,
 * with a missing key meaning unknown rather than zero.
 */
describe('resultModel', () => {
  it('maps a first IMDb import one key to one bucket', () => {
    const model = resultModel(
      {
        watched: 3,
        kept: 1,
        already: 0,
        unsupported: 2,
        unsupported_tv: 1,
        unsupported_episode: 1,
        unmatched: 1,
        ambiguous: 0,
        stragglers: 0,
        duplicate: 0,
        failed: 0,
        watchlist: 0,
        viewings: 0,
      },
      'imdb',
    );
    expect(model).toEqual({
      newlyAdded: 3,
      previouslyImported: 0,
      alreadyPresent: 1,
      watchlistAdded: undefined,
      diaryKept: undefined,
      matchedExcluded: 1,
      unsupportedEpisode: 1,
      unsupportedOther: 0,
      unmatched: 1,
      duplicate: 0,
      failed: 0,
    });
    expect(bucketTotal(model)).toBe(7);
    expect(resultHeadline(model, 'imdb')).toBe('Import complete');
  });

  it('maps a re-import: nothing new, the earlier import’s titles as previouslyImported', () => {
    const model = resultModel(
      {
        watched: 0,
        already: 3,
        kept: 1,
        unsupported: 2,
        unsupported_tv: 1,
        unsupported_episode: 1,
        unmatched: 1,
      },
      'imdb',
    );
    expect(model.newlyAdded).toBe(0);
    expect(model.previouslyImported).toBe(3);
    expect(importedTitles(model)).toBe(3);
    expect(somethingArrived(model)).toBe(false);
    expect(alreadyHere(model)).toBe(true);
    expect(resultHeadline(model, 'imdb')).toBe('Import complete');
    // Founder QA, 2026-11-16: the earlier import's three are already in bingd, not imported.
    expect(alreadyInBingd(model)).toBe((model.alreadyPresent ?? 0) + 3);
    expect(resultSummary(model)).toBe(
      'No new movies were added. Your existing titles are already in bingd.',
    );
    expect(bucketTotal(model)).toBe(7);
  });

  it('keeps a mixed import’s buckets apart, and other kinds as the remainder', () => {
    const model = resultModel(
      {
        watched: 640,
        kept: 12,
        already: 3,
        duplicate: 1,
        unmatched: 6,
        ambiguous: 2,
        stragglers: 1,
        unsupported: 148,
        unsupported_tv: 139,
        unsupported_episode: 7,
        failed: 1,
      },
      'imdb',
    );
    expect(model.unmatched).toBe(9);
    expect(model.unsupportedOther).toBe(2);
    expect(model.matchedExcluded).toBe(139);
    expect(model.failed).toBe(1);
    expect(bucketTotal(model)).toBe(640 + 12 + 3 + 1 + 9 + 148 + 1);
  });

  it('an all-unmatched import headlines nothing new', () => {
    const model = resultModel({ watched: 0, kept: 0, already: 0, unmatched: 4 }, 'imdb');
    expect(resultSummary(model)).toBe('No new movies were added.');
    expect(resultSummary(resultModel({ watched: 0, unmatched: 4 }, 'letterboxd'))).toBe(
      'No new movies were added.',
    );
  });

  it('never folds failed into another bucket', () => {
    const model = resultModel({ watched: 2, failed: 3 }, 'imdb');
    expect(model.failed).toBe(3);
    expect(model.newlyAdded).toBe(2);
    expect(importedTitles(model)).toBe(2);
    expect(model.unmatched).toBeUndefined();
  });

  it('calls a key an old job never counted unknown, never 0', () => {
    // A Letterboxd job from before stragglers and before 20261113000100.
    const model = resultModel({ watched: 19, watchlist: 2 }, 'letterboxd');
    expect(model.alreadyPresent).toBeUndefined();
    expect(model.previouslyImported).toBeUndefined();
    expect(model.matchedExcluded).toBeUndefined();
    expect(model.unsupportedEpisode).toBeUndefined();
    expect(model.unsupportedOther).toBeUndefined();
    expect(model.unmatched).toBeUndefined();
    expect(model.failed).toBeUndefined();
    expect(model.diaryKept).toBeUndefined();
    // A composite with some parts present is the sum of what that job counted.
    expect(resultModel({ unmatched: 2 }, 'letterboxd').unmatched).toBe(2);
    expect(resultModel({}, 'imdb')).toEqual(
      Object.fromEntries(Object.keys(resultModel({}, 'imdb')).map((k) => [k, undefined])),
    );
  });

  it('reads a Letterboxd job’s watchlist and diary, and an IMDb job’s never', () => {
    const counts = { watched: 1, watchlist: 4, viewings: 6 };
    expect(resultModel(counts, 'letterboxd')).toMatchObject({
      watchlistAdded: 4,
      diaryKept: 6,
    });
    expect(resultModel(counts, 'imdb')).toMatchObject({
      watchlistAdded: undefined,
      diaryKept: undefined,
    });
    // A watchlist addition alone is something arriving.
    const watchlistOnly = resultModel({ watched: 0, watchlist: 2 }, 'letterboxd');
    expect(resultSummary(watchlistOnly)).toBe('2 movies added to your watchlist.');
  });

  it('never counts a matched TV show as imported or unmatched', () => {
    const model = resultModel({ watched: 0, unsupported: 5, unsupported_tv: 5 }, 'imdb');
    expect(model.matchedExcluded).toBe(5);
    expect(importedTitles(model)).toBe(0);
    expect(model.unmatched).toBeUndefined();
    expect(model.unsupportedOther).toBe(0);
    expect(resultSummary(model)).toBe('No new movies were added.');
  });

  it('says what happened in one line, one heading for every finish (founder QA, 2026-11-16)', () => {
    const cases = [
      [{ watched: 1, kept: 5, already: 5 }, '1 movie added to bingd.'],
      [{ watched: 3 }, '3 movies added to bingd.'],
      [
        { watched: 0, kept: 5 },
        'No new movies were added. Your existing titles are already in bingd.',
      ],
      [
        { watched: 0, already: 5 },
        'No new movies were added. Your existing titles are already in bingd.',
      ],
      [{ watched: 0 }, 'No new movies were added.'],
    ] as const;
    for (const provider of ['imdb', 'letterboxd'] as const) {
      for (const [counts, expected] of cases) {
        const model = resultModel(counts, provider);
        expect(resultHeadline(model, provider)).toBe('Import complete');
        expect(resultSummary(model)).toBe(expected);
      }
    }
  });

  /**
   * **The founder's repeat IMDb import** (Android, 2026-11-15): one title already ranked
   * here (`kept`), three an earlier import added (`already`), one unmatched. It read
   * "Already in bingd 1 · Imported movies 3"; nothing was imported.
   */
  it('counts a repeat import as nothing new and everything already in bingd', () => {
    const model = resultModel(
      {
        watched: 0,
        kept: 1,
        already: 3,
        unmatched: 1,
        unsupported: 2,
        unsupported_tv: 1,
        unsupported_episode: 1,
      },
      'imdb',
    );
    expect(model.newlyAdded).toBe(0);
    expect(alreadyInBingd(model)).toBe(4);
    expect(model.unmatched).toBe(1);
    // Still rankable: the earlier import's three are unranked titles in the collection.
    expect(importedTitles(model)).toBe(3);
    // Every row in exactly one bucket: 0 + 4 + 1 + 2 recognised kinds = the file's 7 rows.
    expect(bucketTotal(model)).toBe(7);
  });

  it('counts a mixed file once: new titles new, the rest already in bingd', () => {
    const model = resultModel(
      { watched: 2, kept: 1, already: 1, duplicate: 1, unmatched: 1 },
      'imdb',
    );
    expect(model.newlyAdded).toBe(2);
    expect(alreadyInBingd(model)).toBe(2);
    expect(model.duplicate).toBe(1);
    expect(resultSummary(model)).toBe('2 movies added to bingd.');
    expect(bucketTotal(model)).toBe(2 + 2 + 1 + 1);
  });
});
