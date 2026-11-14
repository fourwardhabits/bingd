import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

/**
 * **The usable touch rect of a control, laid out from the rendered tree** (A11Y-44).
 *
 * Jest draws no layout, and `hitSlop` arithmetic on tokens is how three controls were
 * signed off at 44pt while answering 40, 40 and 32. React Native only delivers a touch
 * inside every ancestor's bounds (and Android clips overflow by default), so the rect a
 * finger can hit is the control's box grown by its slop and then **clipped by each
 * ancestor's box**. This lays out a rendered subtree from its real flattened styles and
 * returns exactly that rect.
 *
 * It is a small flexbox — column and row, padding, border, margins (negative included),
 * `gap`/`rowGap`/`columnGap`, fixed and minimum sizes, `flex`/`flexGrow` on the main axis,
 * `alignItems`/`alignSelf` (stretch, start, centre, end), `justifyContent` (start, centre),
 * `flexWrap`, and `position: 'absolute'` against the padding box. Text is one or more lines
 * of its `lineHeight`, at an average advance of `EM_PER_CHAR` (an estimate: a test that
 * depends on whether text wraps sets a width that decides it either way); an icon glyph
 * is its own size square. That is everything the A11Y-44 sites are built from, and
 * anything outside it throws rather than guessing.
 *
 * Measured in Chromium against the same components (react-native-web, real fonts) on the
 * A11Y-44 PR; the numbers agree to the point at every site.
 */

/** Average advance of Inter, per point of font size. */
const EM_PER_CHAR = 0.55;

const GLYPHS = new Set(
  Object.values(Ionicons.glyphMap).map((code) => String.fromCodePoint(code as number)),
);

export type Host = {
  type: string;
  props: Record<string, unknown>;
  children: readonly (Host | string)[];
  parent: Host | null;
};

export type Rect = { top: number; left: number; width: number; height: number };
export type Edges = { top: number; bottom: number; left: number; right: number };

type Style = Record<string, unknown>;

const styleOf = (node: Host): Style =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Style;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const kids = (node: Host): Host[] =>
  node.children.filter((child): child is Host => typeof child !== 'string');

const textOf = (node: Host): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

function edges(style: Style, kind: 'padding' | 'margin' | 'border'): Edges {
  const key = (side: string) => (kind === 'border' ? `border${side}Width` : `${kind}${side}`);
  const all = num(style[kind === 'border' ? 'borderWidth' : kind]) ?? 0;
  const v = num(style[kind === 'border' ? '' : `${kind}Vertical`]);
  const h = num(style[kind === 'border' ? '' : `${kind}Horizontal`]);
  return {
    top: num(style[key('Top')]) ?? v ?? all,
    bottom: num(style[key('Bottom')]) ?? v ?? all,
    left: num(style[key('Left')]) ?? h ?? all,
    right: num(style[key('Right')]) ?? h ?? all,
  };
}

const hidden = (node: Host) => styleOf(node).display === 'none';
const absolute = (node: Host) => styleOf(node).position === 'absolute';

/** Width a node asks for when nothing stretches it. */
function naturalWidth(node: Host): number {
  const style = styleOf(node);
  const fixed = num(style.width);
  if (fixed !== undefined) return fixed;
  const p = edges(style, 'padding');
  const b = edges(style, 'border');
  let content = 0;
  if (node.type === 'Text') {
    const text = textOf(node);
    const size = num(style.fontSize) ?? 17;
    content = text.length === 1 && GLYPHS.has(text) ? size : text.length * size * EM_PER_CHAR;
  } else if (node.type === 'TextInput') {
    content = 0;
  } else {
    const flow = kids(node).filter((k) => !hidden(k) && !absolute(k));
    const outer = flow.map((k) => {
      const m = edges(styleOf(k), 'margin');
      return naturalWidth(k) + m.left + m.right;
    });
    if (style.flexDirection === 'row') {
      const gap = num(style.columnGap) ?? num(style.gap) ?? 0;
      content = outer.reduce((a, w) => a + w, 0) + gap * Math.max(0, outer.length - 1);
    } else {
      content = Math.max(0, ...outer);
    }
  }
  return Math.max(num(style.minWidth) ?? 0, content + p.left + p.right + b.left + b.right);
}

