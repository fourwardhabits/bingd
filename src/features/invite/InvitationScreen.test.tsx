/**
 * The invitation screen's wiring, and only its wiring.
 *
 * Independent review 26d asked for this specifically, and the reason is worth keeping:
 * `claimForRedemption` and `serialiseRedemption` are unit-tested in this directory, but
 * **nothing proved the screen still calls them**. A future edit that reached for
 * `redeemInvite` directly would leave every one of those tests green while reopening
 * exactly the attribution divergence three review rounds were spent closing.
 *
 * So this file asserts the two things only a render can: that accepting sends the token
 * **on screen**, and that it does so through the queue.
 */

import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import InvitationScreen from '../../../app/i/[token]';
import { holdInvite } from './pending';
import { resetRedemptionQueueForTests } from './serialise';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const mockRpc = jest.fn();
let mockRpcResult: unknown = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockRpcResult, error: null });
    },
    auth: { signOut: () => Promise.resolve({ error: null }) },
  },
}));

jest.mock('@/lib/analytics', () => ({
  __esModule: true,
  track: jest.fn(),
  setAcquisition: jest.fn(),
}));

let mockStored: Record<string, string> = {};
jest.mock('@/lib/prefs', () => ({
  __esModule: true,
  readPref: (name: string) =>
    Promise.resolve().then(() => (mockStored[name] ? JSON.parse(mockStored[name]) : null)),
  writePref: (name: string, value: unknown) =>
    Promise.resolve().then(() => {
      mockStored[name] = JSON.stringify(value);
    }),
}));

let mockIssued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(mockIssued += 1)}` }));

let mockToken = B;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: mockToken }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useAuth: () => ({
    status: 'ready',
    userId: 'user-1',
    profile: { id: 'user-1', username: 'me', display_name: 'Me' },
  }),
  signOut: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  mockRpc.mockClear();
  mockStored = {};
  mockIssued = 0;
  mockToken = B;
  mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };
  resetRedemptionQueueForTests();
});

describe('accepting an invitation', () => {
  it('sends the token that is on screen, not the one that was already held', async () => {
    /**
     * The regression the whole 26 → 26d sequence converges on. Token A is pending — the
     * person opened its link earlier — and they are now looking at B. Accepting must
     * redeem **B**.
     *
     * The screen has one call site for `claimForRedemption`, and this is what proves it
     * is still there.
     */
    await holdInvite(A);

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(view.getByText('Accept invitation'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    const [, args] = mockRpc.mock.calls[0] as [string, { p_token: string }];
    expect(args.p_token).toBe(B);
  });

  it('makes the accepted invitation the pending one, so nothing redeems the other after it', async () => {
    // Without this, a non-final answer leaves A pending and the background hook redeems
    // it behind the person who just accepted B.
    await holdInvite(A);

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(view.getByText('Accept invitation'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalled());
    await waitFor(() => expect(JSON.parse(mockStored['invite.pendingToken'] ?? 'null')).toBeNull());
  });

  it('reports a replay that attributed nothing as unaccepted', async () => {
    // `already_applied` with `attributed: false` means the original call was refused.
    // Saying "already accepted" there is the one thing this screen must not do.
    mockRpcResult = { status: 'already_applied', attributed: false };

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(view.getByText('Accept invitation'));

    await waitFor(() => expect(view.getByText('This invitation was not accepted')).toBeTruthy());
  });

  it('says which of the two follow states acceptance produced', async () => {
    mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'pending' };

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(view.getByText('Accept invitation'));

    await waitFor(() => expect(view.getByText(/asked to follow @ada/)).toBeTruthy());
  });

  /**
   * **The one sentence that tells the invitee what they have to do, and it was unpinned.**
   *
   * This screen is the only place the activation bar is stated to the person who has to
   * clear it. It read "Rank ten titles and they will hear about it" until 2026-09-11,
   * when activation moved to the completed First Five — and no test anywhere held it, so
   * the copy and the SQL were free to disagree silently. They did, for as long as it took
   * somebody to look.
   *
   * A wrong number here costs more than a wrong number in Settings. The reader has just
   * arrived, is about to be handed the onboarding run, and is being told how much of it
   * counts. "Ten" would send them past the end of First Five looking for a milestone that
   * had already happened.
   *
   * Pinned both ways, because the sentence is rewritable and the contract is not.
   */
  it('tells the invitee the bar their inviter is actually waiting on', async () => {
    mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(view.getByText('Accept invitation'));

    await waitFor(() =>
      expect(view.getByText(/Rank your first five and they will hear about it\./)).toBeTruthy(),
    );
    // The retired contract, which must not come back under any wording.
    expect(view.queryByText(/ten titles/i)).toBeNull();
    expect(view.queryByText(/first ten/i)).toBeNull();
  });

  it('refuses a malformed token without calling the server', async () => {
    mockToken = 'not-a-token';

    const view = await renderWithProviders(<InvitationScreen />);

    expect(view.getByText('That invitation link is incomplete')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
