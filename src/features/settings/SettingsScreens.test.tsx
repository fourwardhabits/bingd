import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screens: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import AccountScreen from '../../../app/settings/account';
import NotificationsScreen from '../../../app/settings/notifications';
import SettingsScreen from '../../../app/settings/index';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSignOut = jest.fn(() => Promise.resolve());
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      return Promise.resolve({ data: mockRpcResults[name] ?? null, error: null });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: () => Promise.resolve({ data: { visibility: 'public' }, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: [], error: null, count: 0 }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: () => {} }),
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
  signOut: () => mockSignOut(),
}));

// The picker is an image pipeline and a permission dialog; neither is what these tests
// are about, and it would otherwise reach expo-image-picker.
jest.mock('@/features/profile/AvatarPicker', () => ({ AvatarPicker: () => null }));

const request = {
  id: 'n1',
  kind: 'follow_request',
  created_at: '2026-08-17T10:00:00.000Z',
  read_at: null,
  actor_id: 'user-2',
  actor_username: 'ada',
  actor_display_name: 'Ada',
  actor_avatar_path: null,
  subject_type: 'profile',
  subject_id: 'user-2',
  media_item_id: null,
  media_title: null,
};

const comment = {
  ...request,
  id: 'n2',
  kind: 'comment',
  actor_username: 'bo',
  actor_display_name: 'Bo',
  subject_type: 'feed_event',
  media_item_id: 'film-1',
  media_title: 'Inception',
};

beforeEach(() => {
  mockPush.mockReset();
  mockReplace.mockReset();
  mockSignOut.mockClear();
  mockRpc.mockReset();
  mockRpcResults = {};
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * What this replaced was one accurate sentence — "Privacy, notifications, and account
 * controls are not built yet" — which survived because nothing in the database could
 * be reached from here. The bar for Phase F was no beta-critical placeholders, so the
 * first thing worth asserting is that the sentence is gone and the destinations are
 * real.
 */
describe('the Settings hub', () => {
  it('offers the five destinations rather than an apology', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByLabelText('Edit Profile, @sai')).toBeTruthy();
    expect(view.getByLabelText('Privacy')).toBeTruthy();
    expect(view.getByLabelText('Notifications')).toBeTruthy();
    expect(view.getByLabelText('Account & Data')).toBeTruthy();
    // About is a section on this screen rather than a destination — it is two
    // sentences and a link, and a row leading to that would be a row leading to less.
    expect(view.getByText('ABOUT')).toBeTruthy();
  });

  it('says nothing is unbuilt, because nothing on it is', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.queryByText(/not built yet/i)).toBeNull();
    expect(view.queryByText(/coming soon/i)).toBeNull();
  });

  it('keeps the TMDB attribution exactly as their terms word it', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(
      view.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.'),
    ).toBeTruthy();
  });

  it('surfaces the number of people waiting on the reader', async () => {
    // The only number on the screen, and the only thing in the app that is genuinely
    // a task: a reaction is news, a request is somebody waiting.
    mockRpcResults.my_notifications = [request, comment];
    const view = await renderWithProviders(<SettingsScreen />);

    await waitFor(() => expect(view.getByText('1 waiting')).toBeTruthy());
  });

  it('shows no count when nobody is waiting', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<SettingsScreen />);

    await waitFor(() => expect(view.getByLabelText('Notifications')).toBeTruthy());
    expect(view.queryByText(/waiting/)).toBeNull();
  });
});

/**
 * `respond_follow_request` has existed since 20260817000200 and nothing read the
 * `follow_request` row it answers. A private account could receive requests and had
 * nowhere to see them — the private setting was a way to become unreachable rather
 * than a way to choose.
 */
