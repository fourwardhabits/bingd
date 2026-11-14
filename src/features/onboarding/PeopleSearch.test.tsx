import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { resetOnboardingStages } from './use-onboarding-stage';
import { resetStepViewedForTests } from './step-viewed';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import PeopleStepScreen from '../../../app/onboarding/people';

/**
 * **Find your friends by `@username`** (Onboarding 2.0, OB-6, 2026-11-14).
 *
 * The People step's inline search, with the app's real `FollowControl` and the real
 * invite button, so a follow from a result is proved to report `surface: 'onboarding'`
 * and the footer is proved to hold one Maroon fill. `PeopleStep.test.tsx` owns the
 * branches themselves.
 */

const mockRpc = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockTrack = jest.fn();
const mockPrefs = new Map<string, unknown>();
const mockTableRows: Record<string, unknown[]> = {};

jest.mock('@/ui/components/use-stable-bottom-inset', () => ({
  useStableBottomInset: () => 0,
}));

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs.get(name) ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs.set(name, value);
    return Promise.resolve();
  },
}));

jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

jest.mock('@/features/notifications/push', () => ({
  nudgePushDelivery: jest.fn(),
}));

jest.mock('@/features/notifications/push-permission', () => ({
  offerPushPermission: () => Promise.resolve(),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const rows = () => mockTableRows[table] ?? [];
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  Stack: { Screen: () => null },
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'me', username: 'sai', display_name: 'Sai' }),
  useCurrentUserId: () => 'me',
  useAuth: () => ({ status: 'ready', userId: 'me' }),
}));

const member = (id: string, username: string, visibility = 'public') => ({
  id,
  username,
  display_name: username,
  avatar_path: null,
  visibility,
});

const suggestion = (username: string) => ({
  user_id: `id-${username}`,
  username,
  display_name: username,
  avatar_path: null,
  visibility: 'public',
  shared_count: 2,
  ranked_count: 30,
});

/** Who `search_users` answers with, by the text it was asked for. */
let mockDirectory: Record<string, ReturnType<typeof member>[]> = {};
let mockSearchFails = 0;
let mockSearchHangs = false;
let mockSuggestions: ReturnType<typeof suggestion>[] = [];
/** Who this viewer has asked to follow, and how that answered: what `follow_state_with` reads. */
const mockFollowing = new Map<string, string>();

