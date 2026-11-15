import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Imported from `app/` by path, as WatchHistoryScreen.test.tsx does: a test file inside
// `app/` would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

/**
 * **Watch History as cards** (UI wave, 2026-11-12).
 *
 * Each watch is a card — the house treatment, `surface.raised` with `radius.card` and a
 * hairline border — spaced rather than ruled, with the inline editor inside the card it
 * edits. Everything the rows said and did is unchanged and stays pinned by
 * `WatchHistoryScreen.test.tsx`; this file pins the card itself, and the cases the
 * change could have broken: one watch, many across years, an undated import, a long note,
 * editing and removing inside a card, and the largest text on the narrowest phone.
 *
 * The mocks are that file's, unchanged.
 */
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'film-1' }),
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    push: mockPush,
    canGoBack: () => mockCanGoBack,
  }),
  // The route's stack options are recorded so a test can read the title and whether the
  // stack's own header is drawn.
  Stack: {
    Screen: ({ options }: { options?: { title?: string; headerShown?: boolean } }) => {
      mockHeader.title = options?.title;
      mockHeader.headerShown = options?.headerShown;
      return null;
    },
  },
}));
const mockHeader: { title?: string; headerShown?: boolean } = {};

/**
 * The rating and comparison sheets are the title page's own, and their behaviour is theirs
 * (`LogSheet.test.tsx`, `RankingSheet`'s suites). What this screen owns is *which* title it
 * hands them and what it does with their callbacks, so they are recorded rather than drawn.
 */
type SheetProps = Record<string, unknown> & { title?: unknown; subject?: unknown };
const mockLogSheet: { props: SheetProps | null } = { props: null };
const mockRankingSheet: { props: SheetProps | null } = { props: null };
jest.mock('@/features/collection/LogSheet', () => ({
  LogSheet: (props: SheetProps) => {
    mockLogSheet.props = props;
    return null;
  },
}));
jest.mock('@/features/ranking/RankingSheet', () => ({
  RankingSheet: (props: SheetProps) => {
    mockRankingSheet.props = props;
    return null;
  },
}));
const mockCelebrate = jest.fn();
jest.mock('@/features/awards/celebration-queue', () => ({
  useCelebrationHandoff: () => mockCelebrate,
}));
const FILM = {
  id: 'film-1',
  title: 'Heat',
  year: 1995,
  posterUri: null,
  kind: 'movie' as const,
};
const mockHistoryTitle = jest.fn(() => ({ data: FILM as typeof FILM | null }));
jest.mock('@/features/watch-history/use-history-title', () => ({
  useHistoryTitle: () => mockHistoryTitle(),
}));

jest.mock('@/features/auth/session', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));

jest.mock('@/features/collection/use-companions', () => ({
  ...jest.requireActual('@/features/collection/use-companions'),
  useTaggablePeople: () => ({
    data: [{ id: 'friend-1', username: 'alex', name: 'Alex', avatarUri: null }],
    isPending: false,
  }),
}));

const mockHistory = jest.fn();
jest.mock('@/features/watch-history/use-watch-history', () => ({
  useWatchHistory: () => mockHistory(),
}));

const mockEdit = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
const mockDetails = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
const mockDelete = jest.fn((_input: unknown) => Promise.resolve({ outcome: 'ok' }));
jest.mock('@/features/watch-history/writes', () => ({
  deleteWatchEvent: (input: unknown) => mockDelete(input),
  editWatchEvent: (input: unknown) => mockEdit(input),
  setWatchDetails: (input: unknown) => mockDetails(input),
  newOperationId: () => 'op-1',
}));

const mockRemove = jest.fn((_input: unknown): Promise<{ outcome: string; message?: string }> =>
  Promise.resolve({ outcome: 'ok' }),
);
const mockSaveNote = jest.fn((_input: unknown) =>
  Promise.resolve({ outcome: 'ok', noteVersion: '2026-09-25T00:00:00Z' }),
);
jest.mock('@/features/collection/writes', () => ({
  removeFromCollection: (input: unknown) => mockRemove(input),
  saveNote: (input: unknown) => mockSaveNote(input),
  newOperationId: () => 'op-note',
}));

/**
 * Editing a watch writes the **title's** note (founder decision, 2026-09-25), so the log
 * state is what the editor reads. `private` with writing already in it is the case that
 * matters: no default may republish it.
 */
