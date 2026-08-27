import { waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import NotificationsScreen from '../../../app/settings/notifications';

/**
 * **The inbox the founder saw on Android, and the three things wrong with it.**
 *
 * All three were spacing rather than behaviour, and all three came from the same
 * habit: a control sized for a screen used inside a list row.
 *
 *   - "Mark all read" was a `Button`, whose 48pt minimum set the height of a strip
 *     holding one line of footnote type.
 *   - "Follow back" was a full-size `secondary` Button in a container with **no**
 *     horizontal padding, so it sat flush against the screen edge under an avatar
 *     indented by a gutter — the misalignment is what read as "detached".
 *   - The timestamp was an absolute date, which makes the reader do the subtraction.
 */

const mockNotifications: Record<string, unknown>[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string) => {
      if (name === 'my_notifications') {
        return Promise.resolve({ data: mockNotifications, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  Stack: { Screen: () => null },
  useFocusEffect: () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'me',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/** Empty by default, which is the state that offers Follow back. */
const mockRelationships = new Map<string, { following: string | null }>();
/** The ids the screen actually asked about, most recent call last. */
const mockAskedAbout: string[][] = [];

/**
 * **Answers only for the ids it was asked about**, which is the whole point.
 *
 * A mock that returned the map wholesale would satisfy a screen that never asked, and
 * that is precisely the defect independent review found: `invite_welcome` reached
 * `canFollowBack` without reaching the list of actors whose state gets fetched, so the
 * real screen saw `undefined` and offered Follow to somebody already followed. A test
 * has to be able to fail that way or it is not testing it.
 */
jest.mock('@/features/profile/use-social', () => ({
  useRelationships: (ids: string[]) => {
    mockAskedAbout.push(ids);
    const answered = new Map<string, { following: string | null }>();
    for (const id of ids) {
      const known = mockRelationships.get(id);
      if (known) answered.set(id, known);
    }
    return { data: answered };
  },
  useSocialWrites: () => ({ follow: jest.fn(), respondToRequest: jest.fn(), busy: false }),
}));

const follow = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1',
  kind: 'follow',
  type: 'follow',
  created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  read_at: null,
  actor_id: 'them',
  actor_username: 'ada',
  actor_display_name: 'Ada',
  actor_avatar_path: null,
  media_item_id: null,
  media_title: null,
  media_kind: null,
  series_title: null,
  subject_type: 'profile',
  subject_id: 'them',
  ...overrides,
});

beforeEach(() => {
  mockNotifications.length = 0;
  mockNotifications.push(follow());
  mockRelationships.clear();
  mockAskedAbout.length = 0;
});

const open = async () => {
  const view = await renderWithProviders(<NotificationsScreen />);
  await waitFor(() => expect(view.getByText(/started following you/)).toBeTruthy());
  return view;
};

/**
 * **Seeing them is what reads them**, as of 2026-08-23.
 *
 * The screen has had both behaviours: mark-on-open, then a reader-driven `Mark all
 * read`, and now this. Beta feedback was that pressing a button to say "yes, I looked"
 * is friction with nothing on the other side of it.
 *
 * The objection the middle version answered still holds and is still answered — the
 * marking happens *after* the rows are on screen, so the first paint is always the
 * unread one. What is gone is the requirement to press anything, and with it the
 * summary strip, which could never be reached once opening the screen cleared it.
 */
describe('reading is seeing', () => {
  it('paints the rows unread before it marks them', async () => {
    const view = await open();

    expect(view.getByLabelText(/^Unread\./)).toBeTruthy();
  });

  it('offers no control for something that needs no asking', async () => {
    const view = await open();

    expect(view.queryByLabelText('Mark all notifications read')).toBeNull();
    expect(view.queryByText(/unread$/)).toBeNull();
  });
});

describe('a follow notification', () => {
  it('dates itself in relative terms', async () => {
    const view = await open();

    expect(view.getByText('2d ago')).toBeTruthy();
  });

  /**
   * The alignment defect, asserted as arithmetic rather than by eye: the control has to
   * begin where the sentence above it begins, which is the gutter plus the avatar plus
   * the row's own gap.
   */
  it('lines Follow back up with the text rather than the screen edge', async () => {
    const view = await open();

    const button = view.getByRole('button', { name: 'Follow back' });
    const container = StyleSheet.flatten(button.parent?.props?.style);
    expect(container.paddingLeft).toBe(
      theme.layout.gutter + theme.layout.avatar.sm + theme.space[3],
    );
    // A row, so the button is as wide as its label and not as wide as the screen.
    expect(container.flexDirection).toBe('row');
  });

  it('draws Follow back at the compact size, with slop for the target', async () => {
    const view = await open();

    const button = view.getByRole('button', { name: 'Follow back' });
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeLessThan(theme.layout.buttonMinHeight);
    expect(button.props.hitSlop).toBe(theme.space[2]);
  });

  /**
   * Not a stale actionable control: once the reader follows back, the relationship
   * exists and a button offering to create it can only mislead.
   */
  it('withdraws Follow back once the reader already follows them', async () => {
    mockRelationships.set('them', { following: 'approved' });
    const view = await open();

    expect(view.queryByRole('button', { name: 'Follow back' })).toBeNull();
    // The notification itself stays; it is the offer that goes.
    expect(view.getByText(/started following you/)).toBeTruthy();
  });
});

describe('read is something the reader does', () => {
  it('is still drawn unread on the visit that reads it', async () => {
    const view = await open();

    // Still unread after the screen has rendered: only the control changes this.
    expect(view.getByLabelText(/^Unread./)).toBeTruthy();
  });
});
/**
 * **The row a brand-new account opens Bingd to.**
 *
 * `redeem_invite` has always notified the inviter and, since `20260819000500`, created
 * the invitee's follow for them. The invitee was told nothing — so the person who had
 * never seen the app arrived to a follow they did not watch happen and an empty inbox.
 * `20260823000100` files the missing half; these assert how it reads.
 */
describe('the welcome an invitation writes back', () => {
  const welcome = (overrides: Record<string, unknown> = {}) =>
    follow({
      id: 'w1',
      kind: 'invite_welcome',
      type: 'invite_welcome',
      actor_username: 'ada',
      actor_display_name: 'Ada',
      ...overrides,
    });

  it('greets before it reports, and names the inviter', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Welcome to bingd. ')).toBeTruthy());
    expect(view.getByText('Ada')).toBeTruthy();
    expect(view.getByText(' invited you 🎉')).toBeTruthy();
  });

  /**
   * The emoji is drawn and not spoken. "Party popper" in the middle of the only
   * sentence naming the person who brought them helps nobody, and the celebration is
   * the part that survives being dropped.
   */
  it('spells the greeting out for a screen reader, without the emoji', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() =>
      expect(view.getByLabelText(/Welcome to bingd\. Ada invited you/)).toBeTruthy(),
    );
    expect(view.queryByLabelText(/🎉/)).toBeNull();
  });

  it('paints as unread like any other row', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByLabelText(/^Unread./)).toBeTruthy());
  });

  /**
   * "Follow back" is wrong here — the inviter never followed them, so there is nothing
   * to return. In practice this control is rare, because the redemption already made
   * the follow; it appears if the reader later unfollows and comes back to the row.
   */
  it('offers Follow rather than Follow back when there is no edge', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Follow' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow back' })).toBeNull();
  });

  /**
   * The defect independent review found, as its cause rather than its symptom: the
   * screen has to *ask* about the inviter, or every answer downstream is "unknown"
   * and unknown reads as "no edge".
   */
  it('asks the server what the reader already owes the inviter', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(mockAskedAbout.at(-1)).toContain('them');
  });

  it('offers nothing once the follow the redemption made is in place', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    mockRelationships.set('them', { following: 'approved' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  /**
   * A private inviter leaves the invitee's follow *pending*, which is not the same as
   * not following. The row shows no control; the profile behind it is where
   * `FollowControl` draws "Requested".
   */
  it('offers nothing while a request to a private inviter is pending', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    mockRelationships.set('them', { following: 'pending' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });
});

/**
 * The friendship record (20260827000200) — what replaces the vanishing Accept.
 *
 * The server files it pre-read with `payload.mutual` frozen at acceptance; what the
 * client owns is the two sentences and the one control, so that is what is pinned.
 */
describe('the friendship a request leaves behind', () => {
  const friendship = (overrides: Record<string, unknown> = {}) =>
    follow({
      id: 'n-friend',
      kind: 'friendship',
      type: 'friendship',
      read_at: new Date().toISOString(),
      payload: { mutual: true },
      ...overrides,
    });

  it('says the mutual sentence the founder wrote', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(friendship());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText(/You and/)).toBeTruthy();
    expect(view.getByText(/are now friends/)).toBeTruthy();
  });

  it('says who follows you when the acceptance was one-way', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(friendship({ payload: { mutual: false } }));
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText(/now follows you/)).toBeTruthy();
    expect(view.queryByText(/are now friends/)).toBeNull();
  });

  it('offers Follow back on a one-way friendship', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(friendship({ payload: { mutual: false } }));
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('Follow back')).toBeTruthy();
  });

  it('offers no control on a mutual friendship — the reader already follows them', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(friendship());
    mockRelationships.set('them', { following: 'approved' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByText('Follow back')).toBeNull();
  });
});
