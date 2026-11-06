import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import {
  CollectionView,
  filterSortStatus,
  initialViewState,
  type CollectionViewState,
} from './CollectionView';
import { COLLECTION_SORT_AXES, sortAxesFor, type CollectionItem, type CollectionSegment } from './filters';

/**
 * **Collection's one quiet toolbar** (founder, UI cohesion pass, 2026-11-06): Filter & Sort
 * on the left, Grid / List on the right, the count under them with `My lists ›` beside it.
 *
 * Filter & Sort opens one sheet with two parts. Sort applies on the press, as the old sort
 * menu did, and stays open so a second press reverses; the filters keep their Apply and
 * Clear all, because they always waited for Apply.
 */

const item = (n: number, overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Film ${String(n).padStart(2, '0')}`,
  seriesTitle: null,
  kind: 'movie',
  year: 2000 + n,
  posterPath: null,
  genres: n % 2 === 0 ? ['Drama'] : ['Comedy'],
  language: 'en',
  runtimeMinutes: 90,
  score: 10 - n,
  bucket: 'loved',
  watchedOn: null,
  addedAt: new Date(Date.UTC(2020, 0, n)).toISOString(),
  ...overrides,
});

const ITEMS = [item(1), item(2), item(3), item(4)];

/** The view with its state held, as Collection holds it. */
function Harness({
  items = ITEMS,
  segment = 'watched',
  initial,
  onState,
}: {
  items?: CollectionItem[];
  segment?: CollectionSegment;
  initial?: Partial<CollectionViewState>;
  onState?: (state: CollectionViewState) => void;
}) {
  const [state, setState] = useState<CollectionViewState>({ ...initialViewState(), mode: 'list', ...initial });
  return (
    <CollectionView
      items={items}
      segment={segment}
      state={state}
      onChange={(next) => {
        onState?.(next);
        setState(next);
      }}
      onPressItem={() => {}}
      empty={<Text>Empty here</Text>}
      countAccessory={<Text>My lists link</Text>}
    />
  );
}

const draw = (props: React.ComponentProps<typeof Harness> = {}) =>
  renderWithProviders(<Harness {...props} />);

/** What is behind an open sheet, which the screen reader (and so the query) is kept from. */
const BEHIND = { includeHiddenElements: true } as const;


describe('the toolbar', () => {
  it('is one Filter & Sort action and a two-glyph view control, nothing else', async () => {
    const view = await draw();
    const bar = view.getByTestId('collection-toolbar');

    expect(within(bar).getByText('Filter & Sort')).toBeTruthy();
    expect(within(bar).getAllByRole('radio').map((cell) => cell.props.accessibilityLabel)).toEqual([
      'Poster view',
      'List view',
    ]);
    // No separate Filters chip and no separate Sort chip any more.
    expect(view.queryByText('Filters')).toBeNull();
    expect(within(bar).getAllByRole('button')).toHaveLength(1);
  });

  it('says the order in force beside the action, and the filter count once there is one', async () => {
    const view = await draw();
    expect(view.getByTestId('collection-filter-sort-status').props.children).toBe('Rating ↓');
    expect(view.getByTestId('collection-filter-sort').props.accessibilityLabel).toBe(
      'Filter and sort. Sorted by Rating, highest first. No filters',
    );
  });

  it('draws the view glyphs bare, the chosen one in Maroon, each a 44pt target', async () => {
    const view = await draw();
    for (const name of ['Poster view', 'List view']) {
      const cell = view.getByRole('radio', { name });
      const style = StyleSheet.flatten(
        typeof cell.props.style === 'function' ? cell.props.style({ pressed: false }) : cell.props.style,
      );
      expect(style.width).toBe(44);
      expect(style.height).toBe(44);
      expect(style.backgroundColor).toBeUndefined();
    }
    expect(view.getByRole('radio', { name: 'List view' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('switches Grid and List and keeps the choice', async () => {
    const seen: CollectionViewState[] = [];
    const view = await draw({ onState: (state) => seen.push(state) });
    await fireEvent.press(view.getByRole('radio', { name: 'Poster view' }));
    expect(seen.at(-1)?.mode).toBe('poster');
    expect(view.getByRole('radio', { name: 'Poster view' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('puts the count and the lists link on one row', async () => {
    const view = await draw();
    expect(view.getByTestId('collection-count').props.children).toBe('4 titles');
    expect(view.getByText('My lists link')).toBeTruthy();
  });

  it('keeps the lists link above an empty collection', async () => {
    const view = await draw({ items: [] });
    expect(view.getByText('Empty here')).toBeTruthy();
    expect(view.getByText('My lists link')).toBeTruthy();
  });
});

describe('the Filter & Sort sheet', () => {
  const openSheet = async (props: React.ComponentProps<typeof Harness> = {}) => {
    const view = await draw(props);
    await fireEvent.press(view.getByTestId('collection-filter-sort'));
    await waitFor(() => expect(view.getByTestId('collection-sort-section')).toBeTruthy());
    return view;
  };

  it('has a Sort part and a Filter part, Sort first', async () => {
    const view = await openSheet();
    const headers = view.getAllByRole('header').map((node) => node.props.children);
    expect(headers.indexOf('Sort')).toBeGreaterThanOrEqual(0);
    expect(headers.indexOf('Filter')).toBeGreaterThan(headers.indexOf('Sort'));
    expect(view.getByLabelText('Filter and sort your collection')).toBeTruthy();
  });

  it('offers the sort choices this segment has, Rating first on Watched', async () => {
    const watchedView = await openSheet();
    const offered = within(watchedView.getByTestId('collection-sort-section'))
      .getAllByRole('radio')
      .map((radio) => radio.props.accessibilityLabel.split(',')[0]);
    expect(offered).toEqual(sortAxesFor('watched').map((spec) => spec.label));
  });

  it('offers no Rating on the Watchlist, which has no scores', async () => {
    const listView = await openSheet({ segment: 'watchlist', items: ITEMS.map((one) => ({ ...one, score: null })) });
    const labels = within(listView.getByTestId('collection-sort-section'))
      .getAllByRole('radio')
      .map((radio) => radio.props.accessibilityLabel.split(',')[0]);
    expect(labels).not.toContain(COLLECTION_SORT_AXES.rating.label);
    expect(labels[0]).toBe(COLLECTION_SORT_AXES.added.label);
  });

  it('applies a sort on the press, stays open, and reverses on a second press', async () => {
    const seen: CollectionViewState[] = [];
    const view = await openSheet({ onState: (state) => seen.push(state) });
    const section = () => view.getByTestId('collection-sort-section');

    await fireEvent.press(within(section()).getByRole('radio', { name: /^Title/ }));
    // Applied at once, with the sheet still up.
    expect(view.getByTestId('collection-sort-section')).toBeTruthy();
    expect(view.getByTestId('collection-filter-sort-status', BEHIND).props.children).toBe('Title ↑');

    await fireEvent.press(within(section()).getByRole('radio', { name: /^Title/ }));
    expect(view.getByTestId('collection-filter-sort-status', BEHIND).props.children).toBe('Title ↓');
    expect(seen.map((state) => state.sort)).toEqual([
      { axis: 'title', direction: 'asc' },
      { axis: 'title', direction: 'desc' },
    ]);
  });

  it('keeps filters as drafts until Apply, then says how many are on', async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByRole('checkbox', { name: 'Drama, 2' }));
    // Not yet: the wall still holds all four.
    expect(view.getByTestId('collection-count', BEHIND).props.children).toBe('4 titles');

    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByTestId('collection-count', BEHIND).props.children).toBe('2 of 4'));
    expect(view.getByTestId('collection-filter-sort-status', BEHIND).props.children).toBe(
      'Rating ↓ · 1 filter',
    );
    expect(
      StyleSheet.flatten(view.getByTestId('collection-filter-sort-status', BEHIND).props.style).color,
    ).toBe(theme.semantic.action);
  });

  it('clears the filters with Clear all and Apply, leaving the sort alone', async () => {
    const view = await openSheet({
      initial: {
        filters: { ...initialViewState().filters, genres: ['Drama'] },
        sort: { axis: 'title', direction: 'asc' },
      },
    });
    await fireEvent.press(view.getByText('Clear all'));
    await fireEvent.press(view.getByText('Apply'));
    await waitFor(() => expect(view.getByTestId('collection-count', BEHIND).props.children).toBe('4 titles'));
    expect(view.getByTestId('collection-filter-sort-status', BEHIND).props.children).toBe('Title ↑');
  });

  it('reshuffles from the toolbar and from Shuffle pressed again', async () => {
    const seen: CollectionViewState[] = [];
    const view = await openSheet({
      initial: { sort: { axis: 'shuffle', direction: 'desc' } },
      onState: (state) => seen.push(state),
    });
    await fireEvent.press(
      within(view.getByTestId('collection-sort-section')).getByRole('radio', { name: 'Shuffle' }),
    );
    expect(seen.at(-1)?.seed).toBe(2);
    await fireEvent.press(view.getByTestId('collection-reshuffle', BEHIND));
    expect(seen.at(-1)?.seed).toBe(3);
  });
});

describe('the status line', () => {
  it('names an undirected order without an arrow and counts filters in the plural', () => {
    expect(
      filterSortStatus(sortAxesFor('watched'), { axis: 'shuffle', direction: 'desc' }, 3),
    ).toBe('Shuffle · 3 filters');
  });
});
