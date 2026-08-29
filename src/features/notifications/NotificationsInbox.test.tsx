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

  /**
   * **It says Following rather than disappearing**, which is the 20260831000100
   * correction and the one that matters most on this row.
   *
   * `redeem_invite` creates the invitee's follow as part of acceptance, so the edge
   * exists before the welcome is ever drawn — which meant the old hide-once-followed
   * rule hid the control on essentially every welcome ever rendered. The row that
   * exists to introduce two accounts said nothing about whether they were connected.
   */
  it('says Following once the follow the redemption made is in place', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    mockRelationships.set('them', { following: 'approved' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Following' })).toBeTruthy());
    // And never the offer, which would invite a follow that already exists.
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  /**
   * A private inviter leaves the invitee's follow *pending*, which is not the same as
   * not following and not the same as following. It keeps its own word, for
   * `FollowControl`'s reason: collapsing it into "Following" would tell somebody they
   * have access they have not been granted.
   */
  it('says Requested while a request to a private inviter is pending', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    mockRelationships.set('them', { following: 'pending' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Requested' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  /**
   * The settled state is a statement rather than an offer, so it does not invite the
   * tap that would undo the relationship. Ending one from an inbox row is a mis-tap
   * away from a follow nobody meant to lose; `FollowControl` on the profile is where
   * Unfollow and Withdraw live, and the row already opens it.
   */
  it('does not dress its settled state as something to press', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(welcome());
    mockRelationships.set('them', { following: 'approved' });
    const view = await renderWithProviders(<NotificationsScreen />);

    const control = await waitFor(() => view.getByRole('button', { name: 'Following' }));
    // The hint is the row's own destination, not "Follow Ada" — which is what a
    // settled control must never promise.
    expect(control.props.accessibilityHint).toBe('Opens their profile');
  });
});

/**
 * **The inviter's half of the same acceptance** (20260831000100).
 *
 * It replaced a plain `follow` row — "Ada started following you" — which said nothing
 * about where this person came from. The sentence that did say so belonged to
 * `invite_activated`, which does not fire until the invitee's tenth ranking, so the
 * inviter learnt the interesting fact days late or never.
 *
 * Where the row *leads* is asserted in `routing.test.ts`, which owns the destination
 * matrix for every kind and fails if a new one is added unrouted.
 */
describe('the row an acceptance files for the inviter', () => {
  const joined = (overrides: Record<string, unknown> = {}) =>
    follow({
      id: 'j1',
      kind: 'invite_joined',
      type: 'invite_joined',
      actor_username: 'ada',
      actor_display_name: 'Ada',
      ...overrides,
    });

  it('says who joined and where they came from', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('joined bingd. from your invite')).toBeTruthy());
    expect(view.getByText('Ada')).toBeTruthy();
    // Never the sentence it replaced.
    expect(view.queryByText(/started following you/)).toBeNull();
  });

  it('spells the whole sentence out for a screen reader', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() =>
      expect(view.getByLabelText(/Ada joined bingd\. from your invite/)).toBeTruthy(),
    );
  });

  it('paints as unread, so it reaches the bell', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByLabelText(/^Unread\./)).toBeTruthy());
  });

  /**
   * The agreement between `CAN_OFFER_FOLLOW` and `relationshipActionFor`, which is the
   * defect independent review found on the welcome row and which this row inherits: a
   * kind that reaches the control without reaching the list of actors whose state gets
   * fetched draws nothing where its state should be.
   */
  it('asks the server what the inviter owes the person who joined', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(mockAskedAbout.at(-1)).toContain('them');
  });

  /**
   * **"Follow back" and not "Follow"**: the invitee has just followed the inviter, so
   * there genuinely is something to return. The mirror of the welcome's rule.
   */
  it('offers Follow back when the inviter does not follow them yet', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Follow back' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow' })).toBeNull();
  });

  it('says Requested when the inviter has asked a private invitee', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    mockRelationships.set('them', { following: 'pending' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Requested' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow back' })).toBeNull();
  });

  it('says Following once the inviter has followed them back', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(joined());
    mockRelationships.set('them', { following: 'approved' });
    const view = await renderWithProviders(<NotificationsScreen />);

    await waitFor(() => expect(view.getByRole('button', { name: 'Following' })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Follow back' })).toBeNull();
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

// ---------------------------------------------------------------------------
/**
 * **Enough context to decide whether to open it** — founder, 2026-08-30.
 *
 * "Ravi commented on your activity" is a row you have to tap to understand. One line of
 * what was actually said is the difference, and the constraint that came with it in the
 * same breath is that the line must never carry a spoiler or a retracted remark.
 *
 * The withholding is the server's — `my_notifications` sends `comment_excerpt: null` and
 * `comment_spoilers: true` — so what is asserted here is the other half: that the screen
 * draws what it is given, says why when there is nothing, and never grows a row to fit a
 * long comment.
 */
const commentRow = (overrides: Record<string, unknown> = {}) =>
  follow({
    id: 'c1',
    kind: 'comment',
    type: 'comment',
    subject_type: 'feed_event',
    subject_id: 'event-1',
    media_item_id: 'media-1',
    media_title: 'Sinners',
    media_kind: 'movie',
    comment_excerpt: 'Pretty good',
    comment_spoilers: false,
    ...overrides,
  });

describe('the comment preview', () => {
  it('draws one line of what was said, under the sentence', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(commentRow());

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/commented on your/)).toBeTruthy());

    expect(view.getByText('Pretty good')).toBeTruthy();
  });

  it('names the activity as a watch when the server says it was one', async () => {
    // **The noun comes from the activity, not from the title** (founder, 2026-08-29).
    // `my_notifications` returns the subject event's type since 20260901000100, so
    // "your Sinners watch" is a claim the row can actually support.
    mockNotifications.length = 0;
    mockNotifications.push(commentRow({ subject_activity_type: 'title_ranked' }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() =>
      expect(
        view.getByLabelText('Unread. Ada commented on your Sinners watch. Pretty good'),
      ).toBeTruthy(),
    );
    expect(view.getByText(' watch')).toBeTruthy();
    // Once, not twice: the standalone subject line is suppressed when the title is
    // already inside the clause.
    expect(view.getAllByText(/Sinners/)).toHaveLength(1);
  });

  it('keeps the neutral noun for an activity that is not a watch claim', async () => {
    // A comment under a watchlist addition is not a watch, and saying so would be the
    // app asserting a viewing that never happened.
    mockNotifications.length = 0;
    mockNotifications.push(commentRow({ subject_activity_type: 'watchlist_added' }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() =>
      expect(
        view.getByLabelText('Unread. Ada commented on your Sinners activity. Pretty good'),
      ).toBeTruthy(),
    );
  });

  it('says a reply is a reply, and says what it is a reply to', async () => {
    // Both rows `add_comment` writes are `type = 'comment'`; `payload.reply_to` is the
    // server's own way of telling "somebody talked under your activity" from "somebody
    // answered your comment". It has always been written and nothing read it.
    mockNotifications.length = 0;
    mockNotifications.push(
      commentRow({
        subject_activity_type: 'title_ranked',
        payload: { reply_to: 'parent-1' },
      }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() =>
      expect(
        view.getByLabelText('Unread. Ada replied to your comment on Sinners. Pretty good'),
      ).toBeTruthy(),
    );
  });

  it('says a reaction was to the watch it was left on', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      commentRow({
        id: 'r1',
        kind: 'reaction',
        type: 'reaction',
        comment_excerpt: null,
        subject_activity_type: 'title_ranked',
      }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() =>
      expect(view.getByLabelText('Unread. Ada reacted to your Sinners watch')).toBeTruthy(),
    );
  });

  it('does the same for a mention, with the mention’s own sentence', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      commentRow({
        id: 'm1',
        kind: 'mention',
        type: 'mention',
        comment_excerpt: 'sirrr what is that supposed to mean',
        payload: { reply: false },
      }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/mentioned you in a comment/)).toBeTruthy());

    expect(view.getByText('sirrr what is that supposed to mean')).toBeTruthy();
  });

  it('says "in a reply" when that is what it was', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      commentRow({ id: 'm2', kind: 'mention', type: 'mention', payload: { reply: true } }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/mentioned you in a reply/)).toBeTruthy());
  });

  /**
   * The shape contract. A comment is up to a thousand characters and the server sends at
   * most 140 of them; this is the last bound, and without it one long remark would set
   * the height of a row in a list whose whole job is to be scanned.
   */
  it('never lets a long comment grow the row', async () => {
    mockNotifications.length = 0;
    const long = 'a '.repeat(120).trim();
    mockNotifications.push(commentRow({ comment_excerpt: long }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(long)).toBeTruthy());

    expect(view.getByText(long).props.numberOfLines).toBe(1);
  });

  /**
   * The founder's spoiler rule. The row still says something — an absent second line
   * reads as a rendering bug, and "Contains spoilers" is a useful thing to know before
   * tapping.
   */
  it('says Contains spoilers instead of the text, and the text is nowhere', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(commentRow({ comment_excerpt: null, comment_spoilers: true }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());

    // The whole tree, not the row: the point is that no such string reached the client.
    expect(JSON.stringify(view.toJSON())).not.toContain('Pretty good');
  });

  /**
   * A retracted comment. The server sends neither the text nor the spoiler flag, so there
   * is nothing to draw and nothing to explain — the row is the sentence it always was,
   * and the tap still resolves through the ordinary chain.
   */
  it('draws no second line at all for a comment that is gone', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(commentRow({ comment_excerpt: null, comment_spoilers: false }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/commented on your/)).toBeTruthy());

    expect(view.queryByText('Contains spoilers')).toBeNull();
    expect(view.queryByText('Pretty good')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
const watchTagRow = (overrides: Record<string, unknown> = {}) =>
  follow({
    id: 'w1',
    kind: 'watch_tag',
    type: 'watch_tag',
    actor_display_name: 'Suraj',
    subject_type: 'media_item',
    subject_id: 'media-1',
    media_item_id: 'media-1',
    media_title: '100 Meters',
    media_kind: 'movie',
    viewer_ranked: false,
    ...overrides,
  });

describe('the watched-with row', () => {
  /**
   * "Suraj watched 100 Meters with you" — the founder's copy, with the title inside the
   * sentence rather than on a line beneath it. The old shape said "watched something with
   * you" and then the film's name, which is two facts the reader has to join up.
   */
  it('puts the title inside the sentence, and does not repeat it below', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(watchTagRow());

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(' watched ')).toBeTruthy());

    expect(view.getByText(' with you')).toBeTruthy();
    // Once, not twice: the subject line is suppressed for this kind.
    expect(view.getAllByText('100 Meters')).toHaveLength(1);
    expect(view.queryByText(/watched something with you/)).toBeNull();
  });

  /** A title that has left the catalogue has no name to put in the middle. */
  it('falls back to the plain sentence when the title is gone', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      watchTagRow({ media_item_id: null, media_title: null, media_kind: null }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/watched something with you/)).toBeTruthy());
  });

  it('offers Rank when the reader has not ranked it', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(watchTagRow());

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());
  });

  /**
   * The control disappears on the next refetch after they rank it, because
   * `viewer_ranked` is resolved server-side in the read that draws the row. There is no
   * local state and nothing to invalidate — which is what this asserts by changing only
   * that field.
   */
  it('does not offer Rank once they have', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(watchTagRow({ viewer_ranked: true }));

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(' with you')).toBeTruthy());

    expect(view.queryByRole('button', { name: 'Rank' })).toBeNull();
  });

  it('offers nothing when the title itself has gone', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(
      watchTagRow({ media_item_id: null, media_title: null, media_kind: null }),
    );

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/watched something with you/)).toBeTruthy());

    expect(view.queryByRole('button', { name: 'Rank' })).toBeNull();
  });

  /**
   * **Rank opens the title page, never the ranking sheet** — the founder was explicit. A
   * notification is a claim about something that may have happened days ago; dropping the
   * reader into a comparison session from a Bell tap is a modal state entered by accident.
   * The hint is what the row promises out loud, and it says the same thing.
   */
  it('promises the title page rather than a ranking session', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(watchTagRow());

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByRole('button', { name: 'Rank' })).toBeTruthy());

    expect(view.getByRole('button', { name: 'Rank' }).props.accessibilityHint).toBe(
      'Opens the title, where you can rank it',
    );
  });

  it('does not offer Rank on anything that is not a watched-with row', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(commentRow());

    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText(/commented on your/)).toBeTruthy());

    expect(view.queryByRole('button', { name: 'Rank' })).toBeNull();
  });
});
