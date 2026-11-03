/**
 * The invitation screen's wiring, and only its wiring.
 *
 * Independent review 26d asked for this specifically, and the reason is worth keeping:
 * `claimForRedemption` and `serialiseRedemption` are unit-tested in this directory, but
 * **nothing proved the screen still calls them**. A future edit that reached for
 * `acceptInvite` directly would leave every one of those tests green while reopening
 * exactly the attribution divergence three review rounds were spent closing.
 *
 * So this file asserts the two things only a render can: that accepting sends the token
 * **on screen**, and that it does so through the queue.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import InvitationScreen from '../../../app/i/[token]';
import { holdInvite, pendingInvite } from './pending';
import { resetRedemptionQueueForTests } from './serialise';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const mockRpc = jest.fn();
let mockRpcResult: unknown = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };
const READY = { status: 'ok', kind: 'personal', inviter_username: 'ada', inviter_display_name: 'Ada L' };
let mockPreview: { data: unknown; error: unknown } = { data: READY, error: null };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve(
        name === 'invite_preview' ? mockPreview : { data: mockRpcResult, error: null },
      );
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
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ token: mockToken }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

const signedIn = (visibility: 'public' | 'private' = 'public') => ({
  status: 'ready',
  userId: 'user-1',
  profile: { id: 'user-1', username: 'me', display_name: 'Me', visibility },
});
let mockAuth: unknown = signedIn();
jest.mock('@/features/auth', () => ({
  useAuth: () => mockAuth,
  signOut: jest.fn(() => Promise.resolve()),
}));

/** The acceptances the server received, without the read that names the inviter. */
const acceptances = () => mockRpc.mock.calls.filter(([name]) => name !== 'invite_preview');
const pressAccept = async () => {
  await fireEvent.press(await screen.findByText('Accept invitation'));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  mockRpc.mockClear();
  mockStored = {};
  mockIssued = 0;
  mockToken = B;
  mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };
  mockPreview = { data: READY, error: null };
  mockAuth = signedIn();
  mockReplace.mockClear();
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

    await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() => expect(acceptances()).toHaveLength(1));
    const [name, args] = acceptances()[0] as [string, { p_token: string; p_accepting_user: string }];
    expect(name).toBe('accept_invite');
    expect(args.p_token).toBe(B);
    expect(args.p_accepting_user).toBe('user-1');
  });

  it('makes the accepted invitation the pending one, so nothing redeems the other after it', async () => {
    // Without this, a non-final answer leaves A pending and the background hook redeems
    // it behind the person who just accepted B.
    await holdInvite(A);

    await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() => expect(acceptances()).toHaveLength(1));
    await waitFor(() => expect(JSON.parse(mockStored['invite.pendingToken'] ?? 'null')).toBeNull());
  });

  it('reports a replay that attributed nothing as unaccepted', async () => {
    // `already_applied` with `attributed: false` means the original call was refused.
    // Saying "already accepted" there is the one thing this screen must not do.
    mockRpcResult = { status: 'already_applied', attributed: false };

    const view = await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() => expect(view.getByText('This invitation was not accepted')).toBeTruthy());
  });

  it('says which of the two follow states acceptance produced', async () => {
    mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'pending' };

    const view = await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() => expect(view.getByText(/asked to follow @ada/)).toBeTruthy());
  });

  /**
   * **The one sentence stating the activation bar to the person who has to clear it, and
   * it was unpinned by anything.**
   *
   * It read "Rank ten titles and they will hear about it" until 2026-09-11, so the copy
   * and the SQL were free to disagree in silence, and did.
   *
   * **It carries no number now, and that is the finding rather than a preference.** An
   * independent review asked who actually reaches this text, and the answer is: only an
   * account at any point in the flow. A new account lands here straight after the profile
   * form, before its first ranking, and an established one may be well past First Five, so
   * "rank your first five" is wrong for some of them. `_maybe_activate_invite` counts
   * `>=`, so what is true for all of them is the same sentence: keep ranking, and that
   * does it.
   *
   * Pinned both ways, because the sentence is rewritable and the contract is not.
   */
  it('tells the invitee the bar their inviter is actually waiting on', async () => {
    mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'approved' };

    const view = await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() =>
      expect(view.getByText(/Keep ranking and they will hear about it\./)).toBeTruthy(),
    );
    // The retired contract, which must not come back under any wording.
    expect(view.queryByText(/ten titles/i)).toBeNull();
    expect(view.queryByText(/first ten/i)).toBeNull();
  });

  it('says the two accounts now follow each other when both directions came out approved', async () => {
    mockRpcResult = { status: 'ok', inviter_username: 'ada', follow_state: 'approved', connected: true };

    const view = await renderWithProviders(<InvitationScreen />);
    await pressAccept();

    await waitFor(() => expect(view.getByText(/You and @ada now follow each other\./)).toBeTruthy());
  });

  it('refuses a malformed token without calling the server', async () => {
    mockToken = 'not-a-token';

    const view = await renderWithProviders(<InvitationScreen />);

    expect(view.getByText('That invitation link is incomplete')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/**
 * Security audit 2026-11-01, B-1. Merely opening this screen granted access, because it
 * stored the token and the layout redeemed it. These are the properties that stop it.
 */
describe('opening an invitation', () => {
  it('accepts nothing, and stores nothing, for somebody signed in', async () => {
    await renderWithProviders(<InvitationScreen />);
    await screen.findByText('Accept invitation');
    await settle();

    expect(acceptances()).toEqual([]);
    expect(await pendingInvite()).toBeNull();
  });

  it('lets go of a token held from before signing in, once it is on screen', async () => {
    await holdInvite(B);

    await renderWithProviders(<InvitationScreen />);
    await screen.findByText('Accept invitation');

    await waitFor(async () => expect(await pendingInvite()).toBeNull());
    expect(acceptances()).toEqual([]);
  });

  it('holds the token for somebody with no account, and asks the server nothing', async () => {
    for (const status of ['signed-out', 'onboarding']) {
      mockStored = {};
      mockRpc.mockClear();
      mockAuth = { status, userId: 'user-1', email: null };

      await renderWithProviders(<InvitationScreen />);

      await waitFor(async () => expect(await pendingInvite()).toBe(B));
      expect(mockRpc).not.toHaveBeenCalled();
    }
  });

  it('does not hold it before it knows who this is', async () => {
    mockAuth = { status: 'loading' };

    await renderWithProviders(<InvitationScreen />);
    await settle();

    expect(await pendingInvite()).toBeNull();
  });

  it('names the inviter and the account accepting, before the tap', async () => {
    const view = await renderWithProviders(<InvitationScreen />);

    expect(await view.findByText('Ada L (@ada) invited you to bingd')).toBeTruthy();
    expect(view.getByText(/You are signed in as @me\./)).toBeTruthy();
    expect(view.getByText(/you and @ada follow each other/)).toBeTruthy();
  });

  it('says what a private account is opening up, in so many words', async () => {
    mockAuth = signedIn('private');

    const view = await renderWithProviders(<InvitationScreen />);

    expect(
      await view.findByText(
        /Your account is private, and @ada will be able to see your rankings, watchlist and activity\./,
      ),
    ).toBeTruthy();
  });

  it('promises a referral only the one-way follow it delivers', async () => {
    mockPreview = { data: { ...READY, kind: 'referral' }, error: null };

    const view = await renderWithProviders(<InvitationScreen />);

    expect(await view.findByText(/records that you joined on this invitation and follows @ada/)).toBeTruthy();
    expect(view.queryByText(/follow each other/)).toBeNull();
  });

  it('does not offer Accept when it could not find out whose this is', async () => {
    mockPreview = { data: null, error: { code: '', message: 'Network request failed' } };

    const view = await renderWithProviders(<InvitationScreen />);

    expect(await view.findByText('Could not load this invitation', {}, { timeout: 9000 })).toBeTruthy();
    expect(view.queryByText('Accept invitation')).toBeNull();
  }, 12000);

  it('goes straight to the answer accepting would have given', async () => {
    mockPreview = { data: { status: 'refused', reason: 'self' }, error: null };

    const view = await renderWithProviders(<InvitationScreen />);

    expect(await view.findByText('That is your own link')).toBeTruthy();
    expect(view.queryByText('Accept invitation')).toBeNull();
    expect(acceptances()).toEqual([]);
  });
});

describe('Not now', () => {
  it('leaves, accepts nothing, and keeps nothing on the device', async () => {
    await holdInvite(A);
    mockToken = A;

    const view = await renderWithProviders(<InvitationScreen />);
    await fireEvent.press(await view.findByText('Not now'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/collection'));
    expect(acceptances()).toEqual([]);
    expect(await pendingInvite()).toBeNull();
  });
});
