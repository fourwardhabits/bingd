import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import {
  ALL_CATEGORIES,
  categoriesIn,
  MAX_PERMISSION_CONTROLS,
  masterOn,
  VISIBLE_SWITCHES,
  SECTION_COVERAGE,
  SECTIONS,
  type NotificationCategory,
  type NotificationPreferences,
} from './use-notification-preferences';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files.
import NotificationPreferencesScreen from '../../../app/settings/notification-preferences';

const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown[]> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name]?.shift() ?? null;
      return Promise.resolve({ data: error ? null : (mockRpcResults[name] ?? null), error });
    },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/**
 * What the server answers by default: every category at its own default. Reactions is the
 * one that defaults off (20261031000100); the rest default on.
 */
const DEFAULTS: Record<NotificationCategory, boolean> = {
  follows: true,
  follow_accepted: true,
  comments: true,
  reactions: false,
  watch_tags: true,
  recommendations: true,
  invites: true,
  awards: true,
  watchlist_discovery: true,
};

const answerWith = (prefs: Partial<Record<NotificationCategory, boolean>> = {}) => {
  const merged = { ...DEFAULTS, ...prefs };
  mockRpcResults.my_notification_preferences = ALL_CATEGORIES.map((category) => ({
    category,
    enabled: merged[category],
  }));
};

beforeEach(() => {
  mockRpc.mockReset();
  mockRpcResults = {};
  mockRpcErrors = {};
  answerWith();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * The copy every row shows in place of its description until the query has answered.
 * Rendered by `Row` in app/settings/notification-preferences.tsx.
 */
const CHECKING = 'Checking your current setting…';

/**
 * Renders the screen and waits for it to actually have an answer from the server.
 *
 * **Every switch here reads `false` while the query is in flight**, and that is
 * deliberate: the screen draws `prefs ? prefs[key] : false` rather than inventing a
 * default, because one of these categories (Reactions) genuinely defaults off and a guessed
 * render is indistinguishable from a confirmed one. Independent review 14 found that defect on the
 * privacy switch and the screen is written to avoid it.
 *
 * The cost lands in the tests. `false` on this screen is two different statements —
 * *off*, and *not read yet* — so a `waitFor` anchored on `false` is satisfied by the
 * loading tree, returns immediately, and every assertion after it that expects `true`
 * runs against switches that have never been told anything. The same applies to a
 * `fireEvent` on a control that is still `disabled`: the handler is never called and the
 * write being asserted never happens.
 *
 * On a quiet machine the data arrives before `waitFor`'s first poll and the whole file
 * passes, which is why this held for months. On a contended runner it does not. CI run
 * 32323036230 failed exactly here — `Comments` expected `true`, received `false` — and
 * deferring the mock by a single macrotask locally fails a *different* pair of tests in
 * this same file. Which ones lose the race is a coin toss, so the anchor is the defect
 * rather than any one line, and the fix belongs in one place that no test can skip.
 *
 * The anchor is the screen's own loading copy: the one signal that means *read*
 * independently of what any preference turned out to be. It also covers the error state,
 * where the rows are replaced wholesale and the copy goes with them.
 */
const renderLoaded = async () => {
  const view = await renderWithProviders(<NotificationPreferencesScreen />);
  await waitFor(() => expect(view.queryAllByText(CHECKING)).toHaveLength(0));
  return view;
};

/**
 * The structure, before any of it is rendered.
 *
 * A category the screen forgot is a setting nobody can reach and an event nobody can
 * stop; one listed twice gives a single switch two masters. Neither is visible in a
 * test that only reads the sections that are there, so both are asserted against the
 * union rather than against the sections.
 */
describe('the sections cover the vocabulary', () => {
  it('places every category in exactly one section', () => {
    expect([...SECTION_COVERAGE].sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(new Set(SECTION_COVERAGE).size).toBe(SECTION_COVERAGE.length);
  });

  // Watching joined on 20261028000100 with one switch for all three proactive kinds.
  it('is the four groups the founder asked for', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'social',
      'recommendations',
      'achievements',
      'watching',
    ]);
  });

  it('adds one category for Watching, and no toggle per internal event', () => {
    const watching = SECTIONS.find((s) => s.key === 'watching');
    expect(watching && categoriesIn(watching)).toEqual(['watchlist_discovery']);
    expect(watching?.settings[0]?.label).toBe('Watchlist & discovery');
  });

  /**
   * Founder, 2026-10-28: five to ten visible controls. One switch per category and no
   * section masters (a master stored nothing and governed nothing a child does not), so
   * nine switches plus at most one permission-card button. A global "Turn all off" would
   * make eleven, which is why it is a recorded follow-up rather than part of this change.
   */
  it('is one switch per category, and at most ten controls with the permission card', () => {
    expect(VISIBLE_SWITCHES.map((s) => s.key)).toEqual([
      'follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags',
      'recommendations', 'invites', 'awards', 'watchlist_discovery',
    ]);
    const controls = VISIBLE_SWITCHES.length + MAX_PERMISSION_CONTROLS;
    expect(controls).toBeGreaterThanOrEqual(5);
    expect(controls).toBeLessThanOrEqual(10);
  });

  it('gives every section at least one child', () => {
    for (const section of SECTIONS) {
      expect(categoriesIn(section).length).toBeGreaterThan(0);
    }
  });

  /**
   * `follow_request` is not a category and must never become one. It is a task rather
   * than news, and an account that could silence it would receive requests it can
   * never see and never answer.
   */
  it('has no switch for follow requests, and says so in the section instead', () => {
    expect(ALL_CATEGORIES).not.toContain('follow_request' as NotificationCategory);
    const social = SECTIONS.find((s) => s.key === 'social');
    expect(social?.footnote).toMatch(/request/i);
  });
});

