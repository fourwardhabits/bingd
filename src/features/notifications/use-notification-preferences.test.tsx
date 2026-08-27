import { fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import {
  ALL_CATEGORIES,
  categoriesIn,
  masterOn,
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

/** What the server answers by default: every category at its own default. */
const DEFAULTS: Record<NotificationCategory, boolean> = {
  follows: true,
  follow_accepted: true,
  comments: true,
  reactions: false,
  watch_tags: true,
  recommendations: true,
  invites: true,
  awards: false,
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
 * default, because two of these categories genuinely default off and a guessed render is
 * indistinguishable from a confirmed one. Independent review 14 found that defect on the
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

  it('is the three groups the founder asked for', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual(['social', 'recommendations', 'achievements']);
  });

  it('gives every section a master and at least one child', () => {
    for (const section of SECTIONS) {
      expect(section.masterLabel.length).toBeGreaterThan(0);
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
   * matters most here, because two categories genuinely are off by default and a wrong
   * render is indistinguishable from a right one.
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

    for (const section of SECTIONS) {
      expect(view.getByLabelText(section.masterLabel)).toBeTruthy();
      for (const setting of section.settings) {
        expect(view.getByLabelText(setting.label)).toBeTruthy();
      }
    }
  });

  it('draws the two default-off categories off and the rest on', async () => {
    const view = await renderLoaded();

    expect(view.getByLabelText('Reactions').props.value).toBe(false);
    expect(view.getByLabelText('bingd. Awards').props.value).toBe(false);
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
   * One call, not five. A master applied by several sequential writes has an outcome
   * for each subset that commits, and the reader is left with a master disagreeing
   * with its own children — which is exactly the state a section control exists to
   * make impossible.
   */
  it('writes a whole section in one call when the master goes off', async () => {
    const view = await renderLoaded();

    fireEvent(view.getByLabelText('All Social notifications'), 'valueChange', false);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_notification_preferences', {
        p_categories: ['follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags'],
        p_enabled: false,
      }),
    );
    expect(
      mockRpc.mock.calls.filter((c) => c[0] === 'set_notification_preference'),
    ).toHaveLength(0);
  });

  it('turns every child on when the master goes on, including one that defaults off', async () => {
    // "All social notifications" has one deterministic reading, and it does not depend
    // on which children happened to be off first.
    answerWith({
      follows: false,
      follow_accepted: false,
      comments: false,
      reactions: false,
      watch_tags: false,
    });
    const view = await renderLoaded();
    expect(view.getByLabelText('All Social notifications').props.value).toBe(false);

    fireEvent(view.getByLabelText('All Social notifications'), 'valueChange', true);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_notification_preferences', {
        p_categories: ['follows', 'follow_accepted', 'comments', 'reactions', 'watch_tags'],
        p_enabled: true,
      }),
    );
  });

  it('shows the master off exactly when the whole section is off', async () => {
    answerWith({
      follows: false,
      follow_accepted: false,
      comments: false,
      reactions: false,
      watch_tags: false,
    });
    const view = await renderLoaded();

    expect(view.getByLabelText('All Social notifications').props.value).toBe(false);
    // Recommendations & invites was untouched, so its master is still on. A master
    // that reported the whole app rather than its own section would fail here.
    expect(view.getByLabelText('All Recommendations & invites notifications').props.value).toBe(
      true,
    );
  });

  it('leaves other sections alone when one master is used', async () => {
    const view = await renderLoaded();

    fireEvent(view.getByLabelText('All Achievement notifications'), 'valueChange', true);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('set_notification_preferences', {
        p_categories: ['awards'],
        p_enabled: true,
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
    mockRpcErrors.set_notification_preferences = [{ code: '', message: 'socket died' }];
    const view = await renderLoaded();

    const readsBefore = mockRpc.mock.calls.filter(
      (c) => c[0] === 'my_notification_preferences',
    ).length;

    fireEvent(view.getByLabelText('All Social notifications'), 'valueChange', false);

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

  it('says plainly that award notifications are not being sent yet', async () => {
    const view = await renderLoaded();

    // **One badge, not two, since 2026-08-20.** `invites` had a writer from
    // `20260819000500` and kept its `pending` flag anyway, so the screen spent a day
    // telling readers a working feature was not built.
    //
    // Two things say it and they are not the same thing: a badge under the one pending
    // setting, and the explainer saying why the switch is still worth setting. The
    // explainer renders from the first frame; the badge appears only
    // once the read lands. So `getByText(/not being sent yet/i)` matched one element
    // while loading and three afterwards, and threw "found multiple" the moment the data
    // arrived — it passed only when polling happened to catch the loading window, which
    // is the opposite race to the rest of this file and why it flaked in both directions.
    //
    // Asserted separately and exactly, so either one going missing is its own failure
    // rather than being absorbed by the other.
    expect(view.getAllByText('Not being sent yet.')).toHaveLength(1);
    expect(view.getByText(/^Award notifications are not being sent yet\./)).toBeTruthy();
  });

  it('marks bingd. Awards as unwritten and no longer marks invites', async () => {
    // The badge has to be on the right row. Asserting the count alone would pass if the
    // flag had merely moved from Awards to Invites.
    const view = await renderLoaded();

    expect(view.getByText('bingd. Awards')).toBeTruthy();
    expect(
      view.getByText('Somebody you invited joins bingd. and ranks their first ten titles.'),
    ).toBeTruthy();
    expect(view.queryByText(/Invite and Award/)).toBeNull();
  });
});
