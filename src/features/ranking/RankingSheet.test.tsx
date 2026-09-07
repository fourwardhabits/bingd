import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { renderWithProviders } from '@/test-utils/render';
import { queryKeys } from '@/lib/query';
import { theme } from '@/ui/tokens';

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
/**
 * The award ledger, one answer per read.
 *
 * `useNewUnlocks` reads `award_unlocks` twice around a ranking — once on mount for the
 * snapshot, once after the placement — and the difference between the two answers *is*
 * the feature. A queue is the only way to express that: shift a reply per read, and fall
 * back to an empty ledger, which is what every test written before the celebration
 * existed needs and gets without saying so.
 */
let mockUnlockQueue: { rows?: unknown[]; error?: unknown }[] = [];
let mockUnlockReads = 0;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      if (table === 'award_unlocks') {
        const answer = () => {
          mockUnlockReads += 1;
          const next = mockUnlockQueue.shift();
          if (next?.error) return Promise.resolve({ data: null, error: next.error });
          return Promise.resolve({ data: next?.rows ?? [], error: null });
        };
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
        });
        return chain;
      }
      return {
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
      };
    },
  },
  startSessionRefresh: () => () => {},
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a) }),
}));

/**
 * `track` alone, with the vocabulary left real, so `ranking_completed`'s props are
 * checked against the same union the app compiles against rather than a stub of it.
 */
const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  ...jest.requireActual('@/lib/analytics'),
  track: (...a: unknown[]) => mockTrack(...a),
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
  mockPush.mockReset();
  mockTrack.mockReset();
  mockUnlockQueue = [];
  mockUnlockReads = 0;
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

    await sheet.rerender(
      <RankingSheet subject={null} onClose={sheet.onClose} surface="search" />,
    );
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

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in Movies.');
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
    answering(comparison(), {
      data: null,
      error: { code: 'P0002', message: 'no such session' },
    });
    const sheet = await openSheet();

    await fireEvent.press(await sheet.ready('Film A'));
    await waitFor(() => expect(sheet.getByText('That session ended')).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Close' }));

    expect(callsTo('rank_cancel')).toHaveLength(0);
  });
});

