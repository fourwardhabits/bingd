import { fireEvent, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { LeaderboardView } from './LeaderboardView';
import type { LeaderboardEntry } from './use-leaderboard';

/**
 * **The Leaderboard's final polish** (founder, 2026-11-04): the metric chips are one row
 * that scrolls sideways, led by All Titles, and first place carries a small Amber trophy
 * that leaves the row exactly as it was.
 */

const person = (over: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  id: 'u-1',
  username: 'ada',
  name: 'Ada',
  avatarUri: null,
  isPrivate: false,
  viewable: true,
  count: 9,
  rank: 1,
  isYou: false,
  matchPercent: null,
  sharedCount: 0,
  ...over,
});

const board = (entries: LeaderboardEntry[], onChangeMetric = jest.fn()) =>
  render(
    <LeaderboardView
      metric="titles"
      onChangeMetric={onChangeMetric}
      timeframe="month"
      entries={entries}
      standing={undefined}
      loading={false}
      onPressPerson={() => {}}
    />,
  );

const chipNames = (view: Awaited<ReturnType<typeof board>>) =>
  within(view.getByLabelText('Leaderboard metric'))
    .getAllByRole('button')
    .map((chip) => String(within(chip).getByText(/\S/).props.children));

describe('the metric chips', () => {
  it('are All Titles, Movies, TV Shows and Reviews, in that order', async () => {
    const view = await board([]);

    expect(chipNames(view)).toEqual(['All Titles', 'Movies', 'TV Shows', 'Reviews']);
    expect(view.queryByText('Titles')).toBeNull();
  });

  it('sit in one row that scrolls sideways and never wraps', async () => {
    const view = await board([]);
    const row = view.getByLabelText('Leaderboard metric');

    expect(row.props.horizontal).toBe(true);
    const content = StyleSheet.flatten(row.props.contentContainerStyle) as ViewStyle;
    expect(content.flexDirection).toBe('row');
    expect(content.flexWrap ?? 'nowrap').toBe('nowrap');
  });

  it('keep Reviews reachable and choosable, and mark the current one', async () => {
    const onChangeMetric = jest.fn();
    const view = await board([], onChangeMetric);
    const chips = within(view.getByLabelText('Leaderboard metric')).getAllByRole('button');

    expect(chips.map((chip) => Boolean(chip.props.accessibilityState?.selected))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await fireEvent.press(view.getByText('Reviews'));
    expect(onChangeMetric).toHaveBeenCalledWith('reviews');
  });
});

describe('the first-place trophy', () => {
  const trophies = (view: Awaited<ReturnType<typeof board>>) =>
    view.queryAllByTestId('leaderboard-trophy', { includeHiddenElements: true });

  it('is a 16pt Amber trophy on first place and nowhere else', async () => {
    const view = await board([
      person(),
      person({ id: 'u-2', username: 'bea', name: 'Bea', rank: 2, count: 7 }),
      person({ id: 'u-3', username: 'cy', name: 'Cy', rank: 3, count: 5 }),
    ]);

    expect(trophies(view)).toHaveLength(1);
    const [trophy] = trophies(view);
    const style = StyleSheet.flatten(trophy!.props.style) as TextStyle;
    expect(style.color).toBe(theme.semantic.emphasis);
    expect(style.fontSize).toBe(16);
  });

  it('is on every row tied for first, because it keys on rank', async () => {
    const view = await board([
      person(),
      person({ id: 'u-2', username: 'bea', name: 'Bea', rank: 1 }),
      person({ id: 'u-3', username: 'cy', name: 'Cy', rank: 3, count: 5 }),
    ]);

    expect(trophies(view)).toHaveLength(2);
  });

  it('takes no space in the row, so nothing on it moves', async () => {
    const view = await board([person()]);
    const style = StyleSheet.flatten(trophies(view)[0]!.props.style) as ViewStyle;

    expect(style.position).toBe('absolute');
    // The rank keeps its column and stays the first thing drawn in the row.
    const rank = StyleSheet.flatten(view.getByText('1').props.style) as TextStyle;
    expect(rank.minWidth).toBe(24);
    expect(rank.textAlign).toBe('right');
  });

  it('is silent to a screen reader, which already hears "Number 1"', async () => {
    const view = await board([person()]);

    expect(view.queryByTestId('leaderboard-trophy')).toBeNull();
    expect(view.getByRole('button', { name: /^Number 1, Ada,/ })).toBeTruthy();
  });
});
