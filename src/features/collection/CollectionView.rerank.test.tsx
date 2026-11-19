import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CollectionView, initialViewState, type CollectionRerank } from './CollectionView';
import { emptyFilters, type CollectionItem } from './filters';
import type { RerankNotice } from './rerank';
import type { RerankController } from './use-rerank';

/**
 * #318: what Collection offers a drag, and what it refuses. The controller is a stand-in,
 * so these assert the screen's decisions — which titles are rungs, which moves they offer,
 * what a refused long-press says — and `use-rerank.test.tsx` asserts what a move does.
 */

jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => ({
  ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
  measureParentSize: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureFirstChildLayout: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureItemLayout: () => ({ x: 0, y: 0, width: 100, height: 100 }),
}));

const film = (
  id: string,
  title: string,
  position: number | null,
  bucket: CollectionItem['bucket'],
  extra: Partial<CollectionItem> = {},
): CollectionItem => ({
  mediaItemId: id,
  title,
  seriesTitle: null,
  kind: 'movie',
  year: 2000 + (position ?? 0),
  posterPath: null,
  genres: position === 2 ? ['Drama'] : ['Comedy'],
  language: 'en',
  runtimeMinutes: 100,
  score: position == null ? null : 10 - position,
  position,
  category: position == null ? null : 'movies',
  bucket,
  watchedOn: null,
  addedAt: '2026-09-01T00:00:00Z',
  ...extra,
});

const FILMS = [
  film('m1', 'Alpha', 1, 'loved'),
  film('m2', 'Bravo', 2, 'loved'),
  film('m3', 'Charlie', 3, 'loved'),
  film('m4', 'Delta', 4, 'fine'),
  film('m5', 'Unranked one', null, null),
];

const controller = (notice: RerankNotice | null = null) =>
  ({
    busy: false,
    notice,
    move: jest.fn(),
    undo: jest.fn(),
    retry: jest.fn(),
    dismiss: jest.fn(),
    explain: jest.fn(),
  }) as unknown as RerankController & {
    move: jest.Mock;
    undo: jest.Mock;
    retry: jest.Mock;
    dismiss: jest.Mock;
    explain: jest.Mock;
  };

const draw = async ({
  items = FILMS,
  mode = 'poster' as const,
  rerank,
  state = {},
  onChange = jest.fn(),
  onPressItem = jest.fn(),
}: {
  items?: CollectionItem[];
  mode?: 'poster' | 'list';
  rerank?: CollectionRerank;
  state?: Partial<ReturnType<typeof initialViewState>>;
  onChange?: jest.Mock;
  onPressItem?: jest.Mock;
}) => {
  const view = await renderWithProviders(
    <CollectionView
      items={items}
      segment="watched"
      state={{ ...initialViewState(), mode, ...state }}
      onChange={onChange}
      onPressItem={onPressItem}
      empty={null}
      rerank={rerank}
    />,
  );
  /** The pressable that opens a title, by the title's name. */
  const titleButton = (name: string) =>
    view
      .getAllByRole('button')
      .find((node) => String(node.props.accessibilityLabel ?? '').split(', ').includes(name));
  return { ...view, titleButton, onChange, onPressItem };
};

const actionsOf = (node: { props: { accessibilityActions?: { name: string }[] } } | undefined) =>
  (node?.props.accessibilityActions ?? []).map((a) => a.name);

