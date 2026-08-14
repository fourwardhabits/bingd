import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { LogSheet, type LoggableTitle, type LogSheetProps } from './LogSheet';

const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

let issued = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: () => `operation-${(issued += 1)}`,
}));

const filmA: LoggableTitle = {
  id: 'film-a',
  title: 'Film A',
  year: 2010,
  posterUri: null,
  kind: 'movie',
};

const filmB: LoggableTitle = { ...filmA, id: 'film-b', title: 'Film B' };

const LOGGED = 'Logged. It is in your collection whether or not you rank it.';
const RANKED = 'You have already ranked this. Change it from your collection.';

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
});

const callsTo = (fn: string) => mockRpc.mock.calls.filter(([name]) => name === fn);

const open = async (title: LoggableTitle | null, props: Partial<LogSheetProps> = {}) => {
  const view = await renderWithProviders(
    <LogSheet title={title} onClose={() => {}} {...props} />,
  );

  return {
    ...view,
    show: (next: LoggableTitle | null) =>
      view.rerender(<LogSheet title={next} onClose={() => {}} {...props} />),
    bucket: (label: string) => view.getByLabelText(label),
    note: () => view.getByLabelText('Private note'),
    find: () => view.getByRole('button', { name: 'Find where it lands' }),
  };
};

/**
 * The bucket sheet (screens.md §4).
 *
 * The case worth the most attention is what happens between two titles. The parent swaps
 * this component's `title` prop, so state that survives the swap shows one film's answer
 * over another film's name — and, because a note saves on blur, writes one film's private
 * note against the other.
 */
describe('a second title', () => {
  it('does not inherit the first title\u2019s bucket, message or note', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.getByText(LOGGED)).toBeTruthy());
    await fireEvent.changeText(sheet.note(), 'a private note about Film A');

    await sheet.show(filmB);

    expect(sheet.getByText('Film B')).toBeTruthy();
    expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(false);
    expect(sheet.queryByText(LOGGED)).toBeNull();
    expect(sheet.note().props.value).toBe('');
  });

  it('does not file the first title\u2019s note against the second', async () => {
    const sheet = await open(filmA);

    await fireEvent.changeText(sheet.note(), 'a private note about Film A');
    await sheet.show(filmB);

    // Blur is what saves a note, and it is reached by tapping anywhere — including the
    // buckets of the film now on screen.
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(0));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('starts clean when the same title is opened again', async () => {
    // The parent clears its state on close, so this arrives as title -> null -> title. A
    // key on the title cannot help here; only unmounting can.
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(sheet.getByText(LOGGED)).toBeTruthy());

    await sheet.show(null);
    await sheet.show(filmA);

    expect(sheet.bucket('It was fine').props.accessibilityState.selected).toBe(false);
    expect(sheet.queryByText(LOGGED)).toBeNull();
  });
});

describe('choosing a bucket', () => {
  it('sends the bucket for the title on screen and says it is logged', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Not for me'));

    await waitFor(() => expect(sheet.getByText(LOGGED)).toBeTruthy());
    expect(mockRpc).toHaveBeenCalledWith('set_bucket', {
      p_operation_id: 'operation-1',
      p_media_item_id: 'film-a',
      p_bucket: 'not_for_me',
    });
  });

  it('carries a new operation id each time, so a change of mind is not read as a retry', async () => {
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.getByText(LOGGED)).toBeTruthy());
    await fireEvent.press(sheet.bucket('It was fine'));
    await waitFor(() => expect(callsTo('set_bucket')).toHaveLength(2));

    const [first, second] = callsTo('set_bucket').map(([, args]) => args.p_operation_id);
    expect(first).not.toBe(second);
  });

  it('reports a refusal as a refusal rather than as a save', async () => {
    // 55000 from _assert_unranked: the bucket belongs to the ranking now. Showing "Logged."
    // here would tell the user something happened that did not.
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'title is ranked' } });
    const sheet = await open(filmA);

    await fireEvent.press(sheet.bucket('Loved it'));

    await waitFor(() => expect(sheet.getByText(RANKED)).toBeTruthy());
    expect(sheet.queryByText(LOGGED)).toBeNull();
    expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(false);
  });

  it('does not start comparisons on its own (PRD \u00a711)', async () => {
    const onFindWhereItLands = jest.fn();
    const sheet = await open(filmA, { onFindWhereItLands });

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.getByText(LOGGED)).toBeTruthy());

    expect(onFindWhereItLands).not.toHaveBeenCalled();
    expect(callsTo('rank_start')).toHaveLength(0);
  });
});

describe('find where it lands', () => {
  it('waits for a saved bucket, because rank_start would otherwise write one', async () => {
    // rank_start upserts user_media with whatever bucket it is handed, so an enabled button
    // before a save is a silent log in a bucket the user never chose for this title.
    const onFindWhereItLands = jest.fn();
    const sheet = await open(filmA, { onFindWhereItLands });

    expect(sheet.find().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(sheet.find());
    expect(onFindWhereItLands).not.toHaveBeenCalled();

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.find().props.accessibilityState.disabled).toBe(false));

    await fireEvent.press(sheet.find());
    expect(onFindWhereItLands).toHaveBeenCalledWith('loved');
  });

  it('stays shut while the save is still in flight', async () => {
    // A chosen bucket is not a saved bucket. rank_start would upsert user_media with this
    // bucket while set_bucket is still on its way, and whichever landed second would win.
    mockRpc.mockReturnValue(new Promise(() => {}));
    const onFindWhereItLands = jest.fn();
    const sheet = await open(filmA, { onFindWhereItLands });

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.getByText('Saving…')).toBeTruthy());

    expect(sheet.bucket('Loved it').props.accessibilityState.selected).toBe(true);
    expect(sheet.find().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(sheet.find());
    expect(onFindWhereItLands).not.toHaveBeenCalled();
  });

  it('stays shut after a refusal', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'title is ranked' } });
    const sheet = await open(filmA, { onFindWhereItLands: jest.fn() });

    await fireEvent.press(sheet.bucket('Loved it'));
    await waitFor(() => expect(sheet.getByText(RANKED)).toBeTruthy());

    expect(sheet.find().props.accessibilityState.disabled).toBe(true);
  });
});

describe('the private note', () => {
  it('saves against the title on screen, with today\u2019s date', async () => {
    const sheet = await open(filmA);

    await fireEvent.changeText(sheet.note(), 'better than I expected');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(1));
    const [, args] = callsTo('log_watched')[0];
    expect(args.p_media_item_id).toBe('film-a');
    expect(args.p_note).toBe('better than I expected');
    expect(args.p_watched_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not write an empty note when the field is merely touched', async () => {
    const sheet = await open(filmA);

    await fireEvent(sheet.note(), 'blur');
    await fireEvent.changeText(sheet.note(), '   ');
    await fireEvent(sheet.note(), 'blur');

    await waitFor(() => expect(callsTo('log_watched')).toHaveLength(0));
  });
});
