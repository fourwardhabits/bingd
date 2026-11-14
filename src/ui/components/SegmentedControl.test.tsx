import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { SegmentedControl } from './SegmentedControl';

/**
 * **Each option answers 44pt, inside the track** (design-system v3 A.2 #14). Options are drawn
 * 40pt in a track with 2pt of padding; the slop gives that padding back above and below, and
 * slop only answers inside the parent, so it must not exceed the track's padding.
 */
describe('SegmentedControl', () => {
  it('lifts each 40pt option to 44 with slop that stays inside the track', async () => {
    await render(
      <SegmentedControl
        label="Visibility"
        options={[
          { id: 'public', label: 'Public' },
          { id: 'private', label: 'Private' },
        ]}
        value="public"
        onChange={() => {}}
      />,
    );

    const track = StyleSheet.flatten(screen.getByLabelText('Visibility').props.style);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);

    expect(track.padding).toBe(2);
    for (const option of options) {
      const drawn = StyleSheet.flatten(option.props.style);
      const slop = option.props.hitSlop as { top: number; bottom: number };

      expect(drawn.minHeight).toBe(40);
      expect(slop).toEqual({ top: 2, bottom: 2 });
      expect(slop.top).toBeLessThanOrEqual(track.padding);
      expect(slop.bottom).toBeLessThanOrEqual(track.padding);
      expect(drawn.minHeight + slop.top + slop.bottom).toBe(theme.layout.minTapTarget);
    }

    // The track itself holds the full target: two paddings plus the option's height.
    expect(2 * track.padding + StyleSheet.flatten(options[0]!.props.style).minHeight).toBe(
      theme.layout.minTapTarget,
    );
  });
});
