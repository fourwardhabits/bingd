import { renderWithProviders as render } from '@/test-utils/render';
import { StyleSheet } from 'react-native';

import { fontFamily, theme, typography } from '../tokens';
import { CompactSwitch } from './CompactSwitch';
import { MediumSelector } from './MediumSelector';

/**
 * **The page navigation pair** (founder final polish, 2026-11-04): For You and Collection
 * draw the same two controls in one row — the page's dropdown at 22pt serif on the left,
 * and the Movies | TV switch in Inter Medium 14 on the right.
 */
describe('the page navigation pair', () => {
  it('draws the dropdown at title2 in its nav size, and at title1 as a screen title', async () => {
    const options = [
      { id: 'watched', label: 'Watched' },
      { id: 'watchlist', label: 'Watchlist' },
    ] as const;
    const nav = await render(<MediumSelector size="nav" value="watched" options={options} onChange={() => {}} />);
    const title = await render(<MediumSelector value="watched" options={options} onChange={() => {}} />);

    const navText = StyleSheet.flatten(nav.getByText('Watched').props.style);
    expect(navText.fontSize).toBe(typography.title2.fontSize);
    expect(navText.fontFamily).toBe(typography.title2.fontFamily);
    expect(StyleSheet.flatten(title.getByText('Watched').props.style).fontSize).toBe(
      typography.title1.fontSize,
    );
  });

  it('labels the switch in Inter Medium at 14pt, chosen or not', async () => {
    const view = await render(
      <CompactSwitch
        accessibilityLabel="Medium"
        options={[
          { id: 'movies', label: 'Movies' },
          { id: 'tv', label: 'TV' },
        ]}
        value="movies"
        onChange={() => {}}
      />,
    );

    for (const word of ['Movies', 'TV']) {
      const style = StyleSheet.flatten(view.getByText(word).props.style);
      expect(style.fontFamily).toBe(fontFamily.sansMedium);
      expect(style.fontSize).toBe(14);
    }
  });

  it('keeps each half a 44pt target both ways, however short its word', async () => {
    // "TV" measures about 19pt; its half was 35pt wide until the floor applied to width.
    const view = await render(
      <CompactSwitch
        accessibilityLabel="Medium"
        options={[
          { id: 'movies', label: 'Movies' },
          { id: 'tv', label: 'TV' },
        ]}
        value="movies"
        onChange={() => {}}
      />,
    );

    const halves = view.getAllByRole('radio');
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      const style = StyleSheet.flatten(half.props.style);
      expect(style.minWidth).toBe(theme.layout.minTapTarget);
      expect(style.minHeight).toBe(theme.layout.minTapTarget);
    }
  });
});
