import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { RankingSheet, type RankingSheetProps } from './RankingSheet';

/**
 * The controls under the two posters, and the way out of the reveal.
 *
 * Its own file rather than more of `RankingSheet.test.tsx`, which is already 900 lines
 * about the *session* — what each RPC is called with, what a lost reply means, what a
 * cancelled sheet owes the server. Nothing here is about any of that. These are
 * assertions about what a control looks like and what it is called, and mixing the two
 * kinds makes both harder to find.
 *
 * The mocks are deliberately a copy of that file's rather than a shared helper: a
 * fixture two suites edit is a fixture that grows a flag per suite, and this one is
 * fifteen lines.
 */

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
const subject = { id: 'film-a', title: 'Film A', bucket: 'loved' as const, posterUri: null };

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
const REVEAL = 'Film A scored 8.7 out of 10. #3 Movies';

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
 * **The two secondary controls, as controls.**
 *
 * The founder's physical-device pass reported these as "loose text rather than
 * deliberate buttons", and the screenshot bears it out: `tertiary` is a transparent box
 * with no border and no fill, so at `sm` and a secondary tone the pair read as two words
 * that happened to be under the posters. The reference the founder gave is the compact
 * Follow back in the notification inbox — `secondary`, `sm`, with `hitSlop` — and these
 * assert that this is now that control rather than a description of one.
 *
 * The *mechanism* is asserted in `RankingSheet.test.tsx`, which pins Undo to `rank_back`
 * and Too tough to `rank_skip`. A restyle that quietly repointed a word at a different
 * call is exactly what this change must not have been, and the two suites together are
 * what say so.
 */
describe('undo and skip are buttons', () => {
  const controls = async () => {
    answering(comparison);
    const sheet = await openSheet();
    await sheet.ready('Film P');
    return {
      undo: sheet.getByLabelText('Undo the last comparison'),
      skip: sheet.getByLabelText('Too tough to call'),
      sheet,
    };
  };

  it('draws both with a container and a border rather than as bare words', async () => {
    const { undo, skip } = await controls();

    for (const control of [undo, skip]) {
      const style = StyleSheet.flatten(control.props.style);
      // A fill and a hairline. `tertiary` had `backgroundColor: 'transparent'` and no
      // border at all, which is the whole of what made them read as text.
      expect(style.backgroundColor).toBe(theme.surface.raised);
      expect(style.borderWidth).toBeGreaterThan(0);
      expect(style.borderColor).toBe(theme.border.strong);
    }
  });

  it('keeps them compact and still reaches the 44pt target through slop', async () => {
    const { undo, skip } = await controls();

    for (const control of [undo, skip]) {
      const style = StyleSheet.flatten(control.props.style);
      // Subordinate to the posters, which is why they are not `md`.
      expect(style.minHeight).toBeLessThan(theme.layout.buttonMinHeight);
      // design-system.md §8's floor, carried by slop rather than by a taller box.
      expect(style.minHeight + control.props.hitSlop * 2).toBeGreaterThanOrEqual(
        theme.layout.minTapTarget,
      );
    }
  });

  it('gives them the same treatment as each other', async () => {
    const { undo, skip } = await controls();

    const a = StyleSheet.flatten(undo.props.style);
    const b = StyleSheet.flatten(skip.props.style);
    // Two controls of the same rank. Letting each hug its own label made the escape
    // visibly the smaller button, which is a hierarchy nobody chose — and it is what
    // makes the longer word cost nothing.
    expect(a.minHeight).toBe(b.minHeight);
    expect(a.borderWidth).toBe(b.borderWidth);
    expect(a.backgroundColor).toBe(b.backgroundColor);
  });

  it('says Undo and Too tough, and never Skip — to a screen reader as well', async () => {
    const { sheet, skip } = await controls();

    // The words are the founder's. "Too tough" everywhere since 2026-08-30, replacing
    // the per-surface split that had onboarding saying one thing and the Log tab
    // another.
    expect(sheet.getByText('Undo')).toBeTruthy();
    expect(sheet.getByText('Too tough')).toBeTruthy();
    expect(sheet.queryByText('Skip')).toBeNull();

    // **The accessible label is a surface too** (independent review 76). It read
    // "Too tough to call. Skip this comparison" — the new label with the old one still
    // attached — so the control went on saying Skip to anybody who could not see it.
    // The effect is not lost with the word: it moves to the hint, which is where an
    // effect belongs and where it already was.
    expect(skip.props.accessibilityLabel).not.toMatch(/skip/i);
    expect(skip.props.accessibilityHint).toMatch(/different title/i);
  });

  /**
   * **The same control, whichever surface asked for it.**
   *
   * The label used to be `surface === 'onboarding' ? 'Too tough' : 'Skip'`, so a reader
   * met one word in onboarding and the other in the Log tab — which is the divergence
   * the founder found on the device. Every surface this component serves is one of these
   * four values, so asserting across all of them is asserting across the whole product:
   * a future per-surface exception has to break this test to exist.
   *
   * The structure is asserted with the word, because "make onboarding say Too tough"
   * could have been met by giving onboarding its own control — and two controls that
   * look different while doing the same thing is the defect one word further on.
   */
  it.each(['search', 'collection', 'onboarding', 'title'] as const)(
    'draws one Too tough control with the same structure on the %s surface',
    async (surface) => {
      answering(comparison);
      const sheet = await openSheet({ surface });
      await sheet.ready('Film P');

      expect(sheet.getByText('Too tough')).toBeTruthy();
      expect(sheet.queryByText('Skip')).toBeNull();

      const escape = sheet.getByLabelText('Too tough to call');
      const undo = sheet.getByLabelText('Undo the last comparison');
      const a = StyleSheet.flatten(undo.props.style);
      const b = StyleSheet.flatten(escape.props.style);

      // The canonical structure: a raised fill, a hairline, equal halves of the row,
      // and the same compact height as Undo — `theme.surface.raised` is what the
      // founder's "restrained" reference control is drawn with.
      expect(b.backgroundColor).toBe(theme.surface.raised);
      expect(b.borderWidth).toBeGreaterThan(0);
      expect(b.minHeight).toBe(a.minHeight);
      expect(b.borderColor).toBe(a.borderColor);
      expect(escape.props.hitSlop).toBe(undo.props.hitSlop);
    },
  );
});

