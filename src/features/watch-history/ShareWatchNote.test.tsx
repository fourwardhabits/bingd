import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import type { Postgrest } from '@/test-utils/postgrest';
import { renderWithProviders } from '@/test-utils/render';

// Imported from `app/` by path, as the other Watch History suites do: a test file inside
// `app/` would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

/**
 * **B5 — Share as a review, from a watch's note.**
 *
 * The screen's half: which cards offer it, what it hands the title's composer, what it
 * asks before that composer would replace a review, and that none of it writes anything.
 * The composer's half — the draft held unwritten until *Share as a review*, then saved
 * through `save_note` — is `LogSheet.seed.test.tsx`, so the log sheet is recorded here
 * rather than drawn, as `WatchHistoryScreen.test.tsx` records it.
 *
 * The watches are the PostgREST stand-in's, so "the watch note is unchanged" is the stored
 * row read back, not a mock repeating itself.
 */

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'film-1' }),
  useRouter: () => ({
    back: mockBack,
    replace: jest.fn(),
    push: jest.fn(),
    canGoBack: () => true,
  }),
  Stack: { Screen: () => null },
}));

type SheetProps = Record<string, unknown> & { title?: unknown };
const mockLogSheet: { props: SheetProps | null } = { props: null };
jest.mock('@/features/collection/LogSheet', () => ({
  LogSheet: (props: SheetProps) => {
    mockLogSheet.props = props;
    return null;
  },
}));
jest.mock('@/features/ranking/RankingSheet', () => ({ RankingSheet: () => null }));
jest.mock('@/features/awards/celebration-queue', () => ({
  useCelebrationHandoff: () => jest.fn(),
}));
const FILM = {
  id: 'film-1',
  title: 'Top Gun: Maverick',
  year: 2022,
  posterUri: null,
  kind: 'movie',
};
jest.mock('@/features/watch-history/use-history-title', () => ({
  useHistoryTitle: () => ({ data: FILM }),
}));
jest.mock('@/features/auth/session', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'qa_a', display_name: 'QA account A' }),
}));
jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));
jest.mock('@/features/collection/use-companions', () => ({
  ...jest.requireActual('@/features/collection/use-companions'),
  useTaggablePeople: () => ({ data: [], isPending: false }),
}));

/** The title's note as the log state reads it; each test sets what is stored. */
const mockTitleNote: { note: string; noteVisibility: 'public' | 'private' } = {
  note: '',
  noteVisibility: 'private',
};
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: () => ({
    data: {
      note: mockTitleNote.note,
      noteVisibility: mockTitleNote.noteVisibility,
      noteSpoilers: false,
      noteVersion: '2026-11-01T00:00:00Z',
      ranked: true,
    },
  }),
}));

jest.mock('@/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  return {
    supabase: { from: client.from, rpc: client.rpc },
    startSessionRefresh: () => () => {},
  };
});

const pg = () => (globalThis as unknown as { __pg: Postgrest }).__pg;

const WATCH_NOTE = 'Third time, on the big screen, and it still lands.';

const eventRow = (id: string, watchedOn: string, note: string | null) => ({
  id,
  media_item_id: 'film-1',
  watched_on: watchedOn,
  basis: 'reader',
  import_ref: null,
  recorded_at: `${watchedOn}T20:00:00Z`,
  note,
  companions: [],
});

const watchNotes = () =>
  (pg().tables.watch_events as { id: string; note: string | null }[]).map((row) => [
    row.id,
    row.note,
  ]);

let alert: jest.SpyInstance;
/** The buttons of the last alert, by label. */
const lastAlert = () => {
  const call = alert.mock.calls.at(-1) as [string, string | undefined, AlertButton[]];
  return {
    title: call[0],
    body: call[1],
    press: (label: string) =>
      act(() => call[2].find((button) => button.text === label)?.onPress?.()),
    labels: call[2].map((button) => button.text),
  };
};