describe('what a master switch reads', () => {
  // Guarded rather than asserted with `!`: a missing section would otherwise turn
  // every assertion below into a test of `undefined`, which is the shape of failure
  // Review 21 kept finding — a fixture that quietly stops being the thing under test.
  const social = SECTIONS.find((s) => s.key === 'social');
  if (!social)
    throw new Error('the social section must exist for these tests to mean anything');

  const prefs = (over: Partial<NotificationPreferences>): NotificationPreferences => ({
    ...DEFAULTS,
    ...over,
  });

  it('is off only when every child under it is off', () => {
    const allOff = prefs({
      follows: false,
      follow_accepted: false,
      comments: false,
      reactions: false,
      watch_tags: false,
    });
    expect(masterOn(social, allOff)).toBe(false);
  });

  it('is on while any one child is on, which is what makes off mean off', () => {
    const oneOn = prefs({
      follows: false,
      follow_accepted: false,
      comments: true,
      reactions: false,
      watch_tags: false,
    });
    expect(masterOn(social, oneOn)).toBe(true);
  });

  it('is a pure function of the children, so it cannot disagree with them', () => {
    // No stored master state exists to drift. Same children, same answer, always.
    const p = prefs({ reactions: true });
    expect(masterOn(social, p)).toBe(masterOn(social, { ...p }));
  });

  /**
   * Undefined is not off. While the query is in flight the screen knows nothing, and
   * drawing a master in the off position asserts a state nobody has confirmed — which
   * matters most here, because a category genuinely is off by default (Reactions) and a
   * wrong render is indistinguishable from a right one.
   */
  it('does not claim to be on before anything has been read', () => {
    expect(masterOn(social, undefined)).toBe(false);
  });
});

