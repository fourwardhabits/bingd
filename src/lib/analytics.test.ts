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
  it('is the canonical names and nothing else', () => {
    // Pinned deliberately. Adding one — or removing one — is a product decision that has
    // to be made in `docs/product/analytics.md` as well as here, and this failing is the
    // reminder. The three group_picks names arrived 2026-09-03 with the feature; the For
    // You slate and the streak names arrived 2026-09-06 (#112, #108) and were emitted
    // for a day without being pinned here or written into the spec; the two funnel
    // denominators — onboarding_started and ranking_started — arrived 2026-09-07 with
    // the pre-GTM convergence. The four social-activation names arrived 2026-09-08
    // (§A17): three about People and the Feed's follow stories, and one that follows the
    // row a redeemed invite writes. `onboarding_step_completed` arrived 2026-09-09 with
    // the multi-screen first-run flow, and is the only event that can say which screen
    // lost somebody. Its companion `onboarding_motivations` went on 2026-09-09 with the
    // two value screens it reported on: the flow no longer asks why anybody downloaded
    // the app, so nothing emits it and a name nothing emits is a name the spec must not
    // carry. The two `similar_*` names arrived 2026-09-11 with the Similar tab, which is
    // the one thing on a title page that costs a provider request lazily — so whether it
    // is opened at all is a number the feature is answerable by. `comparison_info_opened`
    // arrived 2026-09-11 with the comparison memory aids, and is the only number that can
    // say whether a season needs the recall sheet more than a film does.
    expect([...ANALYTICS_EVENTS].sort()).toEqual(
      [
        'comparison_info_opened',
        'follow_activity_opened',
        'follow_created',
        'for_you_slate_shown',
        'group_picks_generated',
        'group_picks_opened',
        'group_picks_result_opened',
        // The Letterboxd import, 2026-09-11 (Contract V3 §9). Five names for a funnel that
        // crosses into another app in the middle: opened, instructions opened, a file read
        // or refused, the upload started, and a completion that is knowingly an undercount
        // because the work finishes on a cron tick with nobody watching.
        'import_archive_selected',
        'import_completed',
        'import_instructions_opened',
        'import_opened',
        'import_started',
        'invite_activated',
        'invite_auto_follow_succeeded',
        'invite_link_created',
        'invite_redeemed',
        'member_search_result_opened',
        'onboarding_completed',
        'onboarding_started',
        'onboarding_step_completed',
        // 2026-09-15, the five optional links on a profile header. One name for the
        // whole feature: whether they are tapped at all is the question, and a second
        // event would be measuring something that has not earned one.
        'profile_social_link_opened',
        'people_suggestions_mode_changed',
        'people_suggestions_viewed',
        'ranking_completed',
        'ranking_started',
        // T5 Refine, 2026-09-20 (epic §P): one event per finished title, one per sitting.
        'refine_session_ended',
        'refine_target_outcome',
        'recommendation_opened',
        'recommendation_sent',
        'sign_in_completed',
        'sign_in_redirect_rejected',
        'signup_completed',
        'settings_support_email_opened',
        'similar_tab_opened',
        'similar_title_opened',
        'review_helpful_added',
        'review_helpful_removed',
        'reviews_sort_changed',
        'streak_state_viewed',
        'title_logged',
        // The watch-history epic, 2026-09-20 (T3b, epic §P). Three names, and the reason
        // there are only three is that the epic's other surfaces are deferred: Refine
        // and the unranked queue are T5 and T6. `watch_logged` is the one that matters —
        // its `basis` property is what makes §C.3.8's defect visible at all, because
        // nothing before it recorded whether a date was chosen or defaulted, and a
        // backfill through Search therefore looked exactly like three hundred people
        // watching three hundred films today.
        'rewatch_decision',
        'watch_history_opened',
        'watch_logged',
        'watchlist_added',
      ].sort(),
    );
  });

  it('pins every name the union can emit, so the spec check cannot miss one', () => {
    // The union is the compile-time control and this list is what the spec is checked
    // against. They drifted once: two events were emitted for a day without being
    // pinned or documented. Each name the app actually sends has to be in the list.
    for (const name of ['for_you_slate_shown', 'streak_state_viewed'] as const) {
      expect(ANALYTICS_EVENTS as readonly string[]).toContain(name);
    }
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
    // `invite_auto_follow_failed` joined on 2026-09-08: §A17 names it, and there is no
    // state it could describe — the reverse follow edge commits with the attribution row in
    // one transaction, and a private inviter is pending rather than failed.
    expect(Object.keys(DEFERRED_EVENTS).sort()).toEqual([
      'award_earned',
      'invite_auto_follow_failed',
    ]);
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
    expect(
      sanitize({ surface: { name: 'search', note: 'private' }, position: [1, 2] }),
    ).toEqual({});
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

  it('lets the Similar events keep the one property they exist for', () => {
    /**
     * The other half of the allowlist, which nothing was asserting.
     *
     * Declaring a property on the union is not enough to put it on the wire — `sanitize`
     * drops every key the list does not name, silently — and that is not hypothetical:
     * `for_you_slate_shown` has been sending none of `medium`, `size` or `repeat_count`
     * since it shipped, and `streak_state_viewed` none of its three, because the type was
     * widened and the list was not. So `medium` is asserted rather than assumed.
     */
    track({ name: 'similar_title_opened', props: { medium: 'tv' } });

    expect(propertiesOf()).toMatchObject({ medium: 'tv' });
  });

  it('lets For You’s repetition counts reach the wire, which they never had', () => {
    // The independent review of the 2026-09-13 repetition fix: its three new counts were
    // declared on the type and dropped by `sanitize`, exactly like `size` and
    // `repeat_count` before them. A mocked `track` in the hook suite cannot see that.
    track({
      name: 'for_you_slate_shown',
      props: {
        medium: 'movies',
        size: 20,
        repeat_count: 3,
        liked_titles: 27,
        anchors_used: 8,
        pool_size: 130,
      },
    });

    expect(propertiesOf()).toMatchObject({
      medium: 'movies',
      size: 20,
      repeat_count: 3,
      liked_titles: 27,
      anchors_used: 8,
      pool_size: 130,
    });
  });

  it('lets a profile link say which network and nothing about whose profile', () => {
    // `network` is the only property this event has, and the assertion is as much about
    // what is absent: a handle is a `username`, a URL contains one, and the target id
    // would turn a "is this used" count into a record of who looked at whom. None of
    // the three has a key it could arrive under, and this is where that is checked
    // rather than assumed.
    track({ name: 'profile_social_link_opened', props: { network: 'instagram' } });

    expect(propertiesOf()).toMatchObject({ network: 'instagram' });
    for (const key of ['username', 'handle', 'url', 'link', 'profile_id', 'target_id']) {
      expect(propertiesOf()).not.toHaveProperty(key);
    }
  });

  it('drops a handle or a URL even if a call site tried to attach one', () => {
    // The union makes this a compile error, so the cast is the only way to write it —
    // and the runtime filter has to hold anyway, because the union is not what runs.
    track({
      name: 'profile_social_link_opened',
      props: { network: 'x', username: 'suraj', url: 'https://x.com/suraj' },
    } as unknown as Parameters<typeof track>[0]);

    expect(propertiesOf()).toMatchObject({ network: 'x' });
    expect(propertiesOf()).not.toHaveProperty('username');
    expect(propertiesOf()).not.toHaveProperty('url');
  });
});

