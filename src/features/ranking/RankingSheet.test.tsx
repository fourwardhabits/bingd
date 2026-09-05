import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { renderWithProviders } from '@/test-utils/render';
import { queryKeys } from '@/lib/query';

import { RankingSheet, type RankingSheetProps } from './RankingSheet';

const mockRpc = jest.fn();
const mockPivotRead = jest.fn();
const mockRecallRead = jest.fn();
const mockCreditsRead = jest.fn();
const mockSelect = jest.fn();

/**
 * Three reads share this mock, told apart by their columns rather than by their table.
 *
 * The comparison card and the title reminder both select from `media_items`, and the
 * whole point of `queryKeys.titleRecall` existing separately is that they ask for
 * different shapes — so the column list is the honest discriminator, and a test that
 * dispatched on the table name would pass even if the two collapsed onto one key.
 */
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: (columns: string) => {
        mockSelect(columns);
        const chain = {
          eq: () => ({
            single: () => (columns.includes('overview') ? mockRecallRead() : mockPivotRead()),
            // `use-credits` narrows by media item and then by facet.
            eq: () => ({ maybeSingle: () => mockCreditsRead() }),
          }),
          // The head-count probe `use-credits` opens with, awaited directly.
          then: (resolve: (value: unknown) => unknown) => resolve({ count: 1, error: null }),
        };
        return chain;
      },
    }),
  },
  startSessionRefresh: () => () => {},
}));

/**
 * The ranked list the reveal reads for its genre ranks and its neighbours.
 *
 * Mocked rather than driven through the `from` stub above, because `useRankedCollection`
 * pages through `readAllByKey` and the stub answers one shape per column list. What these
 * tests are for is what the reveal *draws* from a list, and the list itself is covered
 * where it is derived (`collection/rank-neighbours.test.ts`).
 *
 * Empty by default, which is the pre-refetch state every other test in this file already
 * rendered under.
 */
const mockRanked = jest.fn(() => ({ data: [] as unknown[] }));

