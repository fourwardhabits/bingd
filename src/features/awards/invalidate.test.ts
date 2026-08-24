import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { AWARD_SOURCES, invalidateAwards } from './invalidate';

/**
 * **Three reviews found this same defect, and this file is the answer to the third.**
 *
 * bingd. Awards is derived and cached for a minute, so a badge only moves when something
 * says the answer has changed. Review 21 found that logging a film did not. `23a237f`
 * fixed the logging path. Review 21b then found that four other writers — comments,
 * direct watchlist writes, recommendations and the follow graph — moved an award and said
 * nothing, so a reader could post their twentieth comment, open the sheet, and see
 * nineteen.
 *
 * What makes that recur is that the knowledge is *absent* rather than wrong. Nothing
 * fails, nothing logs, and no existing test notices, because the thing missing is a
 * registration. So the tests below are about the whole set rather than about one writer:
 * every mutation that moves a metric is exercised, and the ones that deliberately do not
 * are exercised too, so "we considered it" is a passing assertion instead of a comment.
 */

const USER = 'user-1';
const OTHER = 'user-2';

/** Whether a seeded query was invalidated by `run`. */
const invalidated = (key: readonly unknown[], run: (client: QueryClient) => void) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(key, 'seeded');
  run(client);
  return client.getQueryState(key)?.isInvalidated ?? false;
};

describe('the canonical helper', () => {
  it('invalidates this account’s awards', () => {
    expect(invalidated(['awards', USER], (client) => invalidateAwards(client, USER))).toBe(true);
  });

  it('reaches a descendant key, so a future variant of the query is covered', () => {
    expect(
      invalidated(['awards', USER, 'breakdown'], (client) => invalidateAwards(client, USER)),
    ).toBe(true);
  });

  it('never touches another account', () => {
    expect(invalidated(['awards', OTHER], (client) => invalidateAwards(client, USER))).toBe(false);
  });

  it('leaves the expensive reads alone rather than clearing the cache', () => {
    // The alternative fix — an unkeyed invalidate — would refetch the catalogue and the
    // search cache every time somebody bookmarked a film.
    for (const key of [['search', 'inception'], ['credits', 'film-1'], ['feed', USER]]) {
      expect(invalidated(key, (client) => invalidateAwards(client, USER))).toBe(false);
    }
  });

  it('does nothing without an account, rather than invalidating every awards query', () => {
    // `['awards', '']` would prefix-match nothing, but `['awards']` would match every
    // account's — so a signed-out caller must not get that far.
    expect(invalidated(['awards', USER], (client) => invalidateAwards(client, ''))).toBe(false);
  });
});

/**
 * The audit itself, as a test rather than as prose.
 *
 * Twenty tracks read eight metrics (`tracks.ts` gives each one a single `needs` field, on
 * purpose). This asserts the table covers all eight and that every entry has decided
 * something — which is the check that a track added later cannot quietly arrive without
 * anybody asking what moves it.
 */
describe('the metric-to-mutation table', () => {
  const METRICS = [
    'watched',
    'rankings',
    'watchlist',
    'invitedSignups',
    'written',
    'recommendationsSent',
    'reactionsReceived',
    'mutualFollows',
  ];

  it('names every metric the awards read, once each', () => {
    expect(AWARD_SOURCES.map((source) => source.metric).sort()).toEqual([...METRICS].sort());
  });

  it('gives every metric that a local write can move a writer', () => {
    for (const source of AWARD_SOURCES) {
      expect(Boolean(source.writer)).toBe(source.invalidates);
    }
  });

  /**
   * The two that no local mutation can move, and why each is right.
   *
   * Heart Magnet counts reactions *from other people* on this reader's activity — the
   * reader's own reaction is excluded by `neq('user_id')`, so pressing one moves somebody
   * else's award on a device this app is not running on. Invite Instigator counts
   * activated invitees, and nothing writes `activated_at` yet.
   *
   * This is the one thing the one-minute `staleTime` is genuinely for, and stating it
   * here is what stops a future pass "fixing" the gap by invalidating on every reaction.
   */
  it('leaves exactly Heart Magnet and Invite Instigator to the staleTime', () => {
    expect(AWARD_SOURCES.filter((s) => !s.invalidates).map((s) => s.metric)).toEqual([
      'reactionsReceived',
      'invitedSignups',
    ]);
  });
});

/**
 * Each writer, exercised.
 *
 * A table saying a writer invalidates is worth nothing on its own — that is exactly the
 * form the false comment in `use-awards.ts` took, and it was wrong for a month. So every
 * `invalidates: true` row above has a test here that runs the real hook against a stubbed
 * database and looks at the real cache.
 *
 * Each also asserts the **failure** case, because "on success only" is half the contract:
 * a refused write that invalidated anyway would refetch every award on every rejected
 * comment, and a reader would watch their badges flicker for no reason.
 */

const mockRpc = jest.fn();
const mockFrom = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/collection/writes', () => ({
  newOperationId: () => 'op-1',
  setWatchlist: jest.fn(),
}));

/** A builder that resolves to no rows, for the reads a hook makes on mount. */
const emptyRead = () => {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve);
        }
        return () => chain;
      },
    },
  );
  return chain;
};

beforeEach(() => {
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockFrom.mockImplementation(() => emptyRead());
});