describe('the screen', () => {
  it('renders every group and every switch', async () => {
    const view = await renderLoaded();

    // By label rather than by text: SectionHeader renders its title uppercased, and
    // asserting "SOCIAL" would be asserting a typographic choice rather than the
    // grouping. The accessible name is the one that carries the meaning.
    expect(view.getByLabelText('Social')).toBeTruthy();
    expect(view.getByLabelText('Recommendations & invites')).toBeTruthy();
    expect(view.getByLabelText('Achievements')).toBeTruthy();
    expect(view.getByLabelText('Watching')).toBeTruthy();

    for (const section of SECTIONS) {
      // No section master is drawn (2026-10-28), and every category is.
      expect(view.queryByLabelText(section.masterLabel)).toBeNull();
      for (const setting of section.settings) {
        expect(view.getByLabelText(setting.label)).toBeTruthy();
      }
    }
    // The rendered count, not the declared one: nine switches on the screen.
    expect(view.getAllByRole('switch')).toHaveLength(9);
  });

  it('draws the default-off category off and the rest on', async () => {
    const view = await renderLoaded();

    expect(view.getByLabelText('Reactions').props.value).toBe(false);
    expect(view.getByLabelText('bingd Awards').props.value).toBe(true);
    expect(view.getByLabelText('Comments').props.value).toBe(true);
    expect(view.getByLabelText('Follows').props.value).toBe(true);
    expect(view.getByLabelText('Recommendations').props.value).toBe(true);
  });

  it('reads its values from the server rather than assembling defaults itself', async () => {
    answerWith({ comments: false, reactions: true });
    const view = await renderLoaded();

    expect(view.getByLabelText('Comments').props.value).toBe(false);
    expect(view.getByLabelText('Reactions').props.value).toBe(true);
  });

  it('writes one category when a child is toggled', async () => {
    const view = await renderLoaded();

    fireEvent(view.getByLabelText('Comments'), 'valueChange', false);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_notification_preference', {
        p_category: 'comments',
        p_enabled: false,
      }),
    );
  });

  /**
   * The master switches are gone from the screen (2026-10-28), and with them every
   * multi-category write: each switch writes its own category and nothing else, so no
   * tap can change a preference the reader is not looking at.
   */
  it('never writes more than the one category a switch shows', async () => {
    const view = await renderLoaded();

    for (const setting of VISIBLE_SWITCHES) {
      fireEvent(view.getByLabelText(setting.label), 'valueChange', false);
      await waitFor(() =>
        expect(mockRpc).toHaveBeenCalledWith('set_notification_preference', {
          p_category: setting.key,
          p_enabled: false,
        }),
      );
      // One write at a time: the next tap only counts once the screen has settled.
      await waitFor(() => expect(view.getByLabelText(setting.label).props.disabled).toBe(false));
    }
    expect(mockRpc.mock.calls.filter((c) => c[0] === 'set_notification_preferences')).toHaveLength(0);
  });

  it('writes the Watching switch as the one category it is', async () => {
    const view = await renderLoaded();

    expect(view.getByLabelText('Watchlist & discovery').props.value).toBe(true);
    fireEvent(view.getByLabelText('Watchlist & discovery'), 'valueChange', false);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_notification_preference', {
        p_category: 'watchlist_discovery',
        p_enabled: false,
      }),
    );
  });

  it('tells the reader when a write is refused rather than showing the new position', async () => {
    mockRpcErrors.set_notification_preference = [{ code: '42501', message: 'nope' }];
    const view = await renderLoaded();

    fireEvent(view.getByLabelText('Comments'), 'valueChange', false);

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    // Not optimistic: the switch still shows what the server last confirmed.
    expect(view.getByLabelText('Comments').props.value).toBe(true);
  });

  /**
   * A preference that was written and could not say so leaves the switch showing the
   * old position, and the reader's next tap sets it to what it already is. An unknown
   * outcome is therefore refetched, exactly as `lib/write-outcome.ts` requires — the
   * defect independent review 21e found in four screens.
   */
  it('refetches after an unknown outcome, not only after success', async () => {
    mockRpcErrors.set_notification_preference = [{ code: '', message: 'socket died' }];
    const view = await renderLoaded();

    const readsBefore = mockRpc.mock.calls.filter(
      (c) => c[0] === 'my_notification_preferences',
    ).length;

    fireEvent(view.getByLabelText('Comments'), 'valueChange', false);

    await waitFor(() =>
      expect(
        mockRpc.mock.calls.filter((c) => c[0] === 'my_notification_preferences').length,
      ).toBeGreaterThan(readsBefore),
    );
  });

  /**
   * Independent review 23, second Minor. The hook filled a missing category with
   * `true`, which is wrong in the one direction that matters: a build talking to a
   * backend older than 20260819000300 would have drawn `reactions` and `awards` on,
   * and a master toggle would then have switched on categories nobody chose.
   */
  it('refuses to guess a default the server did not send', async () => {
    mockRpcResults.my_notification_preferences = [
      { category: 'follows', enabled: true },
      { category: 'comments', enabled: true },
    ];

    const view = await renderLoaded();

    expect(view.getByText('Could not load your notification settings')).toBeTruthy();
    // Emphatically not a screen of switches drawn from invented values.
    expect(view.queryByLabelText('Reactions')).toBeNull();
  });

  it('no longer claims any category is not being sent', async () => {
    const view = await renderLoaded();

    // The pending badge and the awards explainer are both gone (20260828000100):
    // the unlock ledger writes award_earned now, so a screen saying "not being
    // sent yet" would be the exact wrong-claim failure the invites day taught —
    // a working feature described as unbuilt. Asserted as absences, so either
    // one creeping back is its own failure.
    expect(view.queryByText('Not being sent yet.')).toBeNull();
    expect(view.queryByText(/not being sent yet/i)).toBeNull();
  });

  it('draws the Awards row like any other, and keeps the invites copy honest', async () => {
    const view = await renderLoaded();

    expect(view.getByText('bingd Awards')).toBeTruthy();
    expect(
      view.getByText('Somebody you invited joins bingd. And again when they finish their first five.'),
    ).toBeTruthy();
    expect(view.queryByText(/Invite and Award/)).toBeNull();
  });

  /**
   * **The number in this row is a promise about when a notification arrives.**
   *
   * It read "their first ten titles" from the day this switch started governing real
   * traffic until 2026-09-11, when invite activation moved to the completed First Five.
   * A stale number here is not cosmetic: this row is where somebody goes to find out why
   * they never heard about a friend who joined, and it would have told them to keep
   * waiting for five rankings that were never going to be needed.
   *
   * Pinned as an absence as well as a presence. The wording above is one sentence anybody
   * may rewrite; the **retired contract** is what must never come back, and a substring
   * assertion is what says so whatever the surrounding copy becomes.
   */
  it('never states the retired ten-ranking activation contract', async () => {
    const view = await renderLoaded();

    expect(view.queryByText(/first ten/i)).toBeNull();
    expect(view.queryByText(/ten titles/i)).toBeNull();
  });
});
