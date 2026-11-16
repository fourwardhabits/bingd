import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import type { Postgrest } from '@/test-utils/postgrest';
import { renderWithProviders } from '@/test-utils/render';

// Imported from `app/` by path, as the other Watch History suites do: a test file inside
// `app/` would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

/**
 * **Share a watch's note as a review, from the editor** (founder QA, 2026-11-16).
 *
 * *Edit watch → Note* carries the composer's two claims, both off when it opens. Save writes
 * this watch's own note (`set_watch_details`) and — only when *Share as a review* is on — then
 * publishes a copy as the title's review (`save_note`, public, with the spoiler choice), after
 * asking when that would replace a different stored note. The watch's note stays private and
 * the two are never tied together afterwards. Runs the real screen and writers against the
 * PostgREST stand-in; `set_watch_details` is applied to its `watch_events`, `save_note` is
 * recorded (its row and version checks are `supabase/tests`').
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

// The rating and comparison sheets are the title page's own; nothing here opens them.
jest.mock('@/features/collection/LogSheet', () => ({ LogSheet: () => null }));
jest.mock('@/features/ranking/RankingSheet', () => ({ RankingSheet: () => null }));
jest.mock('@/features/awards/celebration-queue', () => ({
  useCelebrationHandoff: () => jest.fn(),
}));
jest.mock('@/features/watch-history/use-history-title', () => ({
  useHistoryTitle: () => ({
    data: {
      id: 'film-1',
      title: 'Top Gun: Maverick',
      year: 2022,
      posterUri: null,
      kind: 'movie',
    },
  }),
}));
jest.mock('@/features/auth/session', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'qa_a', display_name: 'QA account A' }),
}));
jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));
jest.mock('@/features/collection/use-companions', () => ({
  ...jest.requireActual('@/features/collection/use-companions'),
  useTaggablePeople: () => ({
    data: [{ id: 'friend-1', username: 'qa_b', name: 'QA account B', avatarUri: null }],
    isPending: false,
  }),
}));
/**
 * The title's review, as the log state reads it: public and spoiler-flagged, so a watch
 * editor that still read it would show it, and one that still wrote it would republish it.
 */
const mockTitleNote: { note: string; visibility: 'public' | 'private' } = {
  note: '',
  visibility: 'private',
};
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: () => ({
    data: {
      note: mockTitleNote.note,
      noteVisibility: mockTitleNote.visibility,
      noteSpoilers: false,
      noteVersion: '2026-11-01T00:00:00Z',
      ranked: true,
    },
  }),
}));

/**
 * PostgREST, with `set_watch_details` applied to `watch_events` as the function applies it
 * (`_apply_watch_details`, 20261014000100): the note trimmed, empty is null; companions
 * replaced only when an array is sent. Every other function is only recorded.
 */
jest.mock('@/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  const profiles: Record<string, unknown> = {
    'friend-1': {
      id: 'friend-1',
      username: 'qa_b',
      display_name: 'QA account B',
      avatar_path: null,
    },
  };
  const rpc = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    // A test can hold the write open (`hold`), to see what the editor does meanwhile.
    const held = (globalThis as { __held?: Promise<void> | null }).__held;
    if (name === 'set_watch_details' && held) {
      (globalThis as { __held?: Promise<void> | null }).__held = null;
      return held.then(() => rpc(name, args));
    }
    if (name === 'set_watch_details' && !client.broken.has(name)) {
      const rows = client.tables.watch_events as Record<string, unknown>[];
      const index = rows.findIndex((row) => row.id === args.p_watch_event_id);
      if (index < 0) {
        client.rpcCalls.push({ name, args });
        return Promise.resolve({
          data: null,
          error: { code: 'P0002', message: 'no such watch' },
        });
      }
      const note =
        typeof args.p_note === 'string' && args.p_note.trim() ? args.p_note.trim() : null;
      const companionIds = args.p_companion_ids as string[] | null;
      rows[index] = {
        ...rows[index],
        note,
        ...(companionIds
          ? { companions: companionIds.map((id) => ({ companion: profiles[id] ?? null })) }
          : {}),
      };
    }
    return client.rpc(name, args);
  };
  return { supabase: { from: client.from, rpc }, startSessionRefresh: () => () => {} };
});

const pg = () => (globalThis as unknown as { __pg: Postgrest }).__pg;


const THIRD_NOTE = 'Third time, on the big screen, and it still lands.';
const REVIEW = {
  user_id: 'user-1',
  media_item_id: 'film-1',
  note: 'The title review.',
  note_visibility: 'public',
  note_spoilers: true,
};

