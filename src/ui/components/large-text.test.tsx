import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CompactSwitch } from './CompactSwitch';
import { COMPACT_MAX_SCALE, MediumSelector } from './MediumSelector';
import { StatRow } from './StatRow';

/**
 * **Large system text on the Visual 2.1 controls** (2026-11-03).
 *
 * Jest cannot lay text out, so these pin the three rules the 200% renders needed: the
 * compact selector's one ceiling, the switch growing with its words, and the stat row
 * keeping its numbers level when one label wraps.
 */
describe('the compact selector', () => {
  it('caps its single-word label at the size that still fits a 320pt phone', async () => {
    const view = await renderWithProviders(
      <MediumSelector
        size="compact"
        value="recommended"
        options={[
          { id: 'recommended', label: 'Recommended' },
          { id: 'top', label: 'Top Rated' },
        ]}
        onChange={() => {}}
      />,
    );

    expect(view.getByText('Recommended').props.maxFontSizeMultiplier).toBe(COMPACT_MAX_SCALE);
    // Still a large-text control: three quarters again on top of its own size.
    expect(COMPACT_MAX_SCALE).toBeGreaterThanOrEqual(1.75);
  });

  it('leaves the title-sized selector uncapped, as the design system has it', async () => {
    const view = await renderWithProviders(<MediumSelector value="movies" onChange={() => {}} />);

    expect(view.getByText('Movies').props.maxFontSizeMultiplier).toBeUndefined();
  });
});

describe('the Movies | TV Shows switch', () => {
  it('grows with its words rather than clipping them', async () => {
    const view = await renderWithProviders(
      <CompactSwitch
        accessibilityLabel="Medium"
        options={[
          { id: 'movies', label: 'Movies' },
          { id: 'tv', label: 'TV Shows' },
        ]}
        value="movies"
        onChange={() => {}}
      />,
    );

    for (const half of view.getAllByRole('radio')) {
      const press = StyleSheet.flatten(half.props.style);
      const fill = StyleSheet.flatten(
        (half.children[0] as unknown as { props: { style: never } }).props.style,
      ) as Record<string, unknown>;
      // Floors everywhere, so the word can grow and both the fill and the press follow it.
      expect(press.height).toBeUndefined();
      expect(fill.height).toBeUndefined();
      expect(fill.minHeight).toBe(28);
    }
    // And the words themselves scale: no `allowFontScaling={false}` on them.
    expect(view.getByText('TV Shows').props.allowFontScaling).not.toBe(false);
  });
});

describe('the stat row', () => {
  it('keeps every number on one line when a label wraps', async () => {
    const view = await renderWithProviders(
      <StatRow
        stats={[
          { label: 'Movies', value: 25 },
          { label: 'TV Shows', value: 12 },
        ]}
      />,
    );

    for (const name of ['Movies: 25', 'TV Shows: 12']) {
      const cell = StyleSheet.flatten(view.getByLabelText(name).props.style);
      expect(cell.justifyContent).toBe('flex-start');
    }
    expect(StyleSheet.flatten(view.getByText('TV Shows').props.style).textAlign).toBe('center');
  });
});
