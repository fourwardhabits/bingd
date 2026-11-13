import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { CollectionFilterSheet } from './CollectionFilterSheet';
import { COLLECTION_SORT_AXES, emptyFilters, sortAxesFor, type CollectionItem } from './filters';

/**
 * **The filter sheet's spacing** (FU1113-B, B10) — Collection's and For You's, which are
 * the same component. A deliberate gap between the drag handle and the first section, and
 * one equal gap between every pair of sections, all from `theme.layout.section`. Values,
 * counts, selection, Apply and Clear are unchanged (the existing filter tests cover them).
 */
const item = (n: number, overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Film ${n}`,
  seriesTitle: null,
  kind: 'movie',
  year: n % 2 ? 1995 : 2015,
  posterPath: null,
  genres: n % 2 ? ['Drama'] : ['Comedy'],
  language: n % 2 ? 'en' : 'fr',
  runtimeMinutes: 90,
  score: 8,
  bucket: 'loved',
  watchedOn: null,
  addedAt: null,
  ...overrides,
});

const ITEMS = [item(1), item(2), item(3)];
const SECTION = theme.layout.section;

const draw = (withSort: boolean, onApply = jest.fn()) =>
  render(
    <CollectionFilterSheet
      items={ITEMS}
      value={emptyFilters()}
      showBuckets
      onApply={onApply}
      onClose={() => {}}
      sort={
        withSort
          ? {
              axes: sortAxesFor('watched'),
              value: { axis: COLLECTION_SORT_AXES.rating.axis, direction: 'desc' },
              onChange: () => {},
            }
          : undefined
      }
    />,
  );

const contentStyle = (view: Awaited<ReturnType<typeof draw>>) =>
  StyleSheet.flatten(view.getByTestId('collection-filter-scroll').props.contentContainerStyle);

describe('the filter sheet spacing', () => {
  it('names its steps from the existing space scale', () => {
    const steps = Object.values(theme.space) as number[];
    for (const value of Object.values(SECTION)) expect(steps).toContain(value);
    expect(SECTION.between).toBe(theme.layout.sectionGap);
  });

  it.each([
    ['For You (no sort)', false],
    ['Collection (with sort)', true],
  ])('%s: a deliberate top gap, and one equal gap between every section', async (_, withSort) => {
    const view = await draw(withSort);
    const content = contentStyle(view);
    expect(content.paddingTop).toBe(SECTION.above);
    expect(content.paddingTop).toBeGreaterThan(0);
    // One `gap` for every seam: Sort, Rating, Genre, Decade, Language.
    expect(content.gap).toBe(SECTION.between);

    for (const heading of ['RATING', 'GENRE', 'DECADE', 'LANGUAGE']) {
      const section = view.getByText(heading).parent!;
      const style = StyleSheet.flatten(section.props.style);
      expect(style.gap).toBe(SECTION.headingToControls);
      // No section adds a margin of its own, so no seam differs from another.
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
    }
  });

  it('keeps the Filter heading a heading’s distance from its first section', async () => {
    const view = await draw(true);
    const filter = StyleSheet.flatten(view.getByText('Filter').props.style);
    expect(SECTION.between + (filter.marginBottom as number)).toBe(SECTION.headingToControls);
  });

  it('still applies the chosen values', async () => {
    const onApply = jest.fn();
    const view = await draw(false, onApply);
    await fireEvent.press(view.getByRole('checkbox', { name: 'Drama, 2' }));
    await fireEvent.press(view.getByText('Apply'));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ genres: ['Drama'] }));
  });
});
