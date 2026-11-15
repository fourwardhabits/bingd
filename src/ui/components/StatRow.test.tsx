import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import {
  STAT_LABEL_MIN_SCALE,
  STAT_LABEL_WRAP_SCALE,
  StatRow,
  statLabelMaxScale,
  type StatItem,
} from './StatRow';

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

/**
 * **286-SMOKE-UI: one line at normal text sizes, wrapping at the accessibility sizes**
 * (founder iPhone smoke of d702d098, decisions t222s1181 and t223u, 2026-11-15).
 *
 * `TV Shows` wrapped onto two lines on the profile card. Below `STAT_LABEL_WRAP_SCALE`
 * every label is now one line, fit to its quarter with `Button`'s `fit` trio and a cap
 * that depends on the window width; at and above it the label keeps the old behaviour
 * (the suite above runs at jest's default window, fontScale 2, which is that case).
 *
 * jest has no layout engine, so what is pinned is the props that make the guarantee and
 * the arithmetic behind them, against Inter Regular itself.
 */
const withWindow = async <T,>(width: number, fontScale: number, run: () => Promise<T>) => {
  const rn = jest.requireActual('react-native') as typeof import('react-native');
  const dims = jest.spyOn(rn, 'useWindowDimensions');
  dims.mockReturnValue({ width, height: 800, scale: 2, fontScale });
  try {
    return await run();
  } finally {
    dims.mockRestore();
  }
};

const LABELS = STATS.map((stat) => stat.label);
const CAP_AT: Record<number, number> = { 320: 1.05, 360: 1.1, 390: 1.2 };

describe('the labels at the reader’s width and text size', () => {
  const grid = [320, 360, 390].flatMap((width) =>
    [1, 1.3, 2].map((fontScale) => ({ width, fontScale })),
  );

  it.each(grid)(
    'at $width pt and fontScale $fontScale: one line below the wrap scale, wrapping at it',
    async ({ width, fontScale }) => {
      await withWindow(width, fontScale, async () => {
        const view = await draw();
        for (const stat of STATS) {
          const label = view.getByText(stat.label).props;
          if (fontScale < STAT_LABEL_WRAP_SCALE) {
            expect(label.numberOfLines).toBe(1);
            expect(label.adjustsFontSizeToFit).toBe(true);
            expect(label.minimumFontScale).toBe(STAT_LABEL_MIN_SCALE);
            expect(label.maxFontSizeMultiplier).toBe(CAP_AT[width]);
          } else {
            // Readability first: no line cap, no shrink, no size cap, so the label grows
            // with the reader's text and wraps, and the row grows with it.
            expect(label.numberOfLines).toBeUndefined();
            expect(label.adjustsFontSizeToFit).toBeUndefined();
            expect(label.minimumFontScale).toBeUndefined();
            expect(label.maxFontSizeMultiplier).toBeUndefined();
          }
          // Either way: still scales with the reader's text, still footnote, and the figure
          // is untouched.
          expect(label.allowFontScaling).not.toBe(false);
          expect(StyleSheet.flatten(label.style).fontSize).toBe(
            theme.typography.footnote.fontSize,
          );
          expect(view.getByText(String(stat.value)).props.numberOfLines).toBeUndefined();
        }
      });
    },
  );

  it('wraps without clipping at every accessibility size, and the cells may grow', async () => {
    for (const fontScale of [STAT_LABEL_WRAP_SCALE, 1.647, 2, 2.353, 3.118]) {
      await withWindow(320, fontScale, async () => {
        const view = await draw();
        for (const stat of STATS) {
          const label = view.getByText(stat.label).props;
          expect(label.numberOfLines).toBeUndefined();
          expect(label.ellipsizeMode).toBeUndefined();
          const cell = StyleSheet.flatten(
            view.getByRole('button', { name: `${stat.label}: ${stat.value}` }).props.style,
          );
          expect(cell.height).toBeUndefined();
          expect(cell.maxHeight).toBeUndefined();
        }
      });
    }
  });

  it('keeps every standard text size on one line on both platforms', () => {
    // Android 0.85–1.3; iOS xSmall 0.823 to xxxLarge 1.353. iOS AX1 (1.647) wraps.
    for (const fontScale of [0.823, 0.85, 1, 1.118, 1.15, 1.235, 1.3, 1.353]) {
      expect(fontScale).toBeLessThan(STAT_LABEL_WRAP_SCALE);
    }
    expect(1.647).toBeGreaterThanOrEqual(STAT_LABEL_WRAP_SCALE);
  });

  it('steps the cap by width, never below 1.05 on a supported phone', () => {
    expect(statLabelMaxScale(320)).toBe(1.05);
    expect(statLabelMaxScale(359)).toBe(1.05);
    expect(statLabelMaxScale(360)).toBe(1.1);
    expect(statLabelMaxScale(389)).toBe(1.1);
    expect(statLabelMaxScale(390)).toBe(1.2);
    expect(statLabelMaxScale(430)).toBe(1.2);
  });

  it('does not change what is said, hinted or opened', async () => {
    await withWindow(320, 1, async () => {
      const view = await draw([...STATS.slice(0, 3), { ...STATS[3], value: 8 }]);
      const tv = view.getByRole('button', { name: 'TV Shows: 8' });
      expect(tv.props.accessibilityHint).toBe('Opens the list');
      await fireEvent.press(tv);
      expect(onPress.seasons).toHaveBeenCalled();
      expect(view.getAllByRole('button')).toHaveLength(4);
      expect(view.getAllByTestId('stat-rule')).toHaveLength(3);
    });
  });
});