const eventRow = (
  id: string,
  watchedOn: string,
  extra: { note?: string | null; companions?: unknown[] } = {},
) => ({
  id,
  media_item_id: 'film-1',
  watched_on: watchedOn,
  basis: 'reader',
  import_ref: null,
  recorded_at: `${watchedOn}T20:00:00Z`,
  note: extra.note ?? null,
  companions: extra.companions ?? [],
});

/** Three watches of one title, the third with QA account B and its own note. */
const seedThreeWatches = () => {
  const db = pg();
  db.tables.watch_events = [
    eventRow('w1', '2022-06-01', { note: 'First time, opening weekend.' }),
    eventRow('w2', '2024-03-10'),
    eventRow('w3', '2026-10-24', {
      note: THIRD_NOTE,
      companions: [
        {
          companion: {
            id: 'friend-1',
            username: 'qa_b',
            display_name: 'QA account B',
            avatar_path: null,
          },
        },
      ],
    }),
  ];
  db.tables.ranking_placements = [
    {
      id: 'p1',
      media_item_id: 'film-1',
      kind: 'first',
      outcome: 'placed',
      position: 2,
      category_size: 11,
      from_position: null,
      score: '9.2',
      bucket: 'loved',
      watch_event_id: null,
      created_at: '2022-06-01T20:01:00Z',
    },
  ];
  db.tables.feed_events = [
    {
      actor_id: 'user-1',
      media_item_id: 'film-1',
      type: 'title_ranked',
      payload: { score: 9.2, bucket: 'loved', watch_event_id: null },
      created_at: '2022-06-01T20:01:00Z',
    },
  ];
  db.tables.user_media = [{ ...REVIEW }];
};


const notes = () =>
  Object.fromEntries(
    (pg().tables.watch_events as { id: string; note: string | null }[]).map((row) => [
      row.id,
      row.note,
    ]),
  );

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const open = async (view: View, id: string) => {
  await fireEvent.press(view.getByTestId(`watch-edit-${id}`));
  const editor = within(view.getByTestId(`watch-editor-${id}`));
  await fireEvent.press(editor.getByLabelText(/^Note/));
  return editor;
};

/** The note field inside one watch's editor. */
const field = (editor: ReturnType<typeof within>) =>
  within(editor.getByTestId('watch-note-editor')).getByLabelText('Note');

const save = async (view: View, id: string) =>
  fireEvent.press(
    within(view.getByTestId(`watch-editor-${id}`)).getByRole('button', { name: 'Save' }),
  );

const loaded = async () => {
  const view = await renderWithProviders(<WatchHistoryScreen />);
  await waitFor(() => expect(view.getByTestId('watch-row-w1')).toBeTruthy());
  return view;
};

let alert: jest.SpyInstance;
const answer = (label: string) => {
  const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[];
  return buttons.find((button) => button.text === label)?.onPress?.();
};

