/**
 * When Bingd asks to send notifications.
 *
 * The subject of this file is a resource that can be spent **once**: iOS presents its
 * permission dialog one time per install and refuses ever after. So the assertions are
 * mostly about *not* asking — at launch, after a denial, when the OS has already decided,
 * and on a re-follow that changed nothing.
 *
 * PRD §15: "Never request push permission at first launch. Request after the user's first
 * successful invite or first follow, when the value is concrete."
 */

import { Alert } from 'react-native';
import {
  offerPushPermission,
  PUSH_OFFERED_PREF,
  registerThisDevice,
  shouldOfferPush,
} from './push-permission';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: mockSession }, error: null }),
    },
    rpc: () => Promise.resolve({ data: { status: 'ok' }, error: null }),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  },
}));

jest.mock('./push', () => ({
  __esModule: true,
  pushPermission: jest.fn(),
  requestPushPermission: jest.fn(),
  acquirePushToken: jest.fn(),
  registerPushToken: jest.fn(),
  revokePushToken: jest.fn(),
  rememberToken: jest.fn(),
  pushPlatform: jest.fn(() => 'ios'),
  pushSessionEpoch: jest.fn(() => 0),
  // Passes the write straight through: the *waiting* half is asserted in push.test.ts,
  // against the real module. Here it only has to not swallow the promise.
  trackDispatchedWrite: jest.fn((write: Promise<unknown>) => write),
  noteFailure: jest.fn(),
}));

let mockSession: { user: { id: string } } | null = { user: { id: 'user-1' } };
let mockPrefs: Record<string, unknown> = {};

jest.mock('@/lib/prefs', () => ({
  readPref: (name: string) => Promise.resolve(mockPrefs[name] ?? null),
  writePref: (name: string, value: unknown) => {
    mockPrefs[name] = value;
    return Promise.resolve();
  },
}));

const push = jest.requireMock('./push') as {
  pushPermission: jest.Mock;
  requestPushPermission: jest.Mock;
  acquirePushToken: jest.Mock;
  registerPushToken: jest.Mock;
  revokePushToken: jest.Mock;
  rememberToken: jest.Mock;
  pushPlatform: jest.Mock;
  pushSessionEpoch: jest.Mock;
};

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

/** Answers the priming alert. `press('Turn on')` picks that button. */
const press = (label: string) =>
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    const button = (buttons ?? []).find((b) => b.text === label);
    button?.onPress?.();
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs = {};
  mockSession = { user: { id: 'user-1' } };
  push.pushPermission.mockResolvedValue('undetermined');
  push.requestPushPermission.mockResolvedValue('granted');
  push.acquirePushToken.mockResolvedValue(TOKEN);
  push.registerPushToken.mockResolvedValue('ok');
  push.revokePushToken.mockResolvedValue('ok');
  push.pushPlatform.mockReturnValue('ios');
  push.pushSessionEpoch.mockReturnValue(0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('shouldOfferPush', () => {
  /**
   * A table rather than four `it`s, because what matters is that the four refusals are
   * *different in kind* and only one of them is Bingd's own: `granted` and `blocked` are
   * the OS having decided, `unavailable` is a simulator, and `offered` is this app
   * remembering it asked.
   */
  it.each`
    permission        | offered  | expected | why
    ${'undetermined'} | ${false} | ${true}  | ${'nobody has been asked'}
    ${'undetermined'} | ${true}  | ${false} | ${'we asked once already'}
    ${'granted'}      | ${false} | ${false} | ${'nothing to ask'}
    ${'blocked'}      | ${false} | ${false} | ${'the OS will not present it again'}
    ${'unavailable'}  | ${false} | ${false} | ${'a simulator, or web'}
  `('$why', ({ permission, offered, expected }) => {
    expect(shouldOfferPush({ permission, offered })).toBe(expected);
  });
});

/**
 * The founder's device pass, 2026-08-26, pinned as copy rather than as behaviour.
 *
 * There were two dialogs and each was written as a follow-up to its own moment — "Know
 * when they follow you back?" after a follow, "Know when they join?" after an
 * invitation. Both read as questions about one specific future event from one specific
 * person, when what is actually being requested is the operating system's permission to
 * notify this account about anything, permanently. Somebody who does not care about
 * *that* follow-back says Not now, `push.offered` is written, and the OS prompt is never
 * reached at all.
 *
 * Asserted here because it is user-visible text that two call sites share and nothing
 * else would notice being wrong: the flow works identically whatever the alert says.
 */
describe('what the priming alert says', () => {
  const shown = async (moment: 'follow' | 'invite') => {
    const alert = press('Not now');
    await offerPushPermission(moment);
    const [title, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; style?: string }[],
    ];
    return { title, body, buttons };
  };

  it.each(['follow', 'invite'] as const)('is the same one question after a %s', async (moment) => {
    const { title, body, buttons } = await shown(moment);

    expect(title).toBe('Turn on notifications?');
    expect(body).toBe(
      'Get notified when someone follows you, recommends something, or comments on what you watched.',
    );
    // "Not now" first and cancel-styled: the safe answer is the easy one.
    expect(buttons.map((b) => b.text)).toEqual(['Not now', 'Turn on']);
    expect(buttons[0]?.style).toBe('cancel');
  });

  it('has retired both of the moment-specific questions', async () => {
    for (const moment of ['follow', 'invite'] as const) {
      const { title, body } = await shown(moment);
      expect(`${title} ${body}`).not.toMatch(/Know when/i);
      // And it no longer claims to be about what bingd. *can* do, which was the old
      // body's shape and reads as a feature list rather than as a permission.
      expect(body).not.toMatch(/bingd\. can/i);
      jest.restoreAllMocks();
      mockPrefs = {};
    }
  });
});

