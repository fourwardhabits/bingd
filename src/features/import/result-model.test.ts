import {
  alreadyHere,
  bucketTotal,
  importedTitles,
  resultHeadline,
  resultModel,
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
    expect(resultHeadline(model, 'imdb')).toBe('Your IMDb history is in');
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
    expect(resultHeadline(model, 'imdb')).toBe('Your IMDb history is already here');
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
    expect(resultHeadline(model, 'imdb')).toBe('Nothing new came in');
    expect(
      resultHeadline(resultModel({ watched: 0, unmatched: 4 }, 'letterboxd'), 'letterboxd'),
    ).toBe('Nothing new came in');
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
    expect(resultHeadline(watchlistOnly, 'letterboxd')).toBe('Your Letterboxd history is in');
  });

  it('never counts a matched TV show as imported or unmatched', () => {
    const model = resultModel({ watched: 0, unsupported: 5, unsupported_tv: 5 }, 'imdb');
    expect(model.matchedExcluded).toBe(5);
    expect(importedTitles(model)).toBe(0);
    expect(model.unmatched).toBeUndefined();
    expect(model.unsupportedOther).toBe(0);
    expect(resultHeadline(model, 'imdb')).toBe('Nothing new came in');
  });

  it('headlines the three cases for both providers, never two claims at once', () => {
    const cases = [
      [{ watched: 1, kept: 5, already: 5 }, 'in'],
      [{ watched: 0, kept: 5 }, 'already'],
      [{ watched: 0, already: 5 }, 'already'],
      [{ watched: 0 }, 'none'],
    ] as const;
    for (const provider of ['imdb', 'letterboxd'] as const) {
      const name = provider === 'imdb' ? 'IMDb' : 'Letterboxd';
      for (const [counts, expected] of cases) {
        const headline = resultHeadline(resultModel(counts, provider), provider);
        expect(headline).toBe(
          expected === 'in'
            ? `Your ${name} history is in`
            : expected === 'already'
              ? `Your ${name} history is already here`
              : 'Nothing new came in',
        );
      }
    }
  });
});
