import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

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
/**
 * Errors to answer an RPC with, **in order**, one per call.
 *
 * A queue rather than a value because the deletion path can now ask twice: an unanswered
 * `delete_account` may have committed, and `20260817000700` makes the function
 * idempotent by nature so that asking again is what establishes which. Testing that needs
 * the two calls to be answerable differently.
 */
let mockRpcErrors: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name]?.shift() ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error });
    },
    // The account screen sweeps the avatar folder before it deletes anything. An empty
    // folder is the uninteresting case and keeps these tests about the deletion.
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        remove: () => Promise.resolve({ error: null }),
      }),
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
  // The inbox query refetches when the screen it is on regains focus, so anything
  // rendering a bell reaches for this. A no-op here: focus is not what these test.
  useFocusEffect: () => {},
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

// A public release build, because that is the reader the diagnostics question is about:
// the detailed block is gated on `isRelease`, so asserting its absence on any other lane
// would assert nothing at all.
//
// `lane` rather than `variant` since review 28. A **Beta** build is `variant: 'production'`
// and is not a release — it carries the store bundle identifier against the nonproduction
// backend — so the old gate hid the diagnostics from the friend beta, which is the one
// audience that needed them. Mocking `variant: 'production'` alone would now leave
// `isRelease` undefined and quietly re-enable the block, so the lane is stated too.
// `src/lib/env.test.ts` covers the derivation itself.
jest.mock('@/lib/env', () => ({
  env: { variant: 'production', lane: 'production' },
  lane: 'production',
  isProduction: true,
  isRelease: true,
  showEnvironmentBadge: false,
}));

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
  mockRpcErrors = {};
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
/**
 * Privacy, Terms and Support, reachable from Settings.
 *
 * The store-facing half of this is the reason it is tested at all: both stores require a
 * privacy policy the user can reach, and an in-app Terms link is what makes the signup
 * acknowledgment mean anything after signup — a document you agreed to and can never
 * open again is not a document.
 *
 * They open the web copies rather than rendering in the app, which `lib/legal.ts`
 * explains: a policy in the binary can only be corrected by shipping a build, and until
 * that build lands two versions of the same document are live at once.
 */
describe('the legal group in Settings', () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

  beforeEach(() => openURL.mockClear());

  it('offers all three documents', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByLabelText('Privacy Policy')).toBeTruthy();
    expect(view.getByLabelText('Terms of Use')).toBeTruthy();
    expect(view.getByLabelText('Support')).toBeTruthy();
  });

  it('sends each one to its own canonical address', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    for (const [label, url] of [
      ['Privacy Policy', 'https://bingd.app/privacy'],
      ['Terms of Use', 'https://bingd.app/terms'],
      ['Support', 'https://bingd.app/support'],
    ] as const) {
      await fireEvent.press(view.getByLabelText(label));
      expect(openURL).toHaveBeenCalledWith(url);
    }
  });

  /**
   * A row that closes Settings and opens Safari is not the same promise as a row that
   * pushes a screen, and a chevron only makes the second one. Announced as a link, with
   * a hint, so a screen-reader user is not surprised by leaving the app.
   */
  it('announces them as links that leave the app', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    const terms = view.getByLabelText('Terms of Use');
    expect(terms.props.accessibilityRole).toBe('link');
    expect(terms.props.accessibilityHint).toBe('Opens in your browser');

    // And the in-app destinations are still buttons, so the distinction says something.
    expect(view.getByLabelText('Privacy').props.accessibilityRole).toBe('button');
  });

  /**
   * The policies are not duplicated into the app. If the Terms text itself ever appears
   * on this screen, there are two copies of a legal document in the world and only one
   * of them can be corrected without a release.
   */
  it('does not reproduce the policy text in the app', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.queryByText(/You need to be 13 or older/)).toBeNull();
    expect(view.queryByText(/LEGAL ENTITY/)).toBeNull();
  });
});

