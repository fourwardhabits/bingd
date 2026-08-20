import { QueryClient } from '@tanstack/react-query';

import { invalidateAfterCollectionChange, invalidateAfterWatchlistChange } from './invalidate';

/**
 * The founder ranked a film and the Feed did not show it.
 *
 * The ranking path invalidated the category's rankings, the collection and the title
 * — the set that was correct when it was written, and wrong since the feed started
 * reading `feed_events`, which `_rank_finalize` writes. Nothing invalidated the feed.
 *
 * These tests assert the *set*, because that is what regressed: a surface added later
 * and not added to the list. They also assert what is deliberately left alone, so the
 * fix cannot quietly become "invalidate everything", which would refetch the
 * catalogue and the search cache on every ranking.
 */

const USER = 'user-1';
const OTHER = 'user-2';
const TITLE = 'film-1';

/** Which keys an invalidation actually touched, by seeding one query per key. */
const invalidatedBy = (
  seeds: readonly (readonly unknown[])[],
  run: (client: QueryClient) => void,
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of seeds) client.setQueryData(key, 'seeded');

  const before = new Map(
    seeds.map((key) => [JSON.stringify(key), client.getQueryState(key)?.isInvalidated ?? false]),
  );
  run(client);

  const touched = new Set<string>();
  for (const key of seeds) {
    const now = client.getQueryState(key)?.isInvalidated ?? false;
    if (now && !before.get(JSON.stringify(key))) touched.add(JSON.stringify(key));
  }
  return touched;
};

const KEYS = {
  rankedMovies: ['rankings', USER, 'movies'],
  rankedSeasons: ['rankings', USER, 'tv_seasons'],
  collection: ['collection', USER],
  watchlist: ['collection', USER, 'watchlist'],
  title: ['title', TITLE],
  titlePersonal: ['title', TITLE, 'personal', USER],
  logState: ['log-state', USER, TITLE],
  feed: ['feed', USER, { cursor: undefined }],
  actorActivity: ['actor-activity', USER, 5],
  watched: ['watched', USER],
  // The real hook key, account first. It was seeded here without the account while
  // the hook had gained one, so the assertion below passed against a key nothing uses.
  community: ['community-score', USER, TITLE],
  // Another account's aggregate for the same film, which must be left alone.
  otherUserCommunity: ['community-score', OTHER, TITLE],
  // Other people's rankings, which nothing this reader does can move.
  following: ['following-score', USER, TITLE],
  goalsThisYear: ['goals', USER, 2026],
  goalsLastYear: ['goals', USER, 2025],
  awards: ['awards', USER],
  // Left alone on purpose.
  search: ['search', 'inception'],
  otherUserGoals: ['goals', OTHER, 2026],
  otherUserAwards: ['awards', OTHER],
  credits: ['credits', TITLE],
  videos: ['videos', TITLE],
  otherTitle: ['title', 'film-2'],
  otherUserFeed: ['feed', OTHER, { cursor: undefined }],
  otherUserCollection: ['collection', OTHER],
} as const;

const all = Object.values(KEYS);
const has = (set: Set<string>, key: readonly unknown[]) => set.has(JSON.stringify(key));

