import { fireEvent, waitFor } from '@testing-library/react-native';

import { clearCelebrations, enqueueCelebrations } from '@/features/awards/celebration-queue';
import type { PushPermission } from '@/features/notifications/push';
import { TAB_ROUTES } from '@/lib/routes';
import { renderWithProviders } from '@/test-utils/render';

import { resetRankingOutcome } from './pick-five';
import { resetOnboardingStages, stageInMemory } from './use-onboarding-stage';
import { resetTasteIntent } from './use-taste-onboarding';

// Not colocated with the routes: everything under app/ is bundled by expo-router's
// require.context. See app-directory.test.ts.
import NotificationsScreen from '../../../app/onboarding/notifications';

/**
 * **"Stay in the loop" is asked once, or not at all** (founder QA, 2026-11-16).
 *
 * A follow on the People step offers the permission in context and writes `push.offered`
 * whatever the answer. The onboarding step used to render regardless, so somebody who had
 * just turned notifications on was asked again on the next screen. These run the real
 * eligibility rule (`shouldShowNotificationStep` → `shouldOfferPush`) against the OS
 * permission and the offered flag, and check that a skip ends the flow through the same
 * path Continue does.
 */

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockTrack = jest.fn();
const mockPrefs = new Map<string, unknown>();
const mockCounts: Record<string, number> = {};
const mockFollowReads: (number | 'hang')[] = [];
let mockPermission: () => Promise<PushPermission> = () => Promise.resolve('undetermined');

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
        then: (resolve: (value: unknown) => unknown) => {
          const scripted = table === 'follows' ? mockFollowReads.shift() : undefined;
          if (scripted === 'hang') return new Promise(() => {});
          return resolve({
            data: [],
            error: null,
            count: typeof scripted === 'number' ? scripted : (mockCounts[table] ?? 0),
          });
        },
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    replace: (href: unknown) => mockReplace(href),
    push: (href: unknown) => mockPush(href),
  }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
  useCurrentUserId: () => 'user-1',
  useAuth: () => ({ status: 'onboarding', userId: 'user-1', email: null }),
  UseDifferentAccountButton: () => null,
}));

// The OS answer, and nothing else about push: the eligibility rule itself is the real one.
jest.mock('@/features/notifications/push', () => ({
  ...jest.requireActual('@/features/notifications/push'),
  pushPermission: () => mockPermission(),
}));

/** The question reduced to its exit; the eligibility rule beside it is the real one. */
jest.mock('./NotificationStep', () => ({
  ...jest.requireActual('./NotificationStep'),
  NotificationStep: ({ onDone }: { onDone: () => void }) => {
    const React = jest.requireActual('react');
    const { Text, Pressable } = jest.requireActual('react-native');
    return React.createElement(
      Pressable,
      { accessibilityRole: 'button', accessibilityLabel: 'Not now', onPress: onDone },
      React.createElement(Text, null, 'Stay in the loop'),
    );
  },
}));

beforeEach(() => {
  mockReplace.mockReset();
  mockPush.mockReset();
  mockTrack.mockReset();
  mockPrefs.clear();
  for (const key of Object.keys(mockCounts)) delete mockCounts[key];
  mockFollowReads.length = 0;
  mockPermission = () => Promise.resolve('undetermined');
  clearCelebrations();
  resetOnboardingStages();
  resetTasteIntent();
  resetRankingOutcome();
  mockPrefs.set('user-1.onboarding.taste.phase', 'active');
  mockCounts.rankings = 5;
  mockCounts.user_media = 5;
});

const eventsNamed = (name: string) =>
  mockTrack.mock.calls.map(([event]) => event).filter((event) => event.name === name);

const offeredOnPeople = () => mockPrefs.set('push.offered', true);

/** The flow ended exactly once, by the canonical path, to `destination`. */
const expectEndedOnce = async (destination: string) => {
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(destination));
  await waitFor(() => expect(stageInMemory('user-1')).toBe('done'));
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(eventsNamed('onboarding_completed')).toHaveLength(1);
};

