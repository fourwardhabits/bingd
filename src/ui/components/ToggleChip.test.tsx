import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { NoteClaims } from '@/features/collection/NoteComposer';

import { theme } from '../tokens';

/**
 * **ToggleChip's slop never crosses into its neighbour** (design-system v3 A.2 #12). The two
 * note claims sit `space[2]` apart; slop of `space[2]` either side made the two chips' slops
 * overlap by 8pt. Horizontal slop is now half the gap; vertical slop is unchanged.
 */
describe('ToggleChip slop', () => {
  it('keeps two chips’ horizontal slop inside the gap between them', async () => {
    await render(
      <NoteClaims
        visibility="private"
        spoilers={false}
        onVisibility={() => {}}
        onSpoilers={() => {}}
      />,
    );

    const chips = screen.getAllByRole('checkbox');
    expect(chips).toHaveLength(2);

    let parent = chips[0]!.parent;
    while (parent && parent.type !== 'View') parent = parent.parent;
    const row = StyleSheet.flatten(parent!.props.style);
    expect(row.gap).toBe(theme.space[2]);

    for (const chip of chips) {
      const slop = chip.props.hitSlop as {
        top: number;
        bottom: number;
        left: number;
        right: number;
      };
      expect(StyleSheet.flatten(chip.props.style).minHeight).toBe(
        theme.layout.control.chipHeight,
      );
      expect(slop.left + slop.right).toBeLessThanOrEqual(row.gap);
      // Vertical slop is kept as it was.
      expect(slop.top).toBe(theme.space[2]);
      expect(slop.bottom).toBe(theme.space[2]);
    }
  });
});
