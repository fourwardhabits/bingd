import { useQuery } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useComments } from './use-comments';
import {
  beginThreadRead,
  latestCommentKey,
  reconcilePreviewFromThread,
  resetCommentPreviews,
  type LatestComment,
} from './use-latest-comments';

/**
 * ---------------------------------------------------------------------------
 * A THREAD READ THAT LANDS AFTER A BLOCK MUST NOT RESTORE THE BLOCKED PERSON'S WORDS
 * (combined Preview re-check, 2026-11-04)
 *
 * The scenario, as the review reproduced it: open a thread, close it before its response
 * arrives, block the newest commenter. The block resets the card's preview and refetches it
 * without that person. Then the thread's request — made before the block — answers, and
 * used to overwrite the fresh preview with the blocked author's comment.
 *
 * Real `useComments`, real TanStack client; only the network is held.
 */

let mockRelease: ((rows: unknown[]) => void) | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () =>
      new Promise((resolve) => {
        mockRelease = (rows) => resolve({ data: rows, error: null });
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

const preview = (id: string, author: string, body: string): LatestComment => ({
  id,
  authorId: author,
  authorUsername: author,
  authorName: author,
  authorAvatarUri: null,
  body,
  hasSpoilers: false,
  createdAt: '2026-11-04T10:00:00Z',
});

/**
 * The thread, plus an observer on the card's preview — what a mounted Feed card is. Without
 * one the test client (gcTime 0) would discard the preview entry the moment it was written.
 */
const useThreadAndCard = (eventId: string) => {
  const thread = useComments(eventId, 'viewer');
  useQuery({ queryKey: latestCommentKey('viewer', eventId), queryFn: () => null, enabled: false });
  return thread;
};

beforeEach(() => {
  mockRelease = null;
});

it('keeps the post-block preview when a pre-block thread response lands late', async () => {
  const key = latestCommentKey('viewer', 'e1');
  const { client, result } = await renderHookWithProviders(() => useThreadAndCard('e1'));
  // A card is showing the blocked person's comment as the newest.
  client.setQueryData(key, preview('c-new', 'blocked', 'Words from the person about to be blocked.'));
  // The thread request is in flight.
  await waitFor(() => expect(mockRelease).not.toBeNull());
  const releasePreBlock = mockRelease!;

  // The block: previews reset, then refetched without that person.
  await act(async () => {
    await resetCommentPreviews(client, 'viewer');
  });
  client.setQueryData(key, preview('c-old', 'friend', 'A comment the reader may still see.'));

  // The pre-block thread answer finally lands, still containing the blocked comment.
  await act(async () => {
    releasePreBlock([
      row('c-old', 'friend', 'A comment the reader may still see.', '2026-11-04T09:00:00Z'),
      row('c-new', 'blocked', 'Words from the person about to be blocked.', '2026-11-04T10:00:00Z'),
    ]);
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect((client.getQueryData(key) as LatestComment).body).toBe('A comment the reader may still see.');
});

it('still lets a thread read replace the preview when nothing changed while it ran', async () => {
  const key = latestCommentKey('viewer', 'e2');
  const { client, result } = await renderHookWithProviders(() => useThreadAndCard('e2'));
  await waitFor(() => expect(mockRelease).not.toBeNull());
  await act(async () => {
    mockRelease!([]);
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // The conversation is empty, so the card has nothing to preview.
  expect(client.getQueryData(key)).toBeNull();
});

describe('reconcilePreviewFromThread', () => {
  it('refuses an answer older than the preview it would replace', async () => {
    const { client } = await renderHookWithProviders(() =>
      useQuery({ queryKey: latestCommentKey('viewer', 'e3'), queryFn: () => null, enabled: false }),
    );
    const key = latestCommentKey('viewer', 'e3');
    const read = { generation: 0, startedAt: Date.now() - 10_000 };
    client.setQueryData(key, preview('fresh', 'friend', 'Answered after the thread began.'));
    expect(reconcilePreviewFromThread(client, 'viewer', 'e3', [], read)).toBe(false);
    expect((client.getQueryData(key) as LatestComment).id).toBe('fresh');
  });

  it('refuses an answer from before a visibility change, whatever the timing', async () => {
    const { client } = await renderHookWithProviders(() => null);
    const read = beginThreadRead('viewer');
    await resetCommentPreviews(client, 'viewer');
    expect(reconcilePreviewFromThread(client, 'viewer', 'e4', [], read)).toBe(false);
  });
});