/** Height of a leaf at a given width. */
function leafHeight(node: Host, width: number, style: Style): number {
  if (node.type === 'Text') {
    const text = textOf(node);
    const size = num(style.fontSize) ?? 17;
    if (text.length === 1 && GLYPHS.has(text)) return size;
    const line = num(style.lineHeight) ?? Math.round(size * 1.2);
    const lines = Math.max(
      1,
      Math.ceil((text.length * size * EM_PER_CHAR) / Math.max(1, width) - 1e-6),
    );
    return line * lines;
  }
  if (node.type === 'TextInput') {
    const size = num(style.fontSize) ?? 17;
    return num(style.lineHeight) ?? Math.round(size * 1.2);
  }
  return 0;
}

type Box = Rect;

/**
 * Lay `node` out at `width` (its border-box width). Children's boxes are written to `out`,
 * relative to `node`'s own top-left; returns the border-box height.
 */
function layout(node: Host, width: number, out: Map<Host, Box>, forcedHeight?: number): number {
  const style = styleOf(node);
  const p = edges(style, 'padding');
  const b = edges(style, 'border');
  const innerW = width - p.left - p.right - b.left - b.right;
  const flow = kids(node).filter((k) => !hidden(k) && !absolute(k));
  const row = style.flexDirection === 'row';
  const align = (k: Host) => (styleOf(k).alignSelf ?? style.alignItems ?? 'stretch') as string;
  const placed: { k: Host; x: number; y: number; w: number; h: number }[] = [];
  let contentH = 0;

  if (node.type === 'Text' || node.type === 'TextInput' || flow.length === 0) {
    contentH = node.type === 'View' ? 0 : leafHeight(node, innerW, style);
  } else if (!row) {
    const gap = num(style.rowGap) ?? num(style.gap) ?? 0;
    let y = 0;
    flow.forEach((k, i) => {
      const ks = styleOf(k);
      const m = edges(ks, 'margin');
      const a = align(k);
      const w =
        num(ks.width) ??
        (a === 'stretch' ? innerW - m.left - m.right : Math.min(naturalWidth(k), innerW));
      const h = layout(k, w, out);
      const x =
        a === 'center' ? (innerW - w) / 2 : a === 'flex-end' ? innerW - w - m.right : m.left;
      y += m.top;
      placed.push({ k, x, y, w, h });
      y += h + m.bottom + (i < flow.length - 1 ? gap : 0);
    });
    contentH = y;
  } else {
    const gap = num(style.columnGap) ?? num(style.gap) ?? 0;
    const rowGap = num(style.rowGap) ?? num(style.gap) ?? 0;
    const wrap = style.flexWrap === 'wrap';
    // Basis: fixed width, else natural; flex children share what is left.
    const items = flow.map((k) => {
      const ks = styleOf(k);
      const m = edges(ks, 'margin');
      const grow = num(ks.flexGrow) ?? num(ks.flex) ?? 0;
      const basis = num(ks.width) ?? (grow > 0 ? 0 : naturalWidth(k));
      return { k, m, grow, basis };
    });
    const lines: (typeof items)[] = [];
    let current: typeof items = [];
    let used = 0;
    for (const item of items) {
      const outer = item.basis + item.m.left + item.m.right;
      if (wrap && current.length && used + gap + outer > innerW) {
        lines.push(current);
        current = [];
        used = 0;
      }
      used += (current.length ? gap : 0) + outer;
      current.push(item);
    }
    if (current.length) lines.push(current);
    let y = 0;
    lines.forEach((line, li) => {
      const fixed = line.reduce((a, it) => a + it.basis + it.m.left + it.m.right, 0);
      const free = Math.max(0, innerW - fixed - gap * (line.length - 1));
      const grow = line.reduce((a, it) => a + it.grow, 0);
      const widths = line.map((it) => it.basis + (grow > 0 ? (free * it.grow) / grow : 0));
      const heights = line.map((it, i) => layout(it.k, widths[i]!, new Map()));
      const outerH = line.map((it, i) => heights[i]! + it.m.top + it.m.bottom);
      // A single-line row is as tall as its own box allows; stretch fills that.
      const ownInner =
        lines.length === 1
          ? Math.max(
              0,
              (num(style.height) ?? num(style.minHeight) ?? forcedHeight ?? 0) -
                p.top -
                p.bottom -
                b.top -
                b.bottom,
            )
          : 0;
      const lineH = Math.max(ownInner, ...outerH);
      let x = 0;
      line.forEach((it, i) => {
        const a = align(it.k);
        const stretch = a === 'stretch' && num(styleOf(it.k).height) === undefined;
        const h = stretch ? lineH - it.m.top - it.m.bottom : heights[i]!;
        layout(it.k, widths[i]!, out, stretch ? h : undefined);
        const top =
          a === 'center'
            ? (lineH - h) / 2
            : a === 'flex-end'
              ? lineH - h - it.m.bottom
              : it.m.top;
        x += it.m.left;
        placed.push({ k: it.k, x, y: y + top, w: widths[i]!, h });
        x += widths[i]! + it.m.right + gap;
      });
      y += lineH + (li < lines.length - 1 ? rowGap : 0);
    });
    contentH = y;
  }

  const ownH = Math.max(
    num(style.minHeight) ?? 0,
    num(style.height) ?? forcedHeight ?? contentH + p.top + p.bottom + b.top + b.bottom,
  );
  // `justifyContent: 'center'` in a column with room to spare.
  const innerH = ownH - p.top - p.bottom - b.top - b.bottom;
  const shift =
    !row && style.justifyContent === 'center' ? Math.max(0, (innerH - contentH) / 2) : 0;
  for (const it of placed) {
    out.set(it.k, {
      left: b.left + p.left + it.x,
      top: b.top + p.top + shift + it.y,
      width: it.w,
      height: it.h,
    });
  }

  // Absolute children: against the padding box.
  for (const k of kids(node).filter((c) => !hidden(c) && absolute(c))) {
    const ks = styleOf(k);
    const padW = width - b.left - b.right;
    const padH = ownH - b.top - b.bottom;
    const [t, bo, l, r] = [num(ks.top), num(ks.bottom), num(ks.left), num(ks.right)];
    const w =
      num(ks.width) ?? (l !== undefined && r !== undefined ? padW - l - r : naturalWidth(k));
    const h =
      num(ks.height) ??
      (t !== undefined && bo !== undefined ? padH - t - bo : layout(k, w, new Map()));
    layout(k, w, out, h);
    out.set(k, {
      left: b.left + (l !== undefined ? l : r !== undefined ? padW - r - w : 0),
      top: b.top + (t !== undefined ? t : bo !== undefined ? padH - bo - h : 0),
      width: w,
      height: h,
    });
  }
  return ownH;
}

