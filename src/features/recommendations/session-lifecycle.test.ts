import {
  SESSION_IDLE_MS,
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
