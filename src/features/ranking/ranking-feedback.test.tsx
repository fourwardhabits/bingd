import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RankingSheet, type RankingSheetProps } from './RankingSheet';

/**
 * **How the ranking ritual feels** (founder premium pass, 2026-09-08).
 *
 * Ranking is the act this product is built on, and it is the one flow where the
 * *feedback* is worth pinning as tightly as the RPCs are. Two things happen here that
 * happen nowhere else in the app:
 *
 *   - answering a comparison is the only tap that is an **opinion**, so it takes the
 *     medium `decision` impact rather than the light `selection` one every chip and
 *     bookmark speaks;
 *   - a placement landing is the only **completion** in the app, so it takes the success
 *     notification — once, on the reveal's own mount.
 *
 * And the negative that matters more than either: **the feedback must not have become
 * part of the mechanism.** The founder's standing fear on this screen is a duplicated
 * ranking, and animation plus haptics on the completion path is exactly the shape of
 * change that could produce one. So the RPC counts are asserted alongside the buzzes.
 *
 * Its own file rather than more of `RankingSheet.test.tsx`, which is already 900 lines
 * about the session, and more of `ranking-controls.test.tsx`, which is about what a
 * control looks like. The mocks are a deliberate copy of both rather than a shared
 * helper: a fixture three suites edit is a fixture that grows a flag per suite.
 */

const mockHaptics = { selection: jest.fn(), impact: jest.fn(), notification: jest.fn() };