/**
 * Lay out `root` at `width` and return every descendant's box in root coordinates (the
 * root itself at 0,0).
 */
export function measure(root: Host, width: number): Map<Host, Rect> {
  const local = new Map<Host, Box>();
  const height = layout(root, width, local);
  const abs = new Map<Host, Rect>([[root, { top: 0, left: 0, width, height }]]);
  const resolve = (node: Host): Rect => {
    const known = abs.get(node);
    if (known) return known;
    const own = local.get(node);
    if (!own || !node.parent) throw new Error(`hit-rect: ${node.type} is not under the root`);
    const parent = resolve(node.parent);
    const rect = { ...own, top: parent.top + own.top, left: parent.left + own.left };
    abs.set(node, rect);
    return rect;
  };
  for (const node of local.keys()) resolve(node);
  return abs;
}

const slopOf = (node: Host): Edges => {
  const slop = node.props.hitSlop as number | Partial<Edges> | undefined;
  if (typeof slop === 'number') return { top: slop, bottom: slop, left: slop, right: slop };
  return {
    top: slop?.top ?? 0,
    bottom: slop?.bottom ?? 0,
    left: slop?.left ?? 0,
    right: slop?.right ?? 0,
  };
};

/**
 * The rect a finger can actually hit: `target`'s box plus its `hitSlop`, clipped by the
 * box of every ancestor up to and including `root`.
 */
