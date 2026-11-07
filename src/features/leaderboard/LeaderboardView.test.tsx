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
 * **Its categories and time range** (founder, nav cohesion sprint, 2026-11-06): All |
 * Movies | TV | Reviews as four equal segments that always fit, the full names spoken, and
 * This month / All time as a compact filter under them.
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

const tabs = (view: Awaited<ReturnType<typeof board>>) => view.getAllByRole('tab');

/**
 * **What and when, two dropdowns side by side** (founder Preview QA, 2026-11-07): the
 * content type is a dropdown beside the time range, no longer four segments.
 */
describe('the content type', () => {
  it('is a dropdown of the four, named in full, beside the time range', async () => {
    const view = await board([]);
    const filters = view.getByTestId('leaderboard-filters');
    expect(StyleSheet.flatten(filters.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    const metric = within(filters).getByLabelText('Showing All Titles');
    expect(within(filters).getByLabelText('Showing This month')).toBeTruthy();
    expect(view.queryAllByRole('tab')).toHaveLength(0);
    // A 44pt target, in the same compact type as the time range.
    expect(StyleSheet.flatten(metric.props.style).minHeight).toBe(44);
    expect(
      (StyleSheet.flatten(within(metric).getByText('All Titles').props.style) as TextStyle).fontSize,
    ).toBe(14);

    await fireEvent.press(metric);
    const items = await view.findAllByRole('menuitem');
    expect(items.map((item) => item.props.accessibilityLabel)).toEqual([
      'All Titles',
      'Movies',
      'TV Shows',
      'Reviews',
    ]);
    expect(items[0]!.props.accessibilityState).toMatchObject({ selected: true });
  });

  it('chooses another, and does not report the current one again', async () => {
    const onChangeMetric = jest.fn();
    const view = await board([], onChangeMetric);
    await fireEvent.press(view.getByLabelText('Showing All Titles'));
    await fireEvent.press((await view.findAllByRole('menuitem'))[0]!);
    expect(onChangeMetric).not.toHaveBeenCalled();

    await fireEvent.press(view.getByLabelText('Showing All Titles'));
    await fireEvent.press(await view.findByRole('menuitem', { name: 'Reviews' }));
    expect(onChangeMetric).toHaveBeenCalledWith('reviews');
  });
});

describe('the time range', () => {
  it('is a compact filter that opens a two-line menu, and chooses All time', async () => {
    const onChangeTimeframe = jest.fn();
    const view = await board([], jest.fn(), onChangeTimeframe);

    const filter = view.getByLabelText('Showing This month');
    expect(filter.props.accessibilityHint).toBe('Choose a time range');
    expect(
      (StyleSheet.flatten(within(filter).getByText('This month').props.style) as TextStyle)
        .fontSize,
    ).toBe(14);

    await fireEvent.press(filter);
    const items = await view.findAllByRole('menuitem');
    expect(items.map((item) => item.props.accessibilityLabel)).toEqual(['This month', 'All time']);
    expect(items[0]!.props.accessibilityState).toMatchObject({ selected: true });

    await fireEvent.press(items[1]!);
    expect(onChangeTimeframe).toHaveBeenCalledWith('all_time');
  });

  it('does not report the chosen range again as a change', async () => {
    const onChangeTimeframe = jest.fn();
    const view = await board([], jest.fn(), onChangeTimeframe);

    await fireEvent.press(view.getByLabelText('Showing This month'));
    await fireEvent.press((await view.findAllByRole('menuitem'))[0]!);
    expect(onChangeTimeframe).not.toHaveBeenCalled();
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