describe('offering it', () => {
  it('shows the priming alert before the OS dialog, not instead of it', async () => {
    const alert = press('Turn on');
    await offerPushPermission('follow');

    expect(alert).toHaveBeenCalled();
    expect(push.requestPushPermission).toHaveBeenCalled();
  });

  /**
   * The whole reason for the two-step. A "Not now" is recoverable and a "Don't Allow" is
   * not, so the cheap question has to be the one that can be answered wrongly.
   */
  it('never reaches the OS dialog when the priming alert is declined', async () => {
    press('Not now');
    await offerPushPermission('follow');

    expect(push.requestPushPermission).not.toHaveBeenCalled();
    expect(push.registerPushToken).not.toHaveBeenCalled();
  });

  it('registers the device once permission is granted', async () => {
    press('Turn on');
    await offerPushPermission('follow');

    expect(push.registerPushToken).toHaveBeenCalledWith('user-1', TOKEN, 'ios');
    expect(push.rememberToken).toHaveBeenCalledWith('user-1', TOKEN);
  });

  /**
   * Asking again after "Not now" is what teaches people to dismiss dialogs unread — and
   * it would be spent on the same person the OS prompt would then also fail on.
   */
  it('asks once ever, whichever way it was answered', async () => {
    for (const answer of ['Not now', 'Turn on']) {
      press(answer);
      await offerPushPermission('follow');
      await offerPushPermission('invite');
    }

    expect(mockPrefs[PUSH_OFFERED_PREF]).toBe(true);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all when the OS has already decided', async () => {
    for (const state of ['granted', 'blocked', 'unavailable']) {
      jest.clearAllMocks();
      mockPrefs = {};
      push.pushPermission.mockResolvedValue(state);
      const alert = press('Turn on');

      await offerPushPermission('follow');
      expect(alert).not.toHaveBeenCalled();
    }
  });

  /**
   * Granted somewhere else — a previous install the OS remembers, or another moment in
   * this session. There is nothing to ask and there may well be something to register.
   */
  it('registers without asking when permission already exists', async () => {
    push.pushPermission.mockResolvedValue('granted');
    const alert = press('Turn on');

    await offerPushPermission('follow');

    expect(alert).not.toHaveBeenCalled();
    expect(push.registerPushToken).toHaveBeenCalled();
  });

  /**
   * **This asserted the opposite until the founder's device pass**, and the reversal is
   * the point: the two moments PRD §15 names decide *when* the question may be put, not
   * what it says. Tailoring the wording to the tap made a request for a permanent OS
   * permission read as a question about one follow. See `what the priming alert says`
   * above for the copy itself.
   */
  it('asks the same question whichever moment reached it', async () => {
    const alert = press('Not now');
    await offerPushPermission('follow');
    const followCopy = alert.mock.calls[0]?.slice(0, 2);

    mockPrefs = {};
    jest.clearAllMocks();
    const second = press('Not now');
    await offerPushPermission('invite');
    const inviteCopy = second.mock.calls[0]?.slice(0, 2);

    expect(followCopy).toEqual(inviteCopy);
  });

  /**
   * Called with `void` from a write that has already committed. A rejection here would
   * become an unhandled promise rejection in a success path, and on the strength of a
   * permission dialog.
   */
  it('never rejects, however badly it goes', async () => {
    push.pushPermission.mockRejectedValue(new Error('module missing'));
    await expect(offerPushPermission('follow')).resolves.toBeUndefined();
  });

  it('does nothing without a session to attribute the device to', async () => {
    mockSession = null;
    const alert = press('Turn on');

    await offerPushPermission('follow');
    expect(alert).not.toHaveBeenCalled();
    expect(push.registerPushToken).not.toHaveBeenCalled();
  });
});

describe('registerThisDevice', () => {
  it('does not remember a token the server never accepted', async () => {
    push.registerPushToken.mockResolvedValue('failed');
    await registerThisDevice('user-1');

    expect(push.rememberToken).not.toHaveBeenCalled();
  });

  it('stops quietly when no token could be acquired', async () => {
    push.acquirePushToken.mockResolvedValue(null);
    await registerThisDevice('user-1');

    expect(push.registerPushToken).not.toHaveBeenCalled();
  });

  /**
   * The race an independent review found, and the reason it has no symptom: the sign-out
   * looked for a token to revoke and this function had not written one yet, so the revoke
   * released nothing and the write landed **after** it. The device ends up addressed to an
   * account that has left, on a phone somebody else may now be holding.
   */
  it('undoes a registration that landed after the account signed out', async () => {
    let epoch = 0;
    push.pushSessionEpoch.mockImplementation(() => epoch);
    push.registerPushToken.mockImplementation(() => {
      epoch = 1;
      return Promise.resolve('ok');
    });

    await registerThisDevice('user-1');

    expect(push.revokePushToken).toHaveBeenCalledWith('user-1', TOKEN);
    expect(push.rememberToken).not.toHaveBeenCalled();
  });

  it('writes nothing at all when the account leaves while a token is being minted', async () => {
    let epoch = 0;
    push.pushSessionEpoch.mockImplementation(() => epoch);
    push.acquirePushToken.mockImplementation(() => {
      epoch = 1;
      return Promise.resolve(TOKEN);
    });

    await registerThisDevice('user-1');

    expect(push.registerPushToken).not.toHaveBeenCalled();
    expect(push.revokePushToken).not.toHaveBeenCalled();
  });
  it('stops on a platform with no device tokens at all', async () => {
    push.pushPlatform.mockReturnValue(null);
    await registerThisDevice('user-1');

    expect(push.acquirePushToken).not.toHaveBeenCalled();
  });
});
