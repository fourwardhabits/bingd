import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankingSheet } from './RankingSheet';

/**
 * **Two presses in one frame send one step** (2026-09-16).
 *
 * `busy` is state and disables the controls from the next render, so a poster and Undo
 * pressed inside the same frame both used to reach the server — in an order nobody
 * chose, with the screen drawing whichever reply came back last over a session the other
 * had moved. `act` now holds a ref for the step in flight.
 *
 * **In a file of its own, on purpose.** Two presses issued without awaiting between them
 * leave RNTL 14's renderer broken for every later render in the same file, so this test
 * lived in `RankingSheet.test.tsx` for one run and took 104 of its tests down with it.
 * Here it is the only render there is.
 */

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => {
      const answer = () =>
        Promise.resolve({ data: { id: 'film-p', title: 'Film P', poster_path: null }, error: null });
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        single: answer,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: jest.fn(),
}));
jest.mock('@/features/streaks/use-streak-advance', () => ({
  useStreakAdvance: () => () => Promise.resolve(null),
}));
jest.mock('@/features/collection/use-collection', () => ({
  ...jest.requireActual('@/features/collection/use-collection'),
  useRankedCollection: () => ({ data: [] }),
}));
jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issued += 1)}` }));

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

it('sends one step when a poster and Undo are pressed before the screen can redraw', async () => {
  mockRpc.mockImplementation(() =>
    Promise.resolve({ data: { done: false, session_id: 'session-1', pivot: 'film-p' }, error: null }),
  );
  const view = await renderWithProviders(
    <RankingSheet
      subject={{ id: 'film-a', title: 'Film A', bucket: 'loved', posterUri: null, kind: 'movie' }}
      onClose={jest.fn()}
      surface="search"
    />,
  );

  await waitFor(() =>
    expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(false),
  );
  const poster = view.getByLabelText('Choose Film A');
  const undo = view.getByLabelText('Undo the last comparison');

  // An answer that has not come back yet.
  mockRpc.mockImplementation(() => new Promise(() => {}));

  // Not awaited between: both handlers run before React commits the first one's state.
  await Promise.all([fireEvent.press(poster), fireEvent.press(undo)]);

  expect(callsTo('rank_answer')).toHaveLength(1);
  expect(callsTo('rank_back')).toHaveLength(0);
});
