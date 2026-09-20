import { fireEvent, waitFor, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { AddToListSheet } from './AddToListSheet';

/**
 * `Title ⋯ → Add to list…`.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THE PRD IS SPECIFIC ABOUT, AND WHY EACH IS TESTED
 *
 * **`+ New list` is pinned.** With twenty lists it would otherwise sit below the fold,
 * and creating-a-list-while-adding-a-title is the highest-value path in this flow. The
 * test asserts it is outside the scroller rather than that it is visible, because
 * "visible" is true of a below-the-fold control in a test renderer.
 *
 * **A row toggles both ways.** One control covers add, add-to-several and remove, which
 * is why there is no second mode and no delete affordance.
 *
 * **The confirmation names the destination, and offers Undo.** Because the sheet stays
 * open and the rows keep scrolling, this toast is the *only* feedback that the list hit
 * was the one intended. A bare "Added" under twenty names says nothing.
 *
 * **With no lists, it skips straight to New list** with the title preselected — and
 * deciding that from a settled read rather than from an empty array, or an account
 * mid-fetch would be dropped into a form it did not ask for.
 */

type Row = {
  id: string;
  title: string;
  item_count: number;
  visibility: 'private' | 'link' | 'public';
  contains: boolean;
  updated_at: string;
};

let mockRows: Row[] = [];
const mockRpc = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockRpc(fn, args);
      if (fn === 'my_lists_for_title') return Promise.resolve({ data: mockRows, error: null });
      if (fn === 'add_list_item') {
        return Promise.resolve({ data: { status: 'added', count_after: 3 }, error: null });
      }
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    },
  },
  startSessionRefresh: () => () => {},
}));

const mockTracked: { name: string; props?: Record<string, unknown> }[] = [];
jest.mock('@/lib/analytics', () => ({
  track: (event: { name: string; props?: Record<string, unknown> }) => mockTracked.push(event),
}));

const list = (id: string, title: string, contains = false): Row => ({
  id,
  title,
  item_count: 8,
  visibility: 'private',
  contains,
  updated_at: '2026-09-12T10:00:00Z',
});

beforeEach(() => {
  mockRows = [];
  mockRpc.mockClear();
  mockTracked.length = 0;
});

const open = (onClose = () => {}) =>
  renderWithProviders(
    <AddToListSheet
      mediaItemId="film-1"
      kind="movie"
      name="Past Lives"
      profilePrivate={false}
      onClose={onClose}
    />,
  );

describe('with lists', () => {
  beforeEach(() => {
    mockRows = [list('a', 'Best breakup movies', true), list('b', 'Movies for Dad')];
  });

  it('heads itself with the title being added', async () => {
    const view = await open();
    await waitFor(() => view.getByText(/Past Lives/));
  });

  it('keeps + New list out of the scroller, so twenty lists cannot bury it', async () => {
    const view = await open();

    await waitFor(() => view.getByText('Movies for Dad'));
    const pinned = view.getByRole('button', { name: 'New list' });
    // Walk up from the control: if it were inside the list, a FlatList would be one of
    // its ancestors. Asserting on the structure rather than on visibility is the only
    // way "pinned" is expressible here.
    let node = pinned.parent;
    let insideAList = false;
    while (node) {
      if (String(node.type).includes('FlatList') || node.props?.data !== undefined) {
        insideAList = true;
        break;
      }
      node = node.parent;
    }
    expect(insideAList).toBe(false);
  });

  it('shows membership as a checkbox in both states', async () => {
    const view = await open();

    await waitFor(() => view.getByText('Best breakup movies'));
    const on = view.getByLabelText('Best breakup movies. 8 titles');
    const off = view.getByLabelText('Movies for Dad. 8 titles');
    expect(on.props.accessibilityState.checked).toBe(true);
    expect(off.props.accessibilityState.checked).toBe(false);
  });

  it('adds on a tap, and names the destination with an Undo', async () => {
    const view = await open();

    await waitFor(() => view.getByText('Movies for Dad'));
    await fireEvent.press(view.getByLabelText('Movies for Dad. 8 titles'));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(
      'add_list_item',
      expect.objectContaining({ p_list_id: 'b', p_media_item_id: 'film-1' }),
    ));
    // Scoped to the toast: the list's name appears on its row as well, so matching on
    // the text alone finds two elements and says nothing about which one named the
    // destination. Naming it is the whole point of this confirmation.
    const toast = await waitFor(() => view.getByTestId('add-to-list-toast'));
    within(toast).getByText(/Movies for Dad/);
    within(toast).getByRole('button', { name: 'Undo' });

    expect(mockTracked).toContainEqual({
      name: 'list_item_added',
      props: { surface: 'title_menu', media_kind: 'movie', count_after: 3 },
    });
  });

  it('removes the title again on Undo, as a second call rather than a replay', async () => {
    const view = await open();

    await waitFor(() => view.getByText('Movies for Dad'));
    await fireEvent.press(view.getByLabelText('Movies for Dad. 8 titles'));
    await waitFor(() => view.getByRole('button', { name: 'Undo' }));
    await fireEvent.press(view.getByRole('button', { name: 'Undo' }));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'remove_list_item',
        expect.objectContaining({ p_list_id: 'b', p_media_item_id: 'film-1' }),
      ),
    );

    // **Undo is a new intent rather than a retry of the add**, so it issues its own
    // operation id. That the two ids differ cannot be asserted from here —
    // `newOperationId` is expo-crypto's and has no native module under Jest, so every
    // id comes back undefined. What is pinned instead is that Undo is a second,
    // separate call rather than a replay of the first: a replay would be answered
    // `already_applied` and would remove nothing, which is the failure this shape
    // exists to avoid.
    expect(mockRpc.mock.calls.filter(([fn]) => fn === 'add_list_item')).toHaveLength(1);
    expect(mockRpc.mock.calls.filter(([fn]) => fn === 'remove_list_item')).toHaveLength(1);
  });

  it('toggling a row off removes the title, which is the same control both ways', async () => {
    const view = await open();

    await waitFor(() => view.getByText('Best breakup movies'));
    await fireEvent.press(view.getByLabelText('Best breakup movies. 8 titles'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'remove_list_item',
        expect.objectContaining({ p_list_id: 'a' }),
      ),
    );
    // A removal is not an add and emits nothing.
    expect(mockTracked.filter((event) => event.name === 'list_item_added')).toHaveLength(0);
  });

  it('stays open after a tap', async () => {
    const onClose = jest.fn();
    const view = await open(onClose);

    await waitFor(() => view.getByText('Movies for Dad'));
    await fireEvent.press(view.getByLabelText('Movies for Dad. 8 titles'));

    await waitFor(() => view.getByRole('button', { name: 'Undo' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('with no lists at all', () => {
  it('skips straight to New list with the title preselected', async () => {
    mockRows = [];
    const view = await open();

    // §G: ⋯ → Add to list… on an account with no lists opens the create sheet directly.
    await waitFor(() => view.getByText('New list'));
    view.getByText('Will add: Past Lives');
  });

  it('waits for the read to settle rather than acting on an empty array', async () => {
    // An in-flight read has zero rows too, and opening the create sheet over a loading
    // state would put somebody in a form they did not ask for.
    mockRows = [list('a', 'Best breakup movies')];
    const view = await open();

    await waitFor(() => view.getByText('Best breakup movies'));
    expect(view.queryByText('Will add: Past Lives')).toBeNull();
  });
});