beforeEach(() => {
  const db = pg();
  for (const key of Object.keys(db.tables)) delete db.tables[key];
  db.rpcCalls.length = 0;
  db.broken.clear();
  db.tables.watch_events = [
    eventRow('w1', '2022-06-01', null),
    eventRow('w2', '2026-10-24', WATCH_NOTE),
  ];
  db.tables.ranking_placements = [];
  db.tables.feed_events = [];
  mockTitleNote.note = '';
  mockTitleNote.noteVisibility = 'private';
  mockLogSheet.props = null;
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => alert.mockRestore());

const loaded = async () => {
  const view = await renderWithProviders(<WatchHistoryScreen />);
  await waitFor(() => expect(view.getByTestId('watch-row-w2')).toBeTruthy());
  return view;
};

describe('Share as a review, from a watch’s note (B5)', () => {
  it('is offered on a card with a saved note, beside its other acts, and only there', async () => {
    const view = await loaded();
    expect(view.getByTestId('watch-share-w2')).toBeTruthy();
    expect(view.getByTestId('watch-share-w2').props.accessibilityLabel).toMatch(
      /^Share this watch’s note as a review/,
    );
    // No note, nothing to share.
    expect(view.queryByTestId('watch-share-w1')).toBeNull();

    // Not while an editor is open: on that card the editor replaces the action line, and
    // on the others it would close the editor over its draft.
    await fireEvent.press(view.getByTestId('watch-edit-w1'));
    expect(view.queryByTestId('watch-share-w2')).toBeNull();
  });

  it('opens the title’s composer on the watch note, with no question and no write, when there is no review', async () => {
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(mockLogSheet.props?.seedNote).toBe(WATCH_NOTE);
    expect(mockLogSheet.props?.inWatchHistory).toBe(true);
    expect(mockLogSheet.props?.postRank).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    // The share action itself publishes nothing: no write of either note.
    expect(pg().rpcCalls).toEqual([]);
  });

  it('asks before replacing an existing review; Cancel opens nothing and changes nothing', async () => {
    mockTitleNote.note = 'The title review.';
    mockTitleNote.noteVisibility = 'public';
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));

    expect(alert).toHaveBeenCalledTimes(1);
    const question = lastAlert();
    expect(question.title).toBe('Replace your review?');
    expect(question.body).toMatch(/replace it\. Nothing changes until you share\./);
    expect(question.labels).toEqual(['Cancel', 'Replace']);

    await question.press('Cancel');
    expect(mockLogSheet.props?.title ?? null).toBeNull();
    expect(mockLogSheet.props?.seedNote ?? null).toBeNull();
    expect(pg().rpcCalls).toEqual([]);
    expect(watchNotes()).toEqual([
      ['w1', null],
      ['w2', WATCH_NOTE],
    ]);
  });

  it('Replace opens the composer on the watch note, and still writes nothing', async () => {
    mockTitleNote.note = 'A private thought.';
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));

    // A private title note is named as what it is.
    expect(lastAlert().title).toBe('Replace your note?');
    await lastAlert().press('Replace');

    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(mockLogSheet.props?.seedNote).toBe(WATCH_NOTE);
    expect(pg().rpcCalls).toEqual([]);
  });

  it('does not ask when the stored note already reads the same', async () => {
    mockTitleNote.note = `  ${WATCH_NOTE}  `;
    mockTitleNote.noteVisibility = 'public';
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));

    expect(alert).not.toHaveBeenCalled();
    await waitFor(() => expect(mockLogSheet.props?.seedNote).toBe(WATCH_NOTE));
  });

  it('closing the composer drops the draft, leaves the watch note, and Rerank opens unseeded', async () => {
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));
    await waitFor(() => expect(mockLogSheet.props?.seedNote).toBe(WATCH_NOTE));

    await act(() => (mockLogSheet.props!.onClose as () => void)());
    expect(mockLogSheet.props?.title).toBeNull();
    expect(mockLogSheet.props?.seedNote).toBeNull();

    // The card still shows its private note, from the stored row.
    expect(view.getByTestId('watch-note-w2').props.children).toBe(WATCH_NOTE);
    expect(watchNotes()).toEqual([
      ['w1', null],
      ['w2', WATCH_NOTE],
    ]);
    expect(pg().rpcCalls.map((call) => call.name)).not.toContain('set_watch_details');
    expect(pg().rpcCalls.map((call) => call.name)).not.toContain('save_note');

    // The next sheet this screen opens is Rerank's, and it carries no draft.
    await fireEvent.press(view.getByTestId('watch-rerank-w2'));
    await waitFor(() => expect(mockLogSheet.props?.title).toEqual(FILM));
    expect(mockLogSheet.props?.seedNote).toBeNull();
  });

  it('a hand-off to the ranking drops the draft, so the sheet it returns to is unseeded', async () => {
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-share-w2'));
    await waitFor(() => expect(mockLogSheet.props?.seedNote).toBe(WATCH_NOTE));

    await act(() =>
      (mockLogSheet.props!.onRank as (b: string, m: string) => void)('loved', 'rerank'),
    );
    expect(mockLogSheet.props?.title).toBeNull();
    expect(mockLogSheet.props?.seedNote).toBeNull();
  });
});