beforeEach(() => {
  const db = pg();
  for (const key of Object.keys(db.tables)) delete db.tables[key];
  db.rpcCalls.length = 0;
  db.broken.clear();
  seedThreeWatches();
  mockTitleNote.note = '';
  mockTitleNote.visibility = 'private';
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => alert.mockRestore());

const calls = (name: string) => pg().rpcCalls.filter((call) => call.name === name);
const shareChip = (editor: ReturnType<typeof within>) =>
  editor.getByLabelText('Share this note as a public review');
const spoilerChip = (editor: ReturnType<typeof within>) =>
  editor.getByLabelText('This note contains spoilers');
const failureText = (view: View, id: string) =>
  within(view.getByTestId(`watch-editor-${id}`)).queryByText(
    /saved on this watch|Write a note/,
  );

describe('Share as a review, decided in the editor', () => {
  it('shows both claims before the note has ever been saved, both off', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2'); // a watch with no note
    expect(field(editor).props.value).toBe('');
    expect(shareChip(editor).props.accessibilityState).toMatchObject({ checked: false });
    expect(spoilerChip(editor).props.accessibilityState).toMatchObject({ checked: false });
    expect(editor.getByTestId('note-claims-caption').props.children).toBe(
      'Only you see this note.',
    );
  });

  it('a private save writes this watch only: no review is created or changed', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'Just for me.');
    await fireEvent.press(spoilerChip(editor)); // a spoiler flag alone publishes nothing
    await save(view, 'w2');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());

    expect(notes().w2).toBe('Just for me.');
    expect(calls('set_watch_details')).toHaveLength(1);
    expect(calls('save_note')).toHaveLength(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it('Share + Save writes the watch note, then publishes the same text as the review, with the spoiler flag', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'Better on the second watch.');
    await fireEvent.press(shareChip(editor));
    await fireEvent.press(spoilerChip(editor));
    expect(editor.getByTestId('note-claims-caption').props.children).toMatch(
      /also shares it as your review, hidden .* This watch’s note stays private/,
    );
    await save(view, 'w2');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());

    expect(pg().rpcCalls.map((call) => call.name)).toEqual(['set_watch_details', 'save_note']);
    expect(notes().w2).toBe('Better on the second watch.');
    expect(calls('save_note')[0]?.args).toMatchObject({
      p_media_item_id: 'film-1',
      p_note: 'Better on the second watch.',
      p_note_visibility: 'public',
      p_note_spoilers: true,
      p_base_updated_at: '2026-11-01T00:00:00Z',
    });
  });

  it('sharing an unchanged saved note publishes it without rewriting the watch', async () => {
    const view = await loaded();
    const editor = await open(view, 'w3');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w3');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w3')).toBeNull());
    expect(pg().rpcCalls.map((call) => call.name)).toEqual(['save_note']);
    expect(calls('save_note')[0]?.args.p_note_spoilers).toBe(false);
  });

  it('asks before replacing a different review; Cancel writes nothing and keeps the draft', async () => {
    mockTitleNote.note = 'My earlier review.';
    mockTitleNote.visibility = 'public';
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'A newer thought.');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w2');

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0][0]).toBe('Replace your review?');
    await answer('Cancel');

    await waitFor(() => expect(view.getByTestId('watch-editor-w2')).toBeTruthy());
    expect(pg().rpcCalls).toEqual([]);
    expect(notes().w2).toBeNull();
    expect(field(within(view.getByTestId('watch-editor-w2'))).props.value).toBe(
      'A newer thought.',
    );
  });

  it('Replace writes the watch, then the review', async () => {
    mockTitleNote.note = 'My earlier review.';
    mockTitleNote.visibility = 'public';
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'A newer thought.');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w2');
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    await answer('Replace');

    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());
    expect(pg().rpcCalls.map((call) => call.name)).toEqual(['set_watch_details', 'save_note']);
  });

  it('editing a note later without Share never touches the review', async () => {
    mockTitleNote.note = THIRD_NOTE;
    mockTitleNote.visibility = 'public';
    const view = await loaded();
    const editor = await open(view, 'w3');
    // The editor opens private, whatever was shared before.
    expect(shareChip(editor).props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.changeText(field(editor), `${THIRD_NOTE} Edited.`);
    await save(view, 'w3');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w3')).toBeNull());
    expect(calls('save_note')).toHaveLength(0);
  });

  it('a failed watch write publishes nothing, and says so beside the draft', async () => {
    pg().broken.add('set_watch_details');
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'Keep this.');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w2');

    await waitFor(() => expect(calls('set_watch_details')).toHaveLength(1));
    expect(calls('save_note')).toHaveLength(0);
    expect(view.getByTestId('watch-editor-w2')).toBeTruthy();
    expect(field(within(view.getByTestId('watch-editor-w2'))).props.value).toBe('Keep this.');
  });

  it('a failed publish keeps the saved watch note, says it was not shared, and Save shares it once', async () => {
    pg().broken.add('save_note');
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'Second chance.');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w2');

    await waitFor(() => expect(failureText(view, 'w2')).toBeTruthy());
    expect(failureText(view, 'w2')?.props.children).toMatch(/saved on this watch/);
    expect(notes().w2).toBe('Second chance.');
    expect(field(within(view.getByTestId('watch-editor-w2'))).props.value).toBe(
      'Second chance.',
    );

    pg().broken.delete('save_note');
    pg().rpcCalls.length = 0;
    // SaveButton ignores a second press within 600 ms of the first (its double-tap guard);
    // a reader retrying after reading the message is well past it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 650)));
    await save(view, 'w2');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());
    // The watch was already saved: the retry writes only the review, once.
    expect(pg().rpcCalls.map((call) => call.name)).toEqual(['save_note']);
  });

  it('Share with no text asks for a note instead of publishing an empty review', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.press(shareChip(editor));
    await save(view, 'w2');
    await waitFor(() => expect(failureText(view, 'w2')).toBeTruthy());
    expect(pg().rpcCalls).toEqual([]);
  });

  it('Cancel drops the draft and the choices: nothing written, and the next open is private', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'Never mind.');
    await fireEvent.press(shareChip(editor));
    await fireEvent.press(
      within(view.getByTestId('watch-editor-w2')).getByRole('button', { name: 'Cancel' }),
    );
    expect(pg().rpcCalls).toEqual([]);
    const again = await open(view, 'w2');
    expect(field(again).props.value).toBe('');
    expect(shareChip(again).props.accessibilityState).toMatchObject({ checked: false });
  });
});
