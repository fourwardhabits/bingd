import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

import { theme } from '@/ui/tokens';

/**
 * **A control row on the narrowest phone at the largest text size, without a layout engine.**
 *
 * Jest draws no layout, so a row's fit at 320pt and fontScale 2 is checked the way a
 * designer checks a spec: by adding up what the row is made of. `naturalWidth` walks the
 * rendered host tree and sums it — fixed widths as given, rows as the sum of their children
 * plus gaps and padding, text as its characters at a deliberately generous advance and the
 * scaled font size, and an icon glyph at its own size (glyphs do not grow with text).
 *
 * It over-estimates text on purpose (`EM_PER_CHAR`), so a row that passes here has slack
 * on a device. It is a budget, not a measurement: the founder's Preview pass on a 320pt
 * device at the largest size is the measurement.
 */
export const NARROW_WIDTH = 320;
export const LARGEST_FONT_SCALE = 2;

/** A generous average advance for Inter and DM Serif: wider than either's real average. */
const EM_PER_CHAR = 0.62;

const GLYPHS = new Set(
  Object.values(Ionicons.glyphMap).map((code) => String.fromCodePoint(code as number)),
);

/** A rendered host node, as the testing library hands it back: every node is a host element. */
type Host = {
  type: string;
  props: Record<string, unknown>;
  children: readonly (Host | string)[];
};

type Style = {
  width?: number;
  minWidth?: number;
  flexDirection?: string;
  gap?: number;
  columnGap?: number;
  paddingHorizontal?: number;
  paddingLeft?: number;
  paddingRight?: number;
  padding?: number;
  marginLeft?: number;
  marginRight?: number;
  fontSize?: number;
  position?: string;
};

const styleOf = (node: Host): Style =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Style;

const textOf = (node: Host): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

/** The element children of a node (its text runs are measured by `textOf`). */
const hostChildren = (node: Host): Host[] =>
  node.children.filter((child): child is Host => typeof child !== 'string');

/** The width a node asks for, unconstrained, at `fontScale`. */
export function naturalWidth(node: Host, fontScale = LARGEST_FONT_SCALE): number {
  const style = styleOf(node);
  if (style.position === 'absolute') return 0;
  const margins = (style.marginLeft ?? 0) + (style.marginRight ?? 0);
  const padding =
    (style.paddingLeft ?? style.paddingHorizontal ?? style.padding ?? 0) +
    (style.paddingRight ?? style.paddingHorizontal ?? style.padding ?? 0);

  let content: number;
  if (node.type === 'Text') {
    const text = textOf(node);
    const size = style.fontSize ?? theme.typography.body.fontSize;
    content =
      text.length === 1 && GLYPHS.has(text)
        ? size
        : text.length * size * (node.props.allowFontScaling === false ? 1 : fontScale) * EM_PER_CHAR;
  } else {
    const kids = hostChildren(node).filter((kid) => styleOf(kid).position !== 'absolute');
    const widths = kids.map((kid) => naturalWidth(kid, fontScale));
    content =
      style.flexDirection === 'row'
        ? widths.reduce((sum, w) => sum + w, 0) +
          Math.max(0, kids.length - 1) * (style.columnGap ?? style.gap ?? 0)
        : Math.max(0, ...widths);
  }
  const drawn = style.width ?? Math.max(style.minWidth ?? 0, content + padding);
  return drawn + margins;
}

/**
 * What the leading side of a `BrowseControlsRow` is left with, on a 320pt phone at the
 * largest text size: the row's width less its gutters, its gap and the trailing group's
 * natural width (the trailing side never shrinks).
 */
export function leadingRoom(row: Host, trailing: Host): number {
  const style = styleOf(row);
  const gutters = 2 * (style.paddingHorizontal ?? 0);
  return NARROW_WIDTH - gutters - (style.gap ?? 0) - naturalWidth(trailing);
}

/** Every pressable under `node`, with the target it offers: its drawn box plus its slop. */
export function tapTargets(node: Host) {
  const out: { label: string; width: number; height: number }[] = [];
  const slopOf = (slop: unknown, side: 'top' | 'bottom' | 'left' | 'right') =>
    typeof slop === 'number' ? slop : ((slop as Record<string, number> | undefined)?.[side] ?? 0);
  const walk = (at: Host) => {
    if (at.props.accessibilityRole && at.props.onClick) {
      const style = styleOf(at) as Style & { height?: number; minHeight?: number; minWidth?: number };
      const slop = at.props.hitSlop;
      out.push({
        label: String(at.props.accessibilityLabel ?? ''),
        width:
          (style.width ?? Math.max(style.minWidth ?? 0, naturalWidth(at, 1))) +
          slopOf(slop, 'left') +
          slopOf(slop, 'right'),
        height:
          (style.height ?? style.minHeight ?? 0) + slopOf(slop, 'top') + slopOf(slop, 'bottom'),
      });
    }
    for (const child of at.children) if (typeof child !== 'string') walk(child);
  };
  walk(node);
  return out;
}

/**
 * **C9's check for one `BrowseControlsRow`**, by its `testID`: it never wraps; its trailing
 * side never shrinks and every control in it is a 44pt target; its leading side can give
 * way; and on a 320pt phone at fontScale 2 the trailing group leaves the leading side at
 * least `minLeading` — so the two sides cannot overlap and the row cannot wrap.
 */
export function expectRowFitsNarrow(
  getByTestId: (id: string) => Host,
  rowID: string,
  minLeading: number = theme.layout.minTapTarget,
) {
  const row = getByTestId(rowID);
  const leading = getByTestId(`${rowID}-leading`);
  const trailing = getByTestId(`${rowID}-trailing`);

  expect(styleOf(row)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  expect(styleOf(trailing)).toMatchObject({ flexWrap: 'nowrap', flexShrink: 0 });
  expect(styleOf(leading)).toMatchObject({ flexShrink: 1, minWidth: 0 });

  const room = leadingRoom(row, trailing);
  expect(room).toBeGreaterThanOrEqual(minLeading);

  const targets = tapTargets(trailing);
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    expect({ ...target, ok: target.width >= theme.layout.minTapTarget && target.height >= theme.layout.minTapTarget }).toMatchObject({ ok: true });
  }
  return { room, targets };
}
