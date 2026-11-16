import { fireEvent, render, screen } from '@testing-library/react-native';

import { theme } from '@/ui/tokens';

import {
  BADGE_EM_PER_CHAR,
  SHORTCUT_LABEL_EM,
  SHORTCUT_MIN_PADDING,
  SHORTCUT_PADDING,
  ForYouShortcuts,
  shortcutWidth,
  shortcutsLayout,
  type ForYouShortcut,
} from './ForYouShortcuts';

/**
 * For You's two feature shortcuts (founder, nav cohesion sprint, 2026-11-06): what each
 * says, the unread badge, Sent to You's toggle state, and the pair keeping one row whenever
 * both labels fit, stacking only when they genuinely cannot (founder QA B7, 2026-11-15).
 */

const flatten = (style: unknown) =>
  (Array.isArray(style) ? Object.assign({}, ...style.flat(3)) : (style ?? {})) as Record<
    string,
    unknown
  >;

const shortcuts = (over: Partial<Record<'sent' | 'together', Partial<ForYouShortcut>>> = {}) => {
  const sent = jest.fn();
  const together = jest.fn();
  const list: ForYouShortcut[] = [
    {
      key: 'sent',
      icon: 'mail-outline',
      label: 'Sent to You',
      selected: false,
      onPress: sent,
      ...over.sent,
    },
    {
      key: 'group',
      icon: 'people-outline',
      label: 'Find for a Group',
      onPress: together,
      ...over.together,
    },
  ];
  return { list, sent, together };
};

// The window, with the text size each case asks for. Jest's own mock reports a font scale
// of 2, which is the large-text case, so every case says which it means.
let mockFontScale = 1;
let mockWidth = 360;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 780, scale: 2, fontScale: mockFontScale }),
}));
const withFontScale = (fontScale: number, width = 360) => {
  mockFontScale = fontScale;
  mockWidth = width;
};

// The `Screen`'s left and right safe-area edges: zero on a portrait phone unless a case says.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));
beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
});

const row = () => flatten(screen.getByTestId('for-you-shortcuts').props.style);
const half = (id: 'sent' | 'group') =>
  flatten(screen.getByTestId(`for-you-shortcut-${id}`).props.style);

it('draws both features as equal halves of one row', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

  expect(row().flexDirection).toBe('row');
  for (const id of ['sent', 'group'] as const) {
    expect(half(id)).toMatchObject({ flex: 1, flexBasis: 0 });
  }
});

/**
 * **One row on a 320pt phone at the default size** (founder QA B7, 2026-11-15). The pair
 * used to stack below a 340pt window by rule; "Find for a Group" measures 134.9pt on the
 * floor padding and a half of a 320pt phone is 140, so it fits, at the floor, unclipped.
 */
it('keeps one row on a 320pt phone at the default size, giving up padding first', async () => {
  withFontScale(1, 320);
  await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

  expect(row().flexDirection).toBe('row');
  expect(half('group').paddingHorizontal).toBe(SHORTCUT_MIN_PADDING);
  expect(screen.getByText('Find for a Group')).toBeTruthy();
});

it('stacks them at a large text size', async () => {
  withFontScale(1.6, 430);
  await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

  expect(row().flexDirection).toBe('column');
  expect(half('sent').flex).toBeUndefined();
});

it('shows the unread count as a badge, and says it in full', async () => {
  withFontScale(1);
  const { list } = shortcuts({
    sent: { badge: '12+', accessibilityLabel: 'Sent to You, at least 12 new' },
  });
  await render(<ForYouShortcuts shortcuts={list} />);

  const sent = screen.getByRole('button', { name: 'Sent to You, at least 12 new' });
  // Hidden from a screen reader on purpose: the button's label says the count in full.
  expect(screen.getByText('12+', { includeHiddenElements: true })).toBeTruthy();
  expect(sent.props.accessibilityState).toMatchObject({ selected: false });
});

it('draws no badge at zero', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts({ sent: { badge: null } }).list} />);
  expect(screen.queryByText('0')).toBeNull();
});

it('marks Sent to You while it is on, and gives Find for a Group no toggle state', async () => {
  withFontScale(1);
  await render(<ForYouShortcuts shortcuts={shortcuts({ sent: { selected: true } }).list} />);

  const sent = screen.getByTestId('for-you-shortcut-sent');
  expect(sent.props.accessibilityState).toMatchObject({ selected: true });
  expect(flatten(sent.props.style)).toMatchObject({
    borderColor: theme.semantic.action,
    backgroundColor: theme.surface.sunken,
  });
  expect(
    screen.getByTestId('for-you-shortcut-group').props.accessibilityState?.selected,
  ).toBeUndefined();
});

