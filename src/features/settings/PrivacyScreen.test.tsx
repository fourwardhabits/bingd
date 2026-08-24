import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import PrivacyScreen from '../../../app/settings/privacy';

/**
 * **The privacy screen had no test at all, and said something untrue.**
 *
 * Until 2026-08-23 the explanation under the switch told the reader that "while your
 * account is private, your profile does not appear in search". That stopped being true
 * on 2026-08-19, when `search_users` moved from `can_view_profile` to
 * `can_discover_profile` so that a private account can be *found* and asked to follow
 * without any of its content being readable. Nothing caught the drift, because nothing
 * rendered this screen.
 *
 * These are deliberately about the copy rather than about the switch. A privacy screen
 * is a promise, and the promise is the part that was wrong.
 */

const mockAccount = { visibility: 'public' as 'public' | 'private' };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        single: () =>
          Promise.resolve({ data: { visibility: mockAccount.visibility }, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

jest.mock('@/features/profile/use-social', () => ({
  useMyBlocks: () => ({ data: [], isPending: false }),
  useSocialWrites: () => ({ unblock: jest.fn(), busy: false }),
}));

jest.mock('@/features/settings/use-account', () => ({
  useAccountWrites: () => ({ setVisibility: jest.fn(), busy: false }),
}));

jest.mock('@/features/invite', () => ({ revokeInviteLink: jest.fn() }));

beforeEach(() => {
  mockAccount.visibility = 'public';
});

const open = async () => {
  const view = await renderWithProviders(<PrivacyScreen />);
  await waitFor(() => expect(view.getByLabelText('Private account')).toBeTruthy());
  return view;
};

describe('what the privacy screen promises', () => {
  it('never claims a private account is hidden from search', async () => {
    mockAccount.visibility = 'private';
    const view = await open();

    await waitFor(() =>
      expect(view.queryByText(/does not appear in search/)).toBeNull(),
    );
    // The positive form of the same assertion, so this cannot pass by the copy simply
    // having been deleted.
    expect(view.getByText(/can still find you by name or @handle/)).toBeTruthy();
  });

  it('names what a private account actually withholds', async () => {
    mockAccount.visibility = 'private';
    const view = await open();

    await waitFor(() =>
      expect(view.getByText(/ranked titles, watchlist, reviews and activity/)).toBeTruthy(),
    );
  });

  /**
   * The public case had no explanation at all — the old block described the private
   * setting whichever one you were on, so a public account was told nothing about what
   * that meant.
   */
  it('tells a public account what public means', async () => {
    const view = await open();

    await waitFor(() =>
      expect(view.getByText(/Anyone on bingd. can see your ranked titles/)).toBeTruthy(),
    );
    expect(view.queryByText(/can still find you by name or @handle/)).toBeNull();
  });

  it('promises watch dates and unshared notes on both settings', async () => {
    const publicView = await open();
    await waitFor(() =>
      expect(publicView.getByText(/Your watch dates are never shown to anybody/)).toBeTruthy(),
    );

    mockAccount.visibility = 'private';
    const privateView = await open();
    await waitFor(() =>
      expect(privateView.getByText(/Your watch dates are never shown to anybody/)).toBeTruthy(),
    );
  });

  /**
   * `isPrivate` is false while the read is in flight, so branching on it would describe
   * the public setting to somebody who is private for as long as the query takes. The
   * switch already refuses to guess; the copy has to refuse too.
   */
  it('describes neither setting until it knows which one is on', async () => {
    const view = await renderWithProviders(<PrivacyScreen />);

    expect(view.queryByText(/Anyone on bingd. can see your ranked titles/)).toBeNull();
    expect(view.queryByText(/can still find you by name or @handle/)).toBeNull();
  });
});