describe('the Settings hub', () => {
  it('offers the four destinations rather than an apology', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByLabelText('Edit Profile, @sai')).toBeTruthy();
    expect(view.getByLabelText('Privacy')).toBeTruthy();
    expect(view.getByLabelText('Notification Settings')).toBeTruthy();
    expect(view.getByLabelText('Account & Data')).toBeTruthy();
    // About is a section on this screen rather than a destination — it is two
    // sentences and a link, and a row leading to that would be a row leading to less.
    expect(view.getByText('ABOUT')).toBeTruthy();
  });

  /**
   * The founder's Preview correction: Settings had a Notifications row leading to the
   * inbox, and the bell in the Feed and Profile headers already leads there.
   *
   * The removal is the easy half. The half worth a test is that nothing else went with
   * it — the inbox screen, the bell and the preferences screen are all untouched, and
   * an over-eager cleanup that took the preferences row instead would leave the reader
   * with no way to reach their switches at all.
   */
  it('does not lead to the notification inbox, which the bell already opens', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.queryByLabelText('Notifications')).toBeNull();
    expect(view.queryByText(/waiting/)).toBeNull();
  });

  it('still leads to the notification preferences', async () => {
    const view = await renderWithProviders(<SettingsScreen />);

    await fireEvent.press(view.getByLabelText('Notification Settings'));
    expect(mockPush).toHaveBeenCalledWith('/settings/notification-preferences');
    expect(mockPush).not.toHaveBeenCalledWith('/settings/notifications');
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

  it('names themoviedb.org as the source, and says what TMDB supplies', async () => {
    // TMDB's terms ask for four things in an About section: the notice above,
    // unparaphrased; a visible link to themoviedb.org; a clear indication of which
    // data is theirs; and their approved logo, unmodified. The logo is asserted in
    // its own test below.
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByText('themoviedb.org')).toBeTruthy();
    expect(
      view.getByText(/Artwork, cast and title details come from TMDB/),
    ).toBeTruthy();
  });

  it('carries the approved TMDB logo in the About section', async () => {
    // The asset is TMDB's own primary short (blue) SVG, committed byte-for-byte from
    // themoviedb.org/about/logos-attribution. This asserts it is on the screen and
    // labelled for a screen reader; that the file itself is the approved one is the
    // committed asset's checksum against the hash TMDB embeds in its download URL.
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByLabelText('TMDB')).toBeTruthy();
  });

  it('carries no pending-request count, because it no longer leads to the inbox', async () => {
    /**
     * This screen used to show "1 waiting" beside a Notifications row, and it was the
     * only number on it. The count went with the row in the founder's Preview pass —
     * not because it was wrong, but because it was a badge on a door that is gone.
     *
     * **The reader does not lose it.** `AppHeader`'s bell carries the unread count on
     * Feed and Profile, and a follow request is a notification, so it is counted there.
     * That is asserted where the bell lives rather than here.
     */
    mockRpcResults.my_notifications = [request, comment];
    const view = await renderWithProviders(<SettingsScreen />);

    await waitFor(() => expect(view.getByLabelText('Privacy')).toBeTruthy());
    expect(view.queryByText('1 waiting')).toBeNull();
    expect(view.queryByText(/waiting/)).toBeNull();
  });

  it('signs out from here, in its own group, without touching anything', async () => {
    // The founder's correction: sign-out used to live inside Account & Data, one row
    // from permanent deletion. One is how you finish for the day and the other cannot
    // be undone, and a screen offering them together invites the wrong tap.
    const view = await renderWithProviders(<SettingsScreen />);

    await fireEvent.press(view.getByLabelText('Sign out'));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(mockRpc).not.toHaveBeenCalledWith('delete_account', expect.anything());
    // Replaced rather than pushed, so Settings is not behind a back gesture on a
    // session that no longer exists.
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  it('shows a version a person can read aloud, and no fingerprints', async () => {
    // What this replaced put six rows of release identity — runtime fingerprint,
    // update id, channel, download time — in front of every reader. A support
    // conversation starts with a version and a build number.
    const view = await renderWithProviders(<SettingsScreen />);

    expect(view.getByText(/^bingd\. .+ \(.+\)$/)).toBeTruthy();
    expect(view.queryByText(/^runtime /)).toBeNull();
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
    await fireEvent.press(view.getByLabelText('Unread. Ada, @ada, wants to follow you'));

    expect(mockPush).toHaveBeenCalledWith('/u/ada');
  });

  it('names the title behind a comment, so the row can be acted on', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());
    expect(view.getByText(' commented on your activity')).toBeTruthy();
    // On its own line since friend recommendations arrived: "Suraj recommended a
    // movie" and then "Inception" is the founder's shape, and it also stops a long
    // title pushing the verb off the row.
    expect(view.getByText('Inception')).toBeTruthy();
  });

  /**
   * **Seeing them is what reads them**, as of 2026-08-23.
   *
   * This screen has had both behaviours. It began by marking the inbox read on first
   * render, which made `read_at` a column with one observable value; that was replaced
   * by a reader-driven `Mark all read`; and beta feedback is that pressing a button to
   * say "yes, I looked" is friction with nothing on the other side of it.
   *
   * The objection the middle version answered still holds and is still answered: the
   * marking happens *after* the rows are on screen, so the first paint is the unread
   * one. What is gone is the requirement to press anything.
   */
  it('shows the rows unread first, then marks them read without being asked', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    // Drawn unread — the reader sees what was new on this visit.
    await waitFor(() => expect(view.getByLabelText(/^Unread\. Bo/)).toBeTruthy());
    // And read without a tap.
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('mark_notifications_read', undefined),
    );
  });

  it('asks the server once, not once per render', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('mark_notifications_read', undefined),
    );
    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());

    const calls = mockRpc.mock.calls.filter(([name]) => name === 'mark_notifications_read');
    expect(calls).toHaveLength(1);
  });

  it('asks nothing when everything was already read', async () => {
    mockRpcResults.my_notifications = [{ ...comment, read_at: '2026-08-17T11:00:00.000Z' }];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());
    expect(mockRpc).not.toHaveBeenCalledWith('mark_notifications_read', undefined);
  });

  /**
   * Found by independent review of this change. With `Mark all read` gone there is no
   * manual way back, so a failed mark that latched would leave the reader looking at
   * unread rows and a lit bell with nothing to press until the screen was remounted.
   */
  it('tries again after a failed mark, rather than latching', async () => {
    mockRpcErrors.mark_notifications_read = [{ code: '53400', message: 'nope' }];
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('mark_notifications_read', undefined),
    );
    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());

    // The refusal released the latch, so the rows are still unread and still markable.
    expect(view.getByLabelText(/^Unread\. Bo/)).toBeTruthy();

    /**
     * **And released is not the same as spinning**, which is the second half of the
     * same finding. Depending on the `useMutation` result rather than on its `mutate`
     * would re-run the effect the moment `onError` cleared the latch — a new object
     * identity every time the mutation's state changed — and the retry would go
     * straight back into the call that had just failed. One attempt, and then it waits
     * for a real refetch.
     */
    await act(async () => {
      await Promise.resolve();
    });
    const attempts = mockRpc.mock.calls.filter(
      ([name]) => name === 'mark_notifications_read',
    );
    expect(attempts).toHaveLength(1);
  });
  it('no longer offers a control for something that needs no asking', async () => {
    mockRpcResults.my_notifications = [comment];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Bo')).toBeTruthy());
    expect(view.queryByText('Mark all read')).toBeNull();
    expect(view.queryByText(/unread$/)).toBeNull();
    expect(view.queryByText(/unread/)).toBeNull();
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

  /**
   * **A deletion that commits and loses its reply**, which independent review 21f found
   * as the last member of the family reviews 21c to 21e worked through.
   *
   * The account is gone — the auth user, and every cascade with it — and the client saw
   * an error. It used to say "Could not delete your account" and leave the person signed
   * in against something that no longer exists, with their profile still drawn from
   * cache. There is no cache to reconcile against here, because what changed is whether
   * the account exists; what there is instead is a server function that answers
   * `already_applied` once the profile is gone (`20260817000700`), so asking again turns
   * "unknown" into an answer.
   */
  describe('when the answer is lost', () => {
    const confirmAndDelete = async () => {
      const view = await renderWithProviders(<AccountScreen />);
      await fireEvent.changeText(view.getByLabelText('Type sai to confirm'), 'sai');
      await fireEvent.press(view.getByRole('button', { name: 'Delete my account' }));

      const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as {
        text: string;
        onPress?: () => void;
      }[];
      const destructive = buttons.find((button) => button.text === 'Delete for good');
      await act(async () => {
        destructive?.onPress?.();
        // The handler is an async IIFE the press does not await, so the queue has to be
        // drained before anything is asserted about what it did.
        await Promise.resolve();
      });
      return view;
    };

    const callsToDelete = () =>
      mockRpc.mock.calls.filter(([name]) => name === 'delete_account');

    it('asks again, and finishes the sign-out when the account had already gone', async () => {
      // First reply lost; the second finds the profile already deleted and says so.
      mockRpcErrors.delete_account = [{ code: '', message: 'TypeError: Network request failed' }];
      mockRpcResults.delete_account = { status: 'already_applied' };

      await confirmAndDelete();

      await waitFor(() => expect(callsToDelete()).toHaveLength(2));
      // The point of the whole fix: the person leaves, rather than being told it failed
      // over an account that is not there.
      await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    it('asks again for 08007, which carries a code and still proves nothing', async () => {
      mockRpcErrors.delete_account = [{ code: '08007', message: 'transaction resolution unknown' }];
      mockRpcResults.delete_account = { status: 'already_applied' };

      await confirmAndDelete();

      await waitFor(() => expect(callsToDelete()).toHaveLength(2));
      await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    });

    it('reports the refusal when the second attempt is answered no', async () => {
      // The first reply was lost and the account is still here — the confirmation was
      // wrong, or the delete is genuinely blocked. The person stays signed in and is
      // told the real reason rather than a transport error.
      mockRpcErrors.delete_account = [
        { code: '', message: 'TypeError: Network request failed' },
        { code: '22023', message: 'type your username to confirm' },
      ];

      await confirmAndDelete();

      await waitFor(() => expect(callsToDelete()).toHaveLength(2));
      expect(mockSignOut).not.toHaveBeenCalled();
      // The failure alert, not the "we could not tell" one. The sentence itself is the
      // generic fallback: `diagnose` withholds Postgres wording in a release build, and
      // that is deliberate and unrelated to this.
      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith(
          'Could not delete your account',
          expect.any(String),
        ),
      );
      expect(Alert.alert).not.toHaveBeenCalledWith(
        'We could not confirm that',
        expect.any(String),
      );
    });

    it('signs out and says it could not tell when neither attempt is answered', async () => {
      // Twice unanswered. Claiming it is gone would be a lie; leaving somebody holding a
      // token for an account that may not exist is the state with no next step.
      mockRpcErrors.delete_account = [
        { code: '', message: 'TypeError: Network request failed' },
        { code: '', message: 'TypeError: Network request failed' },
      ];

      await confirmAndDelete();

      await waitFor(() => expect(callsToDelete()).toHaveLength(2));
      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith(
          'We could not confirm that',
          expect.stringContaining('cannot tell you whether your account was deleted'),
        ),
      );
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    it('does not ask twice when the server refused the first time', async () => {
      // A refusal this app raises on purpose proves nothing was deleted. Repeating a
      // destructive call on the strength of a "no" would be inventing an intent.
      mockRpcErrors.delete_account = [{ code: '22023', message: 'type your username to confirm' }];

      await confirmAndDelete();

      await waitFor(() => expect(callsToDelete()).toHaveLength(1));
      expect(mockSignOut).not.toHaveBeenCalled();
    });
  });

  it('offers no sign-out beside the irreversible thing', async () => {
    // It moved to the Settings hub, and the assertion moved with it. What is left on
    // this screen is only the thing that cannot be undone, with the whole inventory of
    // what goes and what stays above it.
    const view = await renderWithProviders(<AccountScreen />);

    expect(view.queryByText('Sign out')).toBeNull();
    expect(view.getByRole('button', { name: 'Delete my account' })).toBeTruthy();
  });
});

/**
 * Follow back, and the recommendation row.
 *
 * Both arrived with 20260817001300. The follow-back control is the one worth guarding
 * hardest: it starts a relationship, it sits inside a list somebody scrolls, and the
 * person on the other end is notified either way — so it has to be absent everywhere
 * it would be wrong rather than merely present where it is right.
 */
describe('the inbox’s two new behaviours', () => {
  const followed = {
    id: 'n3',
    kind: 'follow',
    created_at: '2026-08-17T10:00:00.000Z',
    read_at: null,
    actor_id: 'user-2',
    actor_username: 'ada',
    actor_display_name: 'Ada',
    actor_avatar_path: null,
    subject_type: 'profile',
    subject_id: 'user-2',
    media_item_id: null,
    media_kind: null,
    media_title: null,
    series_title: null,
  };

  const recommended = {
    ...followed,
    id: 'n4',
    kind: 'recommendation',
    subject_type: 'media_item',
    subject_id: 'film-1',
    media_item_id: 'film-1',
    media_kind: 'movie',
    media_title: 'Inception',
    series_title: null,
  };

  it('offers Follow back when the reader does not already follow them', async () => {
    mockRpcResults.my_notifications = [followed];
    mockRpcResults.follow_state_with = [
      { user_id: 'user-2', following: null, followed_by: 'approved', blocked: false },
    ];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Follow back')).toBeTruthy());
    await fireEvent.press(view.getByText('Follow back'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'follow',
        expect.objectContaining({ p_followee_id: 'user-2' }),
      ),
    );
  });

  /**
   * **Both of these wait for the control to *go*, and the wait is the assertion.**
   *
   * `getByText('Ada')` is the wrong anchor on its own, and this suite failed on CI
   * proving it (run 32739006812). The row and the relationship come from two different
   * queries — `my_notifications` and `follow_state_with` — and only the first is settled
   * when the name is on screen. `canFollowBack(row, outgoing)` returns true while
   * `outgoing` is `undefined`, so between the two resolutions the row genuinely renders
   * "Follow back" and then removes it. On a quiet machine both had landed; on a loaded
   * runner the second had not, and the assertion read the intermediate frame.
   *
   * `waitFor` around the absence is not a weaker check — it is the same claim about the
   * settled state, and it still fails if the control never goes. The `getByText` above
   * stays, because it is what stops the whole thing passing on a row that never rendered.
   *
   * **The flash itself is real and is not a test artefact.** A reader whose follow is
   * already mutual sees "Follow back" for as long as `follow_state_with` takes. It is a
   * frame of a control that should not be there, and it is out of scope here — recorded
   * rather than fixed in a moderation tranche.
   */
  it('does not offer it when the follow is already mutual', async () => {
    mockRpcResults.my_notifications = [followed];
    mockRpcResults.follow_state_with = [
      { user_id: 'user-2', following: 'approved', followed_by: 'approved', blocked: false },
    ];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await waitFor(() => expect(view.queryByText('Follow back')).toBeNull());
  });

  it('does not offer it while the reader’s own request is still pending', async () => {
    mockRpcResults.my_notifications = [followed];
    mockRpcResults.follow_state_with = [
      { user_id: 'user-2', following: 'pending', followed_by: 'approved', blocked: false },
    ];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await waitFor(() => expect(view.queryByText('Follow back')).toBeNull());
  });

  it('does not put Follow back beside Approve and Decline', async () => {
    // A request row already asks the reader a question. A third control that quietly
    // starts a relationship in the other direction is one mis-tap from a follow
    // nobody meant.
    mockRpcResults.my_notifications = [request];
    mockRpcResults.follow_state_with = [
      { user_id: 'user-2', following: null, followed_by: 'pending', blocked: false },
    ];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Approve')).toBeTruthy());
    expect(view.queryByText('Follow back')).toBeNull();
  });

  it('says which kind of thing was recommended, and names it', async () => {
    mockRpcResults.my_notifications = [recommended];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText(' recommended a movie')).toBeTruthy();
    expect(view.getByText('Inception')).toBeTruthy();
  });

  it('names the show a recommended season belongs to', async () => {
    mockRpcResults.my_notifications = [
      {
        ...recommended,
        media_kind: 'season',
        media_title: 'Season 2',
        series_title: 'Parks and Recreation',
      },
    ];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText(' recommended a season')).toBeTruthy());
    expect(view.getByText('Parks and Recreation, S2')).toBeTruthy();
  });

  it('opens the exact title rather than the sender', async () => {
    mockRpcResults.my_notifications = [recommended];
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Unread. Ada recommended a movie, Inception'));

    expect(mockPush).toHaveBeenCalledWith('/title/film-1');
  });
});
