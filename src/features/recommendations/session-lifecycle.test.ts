import {
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
  SESSION_SHORT_ABSENCE_MS,
  noteAppState,
  noteSlateOnScreen,
  recommendationArrangement,
  refreshRecommendations,
  resetRecommendationSession,
} from './session-seed';

/**
 * **When a For You session begins** (For You V2, 2026-09-13).
 *
 * The founder's rules, each as a test: a re-render or a few minutes away changes nothing; a
 * return after a meaningful absence is a new session; Refresh is a new arrangement whose
 * on-screen titles count as just shown.
 */

const T0 = Date.UTC(2026, 8, 13, 9);

beforeEach(() => resetRecommendationSession(7));

describe('coming back to the app', () => {
  it('changes nothing after a few minutes away', () => {
    noteSlateOnScreen('user|movies|{}', ['a', 'b']);
    const before = recommendationArrangement();

    expect(noteAppState('background', T0)).toBe(false);
    expect(noteAppState('active', T0 + 5 * 60_000)).toBe(false);

    expect(recommendationArrangement()).toBe(before);
  });

  it('ignores inactive, which iOS emits for a banner or the app switcher', () => {
    const before = recommendationArrangement();
    expect(noteAppState('inactive', T0)).toBe(false);
    expect(noteAppState('active', T0 + 3 * SESSION_IDLE_MS)).toBe(false);
    expect(recommendationArrangement()).toBe(before);
  });

  it('begins a new session after a meaningful absence, counting the wall as seen when the reader left', () => {
    noteSlateOnScreen('user|movies|{}', ['a', 'b']);
    const before = recommendationArrangement();

    noteAppState('background', T0);
    const resumedAt = T0 + SESSION_IDLE_MS + 1;
    expect(noteAppState('active', resumedAt)).toBe(true);

    const after = recommendationArrangement();
    expect(after.seed).not.toBe(before.seed);
    expect(after.reason).toBe('resume');
    expect(after.startedAt).toBe(resumedAt);
    expect(after.shownAt.get('a')).toBe(T0);
    expect(after.shownAt.get('b')).toBe(T0);
  });

  it('measures the absence from the first departure, not the last', () => {
    noteAppState('background', T0);
    noteAppState('background', T0 + SESSION_IDLE_MS - 1);
    expect(noteAppState('active', T0 + SESSION_IDLE_MS)).toBe(true);
  });

  it('forgets a departure once the reader is back', () => {
    noteAppState('background', T0);
    noteAppState('active', T0 + 60_000);
    // No departure pending, so a later activation is not a return from anywhere.
    expect(noteAppState('active', T0 + 5 * SESSION_IDLE_MS)).toBe(false);
  });
});

describe('Refresh', () => {
  it('stamps what was on screen as shown now, and starts a new arrangement', () => {
    noteSlateOnScreen('user|movies|{}', ['a']);
    noteSlateOnScreen('user|tv|{}', ['s']);
    const now = T0 + 42;
    refreshRecommendations(now);

    const after = recommendationArrangement();
    expect(after.reason).toBe('refresh');
    expect(after.startedAt).toBe(now);
    expect(after.shownAt.get('a')).toBe(now);
    expect(after.shownAt.get('s')).toBe(now);
    expect(after.current.has('a')).toBe(true);
  });

  it('keeps earlier stamps and never moves one backwards', () => {
    noteSlateOnScreen('user|movies|{}', ['a']);
    refreshRecommendations(T0 + 100);
    noteSlateOnScreen('user|movies|{}', ['b']);
    refreshRecommendations(T0 + 200);

    const { shownAt } = recommendationArrangement();
    expect(shownAt.get('a')).toBe(T0 + 100);
    expect(shownAt.get('b')).toBe(T0 + 200);
  });
});

describe('what the review of V2 found', () => {
  it('renews an old session on a short real absence, so a day of glances still moves on', () => {
    resetRecommendationSession(9);
    const started = recommendationArrangement().startedAt;
    noteAppState('background', started + SESSION_MAX_AGE_MS);
    expect(noteAppState('active', started + SESSION_MAX_AGE_MS + SESSION_SHORT_ABSENCE_MS - 1)).toBe(false);
    noteAppState('background', started + SESSION_MAX_AGE_MS + 10 * 60_000);
    expect(noteAppState('active', started + SESSION_MAX_AGE_MS + 10 * 60_000 + SESSION_SHORT_ABSENCE_MS)).toBe(true);
  });

  it('stamps a wall once, so a wall left long ago ages instead of being re-stamped', () => {
    noteSlateOnScreen('user|tv|{}', ['old']);
    refreshRecommendations(T0);
    noteSlateOnScreen('user|movies|{}', ['new']);
    refreshRecommendations(T0 + 3_600_000);
    const { shownAt } = recommendationArrangement();
    expect(shownAt.get('old')).toBe(T0);
    expect(shownAt.get('new')).toBe(T0 + 3_600_000);
  });
});

describe('the app-state subscription', () => {
  it('is registered once, when the module loads', () => {
    jest.isolateModules(() => {
      const { AppState } = require('react-native');
      const spy = jest.spyOn(AppState, 'addEventListener');
      const changes = () => spy.mock.calls.filter((call) => call[0] === 'change').length;
      const seed = require('./session-seed');
      const atLoad = changes();
      expect(atLoad).toBeGreaterThan(0);
      seed.ensureRecommendationLifecycle();
      seed.ensureRecommendationLifecycle();
      // Idempotent: a wall mounting, or Fast Refresh re-running the hook, adds nothing.
      expect(changes()).toBe(atLoad);
      spy.mockRestore();
    });
  });
});