export function hitRect(root: Host, target: Host, width: number) {
  const boxes = measure(root, width);
  const box = boxes.get(target);
  if (!box) throw new Error('hit-rect: target is not under the root');
  const slop = slopOf(target);
  let top = box.top - slop.top;
  let bottom = box.top + box.height + slop.bottom;
  let left = box.left - slop.left;
  let right = box.left + box.width + slop.right;
  for (let node = target.parent; node; node = node.parent) {
    const clip = boxes.get(node);
    if (!clip) throw new Error('hit-rect: an ancestor is not under the root');
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.top + clip.height);
    left = Math.max(left, clip.left);
    right = Math.min(right, clip.left + clip.width);
    if (node === root) break;
  }
  return { top, bottom, left, right, height: bottom - top, width: right - left, box, boxes };
}

/** The nearest ancestor (or `node` itself) that matches. */
export function closest(node: Host, match: (candidate: Host) => boolean): Host {
  for (let n: Host | null = node; n; n = n.parent) if (match(n)) return n;
  throw new Error('hit-rect: no matching ancestor');
}

/** The nearest host `View` above `node`. */
export const parentView = (node: Host): Host =>
  closest(node.parent as Host, (n) => n.type === 'View');

/** The box inside `node`'s padding and border: where its content starts and ends. */
export function contentBox(boxes: Map<Host, Rect>, node: Host) {
  const box = boxes.get(node);
  if (!box) throw new Error('hit-rect: node is not under the root');
  const style = styleOf(node);
  const p = edges(style, 'padding');
  const b = edges(style, 'border');
  return { top: box.top + p.top + b.top, bottom: box.top + box.height - p.bottom - b.bottom };
}

/**
 * A `SearchField` where a screen puts it, measured from `root` at `width`.
 *
 * `input` is the field's `TextInput`. Returns the drawn field (`row`, the 40pt chrome),
 * the component's own box (`field`), the clear button's usable rect (`clear`, clipped by
 * every box up to `root`), and the drawn field's distance to whatever is above and below
 * it at the call site: the content of the neighbouring block (inside its padding), or the
 * parent's content edge where there is no neighbour. Those two distances are what a reader
 * sees as the field's place on screen.
 */
export function searchFieldSite(root: Host, input: Host, width: number) {
  const row = parentView(input);
  const field = parentView(row);
  const clear = kids(field).find((k) => k.props.accessibilityLabel === 'Clear search');
  if (!clear) throw new Error('hit-rect: the field has no clear button (give it a value)');
  const hit = hitRect(root, clear, width);
  const { boxes } = hit;
  const rowBox = boxes.get(row)!;

  // The call site's block: the nearest ancestor that has siblings around it.
  let block = field;
  while (block.parent && block.parent !== root && kids(block.parent).length === 1) {
    block = block.parent;
  }
  const parent = block.parent!;
  const flow = kids(parent).filter((k) => !hidden(k) && !absolute(k) && boxes.has(k));
  const at = flow.indexOf(block);
  const above = flow[at - 1];
  const below = flow[at + 1];
  const edgeAbove = above ? contentBox(boxes, above).bottom : contentBox(boxes, parent).top;
  const edgeBelow = below ? contentBox(boxes, below).top : contentBox(boxes, parent).bottom;

  return {
    row: rowBox,
    field: boxes.get(field)!,
    clear: hit,
    clearSlop: clear.props.hitSlop,
    spaceAbove: rowBox.top - edgeAbove,
    spaceBelow: edgeBelow - (rowBox.top + rowBox.height),
    /** The component's box lies inside its parent's (Android clips what does not). */
    insideParent: (() => {
      const own = boxes.get(field)!;
      const outer = boxes.get(field.parent!)!;
      return own.top >= outer.top && own.top + own.height <= outer.top + outer.height;
    })(),
  };
}
