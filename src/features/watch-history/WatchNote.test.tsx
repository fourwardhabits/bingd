import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { Postgrest } from '@/test-utils/postgrest';
import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

// Imported from `app/` by path, as the other Watch History suites do: a test file inside
// `app/` would be picked up by expo-router's require.context (app-directory.test.ts).
import WatchHistoryScreen from '../../../app/title/[id]/history';

/**
 * **FU1113-A — a watch's own note** (P0, 2026-11-13).
 *
 * The card draws `watch_events.note`; *Edit watch → Note* used to edit `user_media.note`,
 * the title's review, through `save_note`. So a watch with its own note opened on a blank
 * field (or on the review), and typing there rewrote — and could publish — the review.
 *
 * This suite runs the real screen, the real `useWatchHistory` read and the real writers
 * against the PostgREST stand-in, with `set_watch_details` applied to the stand-in's
 * `watch_events` the way the function does (owner check and idempotency are the database
 * suite's: `supabase/tests/watch-details.test.mjs`). So "the card shows it after a restart"
 * is a fresh QueryClient reading the stored row back, not a mock returning what the test
 * told it to.
 *
 * The fixture mirrors the founder's QA: one title watched three times, the third (Oct 24)
 * with a companion and its own note, and a public, spoiler-flagged title review that no
 * watch edit may touch.
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
    data: { id: 'film-1', title: 'Top Gun: Maverick', year: 2022, posterUri: null, kind: 'movie' },
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
jest.mock('@/features/collection/use-log-state', () => ({
  useLogState: () => ({
    data: {
      note: 'The title review.',
      noteVisibility: 'public',
      noteSpoilers: true,
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
    'friend-1': { id: 'friend-1', username: 'qa_b', display_name: 'QA account B', avatar_path: null },
  };
  const rpc = (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'set_watch_details' && !client.broken.has(name)) {
      const rows = client.tables.watch_events as Record<string, unknown>[];
      const index = rows.findIndex((row) => row.id === args.p_watch_event_id);
      if (index < 0) {
        client.rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: { code: 'P0002', message: 'no such watch' } });
      }
      const note = typeof args.p_note === 'string' && args.p_note.trim() ? args.p_note.trim() : null;
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

/** One watch with no note. */
const seedOneWatch = () => {
  seedThreeWatches();
  pg().tables.watch_events = [eventRow('w1', '2026-10-24')];
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
  fireEvent.press(within(view.getByTestId(`watch-editor-${id}`)).getByRole('button', { name: 'Save' }));

const loaded = async () => {
  const view = await renderWithProviders(<WatchHistoryScreen />);
  await waitFor(() => expect(view.getByTestId('watch-row-w1')).toBeTruthy());
  return view;
};

beforeEach(() => {
  const db = pg();
  for (const key of Object.keys(db.tables)) delete db.tables[key];
  db.rpcCalls.length = 0;
  db.broken.clear();
  seedThreeWatches();
});

describe('Edit watch → Note edits this watch’s own note', () => {
  it('A1: opens prepopulated with exactly the note the card shows', async () => {
    const view = await loaded();
    expect(view.getByTestId('watch-note-w3').props.children).toBe(THIRD_NOTE);

    const editor = await open(view, 'w3');
    expect(field(editor).props.value).toBe(THIRD_NOTE);
    // Never the title's review, and never another watch's note.
    expect(editor.queryByDisplayValue('The title review.')).toBeNull();
    expect(editor.queryByDisplayValue('First time, opening weekend.')).toBeNull();
  });

  it('A2/A4/A10: saving writes only that watch, through set_watch_details, and nothing else', async () => {
    const view = await loaded();
    const scoresBefore = view.getAllByLabelText(/out of 10/).map((node) => node.props.accessibilityLabel);
    const editor = await open(view, 'w3');
    await fireEvent.changeText(field(editor), '  Fourth row, IMAX, still lands.  ');
    await save(view, 'w3');

    await waitFor(() => expect(view.queryByTestId('watch-editor-w3')).toBeNull());
    // One call, to this watch, with its own operation id (a UUID on a device; the test
    // runtime's `expo-crypto` stand-in returns none, so only its presence is checked).
    expect(pg().rpcCalls).toHaveLength(1);
    expect(pg().rpcCalls[0]?.name).toBe('set_watch_details');
    expect(Object.keys(pg().rpcCalls[0]!.args).sort()).toEqual([
      'p_companion_ids',
      'p_note',
      'p_operation_id',
      'p_watch_event_id',
    ]);
    expect(pg().rpcCalls[0]?.args).toEqual(
      expect.objectContaining({
        p_watch_event_id: 'w3',
        p_note: 'Fourth row, IMAX, still lands.',
        // Companions untouched: null leaves them.
        p_companion_ids: null,
      }),
    );
    // A4: no save_note, so the review, its sharing and its spoiler flag are as they were.
    expect(pg().rpcCalls.map((call) => call.name)).not.toContain('save_note');
    expect(pg().tables.user_media).toEqual([REVIEW]);
    // A2: only w3's row changed; no row added anywhere.
    expect(notes()).toEqual({
      w1: 'First time, opening weekend.',
      w2: null,
      w3: 'Fourth row, IMAX, still lands.',
    });
    expect(pg().tables.watch_events).toHaveLength(3);
    expect(pg().tables.feed_events).toHaveLength(1);
    expect(pg().tables.ranking_placements).toHaveLength(1);

    await waitFor(() =>
      expect(view.getByTestId('watch-note-w3').props.children).toBe('Fourth row, IMAX, still lands.'),
    );
    expect(view.getByTestId('watch-with-w3').props.children).toBe('With QA account B');
    // A10: the card's scores are where they were; no ranking function ran.
    expect(view.getAllByLabelText(/out of 10/).map((node) => node.props.accessibilityLabel)).toEqual(
      scoresBefore,
    );
  });

  it('A3: several watches of one title keep independent notes through several edits', async () => {
    const view = await loaded();
    let editor = await open(view, 'w1');
    expect(field(editor).props.value).toBe('First time, opening weekend.');
    await fireEvent.changeText(field(editor), 'First time, with popcorn.');
    await save(view, 'w1');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w1')).toBeNull());

    editor = await open(view, 'w2');
    expect(field(editor).props.value).toBe('');
    await fireEvent.changeText(field(editor), 'Second time, on a plane.');
    await save(view, 'w2');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());

    expect(notes()).toEqual({
      w1: 'First time, with popcorn.',
      w2: 'Second time, on a plane.',
      w3: THIRD_NOTE,
    });
    editor = await open(view, 'w3');
    expect(field(editor).props.value).toBe(THIRD_NOTE);
    expect(pg().rpcCalls.map((call) => call.args.p_watch_event_id)).toEqual(['w1', 'w2']);
  });

  it('A5: Cancel keeps the saved note and writes nothing', async () => {
    const view = await loaded();
    const editor = await open(view, 'w3');
    await fireEvent.changeText(field(editor), 'Something I did not mean.');
    await fireEvent.press(editor.getByRole('button', { name: 'Cancel' }));

    expect(view.queryByTestId('watch-editor-w3')).toBeNull();
    expect(view.getByTestId('watch-note-w3').props.children).toBe(THIRD_NOTE);
    expect(pg().rpcCalls).toEqual([]);
    expect(notes().w3).toBe(THIRD_NOTE);

    // Reopened, it shows the saved note, not the discarded draft.
    const again = await open(view, 'w3');
    expect(field(again).props.value).toBe(THIRD_NOTE);
  });

  it('A6: a failed save keeps the editor open with the draft, says why, and leaves the card', async () => {
    pg().broken.add('set_watch_details');
    const view = await loaded();
    const editor = await open(view, 'w3');
    await fireEvent.changeText(field(editor), 'A draft worth keeping.');
    await save(view, 'w3');

    await waitFor(() => expect(view.getByTestId('watch-editor-error-w3')).toBeTruthy());
    expect(view.getByTestId('watch-editor-w3')).toBeTruthy();
    expect(field(within(view.getByTestId('watch-editor-w3'))).props.value).toBe('A draft worth keeping.');
    expect(view.getByTestId('watch-note-w3').props.children).toBe(THIRD_NOTE);
    expect(notes().w3).toBe(THIRD_NOTE);
    // No success state: Save is a plain Save again, ready for another try.
    expect(within(view.getByTestId('watch-editor-w3')).getByRole('button', { name: 'Save' })).not.toBeDisabled();

    // The retry lands, and only then does the editor close. (`SaveButton` ignores a second
    // tap inside its repeat guard, so the clock moves on as a person's would.)
    pg().broken.delete('set_watch_details');
    const later = Date.now() + 5_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
    await save(view, 'w3');
    clock.mockRestore();
    await waitFor(() => expect(view.queryByTestId('watch-editor-w3')).toBeNull());
    expect(notes().w3).toBe('A draft worth keeping.');
  });

  it('A7: a single watch with no note opens empty, and saving creates the note on it', async () => {
    seedOneWatch();
    const view = await loaded();
    expect(view.queryByTestId('watch-note-w1')).toBeNull();
    const editor = await open(view, 'w1');
    expect(field(editor).props.value).toBe('');
    await fireEvent.changeText(field(editor), 'Only time so far.');
    await save(view, 'w1');

    await waitFor(() => expect(view.getByTestId('watch-note-w1').props.children).toBe('Only time so far.'));
    expect(notes()).toEqual({ w1: 'Only time so far.' });
    expect(pg().tables.user_media).toEqual([REVIEW]);
  });

  it('A8: clearing a note clears only that watch’s note', async () => {
    const view = await loaded();
    const editor = await open(view, 'w3');
    await fireEvent.changeText(field(editor), '   ');
    await save(view, 'w3');

    await waitFor(() => expect(view.queryByTestId('watch-note-w3')).toBeNull());
    expect(pg().rpcCalls[0]?.args.p_note).toBeNull();
    expect(notes()).toEqual({ w1: 'First time, opening weekend.', w2: null, w3: null });
    expect(view.getByTestId('watch-note-w1').props.children).toBe('First time, opening weekend.');
    expect(pg().tables.user_media).toEqual([REVIEW]);
  });

  it('A9: after a restart (a fresh QueryClient) the card and the editor show the saved note', async () => {
    const first = await loaded();
    const editor = await open(first, 'w3');
    await fireEvent.changeText(field(editor), 'Saved before the restart.');
    await save(first, 'w3');
    await waitFor(() => expect(first.queryByTestId('watch-editor-w3')).toBeNull());
    await first.unmount();

    const second = await loaded();
    await waitFor(() =>
      expect(second.getByTestId('watch-note-w3').props.children).toBe('Saved before the restart.'),
    );
    const reopened = await open(second, 'w3');
    expect(field(reopened).props.value).toBe('Saved before the restart.');
    expect(second.getByTestId('watch-note-w1').props.children).toBe('First time, opening weekend.');
  });

  it('is private: no Share or Spoilers on a watch note, only the line that says so', async () => {
    const view = await loaded();
    const editor = await open(view, 'w3');
    expect(editor.getByTestId('watch-note-private-hint').props.children).toBe('Only you see this note');
    expect(editor.queryByLabelText('Share this note as a public review')).toBeNull();
    expect(editor.queryByLabelText('This note contains spoilers')).toBeNull();
    // The Note row counts this watch's words, never "Shared", which is the review's state.
    expect(editor.queryByText(/^Shared/)).toBeNull();
  });

  it('stops typing at the 1,000-character limit the column holds', async () => {
    const view = await loaded();
    const editor = await open(view, 'w2');
    await fireEvent.changeText(field(editor), 'x'.repeat(1200));
    expect(field(editor).props.value).toHaveLength(1000);
    expect(editor.getByTestId('watch-note-private-hint').props.children).toBe(
      'Only you see this note · 1000/1000',
    );
    await save(view, 'w2');
    await waitFor(() => expect(view.queryByTestId('watch-editor-w2')).toBeNull());
    expect(notes().w2).toHaveLength(1000);
  });

  it('sends the companions only when they changed, with this watch’s note alongside', async () => {
    const view = await loaded();
    await fireEvent.press(view.getByTestId('watch-edit-w3'));
    const editor = within(view.getByTestId('watch-editor-w3'));
    await fireEvent.press(editor.getByLabelText(/^Who I watched with/));
    await fireEvent.press(editor.getByRole('checkbox', { name: 'QA account B' }));
    await save(view, 'w3');

    await waitFor(() => expect(view.queryByTestId('watch-editor-w3')).toBeNull());
    expect(pg().rpcCalls).toEqual([
      expect.objectContaining({
        name: 'set_watch_details',
        args: expect.objectContaining({
          p_watch_event_id: 'w3',
          // The saved note travels unchanged, so removing a companion never clears it.
          p_note: THIRD_NOTE,
          p_companion_ids: [],
        }),
      }),
    ]);
    expect(notes().w3).toBe(THIRD_NOTE);
  });
});

