import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { StatRow, type StatItem } from './StatRow';

/**
 * The profile's four stats — Followers, Following, Movies, TV Shows — with a light rule
 * back between them (founder, 2026-11-12), and nothing else about the row changed.
 *
 * The rule is the title page's score-card hairline (`ImmersiveScores`' `divided`), drawn
 * shorter than the row: what is asserted is where it sits, what it looks like, and that
 * the four cells are still the same 44pt targets with the same type in them.
 */

const onPress = {
  followers: jest.fn(),
  following: jest.fn(),
  movies: jest.fn(),
  seasons: jest.fn(),
};

const STATS: [StatItem, StatItem, StatItem, StatItem] = [
  { label: 'Followers', value: 12, onPress: onPress.followers, hint: 'Opens the list' },
  { label: 'Following', value: 34, onPress: onPress.following, hint: 'Opens the list' },
  { label: 'Movies', value: 210, onPress: onPress.movies, hint: 'Opens the list' },
  { label: 'TV Shows', value: 18, onPress: onPress.seasons, hint: 'Opens the list' },
];

/** The first match, or a failure that says so rather than a type error later. */
const first = <T,>(items: T[]): T => {
  const [item] = items;
  if (item === undefined) throw new Error('nothing matched');
  return item;
};

const draw = (stats: StatItem[] = STATS, centered = true) =>
  render(<StatRow centered={centered} stats={stats} />);

/** The row's own children in order, as `cell` or `rule`. */
const sequence = (view: Awaited<ReturnType<typeof draw>>) => {
  const row = first(view.getAllByTestId('stat-rule')).parent;
  const children = (row?.children ?? []) as { props?: { testID?: string } }[];
  return children.map((node) => (node.props?.testID === 'stat-rule' ? 'rule' : 'cell'));
};

describe('the rules', () => {
  it('sit between the four stats, and not before the first or after the last', async () => {
    const view = await draw();
    expect(view.getAllByTestId('stat-rule')).toHaveLength(3);
    expect(sequence(view)).toEqual(['cell', 'rule', 'cell', 'rule', 'cell', 'rule', 'cell']);
  });

  it('draw none for a single stat', async () => {
    const view = await draw([STATS[0]]);
    expect(view.queryAllByTestId('stat-rule')).toHaveLength(0);
  });

  it('are the title page’s score-card hairline: doubled hairline width, hairline colour', async () => {
    const view = await draw();
    for (const rule of view.getAllByTestId('stat-rule')) {
      const style = StyleSheet.flatten(rule.props.style);
      expect(style.borderLeftWidth).toBe(StyleSheet.hairlineWidth * 2);
      expect(style.borderLeftColor).toBe(theme.border.hairline);
    }
  });

  it('are shorter than the row and centred in it, rather than a full-height border', async () => {
    const view = await draw();
    const style = StyleSheet.flatten(first(view.getAllByTestId('stat-rule')).props.style);
    expect(style.alignSelf).toBe('center');
    expect(typeof style.height).toBe('number');
    expect(style.height as number).toBeLessThan(theme.layout.minTapTarget);
    expect(style.height as number).toBeGreaterThan(0);
  });

  it('take no share of the row and nothing from a screen reader or a tap', async () => {
    const view = await draw();
    const rule = first(view.getAllByTestId('stat-rule'));
    const style = StyleSheet.flatten(rule.props.style);
    expect(style.flex).toBeUndefined();
    expect(style.flexGrow).toBeUndefined();
    expect(rule.props.pointerEvents).toBe('none');
    expect(rule.props.accessible).toBe(false);
    expect(rule.props.importantForAccessibility).toBe('no');
  });
});

describe('the four cells, unchanged', () => {
  it('are still whole 44pt targets, a quarter each, with their figure centred', async () => {
    const view = await draw();
    for (const stat of STATS) {
      const cell = view.getByRole('button', { name: `${stat.label}: ${stat.value}` });
      const style = StyleSheet.flatten(cell.props.style);
      expect(style.minHeight).toBe(theme.layout.minTapTarget);
      expect(style.flex).toBe(1);
      expect(style.alignItems).toBe('center');
      expect(style.justifyContent).toBe('center');
      // No border on the cell: the rule is its own view, so the target keeps its height.
      expect(style.borderLeftWidth).toBeUndefined();
    }
  });

  it('keep the left-aligned figure when the row is not centred', async () => {
    const view = await draw(STATS, false);
    const cell = view.getByRole('button', { name: 'Followers: 12' });
    expect(StyleSheet.flatten(cell.props.style).alignItems).toBe('flex-start');
  });

  it('still open what they opened, and say the hint', async () => {
    const view = await draw();
    await fireEvent.press(view.getByRole('button', { name: 'Movies: 210' }));
    expect(onPress.movies).toHaveBeenCalledTimes(1);
    expect(view.getByRole('button', { name: 'Followers: 12' }).props.accessibilityHint).toBe(
      'Opens the list',
    );
  });

  it('keep the figure in the headline style and the label in the footnote', async () => {
    const view = await draw();
    const figure = StyleSheet.flatten(view.getByText('210').props.style);
    const label = StyleSheet.flatten(view.getByText('Movies').props.style);
    expect(figure.fontSize).toBe(theme.typography.headline.fontSize);
    expect(label.fontSize).toBe(theme.typography.footnote.fontSize);
  });

  it('let large text wrap and grow the row rather than clip against the rule', async () => {
    const view = await draw();
    for (const stat of STATS) {
      expect(view.getByText(String(stat.value)).props.numberOfLines).toBeUndefined();
      expect(view.getByText(stat.label).props.numberOfLines).toBeUndefined();
    }
    const cell = StyleSheet.flatten(
      view.getByRole('button', { name: 'TV Shows: 18' }).props.style,
    );
    // A floor, never a ceiling: the cell is free to grow with the type in it.
    expect(cell.height).toBeUndefined();
    expect(cell.maxHeight).toBeUndefined();
  });

  it('is not a button when a stat leads nowhere', async () => {
    const view = await draw([{ label: 'Followers', value: 0 }, STATS[1]]);
    expect(view.queryByRole('button', { name: 'Followers: 0' })).toBeNull();
    expect(view.getByLabelText('Followers: 0')).toBeTruthy();
    expect(view.getAllByTestId('stat-rule')).toHaveLength(1);
  });
});

/**
 * **A subtle rounded outline** (founder spec §7, 2026-11-13): a clean hairline frame in the
 * dividers' own colour, the card's radius, and no fill — the dividers kept as they were.
 */
describe('the frame', () => {
  it('is a hairline outline with the card radius and no background', async () => {
    const view = await draw();
    const row = StyleSheet.flatten(first(view.getAllByTestId('stat-rule')).parent?.props.style);

    expect(row.borderWidth).toBe(StyleSheet.hairlineWidth * 2);
    expect(row.borderColor).toBe(theme.border.hairline);
    expect(row.borderRadius).toBe(theme.radius.card);
    expect(row.backgroundColor).toBeUndefined();
  });

  it('keeps the rules and every cell’s 44pt target inside it', async () => {
    const view = await draw();
    expect(view.getAllByTestId('stat-rule')).toHaveLength(3);
    for (const name of ['Followers: 12', 'Following: 34', 'Movies: 210', 'TV Shows: 18']) {
      const cell = view.getByLabelText(name);
      const style = StyleSheet.flatten(
        typeof cell.props.style === 'function' ? cell.props.style({ pressed: false }) : cell.props.style,
      );
      expect(style.minHeight).toBeGreaterThanOrEqual(theme.layout.minTapTarget);
    }
  });
});
