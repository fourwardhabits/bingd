import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { commentsKey, useComments } from './use-comments';
import { resetCommentPreviews, useLatestComments } from './use-latest-comments';

/**
 * ---------------------------------------------------------------------------
 * ONE CACHE, ONE WRITER — EVERY ORDERING THE REVIEWS FOUND (combined Preview, 2026-11-04)
 *
 * The Feed card's preview and the conversation are one query per thread. Each case below is
 * an ordering an independent review found in an earlier, two-cache design, replayed against
 * the real `useLatestComments` (the card) and `useComments` (the conversation) on a real
 * TanStack client. Only the network is held, and responses are released explicitly —
 * including two in the same turn with no flush between them.
 *
 * The rule every case checks: **the card and the conversation always show the answer to
 * the newest read, and never an answer from before a visibility change.**
 * ---------------------------------------------------------------------------
 */

type Held = { resolve: (rows: unknown[]) => void };
const mockHeld: Held[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () =>
      new Promise((resolve) => {
        mockHeld.push({ resolve: (rows) => resolve({ data: rows, error: null }) });
      }),
  },
  startSessionRefresh: () => () => {},
}));

const row = (id: string, author: string, body: string, at: string) => ({
  id,
  parent_id: null,
  author_id: author,
  username: author,
  display_name: author,
  avatar_path: null,
  body,
  has_spoilers: false,
  created_at: at,
  edited_at: null,
  deleted_at: null,
  reaction_count: 0,
  reacted_by_me: false,
  reaction_kinds: [],
  my_reaction: null,
  mentions: [],
});

const FRIEND = row('c-friend', 'friend', 'A comment the reader may still see.', '2026-11-04T09:00:00Z');
const GONE = row('c-gone', 'other', 'Words that are no longer available.', '2026-11-04T10:00:00Z');
const STILL = 'A comment the reader may still see.';

const useCardAndThread = ({ viewer, open }: { viewer: string; open: boolean }) => ({
  card: useLatestComments(['e1'], viewer),
  thread: useComments(open ? 'e1' : null, viewer),
});

let reader = 0;
const mount = async () => {
  const viewer = `viewer-${(reader += 1)}`;
  let props = { viewer, open: false };
  const hook = await renderHookWithProviders(() => useCardAndThread(props));
  const set = async (open: boolean) => {
    props = { viewer, open };
    await hook.rerender(undefined as never);
  };
  /** What the card would draw next: the cache, which a render can lag by a notification. */
  const cached = () =>
    (
      (hook.client.getQueryData(commentsKey(viewer, 'e1')) as { body: string | null }[] | undefined) ??
      []
    ).map((comment) => comment.body);
  const settled = () =>
    waitFor(() =>
      expect(hook.client.getQueryState(commentsKey(viewer, 'e1'))?.fetchStatus).toBe('idle'),
    );
  return { viewer, hook, set, cached, settled };
};

const take = async () => {
  await waitFor(() => expect(mockHeld.length).toBeGreaterThan(0));
  return mockHeld.shift()!;
};

const card = (hook: Awaited<ReturnType<typeof mount>>['hook']) =>
  hook.result.current.card.get('e1')?.body ?? null;

beforeEach(() => {
  mockHeld.length = 0;
});

it('the card and the conversation share one read, so they cannot disagree', async () => {
  const { hook, set, settled } = await mount();
  const first = await take();

  // Opening the conversation while the card's read is in flight joins it: no second read.
  await set(true);
  expect(mockHeld).toHaveLength(0);

  await act(async () => {
    first.resolve([FRIEND]);
  });
  await settled();
  await waitFor(() => expect(card(hook)).toBe(STILL));
  expect(hook.result.current.thread.data?.map((comment) => comment.body)).toEqual([STILL]);
});

