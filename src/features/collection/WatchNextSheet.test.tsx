import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { WatchNextSheet, type WatchNextTitle } from './WatchNextSheet';

/**
 * The one control for Watch next (20260929000200).
 *
 * Three states from what is pinned — add, remove, and the replace picker when full — and
 * the one surprise the server can deliver: a sheet that thought there was room being told
 * `full`, which must redraw as the picker rather than fail.
 */

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issued += 1)}` }));

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (event: unknown) => mockTrack(event),
}));

const mockRpc = jest.fn();
let mockReply: unknown = null;
let mockError: { code?: string; message: string } | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockError ? null : mockReply, error: mockError });
    },
  },
}));

const title = (n: number): WatchNextTitle => ({
  mediaItemId: `film-${n}`,
  name: `Film ${n}`,
  year: 2000 + n,
  posterPath: null,
});

beforeEach(() => {
  mockRpc.mockReset();
  mockTrack.mockReset();
  mockReply = null;
  mockError = null;
});

const open = (subject: WatchNextTitle, pinned: WatchNextTitle[], onClose = jest.fn()) =>
  renderWithProviders(
    <WatchNextSheet userId="user-1" subject={subject} pinned={pinned} onClose={onClose} />,
  );

describe('adding', () => {
  it('pins a title when there is room, and closes', async () => {
    mockReply = { status: 'ok', replaced: false, pinned: ['film-1', 'film-4'] };
    const onClose = jest.fn();
    const view = await open(title(4), [title(1)], onClose);

    await fireEvent.press(view.getByText('Add to Watch next'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith('set_watch_next', {
      p_operation_id: expect.any(String),
      p_media_item_id: 'film-4',
      p_present: true,
      p_replace_media_item_id: null,
    });
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'watch_next_changed',
      props: { action: 'added', count_after: 2 },
    });
  });

  it('removes a pinned title', async () => {
    mockReply = { status: 'ok', pinned: [] };
    const onClose = jest.fn();
    const view = await open(title(1), [title(1)], onClose);

    await fireEvent.press(view.getByText('Remove from Watch next'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith(
      'set_watch_next',
      expect.objectContaining({ p_media_item_id: 'film-1', p_present: false }),
    );
  });
});

describe('when three are pinned', () => {
  it('opens straight into the replace picker and swaps in one call', async () => {
    mockReply = { status: 'ok', replaced: true, pinned: ['film-1', 'film-4', 'film-3'] };
    const onClose = jest.fn();
    const view = await open(title(4), [title(1), title(2), title(3)], onClose);

    expect(view.getByText('Watch next is full')).toBeTruthy();
    expect(view.getByText('Replace one with Film 4?')).toBeTruthy();
    expect(view.queryByText('Add to Watch next')).toBeNull();

    await fireEvent.press(view.getByText(/Film 2/));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockRpc).toHaveBeenCalledWith(
      'set_watch_next',
      expect.objectContaining({
        p_media_item_id: 'film-4',
        p_present: true,
        p_replace_media_item_id: 'film-2',
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'watch_next_changed',
      props: { action: 'replaced', count_after: 3 },
    });
  });

  it('counts the cap biting once when it opens full', async () => {
    await open(title(4), [title(1), title(2), title(3)]);
    expect(mockTrack).toHaveBeenCalledWith({ name: 'watch_next_full_shown' });
  });
});

describe('what the server knows better', () => {
  it('redraws as the picker when an add it thought had room is answered full', async () => {
    mockReply = { status: 'refused', reason: 'full', pinned: ['film-1', 'film-2', 'film-3'] };
    const onClose = jest.fn();
    const view = await open(title(4), [title(1), title(2)], onClose);

    await fireEvent.press(view.getByText('Add to Watch next'));

    await waitFor(() => expect(view.getByText('Watch next is full')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says so when the title has left the Watchlist', async () => {
    mockReply = { status: 'refused', reason: 'not_on_watchlist' };
    const view = await open(title(4), []);

    await fireEvent.press(view.getByText('Add to Watch next'));

    await waitFor(() =>
      expect(view.getByText('That title is no longer on your Watchlist.')).toBeTruthy(),
    );
  });
});