describe('after a ranking completes', () => {
  const touched = () =>
    invalidatedBy(all, (client) =>
      invalidateAfterCollectionChange(client, USER, TITLE, { category: 'movies' }),
    );

  it('refreshes the Feed — the one that was missing', async () => {
    expect(has(touched(), KEYS.feed)).toBe(true);
  });

  it('refreshes Profile’s recent activity', async () => {
    expect(has(touched(), KEYS.actorActivity)).toBe(true);
  });

  it('refreshes the Collection and the ranked list it landed in', async () => {
    const set = touched();
    expect(has(set, KEYS.collection)).toBe(true);
    expect(has(set, KEYS.rankedMovies)).toBe(true);
  });

  it('refreshes the Watchlist, which the server just changed underneath it', async () => {
    // `20260815040000` removes a watchlist row once the title is ranked, so a screen
    // still saying "In watchlist" would be the server right and the client wrong.
    expect(has(touched(), KEYS.watchlist)).toBe(true);
  });

  it('refreshes both halves of the title page', async () => {
    const set = touched();
    expect(has(set, KEYS.title)).toBe(true);
    expect(has(set, KEYS.titlePersonal)).toBe(true);
    expect(has(set, KEYS.logState)).toBe(true);
  });

  it('refreshes the watched set, so spoiler notes about it stop being masked', async () => {
    expect(has(touched(), KEYS.watched)).toBe(true);
  });

  it('refreshes this title’s community score, which now includes the new rating', async () => {
    expect(has(touched(), KEYS.community)).toBe(true);
  });

  it('refreshes Bingd Awards, which thirteen tracks read the collection for', async () => {
    // The failure this module exists to prevent, repeated: Awards was built after the
    // list and never added to it, so a badge earned by the film just logged did not move
    // until the one-minute staleTime expired — and `use-awards.ts` carried a comment
    // saying the opposite. Independent review 21.
    expect(has(touched(), KEYS.awards)).toBe(true);
  });

  it('leaves somebody else’s awards alone', async () => {
    expect(has(touched(), KEYS.otherUserAwards)).toBe(false);
  });

  it('leaves the following score alone, which the reader cannot move', async () => {
    // It is the mean over other people's rankings. Nothing this reader does to their
    // own collection changes it, and refetching it here would spend a round trip to be
    // told the same number.
    expect(has(touched(), KEYS.following)).toBe(false);
  });

  it('refreshes goal progress for every year, not just the current one', async () => {
    // A film logged today can carry a watch date from last December, which moves that
    // year's bar and not this one's. The caller does not know which, so both go.
    const set = touched();
    expect(has(set, KEYS.goalsThisYear)).toBe(true);
    expect(has(set, KEYS.goalsLastYear)).toBe(true);
  });

  it('leaves the catalogue, search and other people alone', async () => {
    // The instruction was explicit that this must not be solved by invalidating
    // everything. Search and credits are the expensive reads a ranking cannot change.
    const set = touched();
    for (const key of [
      KEYS.search,
      KEYS.credits,
      KEYS.videos,
      KEYS.otherTitle,
      KEYS.otherUserFeed,
      KEYS.otherUserCollection,
      KEYS.otherUserGoals,
      KEYS.otherUserCommunity,
    ]) {
      expect(has(set, key)).toBe(false);
    }
  });

  it('touches only the category that changed', async () => {
    const set = touched();
    expect(has(set, KEYS.rankedMovies)).toBe(true);
    expect(has(set, KEYS.rankedSeasons)).toBe(false);
  });
});

describe('when the category is not known', () => {
  it('refreshes both ranked lists, since a re-bucket can move a title between them', async () => {
    const set = invalidatedBy(all, (client) =>
      invalidateAfterCollectionChange(client, USER, TITLE),
    );

    expect(has(set, KEYS.rankedMovies)).toBe(true);
    expect(has(set, KEYS.rankedSeasons)).toBe(true);
  });
});

/**
 * The bookmark control, which four screens carry and none of them owned.
 *
 * The title page, the Feed, Recommendations and a person's credits each kept their own
 * invalidation list — the arrangement this whole module exists to argue against — and all
 * four moved **Queue Dragon** without saying so. 24 → 25, and the badge stayed at 24 for a
 * minute. Independent review 21b.
 */
describe('after a watchlist change', () => {
  const touched = () =>
    invalidatedBy(all, (client) => invalidateAfterWatchlistChange(client, USER));

  it('refreshes the watchlist itself', async () => {
    expect(has(touched(), KEYS.watchlist)).toBe(true);
  });

  it('refreshes Bingd Awards, which is what Queue Dragon counts', async () => {
    expect(has(touched(), KEYS.awards)).toBe(true);
  });

  it('leaves the rest of the collection and the ranked lists alone', async () => {
    // A bookmark is not a log. Invalidating the collection here would refetch every
    // logged title and both ranked lists on a single tap, four screens over.
    const set = touched();
    for (const key of [KEYS.collection, KEYS.rankedMovies, KEYS.rankedSeasons, KEYS.watched]) {
      expect(has(set, key)).toBe(false);
    }
  });

  it('leaves another account’s watchlist and awards alone', async () => {
    const set = touched();
    expect(has(set, KEYS.otherUserCollection)).toBe(false);
    expect(has(set, KEYS.otherUserAwards)).toBe(false);
  });
});
