import { fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { FilterChip } from './FilterChip';
import { IconToggle } from './IconToggle';
import { MediumSelector } from './MediumSelector';
import { SectionHeader } from './SectionHeader';
import { SortMenu } from './SortControl';

/**
 * **Every tap target is at least 44 × 44** (design-system.md §10), on the six controls
 * the pre-GTM audit measured short (2026-09-07).
 *
 * None of them grew. A chip is still 32pt on screen; what changed is the slop around
 * it, which is the right tool for a compact control and the wrong tool when it crosses
 * into a neighbour. So these pin two things per control: that drawn size plus slop
 * reaches the target, and that the slop stays inside the gap the row leaves between
 * two of them.
 */

const TARGET = theme.layout.minTapTarget;
const CHIP = theme.layout.control.chipHeight;
const SLOP = theme.layout.chipHitSlop;

type Slop = { top: number; bottom: number; left: number; right: number };
const tall = (drawn: number, slop: Slop) => drawn + slop.top + slop.bottom;
const wide = (drawn: number, slop: Slop) => drawn + slop.left + slop.right;

describe('the shared chip slop', () => {
  it('lifts a 32pt chip to the target', () => {
    expect(tall(CHIP, SLOP)).toBeGreaterThanOrEqual(TARGET);
  });

  it('never crosses the gap between two chips in a row', () => {
    // Chip rows use `space[2]` between neighbours; two slops meeting in that gap must
    // not overlap, or a press between two chips belongs to whichever was drawn last.
    expect(SLOP.left + SLOP.right).toBeLessThanOrEqual(theme.space[2]);
  });
});

describe('FilterChip', () => {
  it('draws 32pt and answers 44', async () => {
    const view = await renderWithProviders(
      <FilterChip icon="options-outline" label="Filters" onPress={() => {}} />,
    );
    const chip = view.getByRole('button', { name: 'Filters' });

    expect(StyleSheet.flatten(chip.props.style).minHeight).toBe(CHIP);
    expect(chip.props.hitSlop).toEqual(SLOP);
  });
});

describe('SortMenu', () => {
  it('gives every option the chip slop', async () => {
    const axes = [
      {
        axis: 'score',
        label: 'Score',
        directions: { desc: 'highest first', asc: 'lowest first' },
        defaultDirection: 'desc',
      },
      { axis: 'shuffle', label: 'Shuffle' },
    ] as const;
    const view = await renderWithProviders(
      <SortMenu
        axes={axes}
        value={{ axis: 'score', direction: 'desc' }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );

    const options = view.getAllByRole('radio');
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(StyleSheet.flatten(option.props.style).minHeight).toBe(CHIP);
      expect(option.props.hitSlop).toEqual(SLOP);
    }
  });
});

describe('IconToggle', () => {
  it('makes each cell 44 × 44 with slop on the outside edges only', async () => {
    const view = await renderWithProviders(
      <IconToggle
        options={[
          { value: 'posters', icon: 'grid-outline', label: 'Posters' },
          { value: 'list', icon: 'list-outline', label: 'List' },
        ]}
        value="posters"
        onChange={() => {}}
        label="View"
      />,
    );
    const [first, last] = view.getAllByRole('radio');
    const cell = StyleSheet.flatten(first!.props.style);

    // The two cells touch. React Native hit-tests siblings last-first, so an inner slop
    // on the second cell would take the first cell's own edge — hence none.
    expect(first!.props.hitSlop).toEqual({ ...SLOP, left: theme.space[2], right: 0 });
    expect(last!.props.hitSlop).toEqual({ ...SLOP, left: 0, right: theme.space[2] });
    expect(tall(cell.height, first!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
    expect(wide(cell.width, first!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
    expect(wide(cell.width, last!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
  });
  /**
   * **Three cells, and the one dimension the arrangement gives up** (§A2, 2026-09-08).
   *
   * The Feed's control gained People. The slop rule is unchanged and that is the point:
   * horizontal slop goes on the group's outer edges only, because the cells are flush and
   * React Native hit-tests siblings last-first, so a left slop on any cell but the first
   * takes its neighbour's own drawn right edge.
   *
   * The consequence is that the **middle cell is 36 × 44 rather than 44 × 44**, and there is
   * no distribution that fixes it: the only eight points a middle cell could gain are ones
   * it takes from a neighbour, and a cell that looks pressable and is not is a worse defect
   * than one that is eight points narrow. Pinned here so it stays a decision — and so that
   * anyone who does find a better arrangement has a failing test telling them the outer
   * cells and the vertical target must not regress with it.
   */
  it('keeps the outer-edge slop rule at three, and says what that costs the middle', async () => {
    const view = await renderWithProviders(
      <IconToggle
        options={[
          { value: 'feed', icon: 'newspaper-outline', label: 'Feed' },
          { value: 'leaderboard', icon: 'trophy-outline', label: 'Leaderboard' },
          { value: 'people', icon: 'people-outline', label: 'People' },
        ]}
        value="feed"
        onChange={() => {}}
        label="Feed mode"
      />,
    );

    const [first, middle, last] = view.getAllByRole('radio');
    const cell = StyleSheet.flatten(first!.props.style);

    expect(first!.props.hitSlop).toEqual({ ...SLOP, left: theme.space[2], right: 0 });
    expect(middle!.props.hitSlop).toEqual({ ...SLOP, left: 0, right: 0 });
    expect(last!.props.hitSlop).toEqual({ ...SLOP, left: 0, right: theme.space[2] });

    // Every cell reaches the target vertically, which is the axis a thumb misses on.
    for (const option of [first, middle, last]) {
      expect(tall(cell.height, option!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
    }
    // The two outer cells reach it horizontally as well.
    expect(wide(cell.width, first!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
    expect(wide(cell.width, last!.props.hitSlop)).toBeGreaterThanOrEqual(TARGET);
    // The middle one does not, and takes nothing from either neighbour to try.
    expect(wide(cell.width, middle!.props.hitSlop)).toBe(cell.width);
  });
});


describe('SectionHeader', () => {
  it('lets the trailing action fill the 44pt row it sits in', async () => {
    const view = await renderWithProviders(
      <SectionHeader title="Recent searches" actionLabel="Clear" onPressAction={() => {}} />,
    );
    const action = view.getByRole('button', { name: 'Clear' });

    expect(StyleSheet.flatten(action.props.style).minHeight).toBe(TARGET);
    expect(action.props.hitSlop).toBe(theme.space[2]);
  });
});

describe('MediumSelector’s option sheet', () => {
  it('dims the status bar on Android and clears the bottom inset', async () => {
    const view = await renderWithProviders(<MediumSelector value="movies" onChange={() => {}} />);
    await fireEvent.press(view.getByLabelText('Showing Movies'));

    // `Sheet`'s treatment: without it an Android modal lays out under the status bar's
    // height and the scrim stops short of the top of the screen. Found by type, the way
    // `WhereToWatch.test.tsx` reaches a Modal: there is no query for one.
    const modal = view.root!.queryAll((node) => node.type === 'Modal')[0];
    expect(modal?.props.statusBarTranslucent).toBe(true);

    const sheet = view
      .root!.queryAll((node) => node.type === 'View')
      .map((node) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>)
      .find((style) => style && 'borderTopLeftRadius' in style);
    // `renderWithProviders` reports a 34pt bottom inset; the padding is that plus a
    // gutter, and never less than the `space[10]` the sheet always had.
    expect(sheet?.paddingBottom).toBe(Math.max(34 + theme.space[4], theme.space[10]));
    expect(sheet?.paddingBottom).toBeGreaterThanOrEqual(theme.space[10]);
  });
});