describe('the reveal', () => {
  const REVEAL = 'Film A scored 8.7 out of 10. #3 in Movies.';

  /**
   * **The score is the hero, and the placement is the second beat** (founder,
   * 2026-09-05, refining 2026-08-15).
   *
   * The ranking flow builds one question, "what am I going to give this", and the panel
   * answers it. That has not changed and this test is what stops it changing: the
   * *number the user sees* must be the score. This screen rendered `#3` at display size
   * until Slice 3 and must not go back.
   *
   * What did change is that the ordinal is no longer a tertiary footnote sharing a line
   * with the genre ranks. It is its own line now, which is asserted below rather than
   * merely tolerated.
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
    // The placement is present as its own line, and is still not the headline. Hidden
    // from the tree because the panel's summary above already spoke it — reading it
    // twice is worse than not reading it.
    expect(sheet.getByText('#3 in Movies', { includeHiddenElements: true })).toBeTruthy();

    // Rendering happened before the spy, so re-run the placement to observe it.
    await sheet.rerender(
      <RankingSheet subject={null} onClose={sheet.onClose} surface="search" />,
    );
    await sheet.rerender(
      <RankingSheet subject={subject} onClose={sheet.onClose} surface="search" />,
    );
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
    expect(sheet.getByText('#3 in Movies', { includeHiddenElements: true })).toBeTruthy();
  });
});

/**
 * **What the ordinal is standing next to.**
 *
 * "#3 in Movies" says how many titles beat this one and not which. The pair either side
 * is the half somebody has an opinion about, and it is read off the list the reveal
 * already holds — so these assert the drawing, and `collection/rank-neighbours.test.ts`
 * asserts the deriving.
 *
 * The score is still the hero throughout (founder, 2026-09-05). Every test here that adds
 * a neighbour also re-asserts that the number the reader sees is the score.
 *
 * **No posters.** The anchors are text, deliberately: artwork beside the panel competes
 * with the number for the one moment the screen exists for, and it would make the reveal
 * wait on an image. `no poster dependency` at the end of this block is the assertion.
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
    expect(sheet.getByText('#3 in Movies', { includeHiddenElements: true })).toBeTruthy();
  });

  it('speaks the whole placement once, in the panel the screen reader reads', async () => {
    ranked(movies);
    answering(placement);
    const sheet = await openSheet();

    // One summary carries score, ordinal and both neighbours. The rows themselves are
    // hidden from the tree, so nothing is read twice.
    await sheet.findByLabelText(
      'Film A scored 8.7 out of 10. #3 in Movies. Below Sicario. Above Collateral.',
    );
  });

  it('says #1 in the placement, and names no title above it', async () => {
    ranked([
      { mediaItemId: 'film-a', position: 1, kind: 'movie', title: 'Film A', genres: [] },
      { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
    ]);
    answering({ ...placement, data: { ...placement.data, position: 1 } });
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #1 in Movies. Above Sicario.');
    // The placement line carries it. No badge, no separate treatment, and nothing
    // invented to sit above a #1.
    expect(sheet.getByText('#1 in Movies', { includeHiddenElements: true })).toBeTruthy();
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

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in Movies. Below Sicario.');
    expect(sheet.queryByText(/^Above/, { includeHiddenElements: true })).toBeNull();
    expect(sheet.getByText('#3 in Movies', { includeHiddenElements: true })).toBeTruthy();
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

    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in TV. Below Severance, S1.');
    // The category is TV and the neighbour is a season. Nothing claims a rank among
    // series, which is not a thing this product orders.
    expect(sheet.getByText('#3 in TV', { includeHiddenElements: true })).toBeTruthy();
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
    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in Movies.');
    // The placement is server-side and arrives with the placement, so it is drawn even
    // with no list. Only the anchors wait.
    expect(sheet.getByText('#3 in Movies', { includeHiddenElements: true })).toBeTruthy();
    expect(sheet.queryByText(/^Below/, { includeHiddenElements: true })).toBeNull();
    expect(sheet.queryByText(/^Above/, { includeHiddenElements: true })).toBeNull();
  });

  /**
   * **Reading a list is not writing to one.** The neighbours come off a query the reveal
   * already ran, so a placement that names two titles must still call exactly the RPCs a
   * placement called before: nothing here re-ranks, re-orders or re-scores anything.
   */
  /**
   * **The anchors are text** (founder, 2026-09-05). A poster beside the panel competes
   * with the number for the one moment this screen exists for, and it would make the
   * reveal wait on an image load. The neighbour rows therefore carry names and nothing
   * else, and `neighboursFor` returns no poster path to draw with even if one tried.
   */
  it('draws the anchors as text, with no poster fetch of its own', async () => {
    ranked(movies);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    expect(sheet.getByText('Sicario', { includeHiddenElements: true })).toBeTruthy();

    // The comparison's two posters are gone with the comparison; the reveal draws none.
    expect(sheet.queryByLabelText('Choose Film A')).toBeNull();
    expect(sheet.queryByLabelText('Choose Film P')).toBeNull();
    // And no read was opened for one.
    expect(mockPivotRead).not.toHaveBeenCalled();
  });

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
 * **The reveal never names a placement worse than tenth** (founder, 2026-09-05, from a
 * physical Android pass).
 *
 * What it drew was every placement it could compute, and the largest number on the screen
 * was the one saying least: `#19 in Movies` is a fact about how much the reader has
 * ranked rather than about the film, and it was leading the block.
 *
 * The rule is `hero-rank.ts`'s, which the title page has applied since 2026-08-28, with
 * the reveal's own allowance of two lines. These tests exercise it end to end — through
 * the real `shownGenreRanksFor` against a real ranked list — rather than unit-testing the
 * selector alone, because the thing the founder photographed was the screen.
 */
describe('the reveal only names a placement worth naming', () => {
  const ranked = (rows: unknown[]) => mockRanked.mockReturnValue({ data: rows });

  /**
   * A ranked list built to order, so a subject's overall position and its genre positions
   * can be set independently.
   *
   * `MIN_GENRE_SIZE` is five, so every genre used here is padded past it — otherwise the
   * genre would be dropped for being too small and the test would pass for the wrong
   * reason.
   */
  const listOf = (subjectPosition: number, subjectGenres: string[], size = 40) => {
    const rows: unknown[] = [];
    for (let i = 1; i <= size; i += 1) {
      if (i === subjectPosition) {
        rows.push({
          mediaItemId: 'film-a',
          position: i,
          kind: 'movie',
          title: 'Film A',
          genres: subjectGenres,
        });
      } else {
        rows.push({
          mediaItemId: `f${i}`,
          position: i,
          kind: 'movie',
          title: `Film ${i}`,
          // Every filler carries every genre under test, so a genre's population is the
          // whole list and the subject's genre rank equals its overall position.
          genres: subjectGenres,
        });
      }
    }
    return rows;
  };

  const revealAt = async (position: number, genres: string[] = [], size = 40) => {
    ranked(listOf(position, genres, size));
    answering({ ...placement, data: { ...placement.data, position } });
    const sheet = await openSheet();
    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    return sheet;
  };

  const text = (sheet: Awaited<ReturnType<typeof openSheet>>, value: string | RegExp) =>
    sheet.queryByText(value, { includeHiddenElements: true });

  it('shows the overall placement inside the top ten', async () => {
    const sheet = await revealAt(3);
    expect(text(sheet, '#3 in Movies')).toBeTruthy();
  });

  it('still shows it at exactly ten, which is the boundary the rule is written on', async () => {
    const sheet = await revealAt(10);
    expect(text(sheet, '#10 in Movies')).toBeTruthy();
  });

  it('suppresses the genres when the overall placement is shown', async () => {
    // The broad claim is the stronger one. Two narrower ones beside it would dilute it,
    // and the founder's complaint was the count of lines as much as any single one.
    const sheet = await revealAt(2, ['Science Fiction', 'Action']);

    expect(text(sheet, '#2 in Movies')).toBeTruthy();
    expect(text(sheet, /Science Fiction/)).toBeNull();
    expect(text(sheet, /Action/)).toBeNull();
  });

  it('hides the overall placement past ten, and says nothing in its place', async () => {
    // No genres qualify here, so this is the bare case: score, title, anchors, and the
    // block ends. Nothing invents a line to fill the space.
    const sheet = await revealAt(19);

    expect(text(sheet, '#19 in Movies')).toBeNull();
    expect(text(sheet, /in Movies/)).toBeNull();
  });

  it('shows the qualifying genre placements instead, past ten', async () => {
    // The founder's own example: #19 overall, and the two genre placements that are
    // actually about the film.
    ranked([
      ...Array.from({ length: 18 }, (_, i) => ({
        mediaItemId: `f${i}`,
        position: i + 1,
        kind: 'movie',
        title: `Film ${i}`,
        // Five of the eighteen above carry each genre, which puts the subject sixth in
        // one and seventh in the other while leaving it nineteenth overall.
        genres: [...(i < 5 ? ['Science Fiction'] : []), ...(i < 6 ? ['Action'] : [])],
      })),
      {
        mediaItemId: 'film-a',
        position: 19,
        kind: 'movie',
        title: 'Film A',
        genres: ['Science Fiction', 'Action'],
      },
    ]);
    answering({ ...placement, data: { ...placement.data, position: 19 } });
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    expect(text(sheet, '#19 in Movies')).toBeNull();
    expect(text(sheet, /#6 Science Fiction/)).toBeTruthy();
    expect(text(sheet, /#7 Action/)).toBeTruthy();
  });

  it('never names a genre placement worse than tenth either', async () => {
    // Twelfth of forty in the only genre it has. The proportional strength that orders
    // genre lines would happily have chosen it; the top-ten filter is what stops it.
    const sheet = await revealAt(12, ['Drama']);

    expect(text(sheet, /Drama/)).toBeNull();
    expect(text(sheet, /in Movies/)).toBeNull();
  });

  it('shows at most two genre placements', async () => {
    ranked([
      ...Array.from({ length: 14 }, (_, i) => ({
        mediaItemId: `f${i}`,
        position: i + 1,
        kind: 'movie',
        title: `Film ${i}`,
        genres: ['Drama', 'Crime', 'Thriller', 'Mystery'].filter((_, g) => i < 5 + g),
      })),
      {
        mediaItemId: 'film-a',
        position: 15,
        kind: 'movie',
        title: 'Film A',
        genres: ['Drama', 'Crime', 'Thriller', 'Mystery'],
      },
    ]);
    answering({ ...placement, data: { ...placement.data, position: 15 } });
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    const line = sheet.getByText(/^#\d+ /, { includeHiddenElements: true });
    // Two ordinals on the line and no third, whatever the title qualifies for.
    expect(String(line.props.children).match(/#\d+/g)).toHaveLength(2);
  });

  it('keeps the neighbours whatever the placement does', async () => {
    // The anchors are the half of the block that is about the film, and they are the
    // half a ranked title always has. A change to the ordinal rule must not touch them.
    const sheet = await revealAt(19);

    expect(text(sheet, 'Film 18')).toBeTruthy();
    expect(text(sheet, 'Film 20')).toBeTruthy();
  });

  it('reads the anchors before the ordinal, as the screen draws them', async () => {
    // The summary is the screen reader's copy of this block, so its order follows the
    // visual one — and it must never speak a placement the screen decided not to show.
    ranked(listOf(19, []));
    answering({ ...placement, data: { ...placement.data, position: 19 } });
    const sheet = await openSheet();

    await sheet.findByLabelText('Film A scored 8.7 out of 10. Below Film 18. Above Film 20.');
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
    answering({
      data: null,
      error: { code: '22023', message: 'title is already in that bucket' },
    });
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
    answering({
      data: null,
      error: { code: '22023', message: 'title is already in that bucket' },
    });
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
    answering({
      data: null,
      error: { code: '', message: 'TypeError: Network request failed' },
    });
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
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(
        false,
      ),
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
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(
        false,
      ),
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
      expect(view.getByLabelText('Choose Film A').props.accessibilityState.disabled).toBe(
        false,
      ),
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
      error: {
        code: '23505',
        message: 'title is already ranked; use rank_rebucket to move it',
      },
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

/**
 * **What the reveal calls the thing it just ranked, and what order it says it in**
 * (founder, physical Android, 2026-09-06).
 *
 * Two findings from one screenshot. A season showed the words **Season 1** under its
 * score — which is `media_items.title` for a season, and identifies nothing — while the
 * two anchors underneath it read `Below Fullmetal Alchemist: Brotherhood, S1`. And the
 * placement, moved below the anchors the day before, wanted to be back under the title
 * now that it is top-ten-only and no longer the loudest wrong thing on the screen.
 */
describe('what the reveal says, and in what order', () => {
  const ranked = (rows: unknown[]) => mockRanked.mockReturnValue({ data: rows });

  const season = (over: Record<string, unknown> = {}) => ({
    mediaItemId: 'film-a',
    position: 3,
    kind: 'season',
    title: 'Season 1',
    seriesTitle: 'Vincenzo',
    seasonNumber: 1,
    genres: [],
    ...over,
  });

  /** Where something sits in the rendered tree. `queryAll` walks in document order. */
  const orderOf = (
    view: Awaited<ReturnType<typeof openSheet>>,
    match: (node: never) => boolean,
  ) => view.root!.queryAll(() => true).findIndex(match as never);

  const textAt = (value: string | RegExp) => (node: never) => {
    const children = (node as { props?: { children?: unknown } }).props?.children;
    const text = Array.isArray(children) ? children.join('') : String(children ?? '');
    return typeof value === 'string' ? text === value : value.test(text);
  };

  it('names a ranked season by its series and season number', async () => {
    // `Vincenzo, S1`, never the bare `Season 1` the row carries — which is a complete
    // name only on a page where the show is already written somewhere else.
    ranked([
      season(),
      { ...season(), mediaItemId: 'other', position: 4, seriesTitle: 'The Office' },
    ]);
    answering({ ...placement, data: { ...placement.data, category: 'tv_seasons' } });
    const sheet = await openSheet();

    await sheet.findByText('Vincenzo, S1');
    expect(sheet.queryByText('Season 1')).toBeNull();
  });

  it('uses the same formatter the anchors use, so the three lines agree', async () => {
    // The anchors have gone through `compactName` since `rank-neighbours` was written.
    // The subject now reads its own row out of the same list and through the same
    // function, which is what makes them agree by construction rather than by two call
    // sites being kept in step.
    ranked([
      { ...season(), mediaItemId: 'above', position: 2, seriesTitle: 'The Office' },
      season(),
    ]);
    answering({ ...placement, data: { ...placement.data, category: 'tv_seasons' } });
    const sheet = await openSheet();

    await sheet.findByText('Vincenzo, S1');
    expect(sheet.getByText('The Office, S1', { includeHiddenElements: true })).toBeTruthy();
  });

  it('leaves a film called what it is called', async () => {
    // `compactName` returns a movie's own title untouched. "The Matrix", never
    // "The Matrix, Movie".
    ranked([
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    ]);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByText('Film A');
  });

  it('keeps a long series name whole rather than inventing a shorter one', async () => {
    const long = 'Fullmetal Alchemist: Brotherhood';
    ranked([season({ seriesTitle: long, seasonNumber: 2 })]);
    answering({ ...placement, data: { ...placement.data, category: 'tv_seasons' } });
    const sheet = await openSheet();

    await sheet.findByText(`${long}, S2`);
  });

  it('falls back to the plain title while the list is still arriving', async () => {
    // The same render on which the anchors are absent. Degrading to what the screen said
    // before this change beats degrading to nothing.
    ranked([]);
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByText('Film A');
  });

  it('puts the placement under the title and the neighbours under that', async () => {
    // The founder's hierarchy, asserted as tree order rather than as presence: score,
    // title, placement, then the two names either side.
    ranked([
      { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
      { mediaItemId: 'm4', position: 4, kind: 'movie', title: 'Collateral', genres: [] },
    ]);
    answering(placement);
    const sheet = await openSheet();
    await sheet.findByText('Film A');

    const title = orderOf(sheet, textAt('Film A'));
    const rank = orderOf(sheet, textAt('#3 in Movies'));
    const below = orderOf(sheet, textAt('Sicario'));
    const above = orderOf(sheet, textAt('Collateral'));

    expect(title).toBeGreaterThan(-1);
    expect(rank).toBeGreaterThan(title);
    expect(below).toBeGreaterThan(rank);
    expect(above).toBeGreaterThan(below);
  });

  it('draws the placement muted, so it cannot compete with the title', async () => {
    // Hierarchy is score, title, placement, neighbours. An ordinal at the title's weight
    // is two headlines.
    ranked([
      { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    ]);
    answering(placement);
    const sheet = await openSheet();

    // Hidden from the accessibility tree — the panel speaks the whole placement once —
    // so the query has to say so.
    const line = await sheet.findByText('#3 in Movies', { includeHiddenElements: true });
    expect(StyleSheet.flatten(line.props.style).color).toBe(theme.text.secondary);
  });

  it('closes the gap entirely when nothing qualifies', async () => {
    // Past ten with no qualifying genre: the block goes straight from the title to the
    // neighbours, and no line is reserved for a placement that is not there.
    ranked(
      Array.from({ length: 40 }, (_, index) => ({
        mediaItemId: index === 18 ? 'film-a' : `f${index}`,
        position: index + 1,
        kind: 'movie',
        title: index === 18 ? 'Film A' : `Film ${index + 1}`,
        genres: [],
      })),
    );
    answering({ ...placement, data: { ...placement.data, position: 19 } });
    const sheet = await openSheet();
    await sheet.findByText('Film A');

    expect(sheet.queryByText(/in Movies/, { includeHiddenElements: true })).toBeNull();

    const title = orderOf(sheet, textAt('Film A'));
    const below = orderOf(sheet, textAt('Film 18'));
    expect(below).toBeGreaterThan(title);
  });
});

/**
 * The award payoff, and the guarantee underneath it.
 *
 * The founder's rule for this feature is that it is **downstream**: the award was
 * granted by a database trigger inside the ranking's own transaction, and everything
 * here only reads what that trigger recorded. So the assertions that matter most are the
 * negative ones — a ranking finishes, closes and reports success whatever this does.
 */
describe('celebrating what the ranking earned', () => {
  const unlock = (awardKey: string, tierKey: string) => ({
    award_key: awardKey,
    tier_key: tierKey,
    earned_at: '2026-09-06T10:00:00Z',
  });

  /**
   * Rank a title to its placement, let the detection land, and press Done.
   *
   * **The wait is the design, not a workaround.** The diff is fired from `apply` without
   * being awaited, precisely so a ranking cannot stall behind a read about badges — so a
   * reader who taps Done in the same frame the placement lands gets no celebration, and
   * that is correct: the congratulations notification is the other door, and it is the
   * durable one. A human pressing a button after reading their score has taken far
   * longer than one round trip, and waiting for the second read is how a test spends the
   * same time.
   */
  const rankAndFinish = async () => {
    answering(placement);
    const sheet = await openSheet();
    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in Movies.');
    await waitFor(() => expect(mockUnlockReads).toBe(2));
    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));
    return sheet;
  };

  it('celebrates a tier this ranking crossed', async () => {
    // Empty before, one row after: the difference is the award.
    mockUnlockQueue = [{ rows: [] }, { rows: [unlock('movie-muncher', 'bronze')] }];

    const sheet = await rankAndFinish();

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/awards/celebrate',
        params: { awards: 'movie-muncher:bronze' },
      }),
    );
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('carries every tier crossed in one breath into one flow', async () => {
    /**
     * One ranking can cross a Movies threshold and a combined Movies-and-TV threshold at
     * once — `_maybe_award_unlocks` loops over every named track — and two modals stacked
     * on each other is two things to dismiss for one accomplishment.
     */
    mockUnlockQueue = [
      { rows: [] },
      { rows: [unlock('movie-muncher', 'bronze'), unlock('two-screen-life', 'tourist')] },
    ];

    await rankAndFinish();

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/awards/celebrate',
        params: { awards: 'movie-muncher:bronze,two-screen-life:tourist' },
      }),
    );
  });

  it('celebrates nothing when the ranking crossed nothing', async () => {
    mockUnlockQueue = [
      { rows: [unlock('movie-muncher', 'bronze')] },
      { rows: [unlock('movie-muncher', 'bronze')] },
    ];

    const sheet = await rankAndFinish();

    expect(mockPush).not.toHaveBeenCalled();
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('never re-celebrates a tier the reader already had', async () => {
    // The ledger is the reader's whole history. Without the before-and-after diff, every
    // Done would congratulate them for a year of awards.
    mockUnlockQueue = [
      { rows: [unlock('lol-mode', 'giggle'), unlock('movie-muncher', 'bronze')] },
      { rows: [unlock('lol-mode', 'giggle'), unlock('movie-muncher', 'bronze')] },
    ];

    await rankAndFinish();

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('celebrates nothing when the snapshot could not be taken', async () => {
    /**
     * Failing quiet is the only safe direction. If the first read failed, every row on
     * the ledger looks new — and the reader would be congratulated for their entire
     * history because their phone lost signal for a second.
     */
    mockUnlockQueue = [
      { error: { message: 'offline' } },
      { rows: [unlock('movie-muncher', 'bronze')] },
    ];

    answering(placement);
    const sheet = await openSheet();
    await sheet.findByLabelText('Film A scored 8.7 out of 10. #3 in Movies.');
    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(sheet.onClose).toHaveBeenCalled();
    // **And the second read never happens.** Without a snapshot there is nothing to
    // compare against, so asking again would spend a round trip on an answer that
    // cannot be used — and the queue's second entry, an award, stays unread.
    expect(mockUnlockReads).toBe(1);
  });

  it('finishes the ranking even when the detection read fails outright', async () => {
    // The negative assertion the whole design exists for: a ranking succeeded, the
    // collection moved, the award is on the ledger — and a failed read about badges
    // changes none of that.
    mockUnlockQueue = [{ rows: [] }, { error: { message: 'offline' } }];

    const sheet = await rankAndFinish();

    await waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
    expect(callsTo('rank_cancel')).toHaveLength(0);
  });

  it('asks the ledger nothing at all when the ranking never placed', async () => {
    // A reader who opens the sheet and closes it has earned nothing, and the ledger is
    // not a thing to read on the way past. The snapshot on mount is the one read.
    answering(comparison());
    const sheet = await openSheet();
    await sheet.ready('Film A');
    await waitFor(() => expect(mockUnlockReads).toBe(1));

    await fireEvent.press(sheet.getByRole('button', { name: 'Close' }));

    expect(mockUnlockReads).toBe(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

/**
 * **The placement is the title's subtitle, and the grouping has to say so** (founder,
 * physical Android, 2026-09-07).
 *
 * The render order was already score, title, placement, anchors, and two passes of
 * physical QA still reported that `#6 Drama` did not read as belonging to the title. The
 * reason was spacing rather than order: the reveal's `space[6]` sat between the title and
 * the placement, and only `space[2]` between the placement and the two names below it, so
 * the eye grouped the placement downward into the anchors.
 *
 * Order tests could not see that, which is why these assert containment: the placement
 * shares a parent with the title, and the anchors do not. That is the property the
 * founder is actually asking for, and it is the one that broke.
 */
describe('the reveal reads title, then placement, then where it landed', () => {
  const movies = [
    { mediaItemId: 'm1', position: 1, kind: 'movie', title: 'Heat', genres: [] },
    { mediaItemId: 'm2', position: 2, kind: 'movie', title: 'Sicario', genres: [] },
    { mediaItemId: 'film-a', position: 3, kind: 'movie', title: 'Film A', genres: [] },
    { mediaItemId: 'm4', position: 4, kind: 'movie', title: 'Collateral', genres: [] },
  ];

  /** Every text under one node, in tree order — children only, never other props. */
  const textIn = (node: unknown): string[] => {
    if (node == null) return [];
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(textIn);
    return textIn((node as { children?: unknown[] }).children ?? []);
  };

  /**
   * The block a line of text sits *inside* — the parent of the node whose whole text is
   * `needle`. Containment rather than depth: the question these tests ask is which lines
   * share a container, and the deepest match is always the `Text` itself.
   */
  const blockHolding = (root: unknown, needle: string): unknown => {
    let found: unknown = null;
    const walk = (node: unknown, parent: unknown) => {
      if (found || !node || typeof node === 'string') return;
      if (Array.isArray(node)) return void node.forEach((child) => walk(child, parent));
      const n = node as { children?: unknown[] };
      const own = textIn(n);
      if (own.length === 1 && own[0] === needle) {
        found = parent;
        return;
      }
      walk(n.children ?? [], n);
    };
    walk(root, null);
    return found;
  };

  const revealOf = async () => {
    mockRanked.mockReturnValue({ data: movies });
    answering(placement);
    const sheet = await openSheet();
    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    return sheet;
  };

  it('puts the placement in the same block as the title', async () => {
    const sheet = await revealOf();

    // The block that holds the title also holds the placement: they are one unit, which
    // is what makes the second read as a subtitle of the first.
    const identity = blockHolding(sheet.toJSON(), 'Film A');
    expect(textIn(identity)).toEqual(expect.arrayContaining(['Film A', '#3 in Movies']));
  });

  it('keeps the anchors out of that block', async () => {
    const sheet = await revealOf();

    // Below/Above are context for the placement, not part of it. Sharing a container is
    // exactly what made four lines of small type read as one column.
    const identity = textIn(blockHolding(sheet.toJSON(), 'Film A'));
    expect(identity.join(' ')).not.toContain('Sicario');
    expect(identity.join(' ')).not.toContain('Collateral');
  });

  it('still reads score, title, placement, then the neighbours', async () => {
    const sheet = await revealOf();

    const order = textIn(sheet.toJSON());
    const at = (needle: string) => order.findIndex((t) => t.includes(needle));
    expect(at('8.7')).toBeLessThan(at('Film A'));
    expect(at('Film A')).toBeLessThan(at('#3 in Movies'));
    expect(at('#3 in Movies')).toBeLessThan(at('Sicario'));
    expect(at('Sicario')).toBeLessThan(at('Collateral'));
  });

  it('ends in exactly two controls, Add details then Done', async () => {
    // `onFinishLog` is what puts Add details on screen — every screen that mounts the
    // sheet passes it, and the reveal falls back to Done alone if one ever does not.
    mockRanked.mockReturnValue({ data: movies });
    answering(placement);
    const sheet = await openSheet({ onFinishLog: jest.fn() });
    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);

    expect(sheet.getByRole('button', { name: 'Add details' })).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(sheet.queryByRole('button', { name: 'Rank another' })).toBeNull();
  });

  it('leaves the title alone when there is no placement worth naming', async () => {
    // Past the top ten the ordinal is withheld, and the block is a title on its own
    // rather than a title with a reserved gap under it.
    mockRanked.mockReturnValue({
      data: Array.from({ length: 40 }, (_, i) => ({
        mediaItemId: i === 19 ? 'film-a' : `m${i}`,
        position: i + 1,
        kind: 'movie',
        title: i === 19 ? 'Film A' : `Other ${i}`,
        genres: [],
      })),
    });
    answering({ ...placement, data: { ...placement.data, position: 20 } });
    const sheet = await openSheet();

    await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
    expect(sheet.queryByText('#20 in Movies', { includeHiddenElements: true })).toBeNull();
    expect(sheet.getByText('Film A', { includeHiddenElements: true })).toBeTruthy();
  });
});

/**
 * **What a completion is reported as, per intent.**
 *
 * The founder's Terrace House report (2026-09-07) was two feed rows for one watch, and
 * the fix was to name the three intents on the Ranked menu. `ranking_completed` had the
 * same defect one layer down and nobody could see it: every completion of an
 * already-ranked title carried `rebucket: false` and was indistinguishable from a first
 * placement, so an Adjust placement counted as a new ranking in every funnel. The event
 * now says which act it was, in the same four words the sheet opens the session with.
 *
 * Each case answers the opening call with a placement outright — an empty band — so the
 * event fires from the same `placed` branch a comparison-driven placement reaches.
 */
describe('what a completion is reported as', () => {
  const completions = (name: string) =>
    mockTrack.mock.calls.filter(([event]) => (event as { name: string }).name === name);

  it.each([
    ['start', undefined, 'rank_start', false],
    ['rebucket', 'rebucket', 'rank_rebucket', true],
    ['rerank', 'rerank', 'rank_again', false],
    ['again', 'again', 'rank_again', false],
  ] as const)(
    'reports mode %s from a placement that opened as %s',
    async (mode, opened, rpc, rebucket) => {
      answering(placement);
      const sheet = await openSheet(
        opened ? { subject: { ...subject, mode: opened } } : {},
      );

      await sheet.findByLabelText(/Film A scored 8.7 out of 10/);
      await waitFor(() => expect(callsTo(rpc)).toHaveLength(1));

      expect(completions('ranking_completed')).toHaveLength(1);
      expect(completions('ranking_completed')[0][0]).toMatchObject({
        name: 'ranking_completed',
        props: { media_kind: 'movie', surface: 'search', comparisons: 0, rebucket, mode },
      });
    },
  );

  it('emits nothing for a placement that may have landed but could not say so', async () => {
    // The lost-reply case. `rank_again` here answers with no code, which `classifyWrite`
    // reads as unknown: the title may be ranked, and an event on a maybe is how a retry
    // becomes two rankings. The undercount is the deliberate direction.
    answering({ data: null, error: { code: '', message: 'TypeError: fail' } });
    const sheet = await openSheet({ subject: { ...subject, mode: 'again' } });

    await waitFor(() => expect(sheet.getByText('Not sure that landed')).toBeTruthy());
    expect(completions('ranking_completed')).toHaveLength(0);
  });
});