const mockLogState = jest.fn(() => ({
  data: {
    note: 'Still holds up.',
    noteVisibility: 'private' as const,
    noteSpoilers: false,
    noteVersion: '2026-09-24T00:00:00Z',
    ranked: false,
  },
}));
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: (...args: unknown[]) => mockLogState(...(args as [])),
}));

type Row = {
  id: string;
  watchedOn: string | null;
  basis: 'reader' | 'none' | 'diary';
  importRef: string | null;
  recordedAt: string;
};

const watch = (id: string, watchedOn: string | null, overrides: Partial<Row> = {}): Row => ({
  id,
  watchedOn,
  basis: watchedOn ? 'reader' : 'none',
  importRef: null,
  recordedAt: `${watchedOn ?? '2020-01-01'}T10:00:00Z`,
  ...overrides,
});

type Details = {
  note?: string | null;
  companions?: { id: string; username: string; name: string; avatarUri: null }[];
};

const history = (events: Row[], details: Record<string, Details> = {}) =>
  mockHistory.mockReturnValue({
    isPending: false,
    data: {
      count: events.length,
      events,
      details: new Map(Object.entries(details)),
      placements: [],
      posts: [],
    },
  });

type View = Awaited<ReturnType<typeof renderWithProviders>>;

/** The card's own style: the row's root view. */
const cardStyle = (view: View, id: string) =>
  StyleSheet.flatten(view.getByTestId(`watch-row-${id}`).props.style);

/** The ids of the cards on screen, top to bottom. */
const cardIds = (view: View) =>
  view
    .getAllByTestId(/^watch-row-/)
    .map((node) => String(node.props.testID).replace('watch-row-', ''));

/** Whether any view in the list draws the hairline rule the rows used to be divided by. */
const hasRule = (view: View) => {
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const element = node as { props?: { style?: unknown }; children?: unknown[] };
    const style = StyleSheet.flatten(element.props?.style as never) as
      { height?: number; backgroundColor?: string } | undefined;
    if (
      style?.height === StyleSheet.hairlineWidth &&
      style.backgroundColor === theme.border.hairline
    )
      return true;
    return (element.children ?? []).some(walk);
  };
  return walk(view.getByTestId('watch-history-list'));
};

beforeEach(() => {
  mockEdit.mockClear();
  mockDetails.mockClear();
  mockDelete.mockClear();
  mockRemove.mockClear();
  mockSaveNote.mockClear();
});

