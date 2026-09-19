import { renderWithProviders } from '@/test-utils/render';

import { CollectionView, initialViewState } from './CollectionView';
import type { CollectionItem } from './filters';

/**
 * The poster wall and the list draw one order.
 *
 * Both modes render the same `visible` array, so this is the assertion that keeps it that
 * way: a collection whose printed scores collide — two 10.0s, four 8.5s, with ids running
 * against the ranking — must come out in ranked order in both. See `ordinal-order.test.ts`
 * for the report this reproduces.
 */

// FlashList measures its parent before drawing anything; jsdom has no layout. Same shim as
// `CollectionView.scale.test.tsx`.
jest.mock('@shopify/flash-list/dist/recyclerview/utils/measureLayout', () => ({
  ...jest.requireActual('@shopify/flash-list/dist/recyclerview/utils/measureLayout'),
  measureParentSize: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureFirstChildLayout: () => ({ x: 0, y: 0, width: 400, height: 900 }),
  measureItemLayout: () => ({ x: 0, y: 0, width: 100, height: 100 }),
}));

const row = (id: string, title: string, position: number, score: number): CollectionItem => ({
  mediaItemId: id,
  title,
  seriesTitle: null,
  kind: 'movie',
  year: 2000,
  posterPath: null,
  genres: ['Comedy'],
  language: 'en',
  runtimeMinutes: 90,
  score,
  position,
  bucket: 'loved',
  watchedOn: null,
  addedAt: '2026-09-01T00:00:00Z',
});

// Ascending id order is the reverse of the ranking inside each collision.
const ITEMS = [
  row('9-first', 'The Dark Knight', 1, 10),
  row('8-second', 'The Odyssey', 2, 10),
  row('7-third', 'Elf', 3, 8.5),
  row('6-fourth', 'Like Mike', 4, 8.5),
  row('5-fifth', 'Puss in Boots', 5, 8.5),
  row('4-sixth', 'George of the Jungle', 6, 8.5),
];

const RANKED = ITEMS.map((item) => item.title);

const drawn = async (mode: 'poster' | 'list') => {
  const view = await renderWithProviders(
    <CollectionView
      // Handed over in id order, so nothing can pass by preserving arrival order.
      items={[...ITEMS].sort((a, b) => a.mediaItemId.localeCompare(b.mediaItemId))}
      segment="watched"
      state={{ ...initialViewState(), mode }}
      onChange={() => {}}
      onPressItem={() => {}}
      empty={null}
    />,
  );
  return view
    .queryAllByRole('button')
    .map((node) => String(node.props.accessibilityLabel ?? '').split(', ')[0] ?? '')
    .filter((title) => RANKED.includes(title));
};

it('draws the ranked order, not the id order, in the poster wall', async () => {
  expect(await drawn('poster')).toEqual(RANKED);
});

it('draws the same order in the list', async () => {
  expect(await drawn('list')).toEqual(RANKED);
});
