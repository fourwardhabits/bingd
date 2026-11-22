import { fireEvent, within } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { LeaderboardFilterSheet } from './LeaderboardFilterSheet';
import { LEADERBOARD_METRICS, LEADERBOARD_TIMEFRAMES } from './use-leaderboard';

/**
 * **The board's filter sheet** (header consistency, founder spec 2026-11-22): the title type
 * and the time period in one sheet, in the Collection sheet's `Section` / `Option` grammar,
 * applied on the press and closed with the quiet Close.
 */
const sheet = (over: Partial<Parameters<typeof LeaderboardFilterSheet>[0]> = {}) => {
  const props = {
    metric: 'titles' as const,
    onChangeMetric: jest.fn(),
    timeframe: 'month' as const,
    onChangeTimeframe: jest.fn(),
    onClose: jest.fn(),
    ...over,
  };
  return { props, view: render(<LeaderboardFilterSheet {...props} />) };
};

describe('LeaderboardFilterSheet', () => {
  it('offers exactly the board’s own values, as two radio groups', async () => {
    const view = await sheet().view;

    const type = within(view.getByLabelText('Type'));
    const period = within(view.getByLabelText('Time period'));
    expect(type.getAllByRole('radio').map((chip) => chip.props.accessibilityLabel)).toEqual(
      LEADERBOARD_METRICS.map((option) => option.label),
    );
    expect(period.getAllByRole('radio').map((chip) => chip.props.accessibilityLabel)).toEqual(
      LEADERBOARD_TIMEFRAMES.map((option) => option.label),
    );
    expect(view.getByLabelText('Type').props.accessibilityRole).toBe('radiogroup');
    expect(view.getByLabelText('Time period').props.accessibilityRole).toBe('radiogroup');
    expect(view.getByText('TYPE')).toBeTruthy();
    expect(view.getByText('TIME PERIOD')).toBeTruthy();
    expect(view.getByRole('header', { name: 'Filters' })).toBeTruthy();
  });

  it('marks the current choice in each group, and only it', async () => {
    const view = await sheet({ metric: 'tv', timeframe: 'all_time' }).view;

    const selected = (group: string) =>
      within(view.getByLabelText(group))
        .getAllByRole('radio')
        .filter((chip) => chip.props.accessibilityState?.selected)
        .map((chip) => chip.props.accessibilityLabel);
    expect(selected('Type')).toEqual(['TV Shows']);
    expect(selected('Time period')).toEqual(['All time']);
  });

  it('reports a new choice on the press and stays open', async () => {
    const { props, view: pending } = sheet();
    const view = await pending;

    await fireEvent.press(view.getByRole('radio', { name: 'Movies' }));
    await fireEvent.press(view.getByRole('radio', { name: 'All time' }));

    expect(props.onChangeMetric).toHaveBeenCalledWith('movies');
    expect(props.onChangeTimeframe).toHaveBeenCalledWith('all_time');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('does not report the choice already on as a change', async () => {
    const { props, view: pending } = sheet();
    const view = await pending;

    await fireEvent.press(view.getByRole('radio', { name: 'All Titles' }));
    await fireEvent.press(view.getByRole('radio', { name: 'This month' }));

    expect(props.onChangeMetric).not.toHaveBeenCalled();
    expect(props.onChangeTimeframe).not.toHaveBeenCalled();
  });

  it('gives every chip a 44pt target', async () => {
    const view = await sheet().view;

    for (const chip of view.getAllByRole('radio')) {
      const style = StyleSheet.flatten(chip.props.style) as ViewStyle;
      const slop = chip.props.hitSlop as typeof theme.layout.chipHitSlop;
      expect(Number(style.minHeight) + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
    }
  });

  it('closes on Close', async () => {
    const { props, view: pending } = sheet();
    const view = await pending;

    await fireEvent.press(view.getByTestId('leaderboard-filter-close-press'));

    expect(props.onClose).toHaveBeenCalled();
  });
});