jest.mock('@/features/collection/use-collection', () => ({
  ...jest.requireActual('@/features/collection/use-collection'),
  useRankedCollection: () => mockRanked(),
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

/**
 * `expo-crypto` has no implementation under Jest, so `randomUUID()` answers `undefined`
 * — and an operation id that is undefined is indistinguishable, at the assertion, from
 * one this component forgot to send. Counting instead of guessing makes the difference
 * visible: `useOperationIntent` minting a fresh id where it should have reused one
 * shows up as two different strings rather than as two `undefined`s that compare equal.
 */
let issuedIds = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issuedIds += 1)}` }));

const subject = { id: 'film-a', title: 'Film A', bucket: 'loved' as const, posterUri: null };

/** What `renderWithProviders` passes; repeated here for the one test that owns its client. */
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const SESSION = 'session-1';

const comparison = (over: Record<string, unknown> = {}) => ({
  data: { done: false, session_id: SESSION, pivot: 'film-p', ...over },
  error: null,
});

const placement = {
  data: {
    done: true,
    position: 3,
    category: 'movies',
    bucket: 'loved',
    // The reveal's hero number. Computed server-side at finalize (20260815010000),
    // because the band sizes the client holds predate this insertion.
    score: 8.7,
    adjustable: false,
  },
  error: null,
};

/** Answers rank_start (and anything after it) with a queue of responses. */
const answering = (...responses: unknown[]) => {
  let index = 0;
  mockRpc.mockImplementation(() =>
    Promise.resolve(responses[Math.min(index++, responses.length - 1)]),
  );
};

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

/** Every string the user can actually read, without the styles a JSON dump carries. */
const visibleText = (node: unknown): string[] => {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(visibleText);
  if (node && typeof node === 'object' && 'children' in node) {
    return visibleText((node as { children: unknown }).children);
  }
  return [];
};

beforeEach(() => {
  mockRpc.mockReset();
  mockSelect.mockReset();
  mockRanked.mockReset();
  mockRanked.mockReturnValue({ data: [] });
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
    data: { payload: { cast: [{ id: 1, name: 'A Name' }], crew: [{ name: 'A Director', job: 'Director' }] } },
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
    close: () => view.getByRole('button', { name: 'Close' }),
    /**
     * A card is not answerable until the opponent is on screen, so a press before that
     * does nothing at all — including in a test, which would then pass for the wrong
     * reason.
     */
    ready: async (title: string) => {
      await waitFor(() =>
        expect(view.getByLabelText(`Choose ${title}`).props.accessibilityState.disabled).toBe(
          false,
        ),
      );
      return view.getByLabelText(`Choose ${title}`);
    },
  };
};

/**
 * Comparison and reveal (screens.md §4).
 *
 * Two things here are load-bearing and invisible from the outside. The first is that
 * dismissing the sheet cancels the session the server is holding: leave it and the next
 * rank_start resumes it mid-search, asking a question the user has no context for. The
 * second is that the opponent's position is never shown — an anchor the user agrees with
 * instead of judging (PRD §10.4).
 */
describe('the comparison', () => {
  it('asks the question over the two titles', async () => {
    answering(comparison());
    const sheet = await openSheet();

    await waitFor(() => expect(sheet.getByText('Which did you like more?')).toBeTruthy());
    expect(sheet.card('Film A')).toBeTruthy();
    expect(await sheet.findByLabelText('Choose Film P')).toBeTruthy();
    expect(callsTo('rank_start')[0][1]).toMatchObject({
      p_media_item_id: 'film-a',
      p_bucket: 'loved',
    });
  });

  it('never shows the opponent\u2019s position', async () => {
    // PRD §10.4. The read is the enforcement: a position cannot be rendered by accident if
    // it was never fetched, so this asserts the columns as well as the screen.
    answering(comparison());
    const sheet = await openSheet();

    await sheet.ready('Film P');

    // Text the user can read, not the JSON dump: styles are full of "position" and hex
    // colours are full of "#".
    const words = visibleText(sheet.toJSON());
    expect(words).toContain('Film P');
    expect(words.filter((word) => /#|\bno\.|\d/.test(word))).toEqual([]);

    // And the position is not merely unrendered: it is never read, which is what makes
    // showing it by accident impossible.
    expect(mockSelect).toHaveBeenCalledWith('id, title, poster_path');
  });

  it('caches the opponent under a key of its own', async () => {
    // Three columns cached under queryKeys.title would be served to a title screen asking
    // for a whole row, and whichever query ran first would win for five minutes.
    answering(comparison());
    const sheet = await openSheet();

    await sheet.ready('Film P');

    const keys = sheet.client
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));

    expect(keys).toContain(JSON.stringify(queryKeys.comparisonCard('film-p')));
    expect(keys).not.toContain(JSON.stringify(queryKeys.title('film-p')));
  });

  it('sends the card the user tapped as the winner', async () => {
    answering(comparison(), comparison({ pivot: 'film-q' }));
    const sheet = await openSheet();

    await fireEvent.press(await sheet.ready('Film A'));

    await waitFor(() => expect(callsTo('rank_answer')).toHaveLength(1));
    expect(callsTo('rank_answer')[0][1]).toMatchObject({
      p_session_id: SESSION,
      p_winner: 'film-a',
    });
  });

  /**
   * The two secondary controls, pinned to what the server actually does.
   *
   * Both labels changed on 2026-08-24 and neither mechanism did. `Back` became `Undo`
   * because `rank_back` genuinely reverses the last answer — it restores `lo`, `hi` and
   * `pivot` from the history entry it pops (20260813001600) — and `Too tough to call`
   * became `Skip` because the founder's case for it is "I do not remember this one",
   * which the old wording excluded and the same `rank_skip` has always served.
   *
   * **The escape is `Too tough` again, on every surface, since 2026-08-30**, and the
   * mechanism has still never moved: one control, one `rank_skip`, no win, no loss and
   * no tie. That is what these assert — a rename that quietly pointed a word at a new
   * call would pass a copy test and fail here.
   *
   * **They are addressed by accessible label.** On 2026-08-25 Undo gained "Undo the last
   * comparison" for the same reason the escape has always carried "Skip this
   * comparison": on a screen whose other exit is a Close, a bare "Undo" is ambiguous
   * about what it undoes. The visible words are asserted separately, below.
   */
  it('undoes the last comparison through rank_back', async () => {
    answering(comparison(), comparison({ pivot: 'film-q' }));
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.getByLabelText('Undo the last comparison'));

    await waitFor(() => expect(callsTo('rank_back')).toHaveLength(1));
    expect(callsTo('rank_back')[0][1]).toMatchObject({ p_session_id: SESSION });
    expect(callsTo('rank_answer')).toHaveLength(0);
  });

  it('sends Too tough to rank_skip, and places nothing', async () => {
    answering(comparison(), comparison({ pivot: 'film-q', skipped: true }));
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.getByLabelText('Too tough to call'));

    await waitFor(() => expect(callsTo('rank_skip')).toHaveLength(1));
    expect(callsTo('rank_skip')[0][1]).toMatchObject({ p_session_id: SESSION });
    // The comparison is replaced, not answered — no judgement is recorded for a pair
    // the reader declined to judge. No fabricated tie, no fabricated preference: the
    // server writes a comparison row only from `rank_answer`, and this never calls it.
    expect(callsTo('rank_answer')).toHaveLength(0);
    await waitFor(() => expect(sheet.getByText('Try this one instead')).toBeTruthy());
  });

  /**
   * **The same call from the onboarding surface**, which is the half the founder could
   * not check by eye once both surfaces printed the same word.
   *
   * The label converged on 2026-08-30; this is what says the *mechanism* converged with
   * it rather than onboarding keeping a path of its own. `rank_skip` is where the
   * server's per-session `seen_items` guarantee lives (20260901000100), so a surface
   * that reached the escape any other way would be a surface without the no-repeat
   * invariant.
   */
  it('sends Too tough to the same rank_skip from onboarding', async () => {
    answering(comparison(), comparison({ pivot: 'film-q', skipped: true }));
    const sheet = await openSheet({ surface: 'onboarding' });

    await sheet.ready('Film P');
    await fireEvent.press(sheet.getByLabelText('Too tough to call'));

    await waitFor(() => expect(callsTo('rank_skip')).toHaveLength(1));
    expect(callsTo('rank_skip')[0][1]).toMatchObject({ p_session_id: SESSION });
    expect(callsTo('rank_answer')).toHaveLength(0);
  });

  it('says nothing about progress it cannot measure', async () => {
    // Founder feedback, 2026-08-24. The line under the posters used to read "Getting
    // closer" on every comparison after the first, which is encouragement rather than
    // information: the binary search's remaining range belongs to the server and this
    // screen has never known it.
    answering(comparison(), comparison({ pivot: 'film-q' }));
    const sheet = await openSheet();

    await sheet.ready('Film P');
    expect(sheet.queryByText('Getting closer')).toBeNull();
    expect(sheet.queryByText('A few comparisons to go')).toBeNull();

    await fireEvent.press(sheet.card('Film A'));
    await waitFor(() => expect(callsTo('rank_answer')).toHaveLength(1));
    expect(sheet.queryByText('Getting closer')).toBeNull();
  });

  it('will not take an answer against a card that is not on screen yet', async () => {
    // Answering here would record a preference over a card reading "…". The subject's card
    // has to wait too, not just the pivot's.
    answering(comparison());
    mockPivotRead.mockReturnValue(new Promise(() => {}));
    const sheet = await openSheet();

    await waitFor(() => expect(sheet.getByText('Which did you like more?')).toBeTruthy());

    // The opponent's card has no title to show yet, which is the whole problem.
    expect(sheet.card('\u2026').props.accessibilityState.disabled).toBe(true);
    expect(sheet.card('Film A').props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(sheet.card('Film A'));
    expect(callsTo('rank_answer')).toHaveLength(0);
  });

  /**
   * Title recall (founder request, 2026-08-24).
   *
   * The property that matters is negative: a reader who holds a poster to remember what
   * it is must not thereby vote for it. Everything else about this feature is a sheet;
   * that one thing is a correctness rule about the ranking.
   */
  describe('remembering a title mid-comparison', () => {
    it('opens the reminder on a long press without answering the comparison', async () => {
      answering(comparison());
      const sheet = await openSheet();

      await sheet.ready('Film P');
      await fireEvent(sheet.card('Film P'), 'longPress');

      await waitFor(() =>
        expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy(),
      );
      // The whole point. React Native suppresses `onPress` after a long press, and this
      // is the assertion that keeps that guarantee load-bearing rather than assumed.
      expect(callsTo('rank_answer')).toHaveLength(0);
      expect(callsTo('rank_skip')).toHaveLength(0);
    });

    it('shows what jogs a memory, and nothing to act on', async () => {
      answering(comparison());
      const sheet = await openSheet();

      await sheet.ready('Film P');
      await fireEvent(sheet.card('Film P'), 'longPress');
      await waitFor(() => expect(sheet.getByText('Directed by A Director')).toBeTruthy());

      expect(sheet.getByText('1998')).toBeTruthy();
      expect(sheet.getByText('R · 117m · Thriller')).toBeTruthy();
      expect(sheet.getByText('With A Name')).toBeTruthy();
      // A reminder, not the title page: nothing here changes the collection.
      expect(sheet.queryByRole('button', { name: 'Add to watchlist' })).toBeNull();
    });

    it('returns to the same pair and the same session when dismissed', async () => {
      answering(comparison());
      const sheet = await openSheet();

      await sheet.ready('Film P');
      await fireEvent(sheet.card('Film P'), 'longPress');
      await waitFor(() =>
        expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy(),
      );

      await fireEvent.press(sheet.getByRole('button', { name: 'Back to ranking' }));

      await waitFor(() =>
        expect(sheet.queryByText('A courier misplaces a briefcase.')).toBeNull(),
      );
      expect(sheet.getByText('Which did you like more?')).toBeTruthy();
      expect(sheet.card('Film P')).toBeTruthy();
      // The session was never cancelled and never restarted — the reminder rendered
      // inside the comparison rather than in place of it.
      expect(callsTo('rank_cancel')).toHaveLength(0);
      expect(callsTo('rank_start')).toHaveLength(1);
    });

    it('offers the same thing to somebody who cannot long press', async () => {
      // design-system.md §8: a hidden gesture may be the fast path and never the only
      // one. VoiceOver and TalkBack have no general long-press gesture.
      answering(comparison());
      const sheet = await openSheet();

      await sheet.ready('Film P');
      await fireEvent.press(sheet.getByLabelText('Details about Film P'));

      await waitFor(() =>
        expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy(),
      );
      expect(callsTo('rank_answer')).toHaveLength(0);
    });

    it('reads a different shape from the comparison card, under its own key', async () => {
      // If these ever collapsed onto one query key, whichever ran first would serve the
      // other a row it did not ask for — the hazard `queryKeys.comparisonCard` records.
      answering(comparison());
      const sheet = await openSheet();

      await sheet.ready('Film P');
      await fireEvent(sheet.card('Film P'), 'longPress');
      await waitFor(() =>
        expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy(),
      );

      const columns = mockSelect.mock.calls.map(([value]) => value as string);
      expect(columns.some((value) => value.includes('overview'))).toBe(true);
      expect(columns).toContain('id, title, poster_path');
    });
  });

  it('says so when the other title cannot be loaded, instead of showing an ellipsis', async () => {
    answering(comparison());
    mockPivotRead.mockResolvedValue({ data: null, error: { message: 'network' } });
    const sheet = await openSheet();

    await waitFor(() => expect(sheet.getByText('Could not load the other title')).toBeTruthy());
    expect(sheet.queryByLabelText('Choose Film A')).toBeNull();
    expect(sheet.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('closing', () => {
  it('cancels the session it is in the middle of', async () => {
    answering(comparison());
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.close());

    await waitFor(() => expect(callsTo('rank_cancel')).toHaveLength(1));
    expect(callsTo('rank_cancel')[0][1]).toEqual({ p_session_id: SESSION });
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('cancels a session that arrives after the sheet has been dismissed', async () => {
    // The dismissal happens while rank_start is still in flight, so nothing on screen ever
    // learns the session id. Discarding the response leaves the session standing.
    let answer: (value: unknown) => void = () => {};
    mockRpc.mockImplementation((fn: string) =>
      fn === 'rank_start'
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ data: { done: true, cancelled: true }, error: null }),
    );

    const sheet = await openSheet();

    expect(sheet.getByText('Working out what to ask…')).toBeTruthy();
    await fireEvent.press(sheet.close());
    expect(sheet.onClose).toHaveBeenCalled();

    await sheet.rerender(<RankingSheet subject={null} onClose={sheet.onClose} surface="search" />);
    answer(comparison());

    await waitFor(() => expect(callsTo('rank_cancel')).toHaveLength(1));
    expect(callsTo('rank_cancel')[0][1]).toEqual({ p_session_id: SESSION });
  });

  it('offers a way out while the session is opening', async () => {
    // Without a control here the only exit is the hardware back button.
    mockRpc.mockImplementation(() => new Promise(() => {}));
    const sheet = await openSheet();

    expect(sheet.getByText('Working out what to ask…')).toBeTruthy();
    expect(sheet.close()).toBeTruthy();
  });

  it('cancels after a failure that leaves the session standing', async () => {
    // A dropped connection or a suspension mid-session: the server still has the session,
    // and this is the one exit the screen offers.
    answering(comparison(), { data: null, error: { code: '42501', message: 'suspended' } });
    const sheet = await openSheet();

    await fireEvent.press(await sheet.ready('Film A'));
    await waitFor(() => expect(sheet.getByText('Could not rank')).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(callsTo('rank_cancel')).toHaveLength(1));
  });

  it('does not cancel a session the server has already finished', async () => {
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 Movies');
    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(callsTo('rank_cancel')).toHaveLength(0);
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('does not cancel a session that Undo already ended', async () => {
    // rank_back at the first comparison deletes the session itself.
    //
    answering(comparison(), { data: { done: false, cancelled: true }, error: null });
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.getByLabelText('Undo the last comparison'));
    await waitFor(() => expect(sheet.getByText('Still in your collection')).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(callsTo('rank_cancel')).toHaveLength(0);
  });

  it('abandoning a session writes no collection state of its own', async () => {
    // The Unranked contract, pinned. Leaving mid-comparison cancels the session and
    // nothing else: the bucket the reader already chose survives, the title stays
    // Logged, and it is Logged-and-not-Ranked — which is exactly what the unranked
    // reminder is for. Nothing here logs a watch that the bucket tap had not already
    // claimed.
    answering(comparison());
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.close());

    await waitFor(() => expect(callsTo('rank_cancel')).toHaveLength(1));
    expect(callsTo('log_watched')).toHaveLength(0);
    expect(callsTo('set_bucket')).toHaveLength(0);
    expect(callsTo('rank_answer')).toHaveLength(0);
  });

  it('does not cancel a session the server says has gone', async () => {
    answering(comparison(), { data: null, error: { code: 'P0002', message: 'no such session' } });
    const sheet = await openSheet();

    await fireEvent.press(await sheet.ready('Film A'));
    await waitFor(() => expect(sheet.getByText('That session ended')).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Close' }));

    expect(callsTo('rank_cancel')).toHaveLength(0);
  });
});

describe('the reveal', () => {
  const REVEAL = 'Film A scored 8.7 out of 10. #3 Movies';

  /**
   * The score is the hero and the ordinal is context beneath it — founder decision,
   * 2026-08-15. This screen rendered `#3` at display size until Slice 3; the assertion
   * to keep is that the *number the user sees* is the score, not that a score exists
   * somewhere on the page.
   */
  it('makes the score the hero and refreshes that category', async () => {
    answering(placement);
    const sheet = await openSheet();
    const invalidate = jest.spyOn(sheet.client, 'invalidateQueries');

    await sheet.findByLabelText(REVEAL);
    // The panel's summary label is what a screen reader reads, so the numeral itself
    // is hidden from the tree — hence includeHiddenElements. It counts up from the
    // bottom of its band, so this waits for the value to settle.
    await waitFor(() =>
      expect(sheet.getByText('8.7', { includeHiddenElements: true })).toBeTruthy(),
    );
    // The ordinal is present, and is not the headline. Also hidden from the tree,
    // because the panel's summary above already spoke it — reading it twice is worse
    // than not reading it.
    expect(sheet.getByText(/#3 Movies/, { includeHiddenElements: true })).toBeTruthy();

    // Rendering happened before the spy, so re-run the placement to observe it.
    await sheet.rerender(<RankingSheet subject={null} onClose={sheet.onClose} surface="search" />);
    await sheet.rerender(<RankingSheet subject={subject} onClose={sheet.onClose} surface="search" />);
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map(([args]) => JSON.stringify(args?.queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.rankings('user-1', 'movies')));
    expect(keys).toContain(JSON.stringify(queryKeys.collection('user-1')));
  });

  /**
   * **The reveal says nothing about Too tough, in either direction** (founder,
   * 2026-08-30).
   *
   * It drew "You skipped a few, so this is an estimate" whenever the server came back
   * `adjustable`. The founder's ruling is that pressing Too tough is a legitimate
   * answer rather than a confession, and a paragraph that appears only for the people
   * who used the affordance turns the one control keeping a ranking honest into
   * something the reward screen apologises for.
   *
   * Both cases are asserted, because "removed" has to mean removed rather than moved:
   * the flag still arrives, and neither value may produce copy about skipping.
   */
  it('says nothing about skipping when the server did not flag the placement', async () => {
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(REVEAL);
    expect(sheet.queryByText(/estimate/i)).toBeNull();
    expect(sheet.queryByText(/skip/i)).toBeNull();
  });

  it('says nothing about skipping when the server does flag the placement', async () => {
    answering({ ...placement, data: { ...placement.data, adjustable: true } });
    const sheet = await openSheet();

    await sheet.findByLabelText(REVEAL);
    // The placement itself is unchanged — `adjustable` still comes back and the
    // uncertainty-safe midpoint still produces it. What went is the sentence.
    expect(sheet.queryByText(/estimate/i)).toBeNull();
    expect(sheet.queryByText(/skipped/i)).toBeNull();
    expect(sheet.queryByText(/too tough/i)).toBeNull();
    // And the reveal still says the two things it is for.
    expect(sheet.getByText(/#3 Movies/, { includeHiddenElements: true })).toBeTruthy();
  });
});

/**
 * **What the ordinal is standing next to.**
 *
 * "#3 Movies" says how many titles beat this one and not which. The pair either side is
 * the half somebody has an opinion about, and it is read off the list the reveal already
 * holds — so these assert the drawing, and `collection/rank-neighbours.test.ts` asserts
 * the deriving.
 *
 * The score is still the hero throughout (founder, 2026-08-15). Every test here that adds
 * a neighbour also re-asserts that the number the reader sees is the score.
 */
describe('the reveal names what it landed between', () => {
  /** Position 3 of the placement above, so the subject sits between films 2 and 4. */
  const movies = [
    { mediaItemId: 'm1', position: 1, kind: 'movie', title: 'Heat', genres: [] },
    { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
    { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    { mediaItemId: 'm4', position: 4, kind: 'movie', title: 'Collateral', genres: [] },
  ];

  const ranked = (rows: unknown[]) => mockRanked.mockReturnValue({ data: rows });

  it('names the title above it and the title below it', async () => {
    ranked(movies);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    expect(sheet.getByText('Sicario', { includeHiddenElements: true })).toBeTruthy();
    expect(sheet.getByText('Collateral', { includeHiddenElements: true })).toBeTruthy();

    // Still the score that is set large, and still the ordinal underneath it.
    await waitFor(() =>
      expect(sheet.getByText('8.7', { includeHiddenElements: true })).toBeTruthy(),
    );
    expect(sheet.getByText(/#3 Movies/, { includeHiddenElements: true })).toBeTruthy();
  });

  it('speaks the whole placement once, in the panel the screen reader reads', async () => {
    ranked(movies);
    answering(placement);
    const sheet = await openSheet();

    // One summary carries score, ordinal and both neighbours. The rows themselves are
    // hidden from the tree, so nothing is read twice.
    await sheet.findByLabelText(
      'Film A scored 8.7 out of 10. #3 Movies. Below Sicario. Above Collateral.',
    );
  });

  it('says "Your new #1" instead of naming a title that is not there', async () => {
    ranked([
      { mediaItemId: 'film-a', position: 1, kind: 'movie', title: 'Film A', genres: [] },
      { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
    ]);
    answering({ ...placement, data: { ...placement.data, position: 1 } });
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #1 Movies. Your new number 1. Above Sicario.');
    expect(sheet.getByText('Your new #1', { includeHiddenElements: true })).toBeTruthy();
    expect(sheet.queryByText(/^Below/, { includeHiddenElements: true })).toBeNull();
  });

  it('shows only the one neighbour a last-place title has', async () => {
    ranked([
      { mediaItemId: 'm1', position: 1, kind: 'movie', title: 'Heat', genres: [] },
      { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    ]);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 Movies. Below Sicario.');
    expect(sheet.queryByText(/^Above/, { includeHiddenElements: true })).toBeNull();
    // Not a #1, so the #1 line must not appear either.
    expect(sheet.queryByText('Your new #1', { includeHiddenElements: true })).toBeNull();
  });

  it('names a TV neighbour by its series, and calls the category TV', async () => {
    ranked([
      {
        mediaItemId: 's1',
        position: 2,
        kind: 'season',
        title: 'Season 1',
        seriesTitle: 'Severance',
        seasonNumber: 1,
        genres: [],
      },
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    ]);
    answering({ ...placement, data: { ...placement.data, category: 'tv_seasons' } });
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 TV. Below Severance, S1.');
    // The show's name, never the bare "Season 1" the row carries.
    expect(sheet.getByText('Severance, S1', { includeHiddenElements: true })).toBeTruthy();
    expect(sheet.queryByText('Season 1', { includeHiddenElements: true })).toBeNull();
  });

  it('keeps a long neighbour name on one line', async () => {
    const long = 'The Assassination of Jesse James by the Coward Robert Ford';
    ranked([
      { mediaItemId: 'm2', position: 2, kind: 'movie', title: long, genres: [] },
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    ]);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    // The row wrapping the name, not the name itself, carries the clamp.
    const row = sheet.getByText(long, { includeHiddenElements: true }).parent;
    expect(row?.props.numberOfLines).toBe(1);
  });

  it('draws nothing extra before the list it reads has arrived', async () => {
    ranked([]);
    answering(placement);
    const sheet = await openSheet();

    // Exactly what this screen said before neighbours existed.
    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 Movies');
    expect(sheet.queryByText(/^Below/, { includeHiddenElements: true })).toBeNull();
    expect(sheet.queryByText(/^Above/, { includeHiddenElements: true })).toBeNull();
  });

  /**
   * **Reading a list is not writing to one.** The neighbours come off a query the reveal
   * already ran, so a placement that names two titles must still call exactly the RPCs a
   * placement called before: nothing here re-ranks, re-orders or re-scores anything.
   */
  it('adds no call of its own to the server', async () => {
    ranked(movies);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    expect(callsTo('rank_start')).toHaveLength(1);
    expect(callsTo('rank_answer')).toHaveLength(0);
    expect(callsTo('rank_rebucket')).toHaveLength(0);
    expect(callsTo('rank_again')).toHaveLength(0);
    expect(mockRpc.mock.calls).toHaveLength(1);
  });
});

/**
 * **A rebucket has already changed the collection before the first comparison.**
 *
 * `rank_rebucket` calls `rank_unrank` and updates `user_media.bucket`, then opens a
 * session (`20260813000700`). Both writes are committed. So a reader who moves a film from
 * Loved to Fine and closes the sheet without answering anything has changed their
 * collection — and invalidating only on `placed` left the ranked list, the score
 * denominators and Rating Rascal describing a ranking that no longer exists, for the whole
 * one-minute `staleTime`. Independent review 21c.
 */
describe('moving a title to another band', () => {
  const rebucket = { ...subject, mode: 'rebucket' as const };

  /**
   * Its own client, seeded before the sheet mounts.
   *
   * The invalidation happens in the effect that opens the session, so a spy installed
   * after `render` returns has already missed it — and `renderWithProviders` sets
   * `gcTime: 0`, which collects a seeded query before it can be inspected. Both problems
   * go away by owning the client.
   */
  const KEYS = [
    ['collection', 'user-1'],
    ['rankings', 'user-1', 'movies'],
    ['rankings', 'user-1', 'tv_seasons'],
    ['awards', 'user-1'],
  ];

  const mount = async (props: Partial<RankingSheetProps> = {}) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const key of KEYS) client.setQueryData(key, 'seeded');

    const view = await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={METRICS}>
          <RankingSheet subject={subject} onClose={jest.fn()} surface="search" {...props} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
    const invalidated = (key: unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;
    return { ...view, invalidated };
  };

  /**
   * **The assertion here is the reverse of what it was**, and the reversal is the
   * founder's device finding answered at this layer.
   *
   * It used to read `refreshes the collection and the awards as soon as the write
   * lands`, and it was correct for the server it was written against: `rank_rebucket`
   * unranked the title and moved its bucket *before* it opened a session, both
   * committed, so a reader who arrived on this screen and changed their mind had
   * already changed their collection. Reviews 21c and 21d put the invalidation here for
   * that reason and made it fire on failures too.
   *
   * `20260826000500` removed the write. Opening a re-ranking session now writes one
   * `ranking_sessions` row and nothing the collection reads, so there is nothing to
   * reconcile — and invalidating anyway would refetch the ranked list behind the
   * comparison the reader is looking at, taking down the very score this tranche exists
   * to keep on screen.
   */
  it('changes nothing in the collection merely by opening a rebucket', async () => {
    answering(comparison());
    // The session is open and nothing has been answered — exactly the state a reader is
    // in when they change their mind and close the sheet.
    const { invalidated } = await mount({ subject: rebucket });

    await waitFor(() => expect(callsTo('rank_rebucket')).toHaveLength(1));
    expect(invalidated(['awards', 'user-1'])).toBe(false);
    expect(invalidated(['collection', 'user-1'])).toBe(false);
    expect(invalidated(['rankings', 'user-1', 'movies'])).toBe(false);
    expect(invalidated(['rankings', 'user-1', 'tv_seasons'])).toBe(false);
  });

  /**
   * And nothing to compensate for when it fails either.
   *
   * The old version refreshed on a failure as well, because a commit whose reply is
   * lost is indistinguishable from a refusal and the committed case had destroyed
   * something. Neither case destroys anything now: a `rank_rebucket` that commits opens
   * a session, and a session is not a collection change.
   */
  it('changes nothing when the rebucket reports a failure', async () => {
    answering({ data: null, error: { code: '22023', message: 'title is already in that bucket' } });
    const { invalidated } = await mount({ subject: rebucket });

    await waitFor(() => expect(callsTo('rank_rebucket')).toHaveLength(1));
    expect(invalidated(['awards', 'user-1'])).toBe(false);
    expect(invalidated(['collection', 'user-1'])).toBe(false);
  });

  /**
   * The founder's device finding, at the layer that answers it.
   *
   * A ranked title re-ranked *inside* its own band cannot go through `rank_rebucket`,
   * which raises 22023 on a bucket that is not moving. `rerank` re-opens in the same
   * band instead, and everything downstream — the comparisons, the reveal, the refresh
   * — is the same session.
   *
   * **This was two calls from here until `20260825000200`**, `rank_unrank` then
   * `rank_start`, and this test asserted that both were made in that order. It is now
   * one `rank_again`, so what it asserts is the opposite: that the second call is *not*
   * made, because there is no longer a moment between them for a dropped connection to
   * land in.
   */
  it('re-ranks inside the same band in one call, and takes nothing away to do it', async () => {
    answering(comparison());
    const { invalidated } = await mount({ subject: { ...subject, mode: 'rerank' as const } });

    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(1));
    // The unrank and the fresh session are one transaction inside the server now, so
    // neither of the two RPCs this used to make is called at all.
    expect(callsTo('rank_unrank')).toHaveLength(0);
    expect(callsTo('rank_start')).toHaveLength(0);
    // Never the rebucket RPC either: the bucket is not moving and that call would be
    // refused.
    expect(callsTo('rank_rebucket')).toHaveLength(0);
    // The bucket the session opens in is the bucket it already had.
    expect(callsTo('rank_again')[0][1]).toMatchObject({ p_bucket: 'loved' });
    // The founder's disappearing score: the old position is still there, so nothing
    // that draws it is thrown away.
    expect(invalidated(['awards', 'user-1'])).toBe(false);
    expect(invalidated(['collection', 'user-1'])).toBe(false);
  });

  /**
   * The one bit of state that is *not* the same between the two callers of
   * `rank_again`, and the reason the founder saw four War Dogs in one feed.
   *
   * Change your rating re-choosing its own band is a correction: `p_new_watch` false,
   * and the server writes no activity. Rank again from the Ranked menu is a second
   * viewing: `p_new_watch` true, and it writes exactly one.
   */
  it('declares Rank again a watch and Change your rating a correction', async () => {
    answering(comparison());
    await mount({ subject: { ...subject, mode: 'again' as const } });
    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(1));
    expect(callsTo('rank_again')[0][1]).toMatchObject({ p_new_watch: true });

    mockRpc.mockClear();
    answering(comparison());
    await mount({ subject: { ...subject, mode: 'rerank' as const } });
    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(1));
    expect(callsTo('rank_again')[0][1]).toMatchObject({ p_new_watch: false });
  });

  it('makes no second call when the re-rank was refused', async () => {
    // A suspension is a refusal, not a lost reply: the position is still there. The
    // transaction rolled back whole, so there is nothing to compensate for and nothing
    // for this component to do but report it.
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'rank_again'
          ? { data: null, error: { code: '42501', message: 'suspended' } }
          : { data: { done: false, session_id: 's', pivot: 'p' }, error: null },
      ),
    );
    await mount({ subject: { ...subject, mode: 'rerank' as const } });

    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(1));
    expect(callsTo('rank_start')).toHaveLength(0);
    expect(callsTo('rank_unrank')).toHaveLength(0);
  });

  /**
   * **One intent, one operation id, across a retry** — the property `20260825000200`
   * exists to make reachable, checked at the layer that decides what an intent is.
   *
   * The dangerous direction is specific and it is this one. A `rank_again` that commits
   * and loses its reply has already dropped the reader's position; a retry carrying a
   * *fresh* id would be a second genuine `rank_again`, and it would unrank the title the
   * first attempt had just re-ranked. Two intents out of one press.
   *
   * So the retry carries the id the lost attempt used, which is what makes the server
   * answer it with the stored result instead of doing the work again — and it is what
   * makes offering the retry at all safe enough to do. The assertion is that the two ids
   * are equal rather than that either is any particular value: which uuid it is belongs
   * to `useOperationIntent`, and is tested there.
   */
  it('retries a lost re-rank under the id the lost attempt used', async () => {
    answering({ data: null, error: { code: '', message: 'TypeError: fail' } });
    const view = await mount({ subject: { ...subject, mode: 'rerank' as const } });

    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(1));
    await waitFor(() => expect(view.getByText('Try again')).toBeTruthy());

    await fireEvent.press(view.getByText('Try again'));
    await waitFor(() => expect(callsTo('rank_again')).toHaveLength(2));

    const firstArgs = callsTo('rank_again')[0][1] as Record<string, unknown>;
    const secondArgs = callsTo('rank_again')[1][1] as Record<string, unknown>;
    expect(firstArgs.p_operation_id).toBeTruthy();
    expect(secondArgs.p_operation_id).toBe(firstArgs.p_operation_id);
  });

  it('offers no retry for a refusal, because there is nothing uncertain about one', async () => {
    // A 22023 rolled the transaction back. The reader's position is exactly where it
    // was, so "Try again" would invite them to repeat something that will be refused
    // again for the same reason.
    answering({ data: null, error: { code: '22023', message: 'title is already in that bucket' } });
    const view = await mount({ subject: rebucket });

    await waitFor(() => expect(callsTo('rank_rebucket')).toHaveLength(1));
    expect(view.queryByText('Try again')).toBeNull();
  });

  /**
   * Independent review 30, the one Major it found.
   *
   * A same-bucket re-rank has no server refusal in front of it. A first ranking is
   * stopped by 23505 and a rebucket by 22023, and both were doing retry protection by
   * accident — so on this path a reader told “Could not rank” over a finalize that
   * actually committed would tap again and write a second `title_ranked` event for one
   * intent. The sentence is the protection.
   */
  it('says the outcome is unknown rather than that it failed', async () => {
    // A bare code is not a refusal this app raises — `write-outcome.ts` reads it as an
    // outcome nobody can prove either way, and marks the step `changed`.
    answering({ data: null, error: { code: '', message: 'TypeError: Network request failed' } });
    const view = await mount({ subject: { ...subject, mode: 'rerank' as const } });

    await waitFor(() => expect(view.getByText('Not sure that landed')).toBeTruthy());
    // Never “Could not rank” over a write that may have committed.
    expect(view.queryByText('Could not rank')).toBeNull();
    // And it says what to do about it, rather than leaving a retry as the obvious move.
    expect(view.getByText(/may already be ranked/)).toBeTruthy();
    // The raw transport error is not a sentence to show anybody.
    expect(view.queryByText(/TypeError/)).toBeNull();
  });

  it('still says plainly when the server actually refused', async () => {
    // A SQLSTATE this app raises on purpose is a definite refusal: nothing committed,
    // and hedging about it would be its own kind of dishonest.
    answering({ data: null, error: { code: '42501', message: 'suspended' } });
    const view = await mount({ subject: { ...subject, mode: 'rerank' as const } });

    await waitFor(() => expect(view.getByText('Could not rank')).toBeTruthy());
    expect(view.queryByText('Not sure that landed')).toBeNull();
  });

  it('leaves a first ranking alone, which writes nothing until it is placed', async () => {
    answering(comparison());
    const { invalidated } = await mount();

    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(invalidated(['awards', 'user-1'])).toBe(false);
  });

  /**
   * **An answer that fails can still have placed the title**, which is the same
   * invariant one step further along the session.
   *
   * `rank_answer` records the comparison and, on the last one, finalises inside the same
   * transaction — the `rankings` row, the score, the `feed_events` entry. So a
   * `rank_answer` that commits and loses its reply arrives here as a failure over a
   * collection that has already moved, and the sheet invalidated only on `placed`.
   * `session.ts` now marks the outcomes it cannot prove were refusals
   * (`lib/write-outcome.ts`), and this is the screen half of it.
   */
  it('refreshes when an answer was never resolved, since it may have placed the title', async () => {
    answering(comparison(), { data: null, error: { code: '', message: 'TypeError: fail' } });
    const view = await mount();

    await waitFor(() =>
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(false),
    );
    await fireEvent.press(view.getByLabelText('Choose Film A'));

    await waitFor(() => expect(callsTo('rank_answer')).toHaveLength(1));
    await waitFor(() => expect(view.invalidated(['collection', 'user-1'])).toBe(true));
    expect(view.invalidated(['awards', 'user-1'])).toBe(true);
  });

  it('refreshes on 08007 from an answer, which carries a code and proves nothing', async () => {
    answering(comparison(), { data: null, error: { code: '08007', message: 'unknown' } });
    const view = await mount();

    await waitFor(() =>
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(false),
    );
    await fireEvent.press(view.getByLabelText('Choose Film A'));

    await waitFor(() => expect(view.invalidated(['collection', 'user-1'])).toBe(true));
  });

  it('leaves the collection alone when an answer was refused outright', async () => {
    // 22023 is the server declining — the pivot stopped being ranked mid-session, which
    // it raises rather than guesses. Nothing was placed, so nothing needs refetching.
    answering(comparison(), { data: null, error: { code: '22023', message: 'pivot is gone' } });
    const view = await mount();

    await waitFor(() =>
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(false),
    );
    await fireEvent.press(view.getByLabelText('Choose Film A'));

    await waitFor(() => expect(callsTo('rank_answer')).toHaveLength(1));
    expect(view.invalidated(['collection', 'user-1'])).toBe(false);
  });
});

describe('a title that is already ranked', () => {
  it('is explained without Postgres wording', async () => {
    answering({
      data: null,
      error: { code: '23505', message: 'title is already ranked; use rank_rebucket to move it' },
    });
    const sheet = await openSheet();

    await waitFor(() =>
      expect(
        sheet.getByText('This already has a position. Move it from your collection instead.'),
      ).toBeTruthy(),
    );
    expect(sheet.queryByText(/rank_rebucket/)).toBeNull();
  });
});
