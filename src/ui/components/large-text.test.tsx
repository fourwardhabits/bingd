import { Dimensions, PixelRatio, StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CompactSwitch } from './CompactSwitch';
import { COMPACT_MAX_SCALE, MediumSelector } from './MediumSelector';
import { StatRow, statColumns } from './StatRow';
import { stackProfileActions } from '@/features/profile/ProfileActions';

/**
 * **Large system text on the Visual 2.1 controls** (2026-11-03).
 *
 * Jest cannot lay text out, so these pin the rules the 130% and 200% renders needed: the
 * compact selector's one ceiling, the switch growing with its words, the stat row going
 * two by two and keeping its numbers level, and the profile's buttons stacking. The
 * renders are the evidence that the rules are right; these stop them being undone.
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

describe('the profile’s two action buttons', () => {
  it('stay side by side at 100% on every supported width', () => {
    for (const width of [320, 360, 375, 390, 412]) {
      expect(stackProfileActions(width, 1)).toBe(false);
    }
  });

  it('stack where "Invite friends" would truncate even at its 85% floor', () => {
    expect(stackProfileActions(320, 1.3)).toBe(true);
    for (const width of [320, 360, 375, 390, 412]) {
      expect(stackProfileActions(width, 2)).toBe(true);
    }
  });
});

describe('the stat row’s columns', () => {
  const PROFILE = ['Followers', 'Following', 'Movies', 'TV Shows'];

  it('stays four across at 100% on every supported width', () => {
    for (const width of [320, 360, 375, 390, 412]) {
      expect(statColumns(PROFILE, width, 1)).toBe(4);
    }
  });

  it('goes two by two where four labels would run together', () => {
    // The two renders that showed it: 130% on 320pt, and 200% on 360pt.
    expect(statColumns(PROFILE, 320, 1.3)).toBe(2);
    expect(statColumns(PROFILE, 360, 2)).toBe(2);
    // And 200% everywhere: no phone is wide enough for four 24pt labels.
    for (const width of [320, 360, 375, 390, 412]) {
      expect(statColumns(PROFILE, width, 2)).toBe(2);
    }
  });

  it('draws each cell half the row when it does', async () => {
    const scale = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    // A 360pt phone; the test environment's own window is 750pt wide.
    const window = jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 360, height: 780, scale: 3, fontScale: 2 });
    try {
      const view = await renderWithProviders(
        <StatRow stats={PROFILE.map((label, value) => ({ label, value }))} />,
      );
      expect(StyleSheet.flatten(view.getByTestId('stat-row').props.style).flexWrap).toBe('wrap');
      for (const label of PROFILE) {
        const cell = StyleSheet.flatten(view.getByLabelText(new RegExp(`^${label}: `)).props.style);
        expect(cell.flexBasis).toBe('50%');
      }
    } finally {
      scale.mockRestore();
      window.mockRestore();
    }
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
