import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { applyRefineNotNow, useRefineCard } from './use-refine';

/**
 * **The Refine card's memory** (founder QA, 2026-09-22).
 *
 * The reported defect: a completed round, back to Collection, and *Fine-tune your
 * rankings* still there — until the app was force-closed and reopened, when it was gone.
 * Both halves of that are asserted here, because together they are the whole rule:
 *
 *   · a sitting that ends must quiet the card on the screen already mounted behind it,
 *     with no remount and no restart;
 *   · and a restart must reach the same answer, since the only thing that may change it
 *     is the server's state or new placements — never the age of the app process.
 *
 * The server is deliberately kept SAYING YES throughout. The titles a round reveals are
 * genuinely still candidates — Keep going is how a reader has them — so "done for now" is
 * the card declining to ask again, and a test that let the server fall silent would pass
 * without exercising it at all.
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

let mockStored: unknown = null;
const mockWritePref = jest.fn(() => Promise.resolve());
jest.mock('@/lib/prefs', () => ({
  readPref: () => Promise.resolve(mockStored),
  writePref: (...a: unknown[]) => mockWritePref(...(a as [])),
}));

/** The server inviting a sitting: four strong candidates, 40 placements behind them. */
const INVITING = {
  status: 'ready',
  candidates: [{ media_item_id: 'heat', title: 'Heat', position: 21, reason: 'neighbours' }],
  placements_total: 40,
  cta: { show: true, count: 4, qualifying: 9, strong: 4, resurface_after: 3 },
};

beforeEach(() => {
  mockStored = null;
  mockWritePref.mockClear();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: INVITING, error: null });
});

it('shows the card while the server invites one and nothing is stored', async () => {
  const { result } = await renderHookWithProviders(() => useRefineCard('user-1', 'movies'));

  await waitFor(() => expect(result.current.show).toBe(true));
  expect(result.current.count).toBe(4);
});

it('a finished sitting quiets the card without a remount', async () => {
  const { result, client } = await renderHookWithProviders(() =>
    useRefineCard('user-1', 'movies'),
  );
  await waitFor(() => expect(result.current.show).toBe(true));

  // Exactly what Done does at the end of a round, from the other screen.
  await act(async () => {
    await applyRefineNotNow(client, 'user-1', 'movies', 40);
  });

  // The notification lands on the next render, which is the frame the reader sees.
  await waitFor(() => expect(result.current.show).toBe(false));
  // ... and it was written down, so the next cold start agrees.
  expect(mockWritePref).toHaveBeenCalledWith(
    'user-1.collection.refine-not-now.movies',
    expect.objectContaining({ placementsAtDismissal: 40 }),
  );
});

it('a restart reaches the same answer as the sitting that ended', async () => {
  mockStored = { dismissedAt: '2026-09-22T21:00:00.000Z', placementsAtDismissal: 40 };

  const { result } = await renderHookWithProviders(() => useRefineCard('user-1', 'movies'));

  // The server still says yes; the stored dismissal is what holds the card back.
  await waitFor(() => expect(result.current.count).toBe(4));
  expect(result.current.show).toBe(false);
});

it('comes back once the reader has ranked enough since', async () => {
  mockStored = { dismissedAt: '2026-09-22T21:00:00.000Z', placementsAtDismissal: 40 };
  mockRpc.mockResolvedValue({
    data: { ...INVITING, placements_total: 43 },
    error: null,
  });

  const { result } = await renderHookWithProviders(() => useRefineCard('user-1', 'movies'));

  // Three new placements is `resurface_after`, the server's own number.
  await waitFor(() => expect(result.current.show).toBe(true));
});

it('never shows it before the stored answer has arrived', async () => {
  // A card that appears and then vanishes is worse than one a frame late. Storage that
  // never answers is how that is stated without a race: the server has said yes and its
  // count is through, and the card still does not appear.
  mockStored = new Promise(() => {});

  const { result } = await renderHookWithProviders(() => useRefineCard('user-1', 'movies'));

  await waitFor(() => expect(result.current.count).toBe(4));
  expect(result.current.show).toBe(false);
});
