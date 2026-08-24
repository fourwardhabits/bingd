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

jest.mock('@/features/profile/use-social', () => ({
  useRelationships: () => ({ data: mockRelationships }),
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
});

const open = async () => {
  const view = await renderWithProviders(<NotificationsScreen />);
  await waitFor(() => expect(view.getByText(/started following you/)).toBeTruthy());
  return view;
};

describe('the unread summary', () => {
  it('offers Mark all read as a text action, not a screen-sized button', async () => {
    const view = await open();

    const action = view.getByLabelText('Mark all notifications read');
    const style = StyleSheet.flatten(action.props.style);
    // The old control carried the Button's 48pt floor. This one carries none at all —
    // its target comes from hitSlop, which is what keeps the strip one line tall.
    expect(style?.minHeight).toBeUndefined();
    expect(action.props.hitSlop).toBe(theme.space[3]);
  });

  it('says how many are unread, from the same selector the bell counts with', async () => {
    const view = await open();

    expect(view.getByText('1 unread')).toBeTruthy();
  });

  it('says nothing when everything has been read', async () => {
    mockNotifications.length = 0;
    mockNotifications.push(follow({ read_at: new Date().toISOString() }));
    const view = await open();

    expect(view.queryByText(/unread/)).toBeNull();
    expect(view.queryByLabelText('Mark all notifications read')).toBeNull();
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
  it('does not mark anything read merely by being opened', async () => {
    const view = await open();

    // Still unread after the screen has rendered: only the control changes this.
    expect(view.getByText('1 unread')).toBeTruthy();
  });
});