beforeEach(() => {
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockPush.mockReset();
  mockTrack.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  mockTableRows.invite_attributions = [];
  mockDirectory = {};
  mockSearchFails = 0;
  mockSearchHangs = false;
  mockSuggestions = [];
  mockFollowing.clear();
  issued = 0;
  resetOnboardingStages();
  resetStepViewedForTests();

  mockRpc.mockImplementation((fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'people_mutuals') return Promise.resolve({ data: [], error: null });
    if (fn === 'people_starter_suggestions') {
      return Promise.resolve({ data: mockSuggestions, error: null });
    }
    if (fn === 'search_users') {
      if (mockSearchHangs) return new Promise(() => {});
      if (mockSearchFails > 0) {
        mockSearchFails -= 1;
        return Promise.resolve({ data: null, error: { message: 'offline' } });
      }
      return Promise.resolve({ data: mockDirectory[String(args.p_query)] ?? [], error: null });
    }
    if (fn === 'follow_state_with') {
      // Known, and no edge: what makes a follow a `follow_created` rather than a maybe.
      const ids = (args.p_user_ids as string[]) ?? [];
      return Promise.resolve({
        data: ids.map((id) => ({
          user_id: id,
          following: mockFollowing.get(id) ?? null,
          followed_by: false,
          blocked: false,
        })),
        error: null,
      });
    }
    if (fn === 'follow') {
      const id = String(args.p_followee_id);
      const isPrivate = Object.values(mockDirectory)
        .flat()
        .some((row) => row.id === id && row.visibility === 'private');
      const state = isPrivate ? 'pending' : 'approved';
      mockFollowing.set(id, state);
      return Promise.resolve({ data: { status: 'ok', state }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

const open = async () => {
  const view = await renderWithProviders(<PeopleStepScreen />);
  await waitFor(() => expect(view.getByLabelText('Search people by username')).toBeTruthy());
  return view;
};

type View = Awaited<ReturnType<typeof open>>;

const type = async (view: View, text: string) => {
  await fireEvent.changeText(view.getByLabelText('Search people by username'), text);
};

const searchedFor = () =>
  mockRpc.mock.calls.filter(([fn]) => fn === 'search_users').map(([, args]) => args.p_query);

const events = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

describe('the field', () => {
  it('sits under the intro, says what it searches, and does not autocorrect a handle', async () => {
    const view = await open();
    const field = view.getByLabelText('Search people by username');

    expect(field.props.placeholder).toBe('Search by @username');
    expect(field.props.autoCapitalize).toBe('none');
    expect(field.props.autoCorrect).toBe(false);
    expect(view.getByText('Find your friends')).toBeTruthy();
    expect(
      view.getByText('Follow people you know to see what they rank and send each other picks.'),
    ).toBeTruthy();
  });

  it('asks for the same handle whether or not it starts with @', async () => {
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    await type(view, '@jo');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));

    expect(view.getByText('@jo')).toBeTruthy();
    expect(new Set(searchedFor())).toEqual(new Set(['jo']));
  });

  it('draws nothing of the search while the field is empty, and the branch comes back on clear', async () => {
    mockSuggestions = [suggestion('gio')];
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('Suggested for you')).toBeTruthy());

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    expect(view.queryByLabelText('Suggested for you')).toBeNull();
    expect(view.queryByText('@gio')).toBeNull();

    await fireEvent.press(view.getByLabelText('Clear search'));
    await waitFor(() => expect(view.getByLabelText('Suggested for you')).toBeTruthy());
    expect(view.getByText('@gio')).toBeTruthy();
    expect(view.queryByText('@jo')).toBeNull();
  });
});

describe('what the search finds', () => {
  it('draws a result as a person row and follows from it on the onboarding surface', async () => {
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    const follow = await view.findByRole('button', { name: 'Follow' });
    await waitFor(() => expect(follow.props.accessibilityState.disabled).toBeFalsy());
    await fireEvent.press(follow);

    await waitFor(() =>
      expect(events('follow_created')).toEqual([
        { name: 'follow_created', props: { surface: 'onboarding', state: 'approved' } },
      ]),
    );
  });

  it('marks a private account and sends it a request, as the control always does', async () => {
    mockDirectory.halloran = [member('id-halloran', 'halloran', 'private')];
    const view = await open();

    await type(view, 'halloran');
    await waitFor(() => expect(view.getByText('@halloran · Private')).toBeTruthy());
    await fireEvent.press(await view.findByRole('button', { name: 'Follow' }));

    await waitFor(() =>
      expect(events('follow_created')).toEqual([
        { name: 'follow_created', props: { surface: 'onboarding', state: 'pending' } },
      ]),
    );
    await waitFor(() => expect(view.getByRole('button', { name: 'Requested' })).toBeTruthy());
  });

  it('never offers the viewer their own row', async () => {
    mockDirectory.sa = [member('me', 'sai'), member('id-sam', 'sam')];
    const view = await open();

    await type(view, 'sa');
    await waitFor(() => expect(view.getByText('@sam')).toBeTruthy());
    expect(view.queryByText('@sai')).toBeNull();
  });

  it('shows the Search tab’s meaningful matches, not every substring', async () => {
    mockDirectory.ann = [member('id-anna', 'anna'), member('id-deanna', 'deanna')];
    const view = await open();

    await type(view, 'ann');
    await waitFor(() => expect(view.getByText('@anna')).toBeTruthy());
    expect(view.queryByText('@deanna')).toBeNull();
  });

  it('opens nothing when a row is pressed, because routing holds the account in the flow', async () => {
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    await fireEvent.press(view.getByText('@jo'));
    await fireEvent.press(view.getByText('jo'));

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(events('member_search_result_opened')).toHaveLength(0);
  });
});

describe('the search’s other states', () => {
  it('holds two skeleton rows while the first answer is out', async () => {
    mockSearchHangs = true;
    const view = await open();

    await type(view, 'jo');

    await waitFor(() =>
      expect(
        view.getAllByTestId('skeleton-row', { includeHiddenElements: true }),
      ).toHaveLength(2),
    );
  });

  it('says so when nobody matches, and points at the invitation', async () => {
    const view = await open();

    await type(view, 'zzz');

    await waitFor(() =>
      expect(view.getByText('No one by that name yet. Invite them instead.')).toBeTruthy(),
    );
  });

  it('says it needs a connection, and Try again asks again', async () => {
    mockSearchFails = 1;
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('Search needs a connection.')).toBeTruthy());
    await fireEvent.press(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    expect(view.queryByText('Search needs a connection.')).toBeNull();
  });
});

describe('the footer', () => {
  it('continues with a query typed, and Continue is always live', async () => {
    mockSearchHangs = true;
    const view = await open();
    await type(view, 'jo');

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/onboarding/notifications');
  });

  it('holds exactly one Maroon fill: Continue, with Invite friends outlined beside it', async () => {
    mockSuggestions = [suggestion('gio')];
    const view = await open();
    await waitFor(() => expect(view.getByLabelText('Suggested for you')).toBeTruthy());

    const footer = view.getByTestId('onboarding-footer');
    type Node = { props: { style?: unknown }; children?: (Node | string)[] };
    /** Whether a button draws the Maroon fill anywhere inside it. */
    const fills = (node: Node): boolean =>
      (StyleSheet.flatten(node.props.style as never) as { backgroundColor?: string } | undefined)
        ?.backgroundColor === theme.semantic.action ||
      (node.children ?? []).some((child) => typeof child !== 'string' && fills(child));

    const buttons = within(footer).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    const invite = within(footer).getByRole('button', { name: 'Invite friends' });
    const proceed = within(footer).getByRole('button', { name: 'Continue' });
    expect(fills(proceed as unknown as Node)).toBe(true);
    expect(fills(invite as unknown as Node)).toBe(false);
    expect(buttons.filter((button) => fills(button as unknown as Node))).toHaveLength(1);
  });
});

describe('onboarding_people_search_used', () => {
  it('is not sent when nobody searched', async () => {
    const view = await open();
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(events('onboarding_people_search_used')).toHaveLength(0);
    expect(events('onboarding_step_completed')).toHaveLength(1);
  });

  it('is sent once on leaving, with the count of searches that came back', async () => {
    mockDirectory.jo = [member('id-jo', 'jo')];
    const view = await open();

    await type(view, 'jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());
    await type(view, 'zzz');
    await waitFor(() =>
      expect(view.getByText('No one by that name yet. Invite them instead.')).toBeTruthy(),
    );
    // The same handle again, with the sigil: one search, not a third.
    await type(view, '@jo');
    await waitFor(() => expect(view.getByText('@jo')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(events('onboarding_people_search_used')).toEqual([
      { name: 'onboarding_people_search_used', props: { searches: 2, had_results: true } },
    ]);
  });

  it('says no results when every search found only the viewer or nobody', async () => {
    mockDirectory.sai = [member('me', 'sai')];
    const view = await open();

    await type(view, 'sai');
    await waitFor(() =>
      expect(view.getByText('No one by that name yet. Invite them instead.')).toBeTruthy(),
    );
    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(events('onboarding_people_search_used')).toEqual([
      { name: 'onboarding_people_search_used', props: { searches: 1, had_results: false } },
    ]);
  });
});
