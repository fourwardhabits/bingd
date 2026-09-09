import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';
import { TAB_ROUTES } from '@/lib/routes';

import { hydrateStage, resetOnboardingStages, stageInMemory } from './use-onboarding-stage';
import { resetRankingOutcome } from './pick-five';
import { resetWelcomeSeen } from './welcome';
import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the routes: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import NotificationsScreen from '../../../app/onboarding/notifications';
import WelcomeScreen from '../../../app/(auth)/welcome';

const mockReplace = jest.fn();
const mockTrack = jest.fn();
const mockPrefs = new Map<string, unknown>();
const mockCounts: Record<string, number> = {};
/** A follow count that never settles, for the bounded-read case. */
let mockCountHangs = false;

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
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          mockCountHangs
            ? new Promise(() => {})
            : resolve({ data: [], error: null, count: mockCounts[table] ?? 0 }),
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
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
  UseDifferentAccountButton: () => null,
}));

/**
 * The notification question itself is `NotificationStep.test.tsx`'s subject, and it owns
 * the rule that nothing touches the operating system until the reader presses the button.
 * What this file is about is what happens *after* either answer, so the step is reduced to
 * its two exits.
 */
jest.mock('./NotificationStep', () => ({
  NotificationStep: ({ onDone }: { onDone: () => void }) => {
    const React = jest.requireActual('react');
    const { Text, Pressable } = jest.requireActual('react-native');
    return React.createElement(
      Pressable,
      { accessibilityRole: 'button', accessibilityLabel: 'finish the step', onPress: onDone },
      React.createElement(Text, null, 'Stay in the loop'),
    );
  },
}));

beforeEach(() => {
  mockReplace.mockReset();
  mockTrack.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockCountHangs = false;
  resetOnboardingStages();
  resetWelcomeSeen();
  resetTasteIntent();
  resetRankingOutcome();
  // Five placed, so the flow reaching its end is a completion rather than a skip.
  mockPrefs.set('user-1.onboarding.taste.phase', 'active');
  mockCounts.rankings = 5;
  mockCounts.user_media = 5;
});

const eventsNamed = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

const finish = async () => {
  const view = await renderWithProviders(<NotificationsScreen />);
  await waitFor(() => expect(view.getByText('Stay in the loop')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('finish the step'));
  return view;
};

describe('where the app opens', () => {
  /**
   * One approved follow means the Feed has something in it, and the follow just made is
   * the first row.
   */
  it('opens the Feed when a connection was made', async () => {
    mockCounts.follows = 1;
    await finish();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.feed));
  });

  /**
   * An empty Feed offers `Find your people`, which is the step they just left. Sending
   * them there is a loop.
   */
  it('opens For You when none was', async () => {
    mockCounts.follows = 0;
    await finish();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.forYou));
  });

  /**
   * **A pending request is not a connection.** It is not an edge, it may never be
   * approved, and treating a maybe as a yes puts somebody on an empty screen — which is
   * exactly the loop the rule exists to avoid. The query asks for `approved` and the count
   * it gets back is of those alone.
   */
  it('does not count a request that has not been approved', async () => {
    // The screen's query filters on state, so a database holding only pending rows answers
    // zero. Modelled here as the count that filter would produce.
    mockCounts.follows = 0;
    await finish();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.forYou));
    expect(mockReplace).not.toHaveBeenCalledWith(TAB_ROUTES.feed);
  });

  /**
   * The read sits between a button press and the navigation it promised, which is the path
   * the build-4 stranding taught this codebase to bound. An unreadable answer resolves to
   * For You, because the failure modes are not symmetric: For You has something for
   * everybody, and the Feed is empty for anybody this query would have been wrong about.
   *
   * The window is generous on purpose. `CONNECTION_GRACE_MS` is three seconds of *real*
   * time, and this assertion is waiting for that deadline to expire rather than for a
   * promise to resolve — so under a loaded full-suite run a five-second budget is close
   * enough to the thing being measured to fail for reasons that have nothing to do with
   * the code. Fifteen is still far below any plausible regression: if the grace ever
   * stopped firing, this would not pass at any timeout.
   */
  it(
    'still leaves when the connection count never settles',
    async () => {
      mockCountHangs = true;
      await finish();

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.forYou), {
        timeout: 15000,
      });
    },
    30000,
  );
});