/**
 * **Details, and that it is one capability rather than three.**
 *
 * `What is this?` was the visible copy under both posters. The founder's objection is
 * that it reads as the screen being unsure, and that at phone width three words wrap
 * under one title and not the other — so the pair stops being symmetrical at the moment
 * symmetry is the question being asked.
 *
 * The reuse assertion is the one that matters beyond the copy. Onboarding, the Search
 * tab and the title page all mount *this* component, so there is one comparison and
 * therefore one Details; what a regression would look like is a surface growing its own,
 * and what catches it is proving the control opens `TitleRecallSheet` rather than
 * anything local.
 */
describe('details, under both posters', () => {
  it('says Details rather than asking a question', async () => {
    answering(comparison);
    const sheet = await openSheet();
    await sheet.ready('Film P');

    // One word per poster, and two posters: the subject and the opponent.
    expect(sheet.getAllByText('Details')).toHaveLength(2);
    expect(sheet.queryByText('What is this?')).toBeNull();
  });

  it('opens the canonical recall sheet, on the title it sits under', async () => {
    answering(comparison);
    const sheet = await openSheet();
    await sheet.ready('Film P');

    await fireEvent.press(sheet.getByLabelText('Details about Film P'));

    // `TitleRecallSheet`'s own read — the overview and the director — rather than
    // anything this screen holds. Nothing else in the app renders it, so seeing it is
    // the proof that the shared component is what opened.
    await waitFor(() => expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy());
    expect(sheet.getByText('Directed by A Director')).toBeTruthy();
    // And the comparison is still standing behind it.
    expect(callsTo('rank_answer')).toHaveLength(0);
    expect(callsTo('rank_cancel')).toHaveLength(0);
  });

  it('keeps the long press as the fast path', async () => {
    // design-system.md §8: a hidden gesture may be the *fast* path and never the only
    // one. The visible control above is the discoverable one; this is the shortcut, and
    // the founder's brief asks for it to survive.
    answering(comparison);
    const sheet = await openSheet();
    await sheet.ready('Film P');

    await fireEvent(sheet.card('Film P'), 'longPress');

    await waitFor(() => expect(sheet.getByText('A courier misplaces a briefcase.')).toBeTruthy());
    // A long press that also answered would file a judgement on a title the reader was
    // still trying to place.
    expect(callsTo('rank_answer')).toHaveLength(0);
  });
});

/**
 * **The reveal is no longer where the log ends.**
 *
 * The founder's central complaint: tap a bucket, answer the comparisons, see a number,
 * and the flow is over — the review you might write and the people you watched it with
 * are behind a second, unprompted visit to a sheet you were just thrown out of.
 */
describe('finishing the log after a ranking', () => {
  it('offers a way on rather than only two ways out', async () => {
    answering(placement);
    const onFinishLog = jest.fn();
    const sheet = await openSheet({ onFinishLog });

    await sheet.findByLabelText(REVEAL);
    // "Add more details", not "Finish your log": the ranking is complete by the time
    // this button exists, and the label must not frame the optional half as an
    // unfinished obligation (founder correction, 2026-08-27).
    await fireEvent.press(sheet.getByRole('button', { name: 'Add more details' }));

    // The placement travels with the call: the session already had it, and making the
    // log sheet re-query for a number this screen is holding would put a spinner in the
    // middle of a finished act.
    expect(onFinishLog).toHaveBeenCalledWith({ score: 8.7, position: 3, category: 'movies' });
  });

  it('still lets somebody finish without writing anything', async () => {
    answering(placement);
    const onFinishLog = jest.fn();
    const sheet = await openSheet({ onFinishLog });

    await sheet.findByLabelText(REVEAL);
    // Both exits survive and Done is still one tap. Nothing in the post-rank state is
    // required of anybody.
    await fireEvent.press(sheet.getByRole('button', { name: 'Done' }));

    expect(onFinishLog).not.toHaveBeenCalled();
    await waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
  });

  it('shows the score before offering anything to do with it', async () => {
    answering(placement);
    const sheet = await openSheet({ onFinishLog: jest.fn() });

    // The reveal keeps its moment. The brief asks for the result to be seen, and a
    // post-rank state that replaced it would be a form where a celebration was.
    await sheet.findByLabelText(REVEAL);
    // The number itself counts up from the bottom of its band, so this waits for it to
    // settle rather than asserting on whatever frame the label happened to land on.
    await waitFor(() =>
      expect(sheet.getByText('8.7', { includeHiddenElements: true })).toBeTruthy(),
    );
    expect(sheet.getByText('Film A')).toBeTruthy();
  });

  it('keeps the old pair of controls when there is no log to return to', async () => {
    answering(placement);
    const sheet = await openSheet();

    await sheet.findByLabelText(REVEAL);
    // A caller with no log sheet mounted gets what the reveal always had, rather than a
    // button that leads nowhere.
    expect(sheet.queryByRole('button', { name: 'Add more details' })).toBeNull();
    expect(sheet.getByRole('button', { name: 'Rank another' })).toBeTruthy();
    expect(sheet.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
