/**
 * The analytics contract, tested where it can actually go wrong.
 *
 * Three things are asserted here and each has a failure that would be silent in
 * production and expensive afterwards:
 *
 * - **Nothing private leaves.** The typed union is the first control and a compile error
 *   is its enforcement, which a runtime test cannot reach. What a runtime test *can*
 *   reach is the second control: the property allowlist, and whether a key that should
 *   never be sent could get through it.
 * - **Identity resets.** Two accounts on one device becoming one person in the vendor's
 *   data cannot be undone after the fact.
 * - **Every event names its build.** A funnel that pools an Android dev client with a
 *   TestFlight build is not a funnel, and the fault is invisible in the app.
 */

import {
  ALLOWED_PROPERTY_KEYS,
  ANALYTICS_EVENTS,
  DEFERRED_EVENTS,
  FORBIDDEN_PROPERTY_KEYS,
  identify,
  initAnalytics,
  resetAnalyticsForTests,
  sanitize,
  setAcquisition,
  track,
  type AnalyticsEvent,
} from './analytics';
import { resetReleaseContext } from './release';

const mockCapture = jest.fn();
const mockIdentify = jest.fn();
const mockReset = jest.fn();
const mockRegister = jest.fn(() => Promise.resolve());

jest.mock('posthog-react-native', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    capture: mockCapture,
    identify: mockIdentify,
    reset: mockReset,
    register: mockRegister,
  })),
}));

// The project runs with no PostHog account at all, so the shared setup mock omits the
// key and every function here would be a no-op. This suite is about what happens when
// one *is* configured.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        variant: 'preview',
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'anon-key-for-tests',
        posthogKey: 'phc_test',
        posthogHost: 'https://us.i.posthog.com',
      },
    },
  },
}));

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '0.1.0',
  nativeBuildVersion: '7',
}));

jest.mock('expo-updates', () => ({
  runtimeVersion: 'fingerprint-abc',
  channel: 'preview',
  updateId: null,
  isEmbeddedLaunch: true,
  isEnabled: true,
}));

beforeEach(() => {
  jest.clearAllMocks();
  resetAnalyticsForTests();
  resetReleaseContext();
  initAnalytics();
});

const propertiesOf = (call = 0) => mockCapture.mock.calls[call][1] as Record<string, unknown>;

describe('the event vocabulary', () => {
  it('is the fourteen canonical names and nothing else', () => {
    // Pinned deliberately. Adding a fifteenth is a product decision that has to be made in
    // `docs/product/analytics.md` as well as here, and this failing is the reminder.
    expect([...ANALYTICS_EVENTS].sort()).toEqual(
      [
        'follow_created',
        'invite_activated',
        'invite_link_created',
        'invite_redeemed',
        'member_search_result_opened',
        'onboarding_completed',
        'ranking_completed',
        'recommendation_opened',
        'recommendation_sent',
        'sign_in_completed',
        'signup_completed',
        'settings_support_email_opened',
        'title_logged',
        'watchlist_added',
      ].sort(),
    );
  });

  it('sends the declared name unchanged', () => {
    for (const name of ANALYTICS_EVENTS) {
      mockCapture.mockClear();
      // The props are irrelevant to this assertion and the union is what checks them at
      // build time, so the cast is confined to this loop.
      track({ name, props: {} } as unknown as AnalyticsEvent);
      expect(mockCapture).toHaveBeenCalledWith(name, expect.anything());
    }
  });

  it('names the deferred events without making them emittable', () => {
    // Each of these describes a state the app cannot observe yet. The names exist so the
    // taxonomy is settled; the union does not admit them, so emitting one is a compile
    // error rather than a judgement call.
    // `invite_activated` and `invite_redeemed` left this list on 2026-08-19, which is the
    // mechanism working rather than the list eroding: 20260819000500 gave both a writer,
    // so both moved into the union in the same change that made them true.
    expect(Object.keys(DEFERRED_EVENTS).sort()).toEqual(['award_earned']);
    for (const name of Object.keys(DEFERRED_EVENTS)) {
      expect(ANALYTICS_EVENTS as readonly string[]).not.toContain(name);
    }
  });
});

