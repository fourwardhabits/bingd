import { waitFor } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

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

/**
 * **The safe area, resolved in JS so the top inset is a number this test can read.**
 *
 * The real `SafeAreaView` is a native view that applies its edges on the other side of
 * the bridge, so under Jest it produces no padding at all and a gap made of padding
 * would be invisible to any assertion. This stand-in does in JavaScript exactly what
 * the native view does — pad each declared edge by that inset — and nothing else.
 *
 * 47 is the `top` the shared render helper already reports, which is roughly a modern
 * iPhone's status bar and about the size of the band the founder photographed.
 */
const mockInsets = { top: 47, bottom: 24, left: 0, right: 0 };

jest.mock('react-native-safe-area-context', () => {
  const { View: RNView } = jest.requireActual('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: unknown }) => children,
    useSafeAreaInsets: () => mockInsets,
    SafeAreaView: ({
      children,
      edges = ['top', 'bottom', 'left', 'right'],
      style,
      ...rest
    }: {
      children: unknown;
      edges?: readonly string[];
      style?: unknown;
    }) => (
      <RNView
        {...rest}
        testID="screen-safe-area"
        style={[
          style,
          {
            paddingTop: edges.includes('top') ? mockInsets.top : 0,
            paddingBottom: edges.includes('bottom') ? mockInsets.bottom : 0,
            paddingLeft: edges.includes('left') ? mockInsets.left : 0,
            paddingRight: edges.includes('right') ? mockInsets.right : 0,
          },
        ]}
      >
        {children}
      </RNView>
    ),
  };
});

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
 * The fulfilment a ranking writes back (20260827000600).
 *
 * The server owns when it fires and to whom; what the client owns is the sentence —
 * the founder's copy, title inline — the fallback when the post is gone, and the
 * absence of any follow control on a row about somebody the reader already chose to
 * recommend things to.
 */
describe('the fulfilment a ranking writes back', () => {
  const fulfilment = (overrides: Record<string, unknown> = {}) =>
    follow({
      id: 'n-fulfilled',
      kind: 'recommendation_ranked',
      type: 'recommendation_ranked',
      media_item_id: 'm-vox',
      media_title: 'Season 1',
      media_kind: 'season',
      series_title: 'The Legend of Vox Machina',
      subject_type: 'feed_event',
      subject_id: 'event-9',
      payload: { recommendation_id: 'rec-1' },
      ...overrides,
    });

  it('says the founder’s sentence with the title inline, formatted like the rest of the app', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(fulfilment());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText(' ranked ')).toBeTruthy();
    expect(view.getByText('The Legend of Vox Machina, S1')).toBeTruthy();
    expect(view.getByText(' from your recommendation')).toBeTruthy();
  });

  it('does not repeat the title on its own line below the sentence', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(fulfilment());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getAllByText('The Legend of Vox Machina, S1')).toHaveLength(1);
  });

  it('falls back to the plain sentence when the ranking post has gone', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      fulfilment({
        media_item_id: null,
        media_title: null,
        media_kind: null,
        series_title: null,
      }),
    );
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText(/ranked your recommendation/)).toBeTruthy();
  });

  it('offers no follow control — the reader already knows this person', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(fulfilment());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow back' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });
});

/**
 * The rhythm pass (20260827000600): hairline rules between rows, inset to the text
 * edge, and the three age shelves — which appear only when they separate something.
 */