it('runs each one’s own action', async () => {
  withFontScale(1);
  const { list, sent, together } = shortcuts();
  await render(<ForYouShortcuts shortcuts={list} />);

  await fireEvent.press(screen.getByRole('button', { name: 'Find for a Group' }));
  expect(together).toHaveBeenCalledTimes(1);
  expect(sent).not.toHaveBeenCalled();
});

/**
 * **Row or stack, by window and text size** (founder QA B7). Jest has no text layout, so
 * the decision is pinned two ways: the rendered shape for each case, and the arithmetic
 * behind it against the font (below). The usable half is
 *
 *     (W - insets - 2 * gutter - gap) / 2  =  (W - 40) / 2 on a portrait phone
 *     320 → 140, 340 → 150, 360 → 160, 375 → 167.5, 430 → 195
 *
 * against Find for a Group at 2 + 2 * padding + 16 + 4 + 7.757em * 13 * fontScale * 1.04.
 * With Sent to You carrying a one-digit badge, which never binds before Find for a Group.
 */
describe('the layout at each width and text size', () => {
  const ROW = SHORTCUT_PADDING;
  const FLOOR = SHORTCUT_MIN_PADDING;
  const cases: { width: number; fontScale: number; expected: 'stack' | number }[] = [
    { width: 320, fontScale: 1, expected: FLOOR },
    { width: 340, fontScale: 1, expected: FLOOR },
    { width: 360, fontScale: 1, expected: ROW },
    { width: 375, fontScale: 1, expected: ROW },
    { width: 430, fontScale: 1, expected: ROW },
    { width: 320, fontScale: 1.3, expected: 'stack' },
    { width: 340, fontScale: 1.3, expected: 'stack' },
    { width: 360, fontScale: 1.3, expected: 'stack' },
    { width: 375, fontScale: 1.3, expected: FLOOR },
    { width: 430, fontScale: 1.3, expected: ROW },
    ...[320, 340, 360, 375, 430].flatMap((width) =>
      [1.6, 2].map((fontScale) => ({ width, fontScale, expected: 'stack' as const })),
    ),
  ];

  it.each(cases)(
    'at $width pt and fontScale $fontScale: $expected',
    async ({ width, fontScale, expected }) => {
      withFontScale(fontScale, width);
      const { list } = shortcuts({
        sent: { badge: '3', accessibilityLabel: 'Sent to You, 3 new' },
      });
      await render(<ForYouShortcuts shortcuts={list} />);

      const stacked = expected === 'stack';
      expect(row().flexDirection).toBe(stacked ? 'column' : 'row');
      for (const id of ['sent', 'group'] as const) {
        const style = half(id);
        expect(style.paddingHorizontal).toBe(stacked ? SHORTCUT_PADDING : expected);
        expect(style.paddingHorizontal as number).toBeGreaterThanOrEqual(SHORTCUT_MIN_PADDING);
        expect(style.flex).toBe(stacked ? undefined : 1);
      }
      // The badge is drawn either way.
      expect(screen.getByText('3', { includeHiddenElements: true })).toBeTruthy();

      // The labels are whole and unshrunk: one line in a half, which the measurement says
      // fits, with only a 0.9 net; free to wrap when stacked rather than shrink or clip.
      for (const label of ['Sent to You', 'Find for a Group']) {
        const text = screen.getByText(label);
        if (stacked) {
          expect(text.props.numberOfLines).toBeUndefined();
          expect(text.props.adjustsFontSizeToFit).toBeUndefined();
        } else {
          expect(text.props.numberOfLines).toBe(1);
          expect(text.props.minimumFontScale).toBeGreaterThanOrEqual(0.9);
        }
        expect(flatten(text.props.style).fontSize).toBe(theme.typography.footnote.fontSize);
      }
    },
  );

  it.each([1, 2])(
    'keeps every press at 44pt at fontScale %s, the slop inside the row and never crossing',
    async (fontScale) => {
      withFontScale(fontScale, 320);
      await render(<ForYouShortcuts shortcuts={shortcuts().list} />);

      const container = row();
      // One row at the default size and stacked at 2, so both shapes are checked.
      expect(container.flexDirection).toBe(fontScale === 1 ? 'row' : 'column');
      for (const id of ['sent', 'group'] as const) {
        const pressable = screen.getByTestId(`for-you-shortcut-${id}`);
        const slop = pressable.props.hitSlop as { top: number; bottom: number };
        expect((half(id).minHeight as number) + slop.top + slop.bottom).toBeGreaterThanOrEqual(
          theme.layout.minTapTarget,
        );
        // A press never answers outside its parent, so the slop must be the row's own room.
        expect(container.paddingTop as number).toBeGreaterThanOrEqual(slop.top);
        expect(container.paddingBottom as number).toBeGreaterThanOrEqual(slop.bottom);
        if (container.flexDirection === 'column') {
          expect(container.gap as number).toBeGreaterThanOrEqual(slop.top + slop.bottom);
        }
      }
    },
  );

  it('reads the safe area the Screen applies, so a notch in landscape can stack the pair', async () => {
    withFontScale(1, 320);
    mockInsets = { top: 0, bottom: 0, left: 12, right: 16 };
    await render(<ForYouShortcuts shortcuts={shortcuts().list} />);
    // (320 - 28 - 40) / 2 = 126, short of Find for a Group's 134.9 on the floor.
    expect(row().flexDirection).toBe('column');
  });

  it('measures the badge actually drawn: the widest stack a 320pt phone', () => {
    const pair = (badge: string | null) => [
      { label: 'Sent to You', badge },
      { label: 'Find for a Group', badge: null },
    ];
    expect(shortcutsLayout(pair('12'), 320, 1).stacked).toBe(false);
    expect(shortcutsLayout(pair('New'), 320, 1).stacked).toBe(true);
    expect(shortcutsLayout(pair('200+'), 320, 1).stacked).toBe(true);
    expect(shortcutsLayout(pair('200+'), 360, 1)).toEqual({
      stacked: false,
      padding: SHORTCUT_MIN_PADDING,
    });
  });

  it('never turns a stack back into a row at a larger text size', () => {
    const pair = shortcuts().list;
    for (const width of [320, 340, 360, 375, 390, 414, 430]) {
      let wasRow = true;
      for (let scale = 0.8; scale <= 3.2; scale += 0.05) {
        const { stacked } = shortcutsLayout(pair, width, scale);
        if (!wasRow) expect(stacked).toBe(true);
        wasRow = !stacked;
      }
    }
  });
});