/**
 * **The card's hierarchy** (FU1113-A): the date top-left, who it was watched with straight
 * under it, the score top-right and top-aligned with the date, this watch's note below the
 * metadata, and Edit watch and Rerank kept.
 */
describe('A11: the card reads date, companions, score, note, then its acts', () => {
  const ids = (node: unknown) => {
    const out: string[] = [];
    const walk = (n: { props?: { testID?: string }; children?: unknown[] }) => {
      if (n.props?.testID) out.push(n.props.testID);
      for (const child of n.children ?? []) if (child && typeof child === 'object') walk(child as never);
    };
    walk(node as never);
    return out;
  };

  it('puts the date top-left with the companions directly under it, and the score top-right', async () => {
    const view = await loaded();
    const main = view.getByTestId('watch-main-w3');
    const [lead, right] = main.children as unknown as { props: { testID?: string } }[];
    expect(lead?.props.testID).toBe('watch-lead-w3');
    expect(right?.props.testID).toBe('watch-score-w3');
    // Top-aligned, not centred on the block.
    expect(StyleSheet.flatten(main.props.style).alignItems).toBe('flex-start');

    const leadKids = (view.getByTestId('watch-lead-w3').children as unknown as {
      props: { testID?: string };
    }[]).map((child) => child.props.testID);
    expect(leadKids.slice(0, 2)).toEqual(['watch-date-w3', 'watch-with-w3']);
    // At most `space[1]` between the date and the metadata under it.
    expect(StyleSheet.flatten(view.getByTestId('watch-lead-w3').props.style).gap).toBeLessThanOrEqual(
      theme.space[1],
    );
  });

  it('draws the note below the metadata, then Edit watch and Rerank', async () => {
    const view = await loaded();
    const order = ids(view.getByTestId('watch-row-w3'));
    const at = (id: string) => order.indexOf(id);
    expect(at('watch-date-w3')).toBeLessThan(at('watch-with-w3'));
    expect(at('watch-with-w3')).toBeLessThan(at('watch-note-w3'));
    expect(at('watch-score-w3')).toBeLessThan(at('watch-note-w3'));
    expect(at('watch-note-w3')).toBeLessThan(at('watch-edit-w3'));
    expect(at('watch-edit-w3')).toBeLessThan(at('watch-rerank-w3'));
    expect(
      StyleSheet.flatten(view.getByTestId('watch-note-block-w3').props.style).paddingTop,
    ).toBe(theme.space[2]);
    expect(within(view.getByTestId('watch-edit-w3')).getByText('Edit watch')).toBeTruthy();
    expect(within(view.getByTestId('watch-rerank-w3')).getByText('Rerank')).toBeTruthy();
  });

  it('keeps the metadata quiet and the date the anchor', async () => {
    const view = await loaded();
    const tone = (id: string) => StyleSheet.flatten(view.getByTestId(id).props.style).color;
    expect(tone('watch-with-w3')).toBe(theme.text.secondary);
    expect(tone('watch-note-w3')).toBe(theme.text.secondary);
    expect(tone('watch-date-w3')).toBe(theme.text.primary);
  });
});