jest.mock('expo-haptics', () => ({
  selectionAsync: () => {
    mockHaptics.selection();
    return Promise.resolve();
  },
  impactAsync: (style: unknown) => {
    mockHaptics.impact(style);
    return Promise.resolve();
  },
  notificationAsync: (type: unknown) => {
    mockHaptics.notification(type);
    return Promise.resolve();
  },
  ImpactFeedbackStyle: { Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

const mockRpc = jest.fn();
const mockPivotRead = jest.fn();
const mockRecallRead = jest.fn();
const mockCreditsRead = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      // The comparison card and the recall sheet both read `media_items` and ask for
      // different shapes, so the column list is the honest discriminator — a mock that
      // dispatched on the table name would pass even if the two collapsed onto one key.
      select: (columns: string) => ({
        eq: () => ({
          single: () => (columns.includes('overview') ? mockRecallRead() : mockPivotRead()),
          eq: () => ({ maybeSingle: () => mockCreditsRead() }),
        }),
        then: (resolve: (value: unknown) => unknown) => resolve({ count: 1, error: null }),
      }),
    }),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issuedIds = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issuedIds += 1)}` }));

const SESSION = 'session-1';
const subject = {
  id: 'film-a',
  title: 'Film A',
  bucket: 'loved' as const,
  posterUri: null,
  kind: 'movie' as const,
};

const comparison = {
  data: { done: false, session_id: SESSION, pivot: 'film-p' },
  error: null,
};

const placement = {
  data: {
    done: true,
    position: 3,
    category: 'movies',
    bucket: 'loved',
    score: 8.7,
    adjustable: false,
  },
  error: null,
};

const answering = (...responses: unknown[]) => {
  let index = 0;
  mockRpc.mockImplementation(() =>
    Promise.resolve(responses[Math.min(index++, responses.length - 1)]),
  );
};

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/**
 * What a screen reader is told when the placement lands.
 *
 * The numeral itself is `accessibilityElementsHidden` — the panel above it carries a
 * summary label with the whole sentence, and hearing "8.7" twice is worse than hearing
 * it once — so this is the honest way to wait for the reveal.
 */
const REVEAL = 'Film A scored 8.7 out of 10. #3 in Movies.';

beforeEach(() => {
  mockRpc.mockReset();
  mockPivotRead.mockReset();
  mockPivotRead.mockResolvedValue({
    data: { id: 'film-p', title: 'Film P', poster_path: null },
    error: null,
  });
  mockRecallRead.mockReset();
  mockRecallRead.mockResolvedValue({
    data: {
      id: 'film-p',
      kind: 'movie',
      title: 'Film P',
      season_number: null,
      release_date: '1998-01-01',
      runtime_minutes: 117,
      episode_count: null,
      overview: 'A courier misplaces a briefcase.',
      poster_path: null,
      genres: ['Thriller'],
      certification: 'R',
      parent: null,
    },
    error: null,
  });
  mockCreditsRead.mockReset();
  mockCreditsRead.mockResolvedValue({
    data: {
      payload: {
        cast: [{ id: 1, name: 'A Name' }],
        crew: [{ name: 'A Director', job: 'Director' }],
      },
    },
    error: null,
  });
});

const openSheet = async (props: Partial<RankingSheetProps> = {}) => {
  const onClose = jest.fn();
  const view = await renderWithProviders(
    <RankingSheet subject={subject} onClose={onClose} surface="search" {...props} />,
  );

  return {
    ...view,
    onClose,
    card: (title: string) => view.getByLabelText(`Choose ${title}`),
    /** A card is not answerable until the opponent is on screen. */
    ready: async (title: string) =>
      waitFor(() =>
        expect(view.getByLabelText(`Choose ${title}`).props.accessibilityState.disabled).toBe(
          false,
        ),
      ),
  };
};

/**
 * **What is asserted here, and what is deliberately asserted elsewhere.**
 *
 * A comparison card is `disabled` until its opponent has loaded, and a disabled card
 * must not buzz — but that state is already pinned by `ranking-controls.test.tsx`'s
 * `ready` helper, which waits on exactly that flag, and reproducing the pending-pivot
 * condition here needs a second render in the same file. This suite keeps **one render
 * per test**, which is the standing rule against RNTL in this repo: a second render
 * inherits the first's mounted tree, and assertions that count calls stop being about
 * what they name.
 */
describe('answering a comparison', () => {
  it('is a decision, not a selection', async () => {
    /**
     * The only tap in this app that is a judgement, and the only place a medium impact is
     * earned. A `selection` here would put the comparison — the unit of work in the whole
     * ritual — at the same weight as ticking a filter chip.
     */
    answering(comparison);
    const sheet = await openSheet();
    await sheet.ready('Film A');

    await fireEvent.press(sheet.card('Film A'));

    expect(mockHaptics.impact).toHaveBeenCalledTimes(1);
    expect(mockHaptics.impact).toHaveBeenCalledWith('medium');
    expect(mockHaptics.selection).not.toHaveBeenCalled();

    // And it decorates the act rather than replacing it: one buzz, one answer. The buzz
    // is fired before the RPC on purpose — feedback that waits for a round trip is
    // feedback about the connection, and on a bad one it lands after the thumb has
    // lifted.
    await waitFor(() => expect(callsTo('rank_answer')).toHaveLength(1));
  });
});

describe('the placement landing', () => {
  it('is a success, once, and only when the score is on screen', async () => {
    /**
     * The one completion in the app. It fires from the reveal's own mount, which happens
     * exactly once per placement — so the assertion is as much about the *count* as about
     * the word.
     */
    answering(comparison, placement);
    const sheet = await openSheet();
    await sheet.ready('Film A');

    expect(mockHaptics.notification).not.toHaveBeenCalled();

    await fireEvent.press(sheet.card('Film A'));
    await waitFor(() => expect(sheet.getByLabelText(REVEAL)).toBeTruthy());

    expect(mockHaptics.notification).toHaveBeenCalledTimes(1);
    expect(mockHaptics.notification).toHaveBeenCalledWith('success');
  });

  it('leaves the session exactly as it was — one answer, one placement', async () => {
    /**
     * **The founder's standing fear on this screen, asserted against the change most
     * likely to reawaken it.** A duplicated ranking is what a completion animation could
     * plausibly cause — a remount, a second effect, a re-entered exit. The entrance is a
     * transform and an opacity over content that was already computed, and this says so
     * in the only terms that matter: the number of calls.
     */
    answering(comparison, placement);
    const sheet = await openSheet();
    await sheet.ready('Film A');

    await fireEvent.press(sheet.card('Film A'));
    await waitFor(() => expect(sheet.getByLabelText(REVEAL)).toBeTruthy());

    expect(callsTo('rank_answer')).toHaveLength(1);
    expect(callsTo('rank_start')).toHaveLength(1);
    expect(callsTo('rank_cancel')).toHaveLength(0);
  });

  it('does not block the way out', async () => {
    // Nothing about the entrance is blocking: the reveal is interactive from the frame it
    // mounts, so a reader who presses Done immediately is not waiting on an animation.
    answering(comparison, placement);
    const sheet = await openSheet();
    await sheet.ready('Film A');
    await fireEvent.press(sheet.card('Film A'));
    await waitFor(() => expect(sheet.getByLabelText(REVEAL)).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
  });
});