describe('the shelves and the rules between rows', () => {
  it('separates neighbouring rows with an inset hairline, and only between them', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      follow({ id: 'a1', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      follow({ id: 'a2', created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }),
      follow({ id: 'a3', created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    );
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getAllByText(/started following you/)).toHaveLength(3));
    // Three rows, two gaps: a rule after the last row would underline the section.
    const dividers = view.getAllByTestId('notification-divider');
    expect(dividers).toHaveLength(2);
    const style = StyleSheet.flatten(dividers.at(0)?.props.style);
    // Inset to where the sentences begin, so the avatar column stays unbroken.
    expect(style?.marginLeft).toBe(
      theme.layout.gutter + theme.layout.avatar.sm + theme.space[3],
    );
    expect(style?.backgroundColor).toBe(theme.border.hairline);
  });

  it('shelves rows by age once there is more than one shelf to show', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      follow({ id: 'a1', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      follow({
        id: 'a2',
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      follow({
        id: 'a3',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getAllByText(/started following you/)).toHaveLength(3));
    expect(view.getByText('TODAY')).toBeTruthy();
    expect(view.getByText('THIS WEEK')).toBeTruthy();
    expect(view.getByText('EARLIER')).toBeTruthy();
  });

  it('shows no heading over a single shelf with nothing above it', async () => {
    // One follow, two days old — the default fixture. A lone label captioning the
    // whole screen separates nothing.
    const view = await open();

    expect(view.queryByText('TODAY')).toBeNull();
    expect(view.queryByText('THIS WEEK')).toBeNull();
    expect(view.queryByText('EARLIER')).toBeNull();
  });

  it('keeps the heading when a requests section sits above the shelf', async () => {
    mockNotifications.push(
      follow({ id: 'r1', kind: 'follow_request', type: 'follow_request' }),
    );
    const view = await open();

    // The old behaviour, carried: "Earlier" marked where the requests ended.
    expect(view.getByText('FOLLOW REQUESTS')).toBeTruthy();
    expect(view.getByText('THIS WEEK')).toBeTruthy();
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

// ---------------------------------------------------------------------------

/**
 * **The blank band between the header and TODAY** (founder physical screenshot).
 *
 * It was safe-area duplication and nothing else. This screen declares
 * `headerShown: true`, and a native-stack header has already consumed the status-bar
 * inset before it draws — so `Screen`'s default top edge added the same inset a second
 * time, *below* the header, as an empty strip about the height of a status bar.
 *
 * Asserted as the resolved padding rather than as the `edges` array, so the fix cannot
 * be "the prop is right" while the band is still there.
 */
describe('the top of the page', () => {
  const rootPadding = (view: Awaited<ReturnType<typeof open>>) =>
    StyleSheet.flatten(view.getByTestId('screen-safe-area').props.style);

  it('adds no second status-bar inset under the header', async () => {
    const view = await open();
    expect(rootPadding(view).paddingTop).toBe(0);
  });

  it('keeps the horizontal insets, which belong to nobody else', async () => {
    // `edges={[]}` would have fixed the band and dropped these with it — they still
    // matter in landscape and under a notch.
    const view = await open();
    const style = rootPadding(view);
    expect(style.paddingLeft).toBe(mockInsets.left);
    expect(style.paddingRight).toBe(mockInsets.right);
  });

  it('leaves the first section its ordinary heading spacing', async () => {
    /**
     * The gap was never this screen's own rhythm, so the fix must not have taken any of
     * it away. Summed from the heading up to the root: with the duplicate inset gone,
     * everything above TODAY is the one `space[4]` that `section` declares — which is
     * the air every other list screen in the app has over its first heading.
     */
    // Two shelves, because a heading is only drawn once there is more than one to tell
    // apart — and TODAY is the heading the founder's screenshot has the band above.
    mockNotifications.length = 0;
    mockNotifications.push(
      follow({ id: 'a1', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
      follow({
        id: 'a2',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    // `open()` waits on a single row, so this one renders directly.
    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('TODAY')).toBeTruthy());

    let total = 0;
    let node: { parent: unknown; props: Record<string, unknown> } | null = view.getByLabelText('Today');
    while (node) {
      const style = (StyleSheet.flatten(node.props.style) ?? {}) as ViewStyle;
      total += Number(style.paddingTop ?? style.paddingVertical ?? 0);
      node = node.parent as typeof node;
    }
    expect(total).toBe(theme.space[4]);
  });
});
