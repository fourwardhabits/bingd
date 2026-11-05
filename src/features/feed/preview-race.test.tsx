import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useComments } from './use-comments';
import { resetCommentPreviews, useLatestComments } from './use-latest-comments';

/**
 * ---------------------------------------------------------------------------
 * COMMENT READS THAT ANSWER OUT OF ORDER (combined Preview re-checks, 2026-11-04)
 *
 * The card's preview and the conversation read the same thread, and their responses can
 * arrive in any order, around a block. Every case here uses the real `useLatestComments`
 * (the card) and the real `useComments` (the conversation) on a real TanStack client;
 * only the network is held, and each response is released explicitly, in the order under
 * test. The rule all of them check: **an answer from a read that began earlier, or before
 * the reader's visibility changed, never replaces a newer one.**
 * ---------------------------------------------------------------------------
 */

type Pending = { resolve: (rows: unknown[]) => void };
const mockPending: Pending[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () =>
      new Promise((resolve) => {
        mockPending.push({ resolve: (rows) => resolve({ data: rows, error: null }) });
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

/** The card, and the conversation when `open` — what a Feed screen mounts. */
const useCardAndThread = ({ viewer, open }: { viewer: string; open: boolean }) => ({
  card: useLatestComments(['e1'], viewer),
  thread: useComments(open ? 'e1' : null, viewer),
});

/** Waits until no read of this card is in flight, so an assertion sees what was written. */
const cardSettled = async (hook: { client: import('@tanstack/react-query').QueryClient }, viewer: string) =>
  waitFor(() =>
    expect(hook.client.getQueryState(['comments', viewer, 'e1', 'latest'])?.fetchStatus).toBe('idle'),
  );

/** Releases the next held request with these rows. */
const release = async (rows: unknown[]) => {
  await waitFor(() => expect(mockPending.length).toBeGreaterThan(0));
  const next = mockPending.shift()!;
  await act(async () => {
    next.resolve(rows);
  });
};

const preview = (current: ReturnType<typeof useCardAndThread>) => current.card.get('e1')?.body ?? null;

/**
 * A clock the tests step by hand (`tick`), so "started before" and "answered after" are
 * never the same instant by accident — a guard that leaned on timing could otherwise pass
 * these tests for the wrong reason, which the previous version of this file did.
 */
let mockNow = 1_700_000_000_000;
const tick = () => {
  mockNow += 1_000;
};
beforeEach(() => {
  mockPending.length = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
});
afterEach(() => {
  jest.restoreAllMocks();
});

// Each test its own reader, so the per-reader order of one cannot touch another's.
let reader = 0;
const nextReader = () => `viewer-${(reader += 1)}`;

it('an old card read that lands after a newer conversation read cannot restore its words', async () => {
  const viewer = nextReader();
  let props = { viewer, open: false };
  const hook = await renderHookWithProviders(() => useCardAndThread(props));

  // The card's read starts first and is held. Then the comment is withdrawn and the
  // conversation opens: its later read answers first, without the comment.
  await waitFor(() => expect(mockPending).toHaveLength(1));
  const cardRead = mockPending.shift()!;
  props = { viewer, open: true };
  await hook.rerender(undefined as never);
  await release([FRIEND]);
  await waitFor(() => expect(hook.result.current.thread.isSuccess).toBe(true));
  await waitFor(() =>
    expect(preview(hook.result.current)).toBe('A comment the reader may still see.'),
  );

  // The card's older read finally answers with the withdrawn comment. It must not apply.
  tick();
  await act(async () => {
    cardRead.resolve([FRIEND, GONE]);
  });
  await cardSettled(hook, viewer);
  // The cache is what the card draws next; the render can lag it by a notification.
  const cached = hook.client.getQueryData(['comments', viewer, 'e1', 'latest']) as { body?: string } | null;
  expect(cached?.body).toBe('A comment the reader may still see.');
  await waitFor(() =>
    expect(preview(hook.result.current)).toBe('A comment the reader may still see.'),
  );
});

it('a newer conversation read still applies after an older card read has landed', async () => {
  const viewer = nextReader();
  let props = { viewer, open: false };
  const hook = await renderHookWithProviders(() => useCardAndThread(props));

  await waitFor(() => expect(mockPending).toHaveLength(1));
  const cardRead = mockPending.shift()!;
  tick();
  props = { viewer, open: true };
  await hook.rerender(undefined as never);
  await waitFor(() => expect(mockPending).toHaveLength(1));
  const threadRead = mockPending.shift()!;

  // The older card read lands first — after the conversation's read began — still
  // carrying the comment …
  tick();
  await act(async () => {
    cardRead.resolve([FRIEND, GONE]);
  });
  await waitFor(() => expect(preview(hook.result.current)).toBe('Words that are no longer available.'));

  // … then the newer conversation read, which no longer has it, replaces it.
  await act(async () => {
    threadRead.resolve([FRIEND]);
  });
  await waitFor(() =>
    expect(preview(hook.result.current)).toBe('A comment the reader may still see.'),
  );
});

it('a conversation reopened around a block never shows its pre-block answer', async () => {
  const viewer = nextReader();
  let props = { viewer, open: false };
  const hook = await renderHookWithProviders(() => useCardAndThread(props));
  await release([FRIEND]); // the card's own read

  // Open the conversation; its request is held. Close it, block, reopen.
  props = { viewer, open: true };
  await hook.rerender(undefined as never);
  await waitFor(() => expect(mockPending).toHaveLength(1));
  const preBlock = mockPending.shift()!;
  props = { viewer, open: false };
  await hook.rerender(undefined as never);
  // Not awaited: its promise settles only when the refetch answers, which this test holds.
  await act(async () => {
    void resetCommentPreviews(hook.client, viewer);
  });
  await waitFor(() => expect(preview(hook.result.current)).toBeNull(), { timeout: 1000 });
  props = { viewer, open: true };
  await hook.rerender(undefined as never);

  // The pre-block answer arrives, still carrying the blocked author.
  await act(async () => {
    preBlock.resolve([FRIEND, GONE]);
  });
  // It is not shown: the conversation reads again, and the post-block answer is what it
  // returns. (The card's post-block refetch is answered along the way.)
  // Answer whatever is asked next — the card's post-block refetch and the re-read —
  // until the conversation settles.
  await waitFor(async () => {
    if (mockPending.length) await release([FRIEND]);
    expect(hook.result.current.thread.isSuccess).toBe(true);
  });
  const bodies = (hook.result.current.thread.data ?? []).map((comment) => comment.body);
  expect(bodies).toEqual(['A comment the reader may still see.']);
  expect(preview(hook.result.current)).toBe('A comment the reader may still see.');
});

it('a conversation read from before a block cannot restore the blocked author on the card', async () => {
  const viewer = nextReader();
  let props = { viewer, open: false };
  const hook = await renderHookWithProviders(() => useCardAndThread(props));
  await release([FRIEND, GONE]); // the card shows the soon-to-be-blocked comment
  await waitFor(() => expect(preview(hook.result.current)).toBe('Words that are no longer available.'));

  props = { viewer, open: true };
  await hook.rerender(undefined as never);
  await waitFor(() => expect(mockPending).toHaveLength(1));
  const preBlock = mockPending.shift()!;

  // The block: the card is reset and refetched without that person.
  // Not awaited: its promise settles only when the refetch answers, which this test holds.
  await act(async () => {
    void resetCommentPreviews(hook.client, viewer);
  });
  await waitFor(() => expect(preview(hook.result.current)).toBeNull(), { timeout: 1000 });
  await release([FRIEND]);
  await waitFor(() =>
    expect(preview(hook.result.current)).toBe('A comment the reader may still see.'),
  );

  // The conversation's pre-block answer lands; it is read again rather than applied.
  await act(async () => {
    preBlock.resolve([FRIEND, GONE]);
  });
  await waitFor(async () => {
    if (mockPending.length) await release([FRIEND]);
    expect(hook.result.current.thread.isSuccess).toBe(true);
  });
  expect(preview(hook.result.current)).toBe('A comment the reader may still see.');
  expect((hook.result.current.thread.data ?? []).map((comment) => comment.body)).toEqual([
    'A comment the reader may still see.',
  ]);
});