describe('ranking_completed', () => {
  /**
   * The four completions, told apart on the wire.
   *
   * `rerank` and `again` reach the same `placed` answer as a first placement and used to
   * be reported as one, because the event carried only `rebucket`. The founder's own
   * Adjust placement on Terrace House would have counted as a brand-new ranking in every
   * funnel reading this event. `mode` is the whole fix, and `rebucket` stays exactly
   * derivable from it so nothing already charted moves.
   */
  it.each([
    ['start', false],
    ['rebucket', true],
    ['rerank', false],
    ['again', false],
  ] as const)('carries mode %s through the allowlist', (mode, rebucket) => {
    mockCapture.mockClear();
    track({
      name: 'ranking_completed',
      props: {
        media_kind: 'movie',
        surface: 'title',
        comparisons: 3,
        rebucket,
        mode,
        skips: 0,
      },
    });

    expect(propertiesOf()).toMatchObject({ mode, rebucket, comparisons: 3, skips: 0 });
  });

  it('carries the skip count through the allowlist', () => {
    // A count and nothing else: `skips` is how often Too tough was pressed and accepted
    // (2026-09-07), never which comparison it was pressed on.
    mockCapture.mockClear();
    track({
      name: 'ranking_completed',
      props: {
        media_kind: 'movie',
        surface: 'search',
        comparisons: 4,
        rebucket: false,
        mode: 'start',
        skips: 2,
      },
    });

    expect(propertiesOf()).toMatchObject({ skips: 2 });
  });

  /**
   * The reason this is asserted here rather than only in the OAuth suite.
   *
   * `methods.oauth.test.ts` mocks `@/lib/analytics` wholesale, so it can prove the event
   * is *emitted* with the right shape and cannot prove it *survives*. `track` filters
   * every key against `ALLOWED_PROPERTY_KEYS`, and `problem` was missing from that list —
   * so the one property that says which of three failures happened was dropped on the
   * way to the wire, and all three refusals would have arrived in PostHog identical and
   * indistinguishable. An independent review caught it; nothing in the suite did.
   */
  it('carries the OAuth refusal reason through the allowlist', () => {
    mockCapture.mockClear();
    track({ name: 'sign_in_redirect_rejected', props: { problem: 'not_the_app' } });

    expect(propertiesOf()).toMatchObject({ problem: 'not_the_app' });
  });

  /**
   * The optional Letterboxd step (2026-09-13). `step` is a value rather than a key, so the
   * allowlist would not drop a new one; this pins that both halves of the step's answer
   * reach the vendor under the keys the funnel is built on.
   */
  it('carries the Letterboxd step and its outcome through the allowlist', () => {
    for (const outcome of ['continued', 'skipped'] as const) {
      mockCapture.mockClear();
      track({ name: 'onboarding_step_completed', props: { step: 'letterboxd', outcome } });

      expect(mockCapture).toHaveBeenCalledWith('onboarding_step_completed', expect.anything());
      expect(propertiesOf()).toMatchObject({ step: 'letterboxd', outcome });
    }
  });

  it('carries a start with the same mode vocabulary as the completion', () => {
    mockCapture.mockClear();
    track({
      name: 'ranking_started',
      props: { media_kind: 'tv_season', surface: 'onboarding', mode: 'start' },
    });

    expect(mockCapture).toHaveBeenCalledWith(
      'ranking_started',
      expect.objectContaining({
        media_kind: 'tv_season',
        surface: 'onboarding',
        mode: 'start',
      }),
    );
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
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'preview' }),
    );
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
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'preview' }),
    );
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