describe('inside the profile card', () => {
  it('drops the frame’s own side margin and keeps everything else about it', async () => {
    const inCard = await render(<StatRow centered inCard stats={STATS} />);
    const alone = await draw();
    const frame = (view: Awaited<ReturnType<typeof draw>>) =>
      StyleSheet.flatten(first(view.getAllByTestId('stat-rule')).parent?.props.style);

    expect(frame(inCard).marginHorizontal).toBe(0);
    expect(frame(alone).marginHorizontal).toBe(theme.layout.gutter);
    for (const style of [frame(inCard), frame(alone)]) {
      expect(style.paddingHorizontal).toBe(theme.space[2]);
      expect(style.borderWidth).toBe(StyleSheet.hairlineWidth * 2);
      expect(style.borderRadius).toBe(theme.radius.card);
    }
  });
});

/**
 * **The one-line contract, against the font.** Each label's advance width is read from
 * Inter Regular's own `hmtx` (the measurement `RankingSheet.test.tsx` makes of SemiBold),
 * with the same 4% allowance. A quarter's text width inside the profile card, with each
 * hairline-doubled line (card border, frame border, the three rules) taken at its 1pt
 * maximum on any iOS device or Android at 2x and up:
 *
 *     quarter = (W - 2*gutter - 7*1 - 2*frame padding - 2*frame margin) / 4 - 2*item padding
 *             = (W - 32 - 7 - 16 - 0) / 4 - 8
 *
 *     W    quarter  cap   TV Shows at fontScale 1 / 1.3 / 2         shrink needed
 *     320  58.25    1.05  64.83 / 68.07 (capped) / wraps            0.898 / 0.856
 *     360  68.25    1.1   64.83 / 71.31 (capped) / wraps            1     / 0.957
 *     390  75.75    1.2   64.83 / 77.80 (capped) / wraps            1     / 0.974
 *
 * (Followers 4.580em, Following 4.539em, Movies 3.418em, TV Shows 4.795em.) Every shrink
 * is at or above the 0.85 floor, so no label is ever clipped or ellipsised, and none is
 * drawn below 85% of footnote's 13pt.
 */
