import { render, screen } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import { NoteClaims, NoteInput } from '@/features/collection/NoteComposer';
import { controlRowSite, parentView, type Host } from '@/test-utils/hit-rect';

import { theme } from '../tokens';

/**
 * **The note claims answer 44pt, on one line or two, and never cross** (design-system v3
 * A.2 #12; A11Y-44).
 *
 * #299 kept horizontal slop to half the 8pt gap between the chips, so neighbours meet
 * without crossing; that still holds. Vertically the 32pt chips sat in a row with no
 * padding, so their slop was clipped to 32. The row now holds `space[2]` above and below
 * (handed back by a negative margin, into the column's empty gaps), and each chip's
 * vertical slop is split by place so it also holds when the two wrap onto two lines, which
 * they do at 320 and 360pt. Laid out from the rendered styles (`hit-rect.ts`), in a column
 * like the two callers' (`noteBox`: gutter padding, `space[2]` gap).
 */
describe('ToggleChip in the note claims', () => {
  const TARGET = theme.layout.minTapTarget;

  const draw = async () => {
    await render(
      <View style={{ paddingHorizontal: theme.layout.gutter, gap: theme.space[2] }}>
        <NoteInput value="" label="Note" onChangeText={() => {}} onBlur={() => {}} />
        <NoteClaims
          visibility="private"
          spoilers={false}
          onVisibility={() => {}}
          onSpoilers={() => {}}
        />
      </View>,
    );
    const chips = screen.getAllByRole('checkbox') as unknown as Host[];
    expect(chips).toHaveLength(2);
    return chips;
  };

  // Wide enough for one line, and narrow enough to wrap, whatever the text measures.
  for (const [layout, width] of [
    ['one line', 1000],
    ['wrapped', 320],
  ] as const) {
    it(`answers 44pt per chip, ${layout}, with the chips and gaps where they were`, async () => {
      const chips = await draw();
      const site = controlRowSite(chips, width);
      expect(site.wrapped).toBe(layout === 'wrapped');

      for (const [index, chip] of chips.entries()) {
        // The chrome is still the 32pt chip.
        expect(site.chips[index]!.height).toBe(theme.layout.control.chipHeight);
        expect(StyleSheet.flatten(chip.props.style as never)).toMatchObject({
          minHeight: theme.layout.control.chipHeight,
        });
        expect(site.hits[index]!.height).toBeGreaterThanOrEqual(TARGET);
      }
      // Wrapped, the first chip's rect ends where the second's begins, or before.
      if (site.wrapped) {
        expect(site.hits[0]!.bottom).toBeLessThanOrEqual(site.hits[1]!.top);
      }
      // `space[2]` from the field to the chips and from the chips to the caption, as before.
      expect(site.spaceAbove).toBe(theme.space[2]);
      expect(site.spaceBelow).toBe(theme.space[2]);
      // The row's box stays inside the column (Android clips what does not).
      expect(site.row.top).toBeGreaterThanOrEqual(0);
      expect(site.row.top + site.row.height).toBeLessThanOrEqual(site.column.height);
    });
  }

  it('keeps two chips’ horizontal slop inside the gap between them', async () => {
    const chips = await draw();
    const row = StyleSheet.flatten(parentView(chips[0]!).props.style) as { gap: number };
    expect(row.gap).toBe(theme.space[2]);
    for (const chip of chips) {
      const slop = chip.props.hitSlop as { left: number; right: number };
      expect(slop.left + slop.right).toBeLessThanOrEqual(row.gap);
    }
  });
});
