import { cleanup, fireEvent, within } from '@testing-library/react-native';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { renderWithProviders as render } from '@/test-utils/render';
import { medal as medalTokens, theme } from '@/ui/tokens';

import { LeaderboardView, timeframeOptions } from './LeaderboardView';
import { orderBoard, type LeaderboardEntry } from './use-leaderboard';

/**
 * **The Leaderboard's final polish** (founder, 2026-11-04): first place carries a small
 * Amber trophy that leaves the row exactly as it was.
 *
 * **Its category and time range** are a quiet dropdown and a switch under the LEADERBOARD
 * heading's row since the 2026-11-23 brief and its layout correction.
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

let mockWindow = { width: 390, height: 800, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

/**
 * **Category ▾ on the left, All time | This month on the right** (founder brief 2026-11-23,
 * and its layout correction): row 2 of the board's header. LEADERBOARD is row 1, beside the
 * mode toggle, drawn by the Feed screen (`FeedMode.test.tsx`). The filter icon, its count,
 * the summary line and the combined sheet are gone.
 */
describe('the controls', () => {
  beforeEach(() => {
    mockWindow = { width: 390, height: 800, scale: 2, fontScale: 1 };
  });

  const timeframeCells = (view: Awaited<ReturnType<typeof board>>) =>
    within(view.getByTestId('leaderboard-timeframe')).getAllByRole('radio');

  it('draws the category dropdown and the timeframe switch, no heading and no filter icon', async () => {
    const view = await board([]);
    const controls = view.getByTestId('leaderboard-controls');
    const category = within(controls).getByTestId('leaderboard-category');
    expect(category.props.accessibilityLabel).toBe('Showing All Titles');
    expect(categoryText(view)).toBe('All Titles');
    expect(timeframeCells(view).map((cell) => cell.props.accessibilityLabel)).toEqual([
      'All time',
      'This month',
    ]);
    // The heading is the Feed screen's, on the toggle's row: never a second one here.
    expect(view.queryByText('LEADERBOARD')).toBeNull();
    expect(view.queryByTestId('leaderboard-heading')).toBeNull();

    expect(view.queryByTestId('leaderboard-filter-button')).toBeNull();
    expect(view.queryByTestId('leaderboard-filter-button-count')).toBeNull();
    expect(view.queryByTestId('leaderboard-filter-summary')).toBeNull();
    expect(view.queryByText(/·/)).toBeNull();
  });

  it('is a quiet neutral dropdown, so it does not compete with the heading, and the compact switch', async () => {
    const view = await board([]);
    // `MediumSelector` at `filter`: Inter Medium 14pt, secondary ink, a small chevron. Not
    // the Maroon serif marquee, and no ground or border of its own.
    const label = within(view.getByTestId('leaderboard-category')).getByText('All Titles');
    const style = StyleSheet.flatten(label.props.style) as TextStyle;
    expect(style.color).toBe(theme.text.secondary);
    expect(style.color).not.toBe(theme.semantic.action);
    expect(style.fontFamily).toBe(theme.typography.subhead.fontFamily);
    expect(style.fontSize).toBe(14);
    const button = StyleSheet.flatten(view.getByTestId('leaderboard-category').props.style) as ViewStyle;
    expect(button.backgroundColor).toBeUndefined();
    expect(button.borderWidth).toBeUndefined();
    // The switch's chosen half: Parchment ground, Maroon word, nothing counted or badged.
    const [allTime, thisMonth] = timeframeCells(view);
    expect(allTime!.props.accessibilityState).toMatchObject({ selected: false });
    expect(thisMonth!.props.accessibilityState).toMatchObject({ selected: true });
    expect(
      within(view.getByTestId('leaderboard-timeframe')).queryAllByTestId(/compact-switch-indicator/),
    ).toHaveLength(0);
  });

  it('lists the four categories in order, marks the current one, and applies a choice at once', async () => {
    const onChangeMetric = jest.fn();
    const view = await board([], onChangeMetric);
    await fireEvent.press(view.getByTestId('leaderboard-category'));
    const menu = within(await view.findByTestId('leaderboard-category-menu'));
    expect(
      menu
        .getAllByRole('menuitem')
        .map((item) => [item.props.accessibilityLabel, Boolean(item.props.accessibilityState?.selected)]),
    ).toEqual([
      ['All Titles', true],
      ['Movies', false],
      ['TV Shows', false],
      ['Reviews', false],
    ]);

    await fireEvent.press(menu.getByRole('menuitem', { name: 'All Titles' }));
    expect(onChangeMetric).not.toHaveBeenCalled();

    await fireEvent.press(view.getByTestId('leaderboard-category'));
    await fireEvent.press(
      within(await view.findByTestId('leaderboard-category-menu')).getByRole('menuitem', {
        name: 'TV Shows',
      }),
    );
    expect(onChangeMetric).toHaveBeenCalledWith('tv');
  });

  it('names whichever category is showing on the closed control', async () => {
    for (const [metric, label] of [
      ['titles', 'All Titles'],
      ['movies', 'Movies'],
      ['tv', 'TV Shows'],
      ['reviews', 'Reviews'],
    ] as const) {
      const view = await render(
        <LeaderboardView
          metric={metric}
          onChangeMetric={jest.fn()}
          timeframe="all_time"
          onChangeTimeframe={jest.fn()}
          entries={[]}
          standing={undefined}
          loading={false}
          onPressPerson={() => {}}
        />,
      );
      expect(categoryText(view)).toBe(label);
      expect(view.getByTestId('leaderboard-category').props.accessibilityLabel).toBe(
        `Showing ${label}`,
      );
      await cleanup();
    }
  });

  it('switches the timeframe, and does not report the one showing again', async () => {
    const onChangeTimeframe = jest.fn();
    const view = await board([], jest.fn(), onChangeTimeframe);
    await fireEvent.press(within(view.getByTestId('leaderboard-timeframe')).getByRole('radio', { name: 'This month' }));
    expect(onChangeTimeframe).not.toHaveBeenCalled();
    await fireEvent.press(within(view.getByTestId('leaderboard-timeframe')).getByRole('radio', { name: 'All time' }));
    expect(onChangeTimeframe).toHaveBeenCalledWith('all_time');
  });

  it('puts the controls directly above the rows', async () => {
    const view = await board([person()]);
    const ids = view.root!
      .queryAll((node) =>
        ['leaderboard-controls', 'leaderboard-content'].includes(String(node.props.testID)),
      )
      .map((node) => node.props.testID);
    expect(ids.filter((id, i) => ids.indexOf(id) === i)).toEqual([
      'leaderboard-controls',
      'leaderboard-content',
    ]);
  });
});

