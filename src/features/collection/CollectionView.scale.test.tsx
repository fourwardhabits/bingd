import { fireEvent } from '@testing-library/react-native';
import { performance } from 'node:perf_hooks';

import { renderWithProviders } from '@/test-utils/render';

import { CollectionView, initialViewState, type CollectionViewState } from './CollectionView';
import type { CollectionItem, CollectionSegment } from './filters';

/**
 * **A large collection draws what is on screen, not what is in it** (2026-09-16).
 *
 * A reader with 688 imported Letterboxd titles found Unranked's Poster view laggy to
 * scroll and List noticeably better. Neither was importer-specific: every Collection
 * surface — ranked Movies and TV under Watched, the Watchlist, Unranked, and any
 * filtered or sorted view of them — is one `CollectionView`, and both of its modes drew
 * every row eagerly into a plain `ScrollView`. A poster tile is the heavier of the two
 * (a scale animation, a press target, an elevated frame, a larger image), which is why
 * the grid was the worse of two unvirtualised lists rather than the only one.
 *
 * These pin the property rather than a frame budget, because a test runner is not a
 * phone: at every size the number of mounted cells stays bounded by the window, and the
 * rows that are drawn are the right rows in the right order.
 */

/**
 * A viewport, the measurement half of FlashList's own `jestSetup.js`, scoped to this file.
 *
 * A test renderer lays nothing out, so without a measured window a virtualised list has
 * no way to tell what is on screen and mounts everything — which would make this suite
 * unable to tell a virtualised list from a `ScrollView`. A 400x900 window with 100pt
 * cells is the library's documented stand-in. Not in `jest.setup.js`: every other suite
 * that renders a FlashList was written against the unmeasured behaviour and asserts on
 * rows beyond any window.
 */
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => ({
  ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
  measureParentSize: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureFirstChildLayout: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureItemLayout: () => ({ x: 0, y: 0, width: 100, height: 100 }),
}));

const SIZES = [50, 250, 700, 1000] as const;

let current: Awaited<ReturnType<typeof renderWithProviders>>;

/** Mounted cells cannot exceed this, whatever the collection holds. */
const WINDOW_CEILING = 120;

const item = (n: number, overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Film ${String(n).padStart(4, '0')}`,
  seriesTitle: null,
  kind: 'movie',
  year: 1950 + (n % 70),
  posterPath: `/p${n}.jpg`,
  genres: n % 3 === 0 ? ['Drama'] : ['Comedy'],
  language: 'en',
  runtimeMinutes: 90,
  score: null,
  bucket: null,
  watchedOn: null,
  addedAt: new Date(Date.UTC(2020, 0, 1) + n * 60_000).toISOString(),
  ...overrides,
});

/** An imported, unranked library: no scores, membership times spread out. */
const unranked = (size: number) => Array.from({ length: size }, (_, i) => item(i + 1));

/** A ranked library: every title scored, highest first by construction. */
const ranked = (size: number) =>
  Array.from({ length: size }, (_, i) =>
    item(i + 1, { score: Math.round((10 - (i * 10) / size) * 10) / 10, bucket: 'loved' }),
  );

const draw = async (
  items: CollectionItem[],
  segment: CollectionSegment,
  state: Partial<CollectionViewState> = {},
) => {
  const onPressItem = jest.fn();
  const started = performance.now();
  const view = await renderWithProviders(
    <CollectionView
      items={items}
      segment={segment}
      state={{ ...initialViewState(), ...state }}
      onChange={() => {}}
      onPressItem={onPressItem}
      empty={null}
    />,
  );
  current = view;
  return { view, onPressItem, ms: performance.now() - started };
};

/** Every mounted cell, in tree order, by the label its tile or row announces. */
const cells = () =>
  current
    .queryAllByRole('button')
    .map((node) => node.props.accessibilityLabel as string | undefined)
    .filter((label): label is string => Boolean(label?.startsWith('Film ')));

describe.each(['poster', 'list'] as const)('a large collection in %s view', (mode) => {
  it.each(SIZES)('mounts a bounded window of an unranked library of %i', async (size) => {
    const { ms } = await draw(unranked(size), 'unranked', { mode });
    const mounted = cells().length;
    // eslint-disable-next-line no-console -- the measurement is the point of this suite
    console.log(
      `[collection-scale] ${mode} unranked ${size}: ${mounted} cells, ${ms.toFixed(0)}ms`,
    );

    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(Math.min(size, WINDOW_CEILING));
    // The count line still describes the whole collection, not the window.
    expect(current.getByText(`${size} titles`)).toBeTruthy();
  });

  it.each(SIZES)('mounts a bounded window of a ranked library of %i', async (size) => {
    await draw(ranked(size), 'watched', { mode });
    expect(cells().length).toBeLessThanOrEqual(Math.min(size, WINDOW_CEILING));
  });

  it('draws the first rows in the order the sort asks for', async () => {
    // Shuffled input; Rating, highest first, is the default sort.
    const items = ranked(700);
    const shuffled = [...items].reverse();
    await draw(shuffled, 'watched', { mode });

    const first = cells().slice(0, 6);
    expect(first.map((label) => label.slice(0, 9))).toEqual(
      items.slice(0, 6).map((row) => row.title),
    );
  });

  it('draws a filtered view of a large library, and only what matches', async () => {
    await draw(unranked(700), 'unranked', {
      mode,
      filters: { ...initialViewState().filters, genres: ['Drama'] },
    });

    const drawn = cells();
    expect(drawn.length).toBeGreaterThan(0);
    // Every third title is a drama: 233 of 700.
    expect(current.getByText('233 of 700')).toBeTruthy();
    for (const label of drawn) {
      const n = Number(label.slice(5, 9));
      expect(n % 3).toBe(0);
    }
  });

  it('opens the title that was pressed', async () => {
    const items = unranked(700);
    const { onPressItem } = await draw(items, 'unranked', {
      mode,
      sort: { axis: 'title', direction: 'asc' },
    });

    await fireEvent.press(current.getAllByRole('button', { name: /^Film 0002/ })[0]!);
    expect(onPressItem).toHaveBeenCalledWith(items[1]!.mediaItemId);
  });
});

describe('imported and ordinary titles on one surface', () => {
  it('draws an imported unranked row and a ranked row with the same cell', async () => {
    const items = [
      item(1, { score: 8.4, bucket: 'loved' }),
      // An import that no provider had artwork for.
      item(2, { posterPath: null }),
    ];
    await draw(items, 'watched', { mode: 'poster' });

    expect(current.getByRole('button', { name: /^Film 0001, 1951, scored 8\.4/ })).toBeTruthy();
    expect(current.getByRole('button', { name: /^Film 0002, 1952$/ })).toBeTruthy();
  });
});