describe('skipping the question that was already answered', () => {
  it('follow → offered → granted: finishes without asking, onto the Feed', async () => {
    mockCounts.follows = 1;
    offeredOnPeople();
    mockPermission = () => Promise.resolve('granted');
    const view = await renderWithProviders(<NotificationsScreen />);

    await expectEndedOnce(TAB_ROUTES.feed);
    expect(view.queryByText('Stay in the loop')).toBeNull();
    // Never shown, so neither viewed nor completed in the step funnel.
    expect(eventsNamed('onboarding_step_completed')).toHaveLength(0);
    // Nothing claims notifications are on: this path only declines to ask.
    expect(view.queryByText(/notifications are on/i)).toBeNull();
  });

  it('follow → offered → declined (Not now in context): does not ask again', async () => {
    offeredOnPeople();
    mockPermission = () => Promise.resolve('undetermined');
    const view = await renderWithProviders(<NotificationsScreen />);
    await expectEndedOnce(TAB_ROUTES.forYou);
    expect(view.queryByText('Stay in the loop')).toBeNull();
  });

  it.each(['granted', 'blocked', 'unavailable'] as const)(
    'OS permission already %s before any offer: finishes without asking',
    async (permission) => {
      mockPermission = () => Promise.resolve(permission);
      const view = await renderWithProviders(<NotificationsScreen />);
      await expectEndedOnce(TAB_ROUTES.forYou);
      expect(view.queryByText('Stay in the loop')).toBeNull();
    },
  );

  it('shows a short wait while it finds out, never the question flashing away', async () => {
    let answer: (p: PushPermission) => void = () => {};
    mockPermission = () => new Promise((resolve) => (answer = resolve));
    const view = await renderWithProviders(<NotificationsScreen />);
    expect(view.getByTestId('notifications-resolving')).toBeTruthy();
    expect(view.queryByText('Stay in the loop')).toBeNull();
    answer('granted');
    await expectEndedOnce(TAB_ROUTES.forYou);
  });

  it('lands on For You when the only follow is a pending request', async () => {
    // A pending request is not counted by the `approved` read.
    mockCounts.follows = 0;
    mockPermission = () => Promise.resolve('granted');
    await renderWithProviders(<NotificationsScreen />);
    await expectEndedOnce(TAB_ROUTES.forYou);
  });

  it('celebrates what the run earned once, after the navigation', async () => {
    mockCounts.follows = 1;
    mockPermission = () => Promise.resolve('granted');
    enqueueCelebrations([{ kind: 'award', awardKey: 'lol-mode', tierKey: 'giggle' }]);
    await renderWithProviders(<NotificationsScreen />);
    await expectEndedOnce(TAB_ROUTES.feed);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
  });

  it('still lands when the follow read never answers, within its grace', async () => {
    mockFollowReads.push('hang', 'hang');
    mockPermission = () => Promise.resolve('granted');
    await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(TAB_ROUTES.forYou), {
      timeout: 6000,
    });
  }, 10000);
});

describe('asking when the question has not been put', () => {
  it('never offered and undetermined: asks, once, and Not now finishes through the same path', async () => {
    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('Stay in the loop')).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();

    await fireEvent.press(view.getByLabelText('Not now'));
    await expectEndedOnce(TAB_ROUTES.forYou);
    expect(eventsNamed('onboarding_step_completed')).toEqual([
      expect.objectContaining({ props: expect.objectContaining({ step: 'notifications' }) }),
    ]);
  });

  it('asks when the permission cannot be read, rather than stranding the flow', async () => {
    mockPermission = () => Promise.reject(new Error('native module missing'));
    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('Stay in the loop')).toBeTruthy());
  });

  it('asks when the permission read does not answer in time', async () => {
    mockPermission = () => new Promise(() => {});
    const view = await renderWithProviders(<NotificationsScreen />);
    await waitFor(() => expect(view.getByText('Stay in the loop')).toBeTruthy(), {
      timeout: 4000,
    });
  }, 8000);
});