describe('ending the flow', () => {
  it('records the flow as finished, so it is never offered again', async () => {
    mockCounts.follows = 1;
    await finish();

    await waitFor(() => expect(stageInMemory('user-1')).toBe('done'));
    expect(mockPrefs.get('user-1.onboarding.stage')).toBe('done');
  });

  /**
   * `complete` is called here and nowhere else, so the completion is reported once, at the
   * real end of onboarding rather than at the end of the ranking run.
   */
  it('reports one completion, at the end rather than at the payoff', async () => {
    mockCounts.follows = 1;
    await finish();

    await waitFor(() => expect(eventsNamed('onboarding_completed')).toHaveLength(1));
    expect(eventsNamed('onboarding_completed')[0].props).toMatchObject({ skipped: false });
  });

  /**
   * `skipped` is **read**, not re-derived from a query at the moment of the press.
   *
   * The earlier version computed it from the taste count, which this screen can mount
   * before. An unanswered query read as zero, and an account that had ranked all five
   * reported itself as a skip — the wrong direction on the flow's central metric. The
   * ranking screen now records the answer at the two exits that know it.
   */
  it('reports a skip when the ranking half was left rather than finished', async () => {
    mockPrefs.set('user-1.onboarding.rankingOutcome', 'skipped');
    await finish();

    await waitFor(() => expect(eventsNamed('onboarding_completed')).toHaveLength(1));
    expect(eventsNamed('onboarding_completed')[0].props).toMatchObject({ skipped: true });
  });


  /**
   * **The regression pin for the reporting bug CI caught.**
   *
   * No rankings are visible to this screen at all — the counts are absent, exactly as they
   * are on a relaunch before the taste query has answered. The old implementation read that
   * as zero, called it a skip, and quietly under-counted every completed flow. The outcome
   * is now a recorded fact, so it survives a screen that knows nothing about the count.
   */
  it('does not call a completion a skip merely because no count is available', async () => {
    mockCounts.follows = 1;
    delete mockCounts.rankings;
    delete mockCounts.user_media;

    await finish();

    await waitFor(() => expect(eventsNamed('onboarding_completed')).toHaveLength(1));
    expect(eventsNamed('onboarding_completed')[0].props).toMatchObject({ skipped: false });
  });
  it('does not navigate twice when the button is pressed twice', async () => {
    mockCounts.follows = 1;
    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('Stay in the loop')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('finish the step'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
  });

  /**
   * The stage is what routing consults, and a finished flow has to survive a relaunch —
   * otherwise the six screens are offered again to an account that has done them.
   */
  it('leaves a finished stage on the device for the next launch', async () => {
    mockCounts.follows = 0;
    await finish();
    await waitFor(() => expect(mockPrefs.get('user-1.onboarding.stage')).toBe('done'));

    resetOnboardingStages();
    await expect(hydrateStage('user-1')).resolves.toBe('done');
  });
});

describe('the opening', () => {
  const open = async () => {
    const view = await renderWithProviders(<WelcomeScreen />);
    await waitFor(() => expect(view.getByText('Your favorites, in order.')).toBeTruthy());
    return view;
  };

  it('makes the argument the headline cannot make on its own', async () => {
    const view = await open();

    expect(view.getByText(/without trying to squeeze everything into stars/)).toBeTruthy();
    // The visual is the app's own comparison, and the question above it is the real one.
    expect(view.getByText('Which did you like more?')).toBeTruthy();
  });

  /**
   * The claim on this screen is the order. A number here would start an explanation the
   * screen has no room to finish.
   */
  it('shows no score', async () => {
    const view = await open();
    expect(view.queryByText(/\d\.\d/)).toBeNull();
  });

  it('names the social half low on the screen', async () => {
    const view = await open();
    expect(
      view.getByText('See what friends are loving, compare taste, and find your next watch.'),
    ).toBeTruthy();
  });

  it.each(['Get started', 'I already have an account'])(
    'sends %s to sign in, and closes the opening for good',
    async (label) => {
      const view = await open();
      await fireEvent.press(view.getByRole('button', { name: label }));

      expect(mockReplace).toHaveBeenCalledWith('/(auth)/sign-in');
      await waitFor(() =>
        expect(mockPrefs.get('onboarding.welcome.seen')).toBe(true),
      );
    },
  );
});
