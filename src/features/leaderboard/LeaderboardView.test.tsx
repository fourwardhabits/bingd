import { fireEvent, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { medal as medalTokens, theme } from '@/ui/tokens';

import { LeaderboardView } from './LeaderboardView';
import { orderBoard, type LeaderboardEntry } from './use-leaderboard';

/**
 * **The Leaderboard's final polish** (founder, 2026-11-04): first place carries a small
 * Amber trophy that leaves the row exactly as it was.
 *
 * **Its categories and time range** behind one filter icon and sheet since the header
 * consistency pass (founder spec, 2026-11-22).
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

const board = (
  entries: LeaderboardEntry[],
  onChangeMetric = jest.fn(),
  onChangeTimeframe = jest.fn(),
) =>
  render(
    <LeaderboardView
      metric="titles"
      onChangeMetric={onChangeMetric}
      timeframe="month"
      onChangeTimeframe={onChangeTimeframe}
      entries={entries}
      standing={undefined}
      loading={false}
      onPressPerson={() => {}}
    />,
  );

/**
 * **What and when, behind one filter icon** (header consistency, founder spec 2026-11-22):
 * the two dropdowns became `FilterIconButton`, a line naming both choices, and one sheet
 * (`LeaderboardFilterSheet`) holding the four types and the two periods as radio chips.
 */
describe('the filters', () => {
  const openSheet = async (view: Awaited<ReturnType<typeof board>>) => {
    await fireEvent.press(view.getByTestId('leaderboard-filter-button'));
    return {
      type: within(await view.findByLabelText('Type')),
      period: within(view.getByLabelText('Time period')),
    };
  };

  it('is one 44pt icon beside a line naming both choices, on the default board', async () => {
    const view = await board([]);
    const filters = view.getByTestId('leaderboard-filters');
    const button = within(filters).getByTestId('leaderboard-filter-button');
    expect(button.props.accessibilityLabel).toBe('Leaderboard filters: All Titles, This month');
    expect(button.props.accessibilityHint).toBe('Opens the title type and time period');
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({ width: 44, height: 44 });
    expect(view.queryByTestId('leaderboard-filter-button-count')).toBeNull();
    expect(view.queryAllByRole('menuitem')).toHaveLength(0);
    expect(view.queryAllByRole('tab')).toHaveLength(0);

    const summary = within(filters).getByTestId('leaderboard-filter-summary', {
      includeHiddenElements: true,
    });
    for (const word of ['All Titles', 'This month']) {
      const text = within(summary).getByText(word, { includeHiddenElements: true });
      expect((StyleSheet.flatten(text.props.style) as TextStyle).color).toBe(
        theme.text.secondary,
      );
    }
  });

  it('counts and colours what is not the default', async () => {
    const view = await render(
      <LeaderboardView
        metric="reviews"
        onChangeMetric={jest.fn()}
        timeframe="all_time"
        onChangeTimeframe={jest.fn()}
        entries={[]}
        standing={undefined}
        loading={false}
        onPressPerson={() => {}}
      />,
    );
    const button = view.getByTestId('leaderboard-filter-button');
    expect(button.props.accessibilityLabel).toBe(
      'Leaderboard filters: Reviews, All time, 2 on',
    );
    expect(button.props.accessibilityState).toMatchObject({ selected: true });
    expect(
      within(
        view.getByTestId('leaderboard-filter-button-count', { includeHiddenElements: true }),
      ).getByText('2', { includeHiddenElements: true }),
    ).toBeTruthy();
    const summary = view.getByTestId('leaderboard-filter-summary', {
      includeHiddenElements: true,
    });
    for (const word of ['Reviews', 'All time']) {
      const text = within(summary).getByText(word, { includeHiddenElements: true });
      expect((StyleSheet.flatten(text.props.style) as TextStyle).color).toBe(
        theme.semantic.action,
      );
    }
  });

  it('opens one sheet with the four types and the two periods, the current ones chosen', async () => {
    const view = await board([]);
    const { type, period } = await openSheet(view);

    expect(type.getAllByRole('radio').map((item) => item.props.accessibilityLabel)).toEqual([
      'All Titles',
      'Movies',
      'TV Shows',
      'Reviews',
    ]);
    expect(period.getAllByRole('radio').map((item) => item.props.accessibilityLabel)).toEqual([
      'This month',
      'All time',
    ]);
    expect(
      type.getByRole('radio', { name: 'All Titles' }).props.accessibilityState,
    ).toMatchObject({
      selected: true,
    });
    expect(
      period.getByRole('radio', { name: 'This month' }).props.accessibilityState,
    ).toMatchObject({ selected: true });
  });

  it('chooses another type and period, and does not report the current ones again', async () => {
    const onChangeMetric = jest.fn();
    const onChangeTimeframe = jest.fn();
    const view = await board([], onChangeMetric, onChangeTimeframe);
    const { type, period } = await openSheet(view);

    await fireEvent.press(type.getByRole('radio', { name: 'All Titles' }));
    await fireEvent.press(period.getByRole('radio', { name: 'This month' }));
    expect(onChangeMetric).not.toHaveBeenCalled();
    expect(onChangeTimeframe).not.toHaveBeenCalled();

    await fireEvent.press(type.getByRole('radio', { name: 'Reviews' }));
    await fireEvent.press(period.getByRole('radio', { name: 'All time' }));
    expect(onChangeMetric).toHaveBeenCalledWith('reviews');
    expect(onChangeTimeframe).toHaveBeenCalledWith('all_time');
  });

  it('closes on Close', async () => {
    const view = await board([]);
    await openSheet(view);
    await fireEvent.press(view.getByTestId('leaderboard-filter-close-press'));
    expect(view.queryByLabelText('Type')).toBeNull();
  });
});

/**
 * **Gold, silver and bronze, filled** (founder Preview QA, 2026-11-07): ranks 1–3 are a
 * filled medal with the number centred on it in the colour certified for that fill;
 * fourth onward is the number, centred in the same column.
 */
describe('the medals', () => {
  const medal = (view: Awaited<ReturnType<typeof board>>, rank: number) =>
    view.queryAllByTestId(`leaderboard-medal-${rank}`, { includeHiddenElements: true });

  it('fills 1, 2 and 3 gold, silver and bronze, and leaves 4 a number', async () => {
    const view = await board([
      person(),
      person({ id: 'u-2', username: 'bea', name: 'Bea', rank: 2, count: 7 }),
      person({ id: 'u-3', username: 'cy', name: 'Cy', rank: 3, count: 5 }),
      person({ id: 'u-4', username: 'dee', name: 'Dee', rank: 4, count: 2 }),
    ]);
    const fill = (rank: number) =>
      (StyleSheet.flatten(medal(view, rank)[0]!.props.style) as ViewStyle).backgroundColor;
    const numeral = (rank: number) =>
      (
        StyleSheet.flatten(
          within(medal(view, rank)[0]!).getByText(String(rank), { includeHiddenElements: true })
            .props.style,
        ) as TextStyle
      ).color;
    expect([fill(1), fill(2), fill(3)]).toEqual([
      medalTokens.gold.fill,
      medalTokens.silver.fill,
      medalTokens.bronze.fill,
    ]);
    expect([numeral(1), numeral(2), numeral(3)]).toEqual([
      medalTokens.gold.numeral,
      medalTokens.silver.numeral,
      medalTokens.bronze.numeral,
    ]);
    expect(medal(view, 4)).toHaveLength(0);
    // The number is on the medal and is not drawn a second time beside it.
    expect(view.getAllByText('1', { includeHiddenElements: true })).toHaveLength(1);
    expect(view.getByText('4')).toBeTruthy();
    expect(view.queryByTestId('leaderboard-trophy', { includeHiddenElements: true })).toBeNull();
  });

  it('shares a medal across a tie, and the next rank skips (1, 2, 2, 4)', async () => {
    const view = await board([
      person(),
      person({ id: 'u-2', username: 'bea', name: 'Bea', rank: 2, count: 7 }),
      person({ id: 'u-3', username: 'cy', name: 'Cy', rank: 2, count: 7 }),
      person({ id: 'u-4', username: 'dee', name: 'Dee', rank: 4, count: 2 }),
    ]);
    expect(medal(view, 2)).toHaveLength(2);
    expect(medal(view, 3)).toHaveLength(0);
    expect(view.getByRole('button', { name: /^Number 4, Dee,/ })).toBeTruthy();
  });

  it('keeps every rank in one column, medal or number', async () => {
    const view = await board([
      person(),
      person({ id: 'u-4', username: 'dee', name: 'Dee', rank: 4, count: 2 }),
    ]);
    const medalStyle = StyleSheet.flatten(medal(view, 1)[0]!.props.style) as ViewStyle;
    expect(medalStyle.width).toBe(26);
    expect(medalStyle.position).toBeUndefined();
    const rank = StyleSheet.flatten(view.getByText('4').props.style) as TextStyle;
    expect(rank.textAlign).toBe('center');
    // Medal and number share one centred column.
    let cell = view.getByText('4').parent;
    while (cell && (StyleSheet.flatten(cell.props.style) as ViewStyle | undefined)?.minWidth === undefined) cell = cell.parent;
    expect(StyleSheet.flatten(cell!.props.style)).toMatchObject({ minWidth: 26, alignItems: 'center' });
  });

  it('is silent to a screen reader, which already hears "Number 1"', async () => {
    const view = await board([person()]);

    expect(view.queryByTestId('leaderboard-medal-1')).toBeNull();
    expect(view.getByRole('button', { name: /^Number 1, Ada,/ })).toBeTruthy();
  });
});

describe('the pinned standing', () => {
  /** Independent review 1: a four-digit standing must not wrap in a 26pt column. */
  it('lets a long rank widen its column rather than wrap', async () => {
    const view = await render(
      <LeaderboardView
        metric="titles"
        onChangeMetric={jest.fn()}
        timeframe="month"
        onChangeTimeframe={jest.fn()}
        entries={[person()]}
        standing={{ rank: 1000, count: 3, entrants: 1200 }}
        loading={false}
        onPressPerson={() => {}}
      />,
    );
    const rank = view.getByText('1000');
    let node = rank.parent;
    while (node && (StyleSheet.flatten(node.props.style) as ViewStyle | undefined)?.minWidth === undefined) node = node.parent;
    const cell = StyleSheet.flatten(node!.props.style) as ViewStyle;
    expect(cell.minWidth).toBe(26);
    expect(cell.width).toBeUndefined();
  });
});

/**
 * **A fixed order for ties** (marquee cohesion sprint): the server's rank, then handle, then
 * id — the server's own page order, restated because its final select promises none.
 */
describe('orderBoard', () => {
  const row = (id: string, username: string, rank: number) => ({ id, username, rank });

  it('orders by rank, then handle, then id, and never changes a rank', () => {
    const rows = [
      row('c', 'zed', 2),
      row('b', 'amy', 2),
      row('a', 'top', 1),
      row('e', 'amy', 2),
      row('d', 'low', 4),
    ];
    const ordered = orderBoard(rows);
    expect(ordered.map((r) => r.id)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(ordered.map((r) => r.rank)).toEqual([1, 2, 2, 2, 4]);
    // The same answer whatever order the rows arrive in.
    expect(orderBoard([...rows].reverse()).map((r) => r.id)).toEqual(['a', 'b', 'e', 'c', 'd']);
    // The input is left alone.
    expect(rows[0]!.id).toBe('c');
  });
});
