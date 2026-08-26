import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * The onboarding permission step (founder follow-up part J).
 *
 * Four rules, and each of them is a way the one permanent dialog can be wasted:
 *
 *   1. **Nothing touches the OS on mount.** A screen that prompts as it appears has spent
 *      the question before the reader has read a word of why.
 *   2. **"Not now" makes no request at all**, so it stays recoverable. A "Don't Allow" is
 *      forever; ours is not.
 *   3. **The offer is recorded either way**, so the contextual primer does not put the
 *      same question again five minutes later (part K).
 *   4. **It does not claim success it did not get.** On the friend-beta binary the OS can
 *      say yes and a token still cannot be minted — Android has no FCM configuration
 *      compiled in — and a step that said "you are all set" there would be the app
 *      claiming a delivery path it does not have.
 */

const mockPush = {
  permission: 'undetermined' as string,
  requested: 0,
  requestResult: 'granted' as string,
  registerResult: 'registered' as string,
  registered: 0,
  offered: 0,
};

jest.mock('@/features/notifications/push', () => ({
  pushPermission: () => Promise.resolve(mockPush.permission),
  requestPushPermission: () => {
    mockPush.requested += 1;
    return Promise.resolve(mockPush.requestResult);
  },
  noteFailure: jest.fn(),
}));

jest.mock('@/features/notifications/push-permission', () => ({
  shouldOfferPush: ({ permission, offered }: { permission: string; offered: boolean }) =>
    permission === 'undetermined' && !offered,
  markPushOffered: () => {
    mockPush.offered += 1;
    return Promise.resolve();
  },
  registerThisDevice: () => {
    mockPush.registered += 1;
    return Promise.resolve(mockPush.registerResult);
  },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'u1', username: 'sai', display_name: 'Sai' }),
}));

import { NotificationStep, shouldShowNotificationStep } from './NotificationStep';

beforeEach(() => {
  mockPush.permission = 'undetermined';
  mockPush.requested = 0;
  mockPush.requestResult = 'granted';
  mockPush.registerResult = 'registered';
  mockPush.registered = 0;
  mockPush.offered = 0;
});

const open = async (onDone = jest.fn()) => {
  const view = await renderWithProviders(<NotificationStep onDone={onDone} />);
  return { view, onDone };
};

describe('when it is shown at all', () => {
  it('is shown to somebody who has never been asked', async () => {
    expect(await shouldShowNotificationStep(false)).toBe(true);
  });

  it('is skipped when the OS has already granted it', async () => {
    mockPush.permission = 'granted';
    expect(await shouldShowNotificationStep(false)).toBe(false);
  });

  /**
   * The case that matters most on iOS. Once somebody has said no, the system will not
   * present its dialog again — so a button whose only possible outcome is nothing is
   * worse than no button, and "Previously denied / OS will not prompt" is the founder's
   * own wording for it.
   */
  it('is skipped when the OS has already refused and will not ask again', async () => {
    mockPush.permission = 'blocked';
    expect(await shouldShowNotificationStep(false)).toBe(false);
  });

  it('is skipped on a device that cannot receive push at all', async () => {
    mockPush.permission = 'unavailable';
    expect(await shouldShowNotificationStep(false)).toBe(false);
  });

  /** Part K: whichever surface asked first closes the question for the other. */
  it('is skipped when Bingd has already put the question somewhere else', async () => {
    expect(await shouldShowNotificationStep(true)).toBe(false);
  });
});

describe('the step itself', () => {
  it('says what it is for, in the founder’s words', async () => {
    const { view } = await open();
    expect(view.getByText('Stay in the loop')).toBeTruthy();
    expect(
      view.getByText(/Know when friends follow you, recommend something, or interact/),
    ).toBeTruthy();
  });

  /**
   * Rule 1, and the one a screenshot cannot catch: the copy is identical whether or not
   * the dialog has already fired, so only a count proves it.
   */
  it('asks the operating system for nothing until the button is pressed', async () => {
    await open();
    expect(mockPush.requested).toBe(0);
    expect(mockPush.offered).toBe(0);
  });

  it('requests the real permission on Turn on notifications', async () => {
    const { view } = await open();

    await act(async () => {
      fireEvent.press(view.getByText('Turn on notifications'));
    });

    expect(mockPush.requested).toBe(1);
    expect(mockPush.registered).toBe(1);
    await waitFor(() => expect(view.getByText('You are all set')).toBeTruthy());
  });

  it('continues without asking when Not now is pressed', async () => {
    const { view, onDone } = await open();

    await act(async () => {
      fireEvent.press(view.getByText('Not now'));
    });

    // Rule 2. The OS was never touched, so the permission is still `undetermined` and
    // Settings can still turn it on later.
    expect(mockPush.requested).toBe(0);
    expect(mockPush.registered).toBe(0);
    await waitFor(() => expect(view.getByText('No problem')).toBeTruthy());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  /** Rule 3, for both answers. */
  it('records the offer whichever button is pressed', async () => {
    const first = await open();
    await act(async () => {
      fireEvent.press(first.view.getByText('Not now'));
    });
    expect(mockPush.offered).toBe(1);

    const second = await open();
    await act(async () => {
      fireEvent.press(second.view.getByText('Turn on notifications'));
    });
    expect(mockPush.offered).toBe(2);
  });

  it('continues when the operating system refuses', async () => {
    mockPush.requestResult = 'blocked';
    const { view, onDone } = await open();

    await act(async () => {
      fireEvent.press(view.getByText('Turn on notifications'));
    });

    // Not required to finish onboarding, which is the founder's J1. A refusal is an
    // answer, not a wall.
    expect(mockPush.registered).toBe(0);
    await waitFor(() => expect(view.getByText('No problem')).toBeTruthy());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  /**
   * Rule 4, and the reason this step is capability-gated rather than lane-gated.
   *
   * This is the friend-beta binary's actual behaviour on Android: the OS grants the
   * permission and `getExpoPushTokenAsync` then fails, because no `google-services.json`
   * was compiled in. **Nothing here checks which lane it is** — the same code says "you
   * are all set" on a build that can register and this on one that cannot, so a
   * production binary starts telling the truth the moment its credentials exist, with
   * no flag anybody has to remember to remove.
   */
  it('does not claim success when no token could be registered', async () => {
    mockPush.registerResult = 'failed';
    const { view, onDone } = await open();

    await act(async () => {
      fireEvent.press(view.getByText('Turn on notifications'));
    });

    expect(view.queryByText('You are all set')).toBeNull();
    await waitFor(() =>
      expect(view.getByText(/cannot send notifications to your lock screen yet/)).toBeTruthy(),
    );
    // And it still says what does work, because the inbox genuinely does.
    expect(view.getByText(/still see everything in the app/)).toBeTruthy();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
