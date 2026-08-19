import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { renderWithProviders } from '@/test-utils/render';
import { queryKeys } from '@/lib/query';

import { RankingSheet, type RankingSheetProps } from './RankingSheet';

const mockRpc = jest.fn();
const mockPivotRead = jest.fn();
const mockSelect = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: (columns: string) => {
        mockSelect(columns);
        return { eq: () => ({ single: () => mockPivotRead() }) };
      },
    }),
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

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
  mockPivotRead.mockReset();
  mockPivotRead.mockResolvedValue({
    data: { id: 'film-p', title: 'Film P', poster_path: null },
    error: null,
  });
});

const openSheet = async (props: Partial<RankingSheetProps> = {}) => {
  const onClose = jest.fn();
  const view = await renderWithProviders(
    <RankingSheet subject={subject} onClose={onClose} {...props} />,
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
    expect(mockRpc).toHaveBeenCalledWith('rank_start', {
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
    expect(callsTo('rank_answer')[0][1]).toEqual({
      p_session_id: SESSION,
      p_winner: 'film-a',
    });
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

    await sheet.rerender(<RankingSheet subject={null} onClose={sheet.onClose} />);
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

  it('does not cancel a session that Back already ended', async () => {
    // rank_back at the first comparison deletes the session itself.
    answering(comparison(), { data: { done: false, cancelled: true }, error: null });
    const sheet = await openSheet();

    await sheet.ready('Film P');
    await fireEvent.press(sheet.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(sheet.getByText('Still in your collection')).toBeTruthy());

    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(callsTo('rank_cancel')).toHaveLength(0);
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
    await sheet.rerender(<RankingSheet subject={null} onClose={sheet.onClose} />);
    await sheet.rerender(<RankingSheet subject={subject} onClose={sheet.onClose} />);
    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map(([args]) => JSON.stringify(args?.queryKey));
    expect(keys).toContain(JSON.stringify(queryKeys.rankings('user-1', 'movies')));
    expect(keys).toContain(JSON.stringify(queryKeys.collection('user-1')));
  });

  it('only says a position is an estimate when the server says so', async () => {
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(REVEAL);
    expect(sheet.queryByText(/estimate/)).toBeNull();
  });

  it('admits a skipped placement is an estimate', async () => {
    answering({ ...placement, data: { ...placement.data, adjustable: true } });
    const sheet = await openSheet();

    await waitFor(() => expect(sheet.getByText(/estimate/)).toBeTruthy());
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
          <RankingSheet subject={subject} onClose={jest.fn()} {...props} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
    const invalidated = (key: unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;
    return { ...view, invalidated };
  };

  it('refreshes the collection and the awards as soon as the write lands', async () => {
    answering(comparison());
    // The session is open and nothing has been answered — exactly the state a reader is
    // in when they change their mind and close the sheet.
    const { invalidated } = await mount({ subject: rebucket });

    await waitFor(() => expect(callsTo('rank_rebucket')).toHaveLength(1));
    await waitFor(() => expect(invalidated(['awards', 'user-1'])).toBe(true));
    expect(invalidated(['collection', 'user-1'])).toBe(true);
    // Both categories, because a rebucket can move a title between them and nothing here
    // knows which one this was.
    expect(invalidated(['rankings', 'user-1', 'movies'])).toBe(true);
    expect(invalidated(['rankings', 'user-1', 'tv_seasons'])).toBe(true);
  });

  /**
   * **Including when it reports a failure**, which is the correction review 21d made.
   *
   * A Postgres exception does roll the whole `rank_rebucket` transaction back — but a
   * transaction can commit and its HTTP response can then be lost, and the client maps
   * that to `failed` too. Nothing on this side distinguishes "refused" from "committed,
   * reply dropped", so the only safe reading is that it may have landed. A definite
   * rollback costs one redundant refetch; the other way costs a screen describing a
   * ranking that is gone.
   */
  it('refreshes even when the rebucket reports a failure, which may still have committed', async () => {
    answering({ data: null, error: { code: '22023', message: 'title is already in that bucket' } });
    const { invalidated } = await mount({ subject: rebucket });

    await waitFor(() => expect(callsTo('rank_rebucket')).toHaveLength(1));
    await waitFor(() => expect(invalidated(['awards', 'user-1'])).toBe(true));
    expect(invalidated(['collection', 'user-1'])).toBe(true);
  });

  it('leaves a first ranking alone, which writes nothing until it is placed', async () => {
    answering(comparison());
    const { invalidated } = await mount();

    await waitFor(() => expect(callsTo('rank_start')).toHaveLength(1));
    expect(invalidated(['awards', 'user-1'])).toBe(false);
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
