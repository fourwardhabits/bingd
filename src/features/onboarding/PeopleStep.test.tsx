import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { resetOnboardingStages } from './use-onboarding-stage';
import { starterLine } from './use-starter-people';

// Not colocated with the route: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import PeopleStepScreen from '../../../app/onboarding/people';

const mockRpc = jest.fn();
const mockReplace = jest.fn();
const mockTrack = jest.fn();
const mockPrefs = new Map<string, unknown>();
/** Rows `from(table)` should answer with, and whether the read should fail outright. */
const mockTableRows: Record<string, unknown[]> = {};
let mockAttributionFails = false;

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

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const rows = () => mockTableRows[table] ?? [];
      const answer = () =>
        table === 'invite_attributions' && mockAttributionFails
          ? { data: null, error: { message: 'unreachable' } }
          : { data: rows(), error: null, count: rows().length };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            table === 'invite_attributions' && mockAttributionFails
              ? { data: null, error: { message: 'unreachable' } }
              : { data: rows()[0] ?? null, error: null },
          ),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve(answer()),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'me', username: 'sai', display_name: 'Sai' }),
}));

/**
 * A visible stand-in for the real control, so this suite can assert *which* control a row
 * offers without dragging the whole social write stack into a screen test. What the
 * control does when pressed is `FollowControl`'s own test's job; what matters here is that
 * a private account is offered Request and the inviter is offered nothing at all.
 */
jest.mock('@/features/profile/FollowControl', () => ({
  FollowControl: ({ name, relationship }: { name: string; relationship?: unknown }) => {
    const React = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    return React.createElement(Text, null, `Follow control for ${name}`);
  },
}));

jest.mock('@/features/profile/InviteFriendsButton', () => ({
  InviteFriendsButton: () => {
    const React = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    return React.createElement(Text, null, 'Invite friends');
  },
}));

beforeEach(() => {
  mockRpc.mockReset();
  mockReplace.mockReset();
  mockTrack.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockTableRows)) delete mockTableRows[key];
  mockAttributionFails = false;
  mockTableRows.invite_attributions = [];
  resetOnboardingStages();

  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'people_mutuals') return Promise.resolve({ data: [], error: null });
    if (fn === 'people_starter_suggestions') return Promise.resolve({ data: [], error: null });
    if (fn === 'follow_state_with') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
});

const profileRow = (id: string, username: string, visibility = 'public') => ({
  id,
  username,
  display_name: username,
  avatar_path: null,
  visibility,
});

const suggestion = (username: string, shared: number, ranked: number, visibility = 'public') => ({
  user_id: `id-${username}`,
  username,
  display_name: username,
  avatar_path: null,
  visibility,
  shared_count: shared,
  ranked_count: ranked,
});

const mutual = (username: string, count: number, names: string[], visibility = 'public') => ({
  user_id: `id-${username}`,
  username,
  display_name: username,
  avatar_path: null,
  visibility,
  mutual_count: count,
  mutual_names: names,
});

const invitedBy = (username: string, connection: { following: boolean; followed_by: boolean }) => {
  mockTableRows.invite_attributions = [
    { inviter_id: `id-${username}`, profiles: profileRow(`id-${username}`, username) },
  ];
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'follow_state_with')
      return Promise.resolve({
        data: [{ user_id: `id-${username}`, ...connection, blocked: false }],
        error: null,
      });
    if (fn === 'people_mutuals')
      return Promise.resolve({ data: mockTableRows.__mutuals ?? [], error: null });
    return Promise.resolve({ data: [], error: null });
  });
};

const eventsNamed = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