describe.each(['poster', 'list'] as const)('Movies in %s view, Rating highest first', (mode) => {
  it('offers the moves on each ranked title, across a category too, and nothing on an unranked one', async () => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton } = await draw({ mode, rerank });
    expect(actionsOf(titleButton('Alpha'))).toEqual(['moveDown', 'moveToBottom']);
    expect(actionsOf(titleButton('Bravo'))).toEqual(['moveUp', 'moveDown']);
    // Charlie is the last I liked it: one step down is into It was fine (founder, 2026-11-19).
    expect(actionsOf(titleButton('Charlie'))).toEqual(['moveUp', 'moveDown', 'moveToTop']);
    // Delta is alone in It was fine: up into I liked it, down into I didn't like it.
    expect(actionsOf(titleButton('Delta'))).toEqual(['moveUp', 'moveDown']);
    expect(actionsOf(titleButton('Unranked one'))).toEqual([]);
  });

  it('an accessibility step across the line names the category it moves into', async () => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton } = await draw({ mode, rerank });
    const delta = titleButton('Delta') as unknown as {
      props: { accessibilityActions: { name: string; label: string }[] };
    };
    expect(delta.props.accessibilityActions.map((a) => a.label)).toEqual([
      'Move up into I liked it',
      'Move down into I didn’t like it',
    ]);
    await fireEvent(titleButton('Delta') as never, 'accessibilityAction', {
      nativeEvent: { actionName: 'moveUp' },
    });
    const [, from, to, toBucket] = (rerank.controller.move as jest.Mock).mock.calls[0];
    expect([from, to, toBucket]).toEqual([3, 3, 'loved']);
  });

  it('an accessibility move is the same move as a drag', async () => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton } = await draw({ mode, rerank });
    await fireEvent(titleButton('Charlie') as never, 'accessibilityAction', {
      nativeEvent: { actionName: 'moveToTop' },
    });
    expect(rerank.controller.move).toHaveBeenCalledTimes(1);
    const [ladder, from, to] = (rerank.controller.move as jest.Mock).mock.calls[0];
    expect(ladder.rungs.map((r: { mediaItemId: string }) => r.mediaItemId)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect([from, to]).toEqual([2, 0]);
  });

  it('a tap still opens the title', async () => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton, onPressItem } = await draw({ mode, rerank });
    await fireEvent.press(titleButton('Bravo') as never);
    expect(onPressItem).toHaveBeenCalledWith('m2');
  });

  it('a long-press on an unranked title says to rank it first, and lifts nothing', async () => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton } = await draw({ mode, rerank });
    await fireEvent(titleButton('Unranked one') as never, 'longPress');
    expect(rerank.controller.explain).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ kind: 'openTitle' }), mediaItemId: 'm5' }),
    );
    expect(rerank.controller.move).not.toHaveBeenCalled();
  });
});

describe('a screen that is not the ranking is never mutated from a display index', () => {
  it.each([
    ['another sort', { sort: { axis: 'year' as const, direction: 'desc' as const } }],
    ['Rating lowest first', { sort: { axis: 'rating' as const, direction: 'asc' as const } }],
    ['a filter', { filters: { ...emptyFilters(), genres: ['Comedy'] } }],
  ])('%s: no move actions, and a long-press offers Sort by rating', async (_label, state) => {
    const rerank = { controller: controller(), pool: 'movies' as const };
    const { titleButton } = await draw({ rerank, state });
    expect(actionsOf(titleButton('Alpha'))).toEqual([]);
    await fireEvent(titleButton('Alpha') as never, 'longPress');
    expect(rerank.controller.explain).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ kind: 'sortByRating' }) }),
    );
  });

  it('Sort by rating restores the ranking order and clears the filters', async () => {
    const notice: RerankNotice = {
      message: 'To reorder, sort by Rating, highest first, with no filters.',
      action: { kind: 'sortByRating', label: 'Sort by rating' },
      tone: 'info',
    };
    const rerank = { controller: controller(notice), pool: 'movies' as const };
    const { getByTestId, onChange } = await draw({
      rerank,
      state: { sort: { axis: 'year', direction: 'desc' }, filters: { ...emptyFilters(), genres: ['Comedy'] } },
    });
    await fireEvent.press(getByTestId('rerank-notice-action'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: { axis: 'rating', direction: 'desc' }, filters: emptyFilters() }),
    );
  });

  it('without a rerank config (Watchlist, Unranked) a long-press does nothing', async () => {
    const { titleButton } = await draw({});
    expect(actionsOf(titleButton('Alpha'))).toEqual([]);
    await fireEvent(titleButton('Alpha') as never, 'longPress');
  });
});