/**
 * **Against the font itself**, as `ActionPair.test.tsx` and `RankingSheet.test.tsx` do it:
 * each label's advance read from Inter Medium's `hmtx`, so the table the layout reads cannot
 * drift from what is drawn, and the badge's per-character estimate is shown never to be
 * narrower than anything a badge says.
 */
describe('measured from the font', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');
  const font = fs.readFileSync(
    path.join(process.cwd(), 'node_modules/@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
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

  it('reads the label widths the layout is decided against', () => {
    for (const [label, em] of Object.entries(SHORTCUT_LABEL_EM)) {
      expect(ems(label)).toBeCloseTo(em, 3);
    }
    expect(theme.typography.footnote.fontSize).toBe(13);
    expect(theme.typography.caption.fontSize).toBe(12);
  });

  it('never estimates a badge narrower than Inter Medium draws it', () => {
    for (const badge of ['0', '1', '7', '9', '12', '88', '199', '200+', '12+', 'New']) {
      expect(BADGE_EM_PER_CHAR * badge.length).toBeGreaterThanOrEqual(ems(badge));
    }
  });

  it('fits each label in its half, unshrunk, whenever the pair is a row', () => {
    for (let width = 320; width <= 430; width += 1) {
      for (const fontScale of [0.823, 1, 1.1, 1.2, 1.3, 1.353, 1.6, 2]) {
        const pair = shortcuts({ sent: { badge: '3' } }).list;
        const { stacked, padding } = shortcutsLayout(pair, width, fontScale);
        if (stacked) continue;
        const room = (width - 2 * theme.layout.gutter - theme.space[2]) / 2;
        for (const shortcut of pair) {
          // What the font draws: glyph, gap, label, gap, badge, padding, the 1pt outline.
          const label = ems(shortcut.label) * theme.typography.footnote.fontSize * fontScale;
          const drawn =
            2 + 2 * padding + 16 + theme.space[1] + label + (shortcut.badge ? 4 + 18 : 0);
          expect(drawn).toBeLessThanOrEqual(room);
          expect(shortcutWidth(shortcut, fontScale, padding)).toBeGreaterThanOrEqual(drawn);
        }
      }
    }
  });
});