describe('the line under a suggestion', () => {
  /**
   * A fact, never a percentage. `Match TBD` is deliberately not borrowed either: on the
   * Leaderboard it means "some overlap, not enough to score", which is a statement about a
   * pair, and here there is usually no pair to speak of.
   */
  it('counts shared titles when there are any', () => {
    expect(starterLine({ shared: 3, ranked: 200 })).toBe('3 shared');
  });

  it('falls back to what they have ranked, which says why the row is here', () => {
    expect(starterLine({ shared: 0, ranked: 214 })).toBe('Ranked 214 movies');
  });

  it('agrees with the noun at one', () => {
    expect(starterLine({ shared: 0, ranked: 1 })).toBe('Ranked 1 movie');
  });
});

describe('an invited account', () => {
  it('acknowledges the connection before it asks for anything', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText("You're already connected")).toBeTruthy());
    expect(view.getByText('abi invited you to bingd.')).toBeTruthy();
  });

  /**
   * **`20260912000200` makes a personal invitation a mutual, approved follow** in all four
   * visibility combinations, so the row states the relationship rather than offering one.
   */
  it('says they are following each other', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Following each other')).toBeTruthy());
  });

  /**
   * Asking somebody to follow an account they already follow is the flow forgetting what
   * redemption just did.
   */
  it('offers no control on the inviter’s row', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Following each other')).toBeTruthy());
    expect(view.queryByText('Follow control for abi')).toBeNull();
  });

  /**
   * The edge is read rather than assumed. A `referral` token still writes a single edge,
   * so the sentence has to follow what actually exists.
   */
  it('says only that they are following when the edge is one way', async () => {
    invitedBy('abi', { following: true, followed_by: false });
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Following')).toBeTruthy());
    expect(view.queryByText('Following each other')).toBeNull();
  });

  it('offers a short mutuals walk beside the acknowledgment', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    mockTableRows.__mutuals = [mutual('priya', 1, ['abi'])];
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByLabelText('People you may know')).toBeTruthy());
    expect(view.getByText('Mutual: abi')).toBeTruthy();
    expect(view.getByText('Follow control for priya')).toBeTruthy();
  });

  /**
   * **The approved Mutuals rule, and exactly the case it exists for.** A friend of a friend
   * is socially grounded, so an eligible private account may appear here — marked, with
   * Request on the control. That is the opposite of the starter list, which never shows one.
   */
  it('admits an eligible private account through the mutual walk, marked', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    mockTableRows.__mutuals = [mutual('halloran', 1, ['abi'], 'private')];
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('@halloran · Private')).toBeTruthy());
  });

  it('never repeats the inviter inside the list it just acknowledged them above', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    mockTableRows.__mutuals = [mutual('abi', 1, ['abi']), mutual('priya', 1, ['abi'])];
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByLabelText('People you may know')).toBeTruthy());
    expect(view.queryByText('Follow control for abi')).toBeNull();
    expect(view.getByText('Follow control for priya')).toBeTruthy();
  });

  /**
   * No candidates: the acknowledgment stands on its own and the offer becomes an
   * invitation. There is no empty list and no "no suggestions yet".
   */
  it('offers an invitation rather than an empty list when the walk finds nobody', async () => {
    invitedBy('abi', { following: true, followed_by: true });
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByLabelText('Bring somebody with you')).toBeTruthy());
    expect(view.getByText('Invite friends')).toBeTruthy();
  });
});

