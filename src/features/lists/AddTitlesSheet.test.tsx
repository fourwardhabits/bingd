import { fireEvent, waitFor } from '@testing-library/react-native';

import { parentView, searchFieldSite, type Host } from '@/test-utils/hit-rect';
import { renderWithProviders } from '@/test-utils/render';

import { AddTitlesSheet } from './AddTitlesSheet';

jest.mock('@/features/search/use-title-search', () => ({
  useTitleSearch: () => ({ results: [], isPending: false, isError: false }),
  yearOf: () => null,
}));
jest.mock('@/features/collection/use-collection', () => ({
  useWatchlist: () => ({ data: [], isPending: false }),
  useLoggedCollection: () => ({ data: { entries: [] }, isPending: false }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));

/**
 * **The clear button answers 44 × 44 here, and the field has not moved** (A11Y-44,
 * design-system v3 A.2 #11). `SearchField`'s box is now 44pt around the 40pt field it
 * draws; this sheet's field block gives the extra 4pt back from its own `space[2]` above
 * and below, so the drawn field is still `space[2]` from the header and from what follows.
 * Laid out from the rendered styles (`hit-rect.ts`).
 */
it('gives Clear a 44pt target and keeps the field where it was', async () => {
  const view = await renderWithProviders(
    <AddTitlesSheet
      listId="list-1"
      listTitle="Weekend"
      viewerId="user-1"
      presentIds={new Set()}
      onClose={jest.fn()}
    />,
  );
  const input = view.getByPlaceholderText('Search films and shows') as unknown as Host;
  await fireEvent.changeText(input as never, 'dune');
  await waitFor(() => expect(view.getByRole('button', { name: 'Clear search' })).toBeTruthy());

  // input → drawn field → SearchField → styles.field → the sheet's column.
  let root = input;
  for (let i = 0; i < 4; i += 1) root = parentView(root);
  const site = searchFieldSite(root, input, 360);

  expect(site.clear.height).toBeGreaterThanOrEqual(44);
  expect(site.clear.width).toBeGreaterThanOrEqual(44);
  expect(site.row.height).toBe(40);
  expect(site.spaceAbove).toBe(8);
  expect(site.spaceBelow).toBe(8);
  expect(site.insideParent).toBe(true);
});
