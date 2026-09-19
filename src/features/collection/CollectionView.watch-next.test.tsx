import { fireEvent, within } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CollectionView, initialViewState, type CollectionViewState } from './CollectionView';
import type { CollectionItem } from './filters';
import { partitionPinned } from './watch-next';

/**
 * Watch next on the Watchlist (20260929000200).
 *
 * The approved display rules, each pinned once: the pinned titles sit above the rest
 * under one label, in slot order, in the current mode's own idiom; no title is drawn
 * twice; filters still apply to them and the count stays whole; sort — Shuffle included —
 * does not move them; and with nothing pinned nothing is drawn at all.
 */

const item = (n: number, overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: `film-${n}`,
  title: `Film ${n}`,
  seriesTitle: null,
  kind: 'movie',
  year: 2000 + n,
  posterPath: null,
  genres: n % 2 === 0 ? ['Drama'] : ['Comedy'],
  language: 'en',
  runtimeMinutes: 100,
  score: null,
  bucket: null,
  watchedOn: null,
  // Film 1 is the most recently added, so the default "Recently added" order is 1, 2, 3...
  addedAt: new Date(Date.UTC(2026, 0, 1) - n * 60_000).toISOString(),
  ...overrides,
});

const LIBRARY = [1, 2, 3, 4, 5, 6].map((n) => item(n));

const draw = (
  pinned: readonly string[],
  state: Partial<CollectionViewState> = {},
  extra: { onLongPressItem?: (id: string) => void } = {},
) =>
  renderWithProviders(
    <CollectionView
      items={LIBRARY}
      segment="watchlist"
      state={{
        ...initialViewState(),
        sort: { axis: 'added', direction: 'desc' },
        ...state,
      }}
      onChange={() => {}}
      onPressItem={() => {}}
      empty={null}
      pinned={pinned}
      onLongPressItem={extra.onLongPressItem}
      longPressLabel={(id) => (pinned.includes(id) ? 'Remove from Watch next' : 'Add to Watch next')}
    />,
  );

/** Every title label in tree order, pinned or not. */
const labels = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
  view
    .queryAllByRole('button')
    .map((node) => node.props.accessibilityLabel as string | undefined)
    .filter((label): label is string => Boolean(label?.startsWith('Film ')))
    .map((label) => label.split(',')[0]);

describe('partitionPinned', () => {
  it('lifts the pins out in slot order and keeps the rest in the order given', () => {
    const { pinned, rest } = partitionPinned(LIBRARY, ['film-4', 'film-2']);
    expect(pinned.map((i) => i.mediaItemId)).toEqual(['film-4', 'film-2']);
    expect(rest.map((i) => i.mediaItemId)).toEqual(['film-1', 'film-3', 'film-5', 'film-6']);
  });

  it('drops a pin the visible list does not hold, which is how a filter hides one', () => {
    const { pinned } = partitionPinned(LIBRARY.slice(0, 2), ['film-4', 'film-2']);
    expect(pinned.map((i) => i.mediaItemId)).toEqual(['film-2']);
  });
});

describe.each(['poster', 'list'] as const)('the Watch next header in %s view', (mode) => {
  it('draws the pins first, under one label, and never twice', async () => {
    const view = await draw(['film-5', 'film-2'], { mode });

    expect(view.getByText('Watch next')).toBeTruthy();
    const order = labels(view);
    expect(order.slice(0, 2)).toEqual(['Film 5', 'Film 2']);
    expect(order.filter((l) => l === 'Film 5')).toHaveLength(1);
    expect(order).toHaveLength(LIBRARY.length);
    expect(view.getByText('6 titles')).toBeTruthy();
  });

  it('draws nothing extra when nothing is pinned', async () => {
    const view = await draw([], { mode });
    expect(view.queryByText('Watch next')).toBeNull();
    expect(labels(view)).toEqual(['Film 1', 'Film 2', 'Film 3', 'Film 4', 'Film 5', 'Film 6']);
  });

  it('keeps the pins on top of Shuffle', async () => {
    const view = await draw(['film-6'], { mode, sort: { axis: 'shuffle' } as never, seed: 7 });
    expect(labels(view)[0]).toBe('Film 6');
  });

  it('lets a filter hide a pin, and the count says so', async () => {
    const filters = { ...initialViewState().filters, genres: ['Drama'] };
    const view = await draw(['film-1', 'film-2'], { mode, filters });

    // Film 1 is a comedy: filtered out, pinned or not. Film 2 is a drama and leads.
    expect(labels(view)).not.toContain('Film 1');
    expect(labels(view)[0]).toBe('Film 2');
    expect(view.getByText('3 of 6')).toBeTruthy();
  });

  it('drops the label when every pin is filtered out', async () => {
    const filters = { ...initialViewState().filters, genres: ['Drama'] };
    const view = await draw(['film-1'], { mode, filters });
    expect(view.queryByText('Watch next')).toBeNull();
  });
});

describe('press and hold', () => {
  it('hands the held title to the caller, in poster view', async () => {
    const onLongPressItem = jest.fn();
    const view = await draw([], { mode: 'poster' }, { onLongPressItem });
    const tile = view.getAllByRole('button').find((n) =>
      String(n.props.accessibilityLabel).startsWith('Film 3'),
    );
    await fireEvent(tile!, 'longPress');
    expect(onLongPressItem).toHaveBeenCalledWith('film-3');
  });

  it('hands the held title to the caller, in list view', async () => {
    const onLongPressItem = jest.fn();
    const view = await draw(['film-2'], { mode: 'list' }, { onLongPressItem });
    const header = view.getByTestId('collection-pinned');
    const row = within(header).getAllByRole('button')[0]!;
    await fireEvent(row, 'longPress');
    expect(onLongPressItem).toHaveBeenCalledWith('film-2');
  });

  it('offers the same act to a screen reader, named for what it will do', async () => {
    const onLongPressItem = jest.fn();
    const view = await draw(['film-2'], { mode: 'poster' }, { onLongPressItem });
    const pinnedTile = within(view.getByTestId('poster-grid-leading')).getAllByRole('button')[0]!;
    expect(pinnedTile.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Remove from Watch next' },
    ]);
    await fireEvent(pinnedTile, 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
    expect(onLongPressItem).toHaveBeenCalledWith('film-2');
  });
});