describe('an organic account', () => {
  const organic = (rows: unknown[]) => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'people_starter_suggestions'
        ? Promise.resolve({ data: rows, error: null })
        : Promise.resolve({ data: [], error: null }),
    );
  };

  /**
   * Not `Find your people`. These are strangers, and a heading calling them the reader's
   * people is the screen lying in its first three words.
   */
  it('names the outcome of following rather than claiming a relationship', async () => {
    organic([suggestion('gio', 3, 88)]);
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Start your Feed')).toBeTruthy());
    expect(view.queryByText('Find your people')).toBeNull();
  });

  it('describes each row with a fact', async () => {
    organic([suggestion('gio', 3, 88), suggestion('sana', 0, 214)]);
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('3 shared')).toBeTruthy());
    expect(view.getByText('Ranked 214 movies')).toBeTruthy();
  });

  /**
   * **No percentage, and no explanation of why there isn't one.** An account that has just
   * ranked five movies cannot be scored against anybody, because `taste.min_common` is 5 —
   * and explaining an absent feature in somebody's first minutes teaches a limitation
   * instead of a benefit.
   */
  it('shows no Match percentage and does not explain its absence', async () => {
    organic([suggestion('gio', 3, 88)]);
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Start your Feed')).toBeTruthy());
    expect(view.queryByText(/%/)).toBeNull();
    expect(view.queryByText(/Match/)).toBeNull();
    expect(view.queryByText(/taste match/i)).toBeNull();
  });

  it('never puts a private account in front of a stranger', async () => {
    // The server refuses this, and the screen is asserted not to draw one either: two
    // independent guards on the rule that matters most on this surface.
    organic([suggestion('gio', 1, 10)]);
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('Follow control for gio')).toBeTruthy());
    expect(view.queryByText(/· Private/)).toBeNull();
  });

  /**
   * A genuinely empty read is not the same as a failed one. Nobody is told they are alone;
   * the offer is simply the one that still makes sense.
   */
  it('offers an invitation when there is genuinely nobody to suggest', async () => {
    organic([]);
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByLabelText('Bring somebody with you')).toBeTruthy());
    expect(view.getByText('Invite friends')).toBeTruthy();
  });
});

describe('when the read fails', () => {
  /**
   * **A failure resolves to "could not load" and never to "there is nobody".**
   *
   * The two are different sentences, and telling an invited person they are alone because
   * a request timed out is the worst thing this step could say.
   */
  it('says it could not find out, rather than that nobody is there', async () => {
    mockAttributionFails = true;
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('People on bingd.')).toBeTruthy());
    expect(view.getByText(/could not load suggestions/)).toBeTruthy();
    expect(view.queryByText('Start your Feed')).toBeNull();
    expect(view.queryByText("You're already connected")).toBeNull();
  });

  /**
   * The title is neutral on purpose: `Start your Feed` would assert the account is organic
   * and `You're already connected` would assert it is not, and the read failed, so neither
   * is known.
   */
  it('offers a retry and a way on, because this step must never strand anybody', async () => {
    mockAttributionFails = true;
    const view = await renderWithProviders(<PeopleStepScreen />);

    await waitFor(() => expect(view.getByText('People on bingd.')).toBeTruthy());
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/notifications');
  });
});

describe('leaving the step', () => {
  it('continues into the notification question', async () => {
    const view = await renderWithProviders(<PeopleStepScreen />);
    await waitFor(() => expect(view.getByText('Start your Feed')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/notifications');
  });

  /**
   * The variant reported is the branch drawn **on entry**, so a `could_not_load` that was
   * retried into a real list still reports what the reader first met.
   */
  it('reports which branch the reader actually met', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'people_starter_suggestions'
        ? Promise.resolve({ data: [suggestion('gio', 2, 40)], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const view = await renderWithProviders(<PeopleStepScreen />);
    await waitFor(() => expect(view.getByText('2 shared')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    const [event] = eventsNamed('onboarding_step_completed');
    expect(event.props).toMatchObject({ step: 'people', variant: 'starter_shared' });
  });

  it('separates a list justified by overlap from one justified by activity', async () => {
    mockRpc.mockImplementation((fn: string) =>
      fn === 'people_starter_suggestions'
        ? Promise.resolve({ data: [suggestion('gio', 0, 40)], error: null })
        : Promise.resolve({ data: [], error: null }),
    );
    const view = await renderWithProviders(<PeopleStepScreen />);
    await waitFor(() => expect(view.getByText('Ranked 40 movies')).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Continue' }));

    expect(eventsNamed('onboarding_step_completed')[0].props.variant).toBe('starter_active');
  });
});
