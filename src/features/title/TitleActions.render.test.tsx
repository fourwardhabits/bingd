import { within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { RANK_LABEL, RANK_LABEL_MAX_SCALE, TitleActions } from './TitleActions';

/**
 * **One row: Rank / Log rewatch · Watchlist · Add to List · Recommend** (TV show & season
 * ranking, founder brief §3, 2026-11-14).
 *
 * A layout cannot be measured here, so what is pinned is the contract that makes one row
 * hold at the narrowest phone and the largest text: the cluster never wraps; the labelled
 * control is the only thing that gives width back, and its word stays on one line, grows
 * no further than 1.5x, and past that fits itself to the row rather than being cut; and the
 * icon controls keep fixed boxes whose slop clears the 44pt target.
 */
const action = (label: string, ranked = false) => (
  <TitleActions
    tone="artwork"
    rank={{
      ranked,
      label,
      compact: ranked,
      unclamped: true,
      accessibilityLabel: label,
      onPress: jest.fn(),
    }}
    save={{ accessibilityLabel: 'Save', onPress: jest.fn() }}
    list={{ accessibilityLabel: 'List', onPress: jest.fn() }}
    recommend={{ accessibilityLabel: 'Recommend', onPress: jest.fn() }}
  />
);

describe('the title action cluster', () => {
  it.each([RANK_LABEL.movie, RANK_LABEL.series, RANK_LABEL.season])(
    'keeps "%s" and all three icons on one row',
    async (label) => {
      const view = await renderWithProviders(action(label));
      const cluster = view.getByTestId('title-actions');
      expect(StyleSheet.flatten(cluster.props.style).flexWrap).toBe('nowrap');
      expect(StyleSheet.flatten(cluster.props.style).flexDirection).toBe('row');
      for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
        expect(within(cluster).getByTestId(id)).toBeTruthy();
      }
    },
  );

  it('fits the word to the row at large text instead of cutting it or wrapping', async () => {
    const view = await renderWithProviders(action('Log rewatch', true));
    const label = view.getByTestId('title-action-rank-label');
    expect(label.props.children).toBe('Log rewatch');
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.maxFontSizeMultiplier).toBe(RANK_LABEL_MAX_SCALE);
    expect(label.props.minimumFontScale).toBeGreaterThanOrEqual(0.7);
  });

  it('lets only the labelled control give width back', async () => {
    const view = await renderWithProviders(action(RANK_LABEL.season));
    const control = view.getByTestId('title-action-rank');
    const style = StyleSheet.flatten(
      typeof control.props.style === 'function'
        ? control.props.style({ pressed: false })
        : control.props.style,
    );
    expect(style.flexShrink).toBe(1);
    // Its own target never drops below the minimum.
    expect(style.minHeight).toBeGreaterThanOrEqual(theme.layout.minTapTarget - 8);
  });

  it('keeps each icon a fixed box whose slop clears 44pt', async () => {
    const view = await renderWithProviders(action(RANK_LABEL.season));
    for (const id of ['title-action-save', 'title-action-list', 'title-action-recommend']) {
      const icon = view.getByTestId(id);
      const style = StyleSheet.flatten(
        typeof icon.props.style === 'function'
          ? icon.props.style({ pressed: false })
          : icon.props.style,
      );
      expect(
        style.width + icon.props.hitSlop.left + icon.props.hitSlop.right,
      ).toBeGreaterThanOrEqual(44);
      expect(style.height).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    }
  });
});