it('an older read answering last — even in the same turn — never replaces a newer one', async () => {
  const { viewer, hook, cached, settled } = await mount();
  const first = await take();
  await act(async () => {
    first.resolve([FRIEND, GONE]);
  });
  await settled();

  // A refresh starts a read, and before it answers a comment write elsewhere (or a pull)
  // asks again. The second read supersedes the first.
  await act(async () => {
    void hook.client.invalidateQueries({ queryKey: ['comments', viewer] });
  });
  const older = await take();
  await act(async () => {
    void hook.client.invalidateQueries({ queryKey: ['comments', viewer] });
  });
  const newer = await take();

  // Both answer in one turn, the older one last, with no flush between them.
  await act(async () => {
    newer.resolve([FRIEND]);
    older.resolve([FRIEND, GONE]);
  });
  await settled();

  expect(cached()).toEqual([STILL]);
  await waitFor(() => expect(card(hook)).toBe(STILL));
});

it('a block drops the card at once and a pre-block answer is never committed', async () => {
  const { viewer, hook, set, cached, settled } = await mount();
  const first = await take();
  await act(async () => {
    first.resolve([FRIEND, GONE]);
  });
  await waitFor(() => expect(card(hook)).toBe('Words that are no longer available.'));

  // The conversation opens and refetches; that read is held.
  await set(true);
  const preBlock = await take();

  // The block. Not awaited: its promise settles when the refetch it starts answers.
  await act(async () => {
    void resetCommentPreviews(hook.client, viewer);
  });
  // The card has nothing to show until a post-block read answers.
  await waitFor(() => expect(card(hook)).toBeNull());
  const postBlock = await take();

  // The pre-block answer and the post-block one arrive in the same turn, pre-block last.
  await act(async () => {
    postBlock.resolve([FRIEND]);
    preBlock.resolve([FRIEND, GONE]);
  });
  await settled();

  expect(cached()).toEqual([STILL]);
  await waitFor(() => expect(card(hook)).toBe(STILL));
  expect(hook.result.current.thread.data?.map((comment) => comment.body)).toEqual([STILL]);
});

it('a conversation reopened around a block never shows its pre-block answer', async () => {
  const { viewer, hook, set, cached, settled } = await mount();
  const first = await take();
  await act(async () => {
    first.resolve([FRIEND]);
  });
  await settled();

  await set(true);
  const preBlock = await take();
  await set(false);
  await act(async () => {
    void resetCommentPreviews(hook.client, viewer);
  });
  await set(true);

  await act(async () => {
    preBlock.resolve([FRIEND, GONE]);
  });
  // Answer whatever is asked after the block until it settles.
  await waitFor(async () => {
    if (mockHeld.length) {
      const next = mockHeld.shift()!;
      await act(async () => {
        next.resolve([FRIEND]);
      });
    }
    expect(hook.result.current.thread.isSuccess).toBe(true);
  });

  expect(cached()).toEqual([STILL]);
  expect(hook.result.current.thread.data?.map((comment) => comment.body)).toEqual([STILL]);
});

it('signing out drops every thread, and an answer that lands afterwards is not committed', async () => {
  const { viewer, hook, cached } = await mount();
  const pending = await take();

  // Sign-out clears the whole client (`session.tsx`).
  await act(async () => {
    hook.client.clear();
  });
  await act(async () => {
    pending.resolve([FRIEND, GONE]);
  });

  expect(cached()).toEqual([]);
  expect(hook.client.getQueryData(commentsKey(viewer, 'e1'))).toBeUndefined();
});

it('the conversation never opens onto words the card read before it opened', async () => {
  const { hook, set, settled } = await mount();
  const first = await take();
  await act(async () => {
    first.resolve([FRIEND, GONE]);
  });
  await settled();

  // Opening the conversation: the card's earlier answer is in the cache, but the sheet
  // draws nothing until its own read — made now — has answered (review 43).
  await set(true);
  expect(hook.result.current.thread.data).toBeUndefined();
  expect(hook.result.current.thread.isPending).toBe(true);
  const own = await take();
  await act(async () => {
    own.resolve([FRIEND]);
  });
  await waitFor(() =>
    expect(hook.result.current.thread.data?.map((comment) => comment.body)).toEqual([STILL]),
  );
});