describe('the TV wall: one poster per series, never dragged', () => {
  const SERIES = [
    film('s1', 'Explicit show', 1, 'loved', {
      kind: 'series',
      category: 'tv_shows',
      showScore: { sumTenths: 90, n: 1, source: 'explicit', rankedSeasonCount: 0 },
    }),
    film('s2', 'Average show', 2, 'loved', {
      kind: 'series',
      category: 'tv_shows',
      showScore: { sumTenths: 170, n: 2, source: 'average', rankedSeasonCount: 2 },
    }),
  ];

  it('offers no move, explains the pool editors on a long-press, and shows Reorder', async () => {
    const onReorderTv = jest.fn();
    const rerank = { controller: controller(), pool: null, onReorderTv };
    const { titleButton, getByTestId } = await draw({ items: SERIES, rerank });
    expect(actionsOf(titleButton('Explicit show'))).toEqual([]);
    expect(actionsOf(titleButton('Average show'))).toEqual([]);
    await fireEvent(titleButton('Average show') as never, 'longPress');
    expect(rerank.controller.explain).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ kind: 'reorderTv' }) }),
    );
    await fireEvent.press(getByTestId('collection-reorder-tv'));
    expect(onReorderTv).toHaveBeenCalled();
  });
});

describe('a TV pool editor', () => {
  const SEASONS = [
    film('a1', 'Season 1', 1, 'loved', { kind: 'season', seasonNumber: 1, seriesTitle: 'Show A', category: 'tv_seasons' }),
    film('a2', 'Season 2', 2, 'loved', { kind: 'season', seasonNumber: 2, seriesTitle: 'Show A', category: 'tv_seasons' }),
    film('b1', 'Season 1', 3, 'loved', { kind: 'season', seasonNumber: 1, seriesTitle: 'Show B', category: 'tv_seasons' }),
  ];

  it('draws the pool in ranking order with its ranks, a Done, and no filters', async () => {
    const onDone = jest.fn();
    const rerank = {
      controller: controller(),
      pool: 'tv_seasons' as const,
      editor: { title: 'Reorder TV seasons', onDone, footnote: 'Seasons only.' },
    };
    const view = await draw({
      items: [...SEASONS].reverse(),
      rerank,
      // The editor ignores the wall's own sort and filters.
      state: { sort: { axis: 'year', direction: 'asc' }, filters: { ...emptyFilters(), genres: ['Drama'] } },
    });
    expect(view.getByTestId('collection-editor-title').props.children).toBe('Reorder TV seasons');
    expect(view.getAllByTestId('poster-rank-badge', { includeHiddenElements: true }).map((b) => b.props.children.props.children)).toEqual([
      '#1',
      '#2',
      '#3',
    ]);
    expect(view.queryByTestId('collection-filter-sort')).toBeNull();
    expect(view.getByTestId('collection-editor-note').props.children).toBe('Seasons only.');
    const labels = view.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));
    expect(labels.filter((l) => l.startsWith('#'))).toHaveLength(3);
    await fireEvent.press(view.getByTestId('collection-editor-done'));
    expect(onDone).toHaveBeenCalled();
  });
});

describe('the notice bar', () => {
  it('Undo and Retry go to the controller, and the bar can be dismissed', async () => {
    const undo: RerankNotice = { message: 'Moved “Alpha” to #2 · 8.5', action: { kind: 'undo', label: 'Undo' }, tone: 'info' };
    const rerank = { controller: controller(undo), pool: 'movies' as const };
    const view = await draw({ rerank });
    expect(view.getByTestId('rerank-notice-message').props.children).toBe('Moved “Alpha” to #2 · 8.5');
    await fireEvent.press(view.getByTestId('rerank-notice-action'));
    expect(rerank.controller.undo).toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('rerank-notice-dismiss'));
    expect(rerank.controller.dismiss).toHaveBeenCalled();

    const retry: RerankNotice = { message: 'Couldn’t move', action: { kind: 'retry', label: 'Retry' }, tone: 'error' };
    const failed = { controller: controller(retry), pool: 'movies' as const };
    const again = await draw({ rerank: failed });
    await fireEvent.press(again.getByTestId('rerank-notice-action'));
    expect(failed.controller.retry).toHaveBeenCalled();
  });

  it('Open title opens the title the notice is about', async () => {
    const notice: RerankNotice = {
      message: '“Alpha” is in I liked it.',
      action: { kind: 'openTitle', label: 'Open title' },
      mediaItemId: 'm1',
      tone: 'info',
    };
    const view = await draw({ rerank: { controller: controller(notice), pool: 'movies' } });
    await fireEvent.press(view.getByTestId('rerank-notice-action'));
    expect(view.onPressItem).toHaveBeenCalledWith('m1');
  });
});