describe('follow requests', () => {
  it('shows who is waiting, and offers both answers', async () => {
    mockRpcResults.my_notifications = [request];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('@ada · wants to follow you')).toBeTruthy();
    expect(view.getByText('Approve')).toBeTruthy();
    expect(view.getByText('Decline')).toBeTruthy();
  });

  it('approves through the existing writer rather than touching follows', async () => {
    mockRpcResults.my_notifications = [request];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Approve')).toBeTruthy());
    await fireEvent.press(view.getByText('Approve'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'respond_follow_request',
        expect.objectContaining({ p_requester_id: 'user-2', p_approve: true }),
      ),
    );
  });

  it('declines through the same writer, which is silent by design', async () => {
    mockRpcResults.my_notifications = [request];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Decline')).toBeTruthy());
    await fireEvent.press(view.getByText('Decline'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'respond_follow_request',
        expect.objectContaining({ p_requester_id: 'user-2', p_approve: false }),
      ),
    );
  });

  it('links the person asking to their profile', async () => {
    mockRpcResults.my_notifications = [request];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Ada, @ada, wants to follow you'));

    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('names the title behind a comment, so the row can be acted on', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());
    expect(view.getByText(' commented on your activity')).toBeTruthy();
    expect(view.getByText(' · Inception')).toBeTruthy();
  });

  it('marks the inbox read on opening it, which is what read means for a list', async () => {
    mockRpcResults.my_notifications = [comment];
    await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('mark_notifications_read', undefined));
  });

  it('says so plainly when there is nothing', async () => {
    mockRpcResults.my_notifications = [];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Nothing yet')).toBeTruthy());
  });
});

/**
 * The one action in the app that cannot be undone by any means.
 */
describe('deleting an account', () => {
  it('will not fire until the handle is typed', async () => {
    const view = await renderWithProviders(<AccountScreen />);

    const button = view.getByRole('button', { name: 'Delete my account' });
    expect(button.props.accessibilityState.disabled).toBe(true);
  });

  it('will not accept somebody else’s handle', async () => {
    const view = await renderWithProviders(<AccountScreen />);

    await fireEvent.changeText(view.getByLabelText('Type sai to confirm'), 'ada');

    expect(view.getByRole('button', { name: 'Delete my account' }).props.accessibilityState.disabled).toBe(true);
  });

  it('enables once the caller types their own handle', async () => {
    const view = await renderWithProviders(<AccountScreen />);

    await fireEvent.changeText(view.getByLabelText('Type sai to confirm'), 'Sai');

    // Case-insensitive, because the keyboard capitalises and the column is citext.
    expect(view.getByRole('button', { name: 'Delete my account' }).props.accessibilityState.disabled).toBe(false);
  });

  it('asks once more before it does anything', async () => {
    const view = await renderWithProviders(<AccountScreen />);
    await fireEvent.changeText(view.getByLabelText('Type sai to confirm'), 'sai');
    await fireEvent.press(view.getByRole('button', { name: 'Delete my account' }));

    // The typed handle is not the confirmation on its own — a destructive action that
    // fires straight off a text field is one autocomplete away from an accident.
    expect(Alert.alert).toHaveBeenCalledWith(
      'Delete your account?',
      expect.stringContaining('cannot be undone'),
      expect.any(Array),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('delete_account', expect.anything());
  });

  it('says what survives, rather than claiming everything goes', async () => {
    // A tester deciding whether to trust this app with a year of their viewing
    // deserves the actual answer.
    const view = await renderWithProviders(<AccountScreen />);

    expect(view.getByText(/handle stays reserved/)).toBeTruthy();
  });

  it('does not describe a moderation report as anonymous, because it is not', async () => {
    // Independent review 14, fourth Major: reports were listed under "kept with
    // nothing left that points at you", and that was false — `reports.subject_id`
    // still names the account when the report was about a profile, and `reports.note`
    // is free text somebody typed. They survive deliberately, because an account that
    // could delete the complaints against it by closing itself makes reporting
    // worthless. The screen now says so in its own category.
    const view = await renderWithProviders(<AccountScreen />);

    expect(view.getByText('Kept as a safety record, and not anonymous:')).toBeTruthy();
    expect(view.getByText(/Reports made about you or by you/)).toBeTruthy();

    const anonymousList = view.getByText('Kept, with nothing left that names you:');
    expect(anonymousList).toBeTruthy();
    expect(view.queryByText(/Moderation reports, so a record/)).toBeNull();
  });

  it('offers no deactivation, because there is no such state', async () => {
    // `profile_status` is (active, suspended). A control that pretends to hide an
    // account and only signs it out would be the fake control this run forbids.
    const view = await renderWithProviders(<AccountScreen />);

    expect(view.queryByText(/deactivat/i)).toBeTruthy();
    expect(view.getByText(/There is no deactivation/)).toBeTruthy();
  });

  it('signs out without touching anything', async () => {
    const view = await renderWithProviders(<AccountScreen />);

    await fireEvent.press(view.getByText('Sign out'));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(mockRpc).not.toHaveBeenCalledWith('delete_account', expect.anything());
    expect(mockReplace).toHaveBeenCalledWith('/');
  });
});
