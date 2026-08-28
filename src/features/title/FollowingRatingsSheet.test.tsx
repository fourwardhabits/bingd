import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { FollowingRatingsSheet } from './FollowingRatingsSheet';

/**
 * The people behind the Following score (founder tranche 2026-08-27 §13).
 *
 * What the sheet must get right is the founder's sentence: "which people I follow
 * watched this, how much they liked it, and how much I generally trust their taste"
 * — three facts per row, one of which is allowed to be "Match TBD" and is never
 * allowed to be an invented number. The population and the ordering are the
 * server's (`following_ratings`, pinned in supabase/tests); what is pinned here is
 * that the client renders that answer without editing it.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

let mockRows: unknown[] | { error: true } = [];
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      if (!Array.isArray(mockRows)) {
        return Promise.resolve({ data: null, error: { message: 'nope' } });
      }
      return Promise.resolve({ data: mockRows, error: null });
    },
  },
}));

const row = (over: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  username: 'abisola',
  display_name: 'Abisola',
  avatar_path: null,
  score: '8.7',
  match_score: 82,
  common_count: 12,
  ...over,
});

const open = (over: Partial<Parameters<typeof FollowingRatingsSheet>[0]> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <FollowingRatingsSheet
      mediaItemId="m1"
      titleName="Dune (2021)"
      viewerId="viewer"
      onPressPerson={() => {}}
      onClose={() => {}}
      {...over}
    />,
    { wrapper },
  );
};

beforeEach(() => {
  mockRows = [];
  mockRpcCalls.length = 0;
});

describe('who rated this, and how far to trust them', () => {
  it('asks the one canonical function about this title', async () => {
    mockRows = [row()];
    await open();
    await waitFor(() => expect(screen.getByText('Abisola')).toBeTruthy());

    expect(mockRpcCalls).toEqual([{ name: 'following_ratings', args: { p_media_item_id: 'm1' } }]);
  });

  it('shows each person with their rating and their Match', async () => {
    mockRows = [row()];
    await open();

    // One announcement per row: who, their handle, their number for this film, and
    // the trust behind their numbers generally.
    await waitFor(() =>
      expect(
        screen.getByLabelText('Abisola, @abisola, rated it 8.7 out of 10, 82% Match'),
      ).toBeTruthy(),
    );
    // The visible column is hidden from the accessibility tree on purpose — both
    // facts are in the row's one announcement — so the query has to say so.
    expect(screen.getByText('82% Match', { includeHiddenElements: true })).toBeTruthy();
  });

  it('says Match TBD below the evidence threshold, never a number', async () => {
    // taste_match answered null — under taste.min_common shared titles. Two words,
    // muted; a percentage invented to fill the column is §16's named failure.
    mockRows = [row({ match_score: null, common_count: 2 })];
    await open();

    await waitFor(() =>
      expect(screen.getByText('Match TBD', { includeHiddenElements: true })).toBeTruthy(),
    );
    expect(screen.queryByText(/% Match/, { includeHiddenElements: true })).toBeNull();
  });

  it('renders the rows in the order the server sent them', async () => {
    // The ordering — trustworthy Match first, then rating, then username — is the
    // function's contract. A client-side re-sort would give two surfaces two orders.
    mockRows = [
      row({ user_id: 'u1', username: 'ada', display_name: 'Ada', match_score: 91 }),
      row({ user_id: 'u2', username: 'ravi', display_name: 'Ravi', match_score: 60, score: '9.9' }),
      row({ user_id: 'u3', username: 'silky', display_name: 'Silky', match_score: null }),
    ];
    await open();
    await waitFor(() => expect(screen.getByText('Silky')).toBeTruthy());

    const names = screen.getAllByText(/^(Ada|Ravi|Silky)$/).map((node) => node.props.children);
    expect(names).toEqual(['Ada', 'Ravi', 'Silky']);
  });

  it('opens the person behind a row', async () => {
    const onPressPerson = jest.fn();
    mockRows = [row()];
    await open({ onPressPerson });
    await waitFor(() => expect(screen.getByText('Abisola')).toBeTruthy());

    await fireEvent.press(
      screen.getByLabelText('Abisola, @abisola, rated it 8.7 out of 10, 82% Match'),
    );
    expect(onPressPerson).toHaveBeenCalledWith('abisola');
  });

  it('states an empty population rather than apologising', async () => {
    mockRows = [];
    await open();

    await waitFor(() => expect(screen.getByText('No one you follow has ranked this.')).toBeTruthy());
  });

  it('offers a retry when the read genuinely failed', async () => {
    mockRows = { error: true };
    await open();

    await waitFor(() => expect(screen.getByText('Could not load these')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('falls back to the handle when a display name is absent', async () => {
    mockRows = [row({ display_name: null })];
    await open();

    await waitFor(() => expect(screen.getByText('abisola')).toBeTruthy());
  });
});