describe('measured from the font', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const font = fs.readFileSync(
    path.join(process.cwd(), 'node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  );

  const ems = (() => {
    const u16 = (o: number) => font.readUInt16BE(o);
    const tables: Record<string, number> = {};
    for (let i = 0; i < u16(4); i++) {
      tables[font.toString('latin1', 12 + 16 * i, 16 + 16 * i)] = font.readUInt32BE(20 + 16 * i);
    }
    const unitsPerEm = u16(tables.head! + 18);
    const metrics = u16(tables.hhea! + 34);
    const advance = (glyph: number) => u16(tables.hmtx! + 4 * Math.min(glyph, metrics - 1));
    const cmap = tables.cmap!;
    let format4 = -1;
    for (let i = 0; i < u16(cmap + 2) && format4 < 0; i++) {
      const sub = cmap + font.readUInt32BE(cmap + 8 + 8 * i);
      if (u16(sub) === 4) format4 = sub;
    }
    const segments = u16(format4 + 6) / 2;
    const glyphOf = (code: number) => {
      for (let k = 0; k < segments; k++) {
        const end = u16(format4 + 14 + 2 * k);
        if (code > end) continue;
        const start = u16(format4 + 16 + 2 * segments + 2 * k);
        if (code < start) return 0;
        const delta = font.readInt16BE(format4 + 16 + 4 * segments + 2 * k);
        const rangeAt = format4 + 16 + 6 * segments + 2 * k;
        const range = u16(rangeAt);
        if (range === 0) return (code + delta) & 0xffff;
        const glyph = u16(rangeAt + range + 2 * (code - start));
        return glyph ? (glyph + delta) & 0xffff : 0;
      }
      return 0;
    };
    return (label: string) =>
      [...label].reduce((sum, ch) => sum + advance(glyphOf(ch.charCodeAt(0))), 0) / unitsPerEm;
  })();

  it('reads the widths the cap was chosen against', () => {
    expect(ems('TV Shows')).toBeCloseTo(4.795, 2);
    expect(Math.max(...LABELS.map(ems))).toBe(ems('TV Shows'));
    expect(theme.typography.footnote.fontSize).toBe(13);
    expect('maxFontSizeMultiplier' in theme.typography.footnote).toBe(false);
  });

  it('fits every label on one line at or above the 0.85 floor, 320–430pt, every standard size', async () => {
    // The frame and item insets as rendered in the card, not restated.
    const view = await render(<StatRow centered inCard stats={STATS} />);
    const frame = StyleSheet.flatten(first(view.getAllByTestId('stat-rule')).parent?.props.style);
    const item = StyleSheet.flatten(
      view.getByRole('button', { name: 'TV Shows: 18' }).props.style,
    );
    const line = 1; // hairlineWidth * 2, at most 1pt
    const quarterAt = (width: number) =>
      (width -
        2 * theme.layout.gutter - // the card's margin
        2 * line - // the card's border
        2 * (frame.marginHorizontal as number) -
        2 * line - // the frame's border
        2 * (frame.paddingHorizontal as number) -
        3 * line) / // the rules
        4 -
      2 * (item.paddingHorizontal as number);

    expect(quarterAt(320)).toBeCloseTo(58.25, 2);
    expect(quarterAt(360)).toBeCloseTo(68.25, 2);
    expect(quarterAt(390)).toBeCloseTo(75.75, 2);

    for (let width = 320; width <= 430; width++) {
      for (const fontScale of [0.823, 1, 1.118, 1.235, 1.3, 1.353, 1.49]) {
        const size =
          theme.typography.footnote.fontSize * Math.min(fontScale, statLabelMaxScale(width));
        for (const label of LABELS) {
          const natural = ems(label) * size * 1.04;
          const shrink = Math.min(1, quarterAt(width) / natural);
          expect(shrink).toBeGreaterThanOrEqual(STAT_LABEL_MIN_SCALE);
          // Never below 85% of footnote's 13pt (or of the smaller size the reader chose).
          expect(size * shrink).toBeGreaterThanOrEqual(
            theme.typography.footnote.fontSize * Math.min(fontScale, 1) * STAT_LABEL_MIN_SCALE,
          );
        }
      }
    }
  });
});