/**
 * Mounts a writer hook over a cache with `['awards', USER]` already in it.
 *
 * Its own client rather than the shared `renderHookWithProviders`, whose `gcTime: 0`
 * collects a query the moment it has no observers — which would make every assertion
 * below read "not invalidated" for a reason that has nothing to do with invalidation.
 */
const withSeededAwards = async <T>(hook: () => T) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  client.setQueryData(['awards', USER], 'seeded');

  const wrapper = ({ children }: { children: ReactNode }) =>
    QueryClientProvider({ client, children });

  const { result } = await renderHook(hook, { wrapper });
  return {
    result,
    /** Runs the write, then reports whether the seeded awards query was invalidated. */
    moved: async (write: () => Promise<unknown>) => {
      await act(async () => {
        await write();
      });
      return client.getQueryState(['awards', USER])?.isInvalidated ?? false;
    },
  };
};

describe('a comment moves Comment Gremlin', () => {
  type CommentWrites = {
    add: (input: { eventId: string; body: string; hasSpoilers: boolean }) => Promise<unknown>;
    remove: (input: { commentId: string }) => Promise<unknown>;
  };
  const useWrites = (): CommentWrites => {
    // Resolved after `jest.mock` has run, which an `import` would not be.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useCommentWrites } = require('@/features/feed/use-comments');
    return useCommentWrites(USER);
  };

  it('invalidates awards when the comment is posted', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(
      await moved(() => result.current.add({ eventId: 'e1', body: 'hi', hasSpoilers: false })),
    ).toBe(true);
  });

  it('does not when the write is refused', async () => {
    mockRpc.mockResolvedValue({ error: { code: '42501', message: 'no' } });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(
      await moved(() => result.current.add({ eventId: 'e1', body: 'hi', hasSpoilers: false })),
    ).toBe(false);
  });

  it('invalidates on delete too, since the count can go down', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(
      await moved(() => result.current.remove({ commentId: 'c1' })),
    ).toBe(true);
  });
});

describe('a recommendation moves Hype Courier', () => {
  type Send = { mutateAsync: (input: unknown) => Promise<unknown> };
  const useSend = (): Send => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above.
    const { useRecommendTitle } = require('@/features/recommendations/use-recommend');
    return useRecommendTitle(USER);
  };
  const send = (result: { current: Send }) =>
    result.current.mutateAsync({ recipientId: 'them', mediaItemId: 'film-1' });

  it('invalidates awards when it is sent', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'sent' }, error: null });
    const { result, moved } = await withSeededAwards(useSend);

    expect(await moved(() => send(result))).toBe(true);
  });

  it('does not when the server refuses in the body', async () => {
    // `recommend_title` returns `not_mutual` as a 200 with a body, which is the case a
    // check on `error` alone would call a success.
    mockRpc.mockResolvedValue({ data: { status: 'refused', reason: 'not_mutual' }, error: null });
    const { result, moved } = await withSeededAwards(useSend);

    expect(await moved(() => send(result))).toBe(false);
  });
});

describe('following back moves Mutual Mania', () => {
  type SocialWrites = {
    follow: (input: { userId: string }) => Promise<unknown>;
    block: (input: { userId: string }) => Promise<unknown>;
    respondToRequest: (input: { userId: string; approve: boolean }) => Promise<unknown>;
  };
  const useWrites = (): SocialWrites => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above.
    const { useSocialWrites } = require('@/features/profile/use-social');
    return useSocialWrites(USER);
  };

  it('invalidates awards on a follow', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(await moved(() => result.current.follow({ userId: 'them' }))).toBe(true);
  });

  it('and on a block, which removes both edges and can move it down', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(await moved(() => result.current.block({ userId: 'them' }))).toBe(true);
  });

  it('and on answering a request, which is how a follower becomes a mutual', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(
      await moved(() => result.current.respondToRequest({ userId: 'them', approve: true })),
    ).toBe(true);
  });

  it('does not when the write fails', async () => {
    mockRpc.mockResolvedValue({ error: { code: '42501', message: 'no' } });
    const { result, moved } = await withSeededAwards(useWrites);

    expect(await moved(() => result.current.follow({ userId: 'them' }))).toBe(
      false,
    );
  });
});

/**
 * Goals and the reader's own reaction, which are the deliberate non-entries.
 *
 * Asserted because a later pass tidying up "every mutation should invalidate awards"
 * would be wrong, and this is where the reasoning is written down: no award reads a goal,
 * and a reader's own reaction is excluded from their own Heart Magnet by construction.
 */
describe('what deliberately does not move an award', () => {
  it('a goal write leaves awards alone', async () => {
    mockRpc.mockResolvedValue({ error: null });
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above.
    const { setWatchGoal } = require('@/features/goals/use-goals');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['awards', USER], 'seeded');

    await setWatchGoal({ year: 2026, category: 'movies', target: 52 });

    // Nothing to invalidate, because `setWatchGoal` takes no client at all — which is the
    // structural version of "no award reads a goal".
    expect(client.getQueryState(['awards', USER])?.isInvalidated ?? false).toBe(false);
  });

  it('the reader’s own reaction leaves their own awards alone', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const { result, moved } = await withSeededAwards(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useSetReaction } = require('@/features/feed/use-reactions');
      return useSetReaction(USER) as {
        setReaction: (id: string, kind: string) => Promise<unknown>;
      };
    });

    expect(await moved(() => result.current.setReaction('event-1', 'heart'))).toBe(false);
  });
});