describe('the privacy boundary', () => {
  it('allows no property key that names free text or a person', () => {
    for (const forbidden of FORBIDDEN_PROPERTY_KEYS) {
      expect(ALLOWED_PROPERTY_KEYS).not.toContain(forbidden);
    }
  });

  it('drops an undeclared key rather than forwarding it', () => {
    expect(sanitize({ surface: 'search', query: 'the godfather', email: 'a@b.c' })).toEqual({
      surface: 'search',
    });
  });

  it('drops an object or an array even under an allowed key', () => {
    // The failure this guards is somebody spreading a row into a property bag: the key
    // survives the allowlist and the bio travels inside the value.
    expect(sanitize({ surface: { name: 'search', note: 'private' }, position: [1, 2] })).toEqual({});
  });

  it('drops null and undefined rather than sending them as values', () => {
    expect(sanitize({ surface: null, position: undefined, media_kind: 'movie' })).toEqual({
      media_kind: 'movie',
    });
  });

  it('sends nothing outside the allowlist on a real event', () => {
    track({ name: 'member_search_result_opened', props: { surface: 'search', position: 1 } });

    for (const key of Object.keys(propertiesOf())) {
      expect(ALLOWED_PROPERTY_KEYS).toContain(key);
    }
  });
});

describe('release identity', () => {
  it('travels with every event', () => {
    track({ name: 'watchlist_added', props: { surface: 'feed' } });

    expect(propertiesOf()).toMatchObject({
      environment: 'preview',
      app_version: '0.1.0',
      build_number: '7',
      runtime_version: 'fingerprint-abc',
      eas_channel: 'preview',
      // `dev_client` rather than `embedded`, even though the `expo-updates` mock above
      // says `isEmbeddedLaunch: true`: Jest sets `__DEV__`, and the packager case wins
      // over the update state on purpose. `release.test.ts` covers the rule directly.
      build_kind: 'dev_client',
    });
  });

  it('is registered as well as merged, so library events carry it too', () => {
    // `register` is what reaches PostHog's own lifecycle events. Merging per event is
    // what covers the first launch, where `register` may not have persisted yet.
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ environment: 'preview' }));
  });

  it('omits an update id when the build is running its own bundle', () => {
    track({ name: 'watchlist_added', props: { surface: 'feed' } });
    expect(propertiesOf()).not.toHaveProperty('eas_update_id');
  });
});

describe('identity', () => {
  it('identifies by the internal id after authentication', () => {
    identify('user-1');
    expect(mockIdentify).toHaveBeenCalledWith('user-1');
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('does not reset on a cold start that has not resolved a session yet', () => {
    // `session.tsx` issues identify(null) before `getSession` answers. Resetting there
    // throws away the anonymous id on every launch, and with it the join between
    // somebody's pre-signup events and the account they go on to create.
    identify(null);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('resets on sign-out', () => {
    identify('user-1');
    identify(null);
    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('resets on the account-deletion path, which is a sign-out', () => {
    // `delete_account` is always followed by `signOut()` — including on the branch where
    // the outcome was never established (`app/settings/account.tsx`) — so the session
    // goes null and this is the same transition as above. Asserted separately because it
    // is a separate requirement, and a future deletion flow that did not sign out would
    // pass the test above and fail this one's intent.
    identify('user-1');
    identify(null);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });

  it('re-registers the release context after a reset, which clears super properties', () => {
    mockRegister.mockClear();
    identify('user-1');
    identify(null);
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ environment: 'preview' }));
  });

  it('resets before identifying a different account on the same device', () => {
    // Without the reset, PostHog aliases the second account onto the first one's
    // anonymous id and the two people are one person for ever.
    identify('user-1');
    mockReset.mockClear();
    identify('user-2');

    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenLastCalledWith('user-2');
  });

  it('does nothing when the same account is identified twice', () => {
    identify('user-1');
    mockIdentify.mockClear();
    identify('user-1');
    expect(mockIdentify).not.toHaveBeenCalled();
  });
});

describe('acquisition and cohort', () => {
  it('registers them when they are known', () => {
    mockRegister.mockClear();
    setAcquisition({ source: 'invite', cohort: 'amc_alist_01' });
    expect(mockRegister).toHaveBeenCalledWith({
      acquisition_source: 'invite',
      beta_cohort: 'amc_alist_01',
    });
  });

  it('registers nothing at all when neither is known', () => {
    // Nullable by design. Nothing may infer a source from behaviour, so "we do not know"
    // has to be expressible as an absent property rather than as a value.
    mockRegister.mockClear();
    setAcquisition({ source: null, cohort: null });
    expect(mockRegister).toHaveBeenCalledWith({});
  });
});