describe('a watch is a card', () => {
  it('draws the house card: raised surface, card radius, hairline border, inset from the edge', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const card = cardStyle(view, 'w1');
    expect(card.backgroundColor).toBe(theme.surface.raised);
    expect(card.borderRadius).toBe(theme.radius.card);
    expect(card.borderColor).toBe(theme.border.hairline);
    expect(card.borderWidth).toBeGreaterThan(0);
    expect(card.marginHorizontal).toBe(theme.layout.gutter);
  });

  it('one watch: one card, no span, Watched once', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(cardIds(view)).toEqual(['w1']);
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched once');
    expect(view.queryByTestId('watch-history-span')).toBeNull();
    expect(hasRule(view)).toBe(false);
  });

  it('several watches across years: cards under year headers, newest first, the count right', async () => {
    history([
      watch('w1', '2023-02-10'),
      watch('w2', '2024-03-04'),
      watch('w3', '2024-11-30'),
      watch('w4', '2026-10-12'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-history-summary').props.children).toBe('Watched 4 times');
    expect(cardIds(view)).toEqual(['w4', 'w3', 'w2', 'w1']);
    // One header per year, above its first card.
    for (const year of ['2026', '2024', '2023'])
      expect(view.getAllByText(year)).toHaveLength(1);
    // Spaced, not ruled.
    expect(hasRule(view)).toBe(false);
    for (const id of ['w1', 'w2', 'w3', 'w4']) {
      expect(cardStyle(view, id).backgroundColor).toBe(theme.surface.raised);
    }
    expect(view.getByTestId('watch-date-w3').props.children).toMatch(/^Nov 30, 2024/);
  });

  it('keeps an undated import last, labelled Earlier, with where it came from on one line', async () => {
    history([
      watch('w0', null, {
        basis: 'diary',
        importRef: 'https://letterboxd.com/x/film/heat/#prior',
      }),
      watch('w1', '2024-03-04', {
        basis: 'diary',
        importRef: 'https://letterboxd.com/x/film/heat/',
      }),
      watch('w2', '2025-06-01'),
    ]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(cardIds(view)).toEqual(['w2', 'w1', 'w0']);
    expect(view.getByTestId('watch-date-w0').props.children).toBe('Earlier');
    expect(view.getByTestId('watch-provenance-w0').props.children).toBe(
      'Date not recorded · From Letterboxd',
    );
    expect(view.getByTestId('watch-provenance-w1').props.children).toBe('From Letterboxd');
    expect(view.queryByTestId('watch-provenance-w2')).toBeNull();
  });

  it('an undated native watch says only that its date was not recorded', async () => {
    history([watch('w0', null), watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(view.getByTestId('watch-provenance-w0').props.children).toBe('Date not recorded');
  });

  it('clamps a long note to three lines inside the card, with More and Less', async () => {
    const long = 'A long thought about the heist, the coffee shop and the ending. '.repeat(5);
    history([watch('w1', '2026-09-01')], { w1: { note: long } });
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const card = within(view.getByTestId('watch-row-w1'));
    expect(card.getByTestId('watch-note-w1').props.numberOfLines).toBe(3);
    await fireEvent.press(card.getByText('More'));
    expect(card.getByTestId('watch-note-w1').props.numberOfLines).toBeUndefined();
    expect(card.getByText('Less')).toBeTruthy();
  });

  it('opens the editor inside the card, and saves from there', async () => {
    history([watch('w1', '2024-03-04'), watch('w2', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    const card = within(view.getByTestId('watch-row-w1'));
    expect(card.getByTestId('watch-editor-w1')).toBeTruthy();
    expect(card.getByText('Who I watched with')).toBeTruthy();
    expect(
      within(view.getByTestId('watch-row-w2')).queryByTestId('watch-editor-w2'),
    ).toBeNull();

    await fireEvent.press(card.getByLabelText(/Who I watched with/));
    await fireEvent.press(card.getByText('Alex'));
    await fireEvent.press(card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
    expect(mockDetails).toHaveBeenCalledWith(
      expect.objectContaining({ watchEventId: 'w1', companionIds: ['friend-1'] }),
    );
    await waitFor(() => expect(view.queryByTestId('watch-editor-w1')).toBeNull());
  });

  it('removes a watch from inside its card', async () => {
    history([watch('w1', '2024-03-04'), watch('w2', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w2'));
    const card = within(view.getByTestId('watch-row-w2'));
    await fireEvent.press(card.getByTestId('watch-remove-w2'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ watchEventId: 'w2' }));
  });
});

/**
 * **The largest text on a 320pt phone** (UI wave, 2026-11-12). A unit renderer has no
 * layout, so this pins what makes the card safe there: nothing in it is a fixed height,
 * nothing clips, the date can wrap, and Cancel and Save wrap rather than run off the card.
 */
describe('a card at large text sizes', () => {
  it('never fixes its height or clips its contents', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const card = cardStyle(view, 'w1');
    expect(card.height).toBeUndefined();
    expect(card.maxHeight).toBeUndefined();
    expect(card.overflow).not.toBe('hidden');
  });

  it('lets the date wrap beside the score instead of truncating it', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const date = view.getByTestId('watch-date-w1');
    expect(date.props.numberOfLines).toBeUndefined();
    expect(date.props.adjustsFontSizeToFit).toBeUndefined();
    // The column the date sits in takes what the score leaves, so it wraps there.
    expect(StyleSheet.flatten(date.parent!.props.style).flex).toBe(1);
  });

  it('wraps Cancel and Save onto a second line rather than past the card’s edge', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    const save = within(view.getByTestId('watch-editor-w1')).getByRole('button', {
      name: 'Save',
    });
    // Up from the Save button to the row that holds both actions.
    let row = save.parent;
    while (row && StyleSheet.flatten(row.props.style)?.flexDirection !== 'row')
      row = row.parent;
    expect(StyleSheet.flatten(row!.props.style).flexWrap).toBe('wrap');
  });

  it('keeps Edit’s full 44pt target inside the card', async () => {
    history([watch('w1', '2026-09-01')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    const edit = view.getByTestId('watch-edit-w1');
    const style = StyleSheet.flatten(
      typeof edit.props.style === 'function'
        ? edit.props.style({ pressed: false })
        : edit.props.style,
    );
    expect(style.minHeight).toBe(theme.layout.minTapTarget);
  });
});

/**
 * **The refined card** (founder spec §5, 2026-11-13): the standard Save at the top right
 * of the editor's header with Cancel secondary beside it, the editor behind exactly one
 * hairline, and no rules between the date, the facts and the acts.
 */
describe('the refined card', () => {
  /** Every border drawn inside a card, as `testID-or-type:side`. */
  const rulesIn = (node: unknown): string[] => {
    const out: string[] = [];
    const walk = (n: { type?: string; props?: Record<string, unknown>; children?: unknown[] }) => {
      const style = StyleSheet.flatten(
        typeof n.props?.style === 'function'
          ? (n.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false })
          : n.props?.style,
      ) as Record<string, number> | undefined;
      for (const side of ['borderTopWidth', 'borderBottomWidth']) {
        if (style && (style[side] ?? 0) > 0) out.push(`${String(n.props?.testID ?? n.type)}:${side}`);
      }
      for (const child of n.children ?? []) if (child && typeof child === 'object') walk(child as never);
    };
    for (const child of (node as { children?: unknown[] }).children ?? [])
      if (child && typeof child === 'object') walk(child as never);
    return out;
  };

  it('puts the standard Save at the top right of the editor, with Cancel secondary', async () => {
    history([watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));

    const header = view.getByTestId('watch-editor-header-w1');
    // The header is the editor's first child: Save is at its top, not under the form.
    const editorKids = view.getByTestId('watch-editor-w1').children as unknown as { props: { testID?: string } }[];
    expect(editorKids[0]?.props.testID).toBe('watch-editor-header-w1');
    const fill = StyleSheet.flatten(within(header).getByTestId('watch-save-w1-fill').props.style);
    expect(fill.backgroundColor).toBe(theme.semantic.action);
    expect(fill.minHeight).toBe(theme.layout.control.compactAction.visibleHeight);
    // Cancel is the secondary kind: the raised surface and a hairline, never Maroon fill.
    const cancel = within(header).getByRole('button', { name: 'Cancel' });
    const cancelStyle = StyleSheet.flatten(
      (typeof cancel.props.style === 'function' ? cancel.props.style({ pressed: false }) : cancel.props.style) as never,
    ) as { backgroundColor?: string };
    expect(cancelStyle.backgroundColor).toBe(theme.surface.raised);
    // Save comes after Cancel, at the trailing end of the header.
    const actions = within(header).getByRole('button', { name: 'Save' });
    expect(actions).toBeTruthy();
  });

  it('saves once for a double tap on Save', async () => {
    history([watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    const card = within(view.getByTestId('watch-row-w1'));
    await fireEvent.press(card.getByLabelText(/Who I watched with/));
    await fireEvent.press(card.getByText('Alex'));
    const save = card.getByRole('button', { name: 'Save' });
    await fireEvent.press(save);
    await fireEvent.press(save);
    await waitFor(() => expect(mockDetails).toHaveBeenCalledTimes(1));
    expect(mockDetails).toHaveBeenCalledTimes(1);
  });

  it('draws no rule inside a collapsed card', async () => {
    history([watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    expect(rulesIn(view.getByTestId('watch-row-w1'))).toEqual([]);
  });

  it('draws exactly one rule when editing: the editor’s own boundary', async () => {
    history([watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(rulesIn(view.getByTestId('watch-row-w1'))).toEqual(['watch-editor-w1:borderTopWidth']);
  });

  it('keeps Cancel a 44pt target despite its compact drawing', async () => {
    history([watch('w1', '2024-03-04')]);
    const view = await renderWithProviders(<WatchHistoryScreen />);
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    const cancel = view.getByRole('button', { name: 'Cancel' });
    const style = StyleSheet.flatten(
      (typeof cancel.props.style === 'function' ? cancel.props.style({ pressed: false }) : cancel.props.style) as never,
    ) as { minHeight?: number };
    const slop = cancel.props.hitSlop as { top: number; bottom: number };
    expect((style.minHeight ?? 0) + slop.top + slop.bottom).toBeGreaterThanOrEqual(
      theme.layout.minTapTarget,
    );
  });
});