/**
 * **At 320pt, 360pt and a large text size** — without a layout engine, from the fonts.
 *
 * The row wraps: the dropdown on the left gutter, the switch on the right one, dropping onto
 * a line of its own when the two do not share one. So what has to hold is (a) the row is
 * that wrapping row, and (b) each piece on its own fits the row at every width and size the
 * app supports — the switch shortening This month to Month only where even alone it would
 * not (`timeframeOptions`).
 *
 * Advance widths, Inter Medium 14pt, from the bundled TTF (and the switch measured in
 * Chromium through the web harness):
 *
 *     switch, 100%    49.7 + 74.9 text, + 42 padding/outline      = 166.5pt
 *     switch, 200%    99.3 + 149.7 + 42 = 291  > 288 (320 - 2 x 16) -> "Month": 227pt
 *     TV Shows ▾      67.9 + 8 + 16 chevron = 91.9 (the widest category)
 *
 *     320pt, 100%: 91.9 + 8 + 166.5 = 266.4 <= 288, one line for every category
 */
describe('the control row at 320pt, 360pt and large text', () => {
  const ROOM = (width: number) => width - 2 * theme.layout.gutter;

  it('is one wrapping row on the gutters, with no top padding of its own', async () => {
    const view = await board([]);
    const row = view.getByTestId('leaderboard-controls');
    const style = StyleSheet.flatten(row.props.style as ViewStyle);
    expect(style).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      paddingHorizontal: theme.layout.gutter,
      columnGap: GAP,
      minHeight: theme.layout.minTapTarget,
    });
    expect(style.paddingTop ?? 0).toBe(0);
    // The switch keeps the right gutter on its own line too.
    expect(
      StyleSheet.flatten(view.getByTestId('leaderboard-timeframe').props.style as ViewStyle),
    ).toMatchObject({ marginLeft: 'auto', maxWidth: '100%' });
  });

  it('keeps This month wherever the switch fits on its own, and says Month only where it does not', () => {
    expect(timeframeOptions(320, 1).map((o) => o.label)).toEqual(['All time', 'This month']);
    expect(timeframeOptions(360, 1).map((o) => o.label)).toEqual(['All time', 'This month']);
    expect(timeframeOptions(320, 1.5).map((o) => o.label)).toEqual(['All time', 'This month']);
    expect(timeframeOptions(360, 2).map((o) => o.label)).toEqual(['All time', 'This month']);
    expect(timeframeOptions(320, 2).map((o) => o.label)).toEqual(['All time', 'Month']);
    // The value is the same either way.
    expect(timeframeOptions(320, 2).map((o) => o.id)).toEqual(['all_time', 'month']);
  });

  it('fits the switch inside the row at every width and size, from the font', () => {
    const switchWidth = (labels: readonly { label: string }[], scale: number) =>
      labels.reduce((sum, o) => sum + Math.max(44, EM[o.label]! * 14 * 1.04 * scale + 16), 0) + 10;
    for (const width of [320, 360, 390]) {
      for (const scale of [1, 1.3, 1.5, 2]) {
        expect({ width, scale, w: switchWidth(timeframeOptions(width, scale), scale) <= ROOM(width) }).toEqual({
          width,
          scale,
          w: true,
        });
      }
    }
  });

  it('shares one line at 100% on 320pt and 360pt for every category', () => {
    const switchAt1 = EM['All time']! * 14 + 16 + EM['This month']! * 14 + 16 + 10;
    for (const width of [320, 360]) {
      for (const label of ['All Titles', 'Movies', 'TV Shows', 'Reviews']) {
        // The label at 14pt, the selector's 8pt gap and its 16pt chevron.
        const dropdown = EM[label]! * 14 * 1.04 + 8 + 16;
        expect({ width, label, fits: dropdown + GAP + switchAt1 <= ROOM(width) }).toEqual({
          width,
          label,
          fits: true,
        });
      }
    }
  });

  it('keeps the dropdown inside the row at 200% text on 320pt', () => {
    for (const label of ['All Titles', 'Movies', 'TV Shows', 'Reviews']) {
      expect(EM[label]! * 14 * 1.04 * 2 + 8 + 16).toBeLessThanOrEqual(ROOM(320));
    }
  });

  it('draws the short switch on a 320pt phone at 200% text, and the long one at 360pt', async () => {
    mockWindow = { width: 320, height: 700, scale: 2, fontScale: 2 };
    const narrow = await board([]);
    expect(timeframeCellsOf(narrow)).toEqual(['All time', 'Month']);
    await cleanup();
    mockWindow = { width: 360, height: 780, scale: 2, fontScale: 2 };
    const wide = await board([]);
    expect(timeframeCellsOf(wide)).toEqual(['All time', 'This month']);
  });
});

/** Em widths from the bundled Inter Medium TTF (the switch's and the dropdown's face). */
const EM: Record<string, number> = {
  'All time': 3.547,
  'This month': 5.347,
  Month: 3.06,
  'All Titles': 4.103,
  Movies: 3.469,
  'TV Shows': 4.848,
  Reviews: 4.017,
};

/** The control row's least gap between the dropdown and the switch. */
const GAP = theme.space[2];

/** The words on the closed category dropdown. */
const categoryText = (view: Awaited<ReturnType<typeof board>>) =>
  view
    .getByTestId('leaderboard-category')
    .queryAll((node: { type: unknown; props: { children?: unknown } }) =>
      node.type === 'Text' && typeof node.props.children === 'string',
    )
    .map((node: { props: { children?: unknown } }) => node.props.children)
    .find((text: unknown) => typeof text === 'string' && text.length > 1);

const timeframeCellsOf = (view: Awaited<ReturnType<typeof board>>) =>
  within(view.getByTestId('leaderboard-timeframe'))
    .getAllByRole('radio')
    .map((cell) => cell.props.accessibilityLabel as string);

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
