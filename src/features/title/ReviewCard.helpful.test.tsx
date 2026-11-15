import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { View } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ReviewCard, formatReviewDate } from './ReviewCard';
import { useSetReviewHelpful, useTitleReviews, type TitleReview } from './use-title-reviews';

/**
 * **The thumbs-up, on the real write** (FU1113-F, F3 / F4).
 *
 * The card itself is a pure view; what a reader sees after a tap is the card reading the
 * one `['title-reviews', id, sort]` cache that `useSetReviewHelpful` writes optimistically,
 * reconciles from the server's answer, and rolls back on failure. Two cards mounted over
 * two observers of that cache stand in for the title page's preview and the See all sheet:
 * a tap on one must move both, because they are one cache entry and not two copies.
 */

let mockRpc: jest.Mock;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'op-1' }));

const MEDIA = 'media-1';

const row = (count: number, mine: boolean) => ({
  id: 'review-1',
  user_id: 'author-1',
  username: 'reader_a',
  display_name: 'Reader A',
  avatar_path: null,
  note: 'The last twenty minutes are the whole film.',
  has_spoilers: false,
  updated_at: '2026-09-01T10:00:00.000Z',
  score: '8.4',
  reaction_count: 0,
  helpful_count: count,
  viewer_helpful: mine,
});

let server: { count: number; mine: boolean };
let failWrite: boolean;
/** Resolves the in-flight write when the test says so, so the optimistic state is observable. */
let release: (() => void) | null;

beforeEach(() => {
  server = { count: 2, mine: false };
  failWrite = false;
  release = null;
  mockRpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'title_reviews_v2') {
      return { data: [row(server.count, server.mine)], error: null };
    }
    if (name === 'set_review_helpful') {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (failWrite) return { data: null, error: { message: 'no such review' } };
      server = args.p_helpful
        ? { count: server.count + 1, mine: true }
        : { count: server.count - 1, mine: false };
      return { data: { helpful_count: server.count, viewer_helpful: server.mine }, error: null };
    }
    return { data: null, error: null };
  });
});

/** One surface: an observer of the shared list, drawing its review through the card. */
function Surface({ testID }: { testID: string }) {
  const list = useTitleReviews(MEDIA, 'top_desc');
  const setHelpful = useSetReviewHelpful(MEDIA);
  const review: TitleReview | undefined = list.data?.[0];
  if (!review) return null;
  return (
    <View testID={testID}>
      <ReviewCard
        review={{
          id: review.id,
          username: review.name,
          date: formatReviewDate(review.updatedAt),
          text: review.text,
          spoilers: review.hasSpoilers,
          helpfulCount: review.helpfulCount,
          viewerHelpful: review.viewerHelpful,
          isOwn: false,
        }}
        helpfulPending={setHelpful.isPending}
        onToggleHelpful={() =>
          setHelpful.mutate({ reviewId: review.id, helpful: !review.viewerHelpful })
        }
      />
    </View>
  );
}

const mount = () =>
  renderWithProviders(
    <>
      <Surface testID="page" />
      <Surface testID="sheet" />
    </>,
  );

const countIn = (view: Awaited<ReturnType<typeof mount>>, where: string) =>
  within(view.getByTestId(where)).queryByTestId('review-helpful-count')?.props.children ?? null;

it('moves the count and the selection the instant it is tapped, before any answer', async () => {
  const view = await mount();
  await waitFor(() => expect(countIn(view, 'page')).toBe('2 people found this helpful'));

  await fireEvent.press(within(view.getByTestId('page')).getByTestId('review-helpful'));

  // Optimistic: the server has not answered yet.
  await waitFor(() => expect(countIn(view, 'page')).toBe('3 people found this helpful'));
  expect(
    within(view.getByTestId('page')).getByRole('button', { name: 'Remove helpful' }).props
      .accessibilityState,
  ).toMatchObject({ selected: true, busy: true });
  expect(release).not.toBeNull();

  release?.();
  await waitFor(() =>
    expect(
      within(view.getByTestId('page')).getByTestId('review-helpful').props.accessibilityState,
    ).toMatchObject({ selected: true, busy: false }),
  );
  expect(countIn(view, 'page')).toBe('3 people found this helpful');
});

it('rolls the count and the selection back when the write fails', async () => {
  failWrite = true;
  const view = await mount();
  await waitFor(() => expect(countIn(view, 'page')).toBe('2 people found this helpful'));

  await fireEvent.press(within(view.getByTestId('page')).getByTestId('review-helpful'));
  await waitFor(() => expect(countIn(view, 'page')).toBe('3 people found this helpful'));

  release?.();
  await waitFor(() => expect(countIn(view, 'page')).toBe('2 people found this helpful'));
  expect(
    within(view.getByTestId('page')).getByRole('button', { name: 'Mark review helpful' }),
  ).toBeTruthy();
});

it('takes a vote back on a second tap, and drops the count line at zero', async () => {
  server = { count: 1, mine: true };
  const view = await mount();
  await waitFor(() => expect(countIn(view, 'page')).toBe('1 person found this helpful'));

  await fireEvent.press(
    within(view.getByTestId('page')).getByRole('button', { name: 'Remove helpful' }),
  );
  release?.();
  await waitFor(() => expect(countIn(view, 'page')).toBeNull());
  expect(mockRpc).toHaveBeenCalledWith(
    'set_review_helpful',
    expect.objectContaining({ p_review_id: 'review-1', p_helpful: false }),
  );
});

it('shows the same count on the page and in the sheet after a toggle (F4)', async () => {
  const view = await mount();
  await waitFor(() => expect(countIn(view, 'sheet')).toBe('2 people found this helpful'));

  await fireEvent.press(within(view.getByTestId('sheet')).getByTestId('review-helpful'));
  release?.();

  await waitFor(() => expect(countIn(view, 'sheet')).toBe('3 people found this helpful'));
  expect(countIn(view, 'page')).toBe('3 people found this helpful');
  expect(
    within(view.getByTestId('page')).getByTestId('review-helpful').props.accessibilityState
      .selected,
  ).toBe(true);
});
