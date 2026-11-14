import { fireEvent } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { theme } from '../tokens';
import { ActionPair, actionPairFitsRow, PAIR_LABEL_EM, pairLabelWidth } from './ActionPair';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

/**
 * The page-level action pair (IMP1113-UI, H2 row 23, I6): equal halves, secondary leading,
 * primary trailing; stacked primary-first only when the labels do not fit. Jest lays
 * nothing out, so the decision is pinned through the arithmetic and the tree it produces,
 * and the arithmetic is held against the font file.
 */
const windowOf = (width: number, fontScale: number) =>
  (useWindowDimensions as unknown as jest.Mock).mockReturnValue({
    width,
    height: 800,
    scale: 3,
    fontScale,
  });

const onDone = jest.fn();
const onRank = jest.fn();
const draw = (props: Partial<Parameters<typeof ActionPair>[0]> = {}) =>
  renderWithProviders(
    <ActionPair
      secondary={{ label: 'Done', onPress: onDone, testID: 'done' }}
      primary={{ label: 'Rank titles', onPress: onRank, testID: 'rank' }}
      testID="pair"
      {...props}
    />,
  );

beforeEach(() => {
  windowOf(360, 1);
  onDone.mockClear();
  onRank.mockClear();
});

describe('ActionPair', () => {
  it('sits side by side at 360pt and the default text size: Done left, Rank titles right', async () => {
    const view = await draw();
    const pair = view.getByTestId('pair');
    expect(StyleSheet.flatten(pair.props.style)).toMatchObject({ flexDirection: 'row' });
    expect(view.getAllByRole('button').map((b) => b.props.testID)).toEqual(['done', 'rank']);
    // Equal halves: each wrapper is flex 1, and both labels are held to one line (`fit`),
    // so two `md` buttons are one height.
    for (const id of ['done', 'rank']) {
      const wrapper = view.getByTestId(id).parent!;
      expect(StyleSheet.flatten(wrapper.props.style)).toMatchObject({ flex: 1 });
    }
    expect(view.getByText('Done').props.numberOfLines).toBe(1);
    expect(view.getByText('Rank titles').props.numberOfLines).toBe(1);
  });

  it('stacks at 320pt and twice the text size, primary first, full width, labels free to wrap', async () => {
    windowOf(320, 2);
    const view = await draw();
    const pair = view.getByTestId('pair');
    expect(StyleSheet.flatten(pair.props.style).flexDirection).toBeUndefined();
    expect(view.getAllByRole('button').map((b) => b.props.testID)).toEqual(['rank', 'done']);
    for (const id of ['done', 'rank']) {
      expect(
        StyleSheet.flatten(view.getByTestId(id).parent!.props.style ?? {}),
      ).not.toMatchObject({
        flex: 1,
      });
    }
    // No clipping at large text: stacked labels are not capped to a line or shrunk.
    expect(view.getByText('Rank titles').props.numberOfLines).toBeUndefined();
    expect(view.getByText('Rank titles').props.adjustsFontSizeToFit).toBe(false);
  });

  it('does what each half says', async () => {
    const view = await draw();
    await fireEvent.press(view.getByTestId('rank'));
    await fireEvent.press(view.getByTestId('done'));
    expect(onRank).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('pads the bottom by the safe area only when pinned', async () => {
    const loose = await draw();
    expect(
      StyleSheet.flatten(loose.getByTestId('pair').props.style).paddingBottom,
    ).toBeUndefined();
    await loose.unmount();
    const pinned = await draw({ pinned: true });
    // `renderWithProviders`' phone has a 34pt home indicator.
    expect(StyleSheet.flatten(pinned.getByTestId('pair').props.style).paddingBottom).toBe(34);
  });

  it('decides from the viewport: a row only where both labels fit their halves', () => {
    expect(actionPairFitsRow(['Done', 'Rank titles'], 360, 1)).toBe(true);
    expect(actionPairFitsRow(['Done', 'Rank titles'], 320, 1)).toBe(true);
    expect(actionPairFitsRow(['Done', 'Rank titles'], 320, 2)).toBe(false);
    expect(actionPairFitsRow(['Done', 'Rank titles'], 360, 2)).toBe(false);
    // Monotonic: a larger text size never turns a stack back into a row.
    let wasRow = true;
    for (let scale = 1; scale <= 2.01; scale += 0.05) {
      const row = actionPairFitsRow(['Done', 'Rank titles'], 375, scale);
      if (!wasRow) expect(row).toBe(false);
      wasRow = row;
    }
  });

  /**
   * **Against the font itself**, as `RankingSheet.test.tsx` does it: each label's advance
   * read from Inter SemiBold's `hmtx`, so the per-character estimate is shown never to be
   * narrower than what is drawn. An estimate that under-measured would put a label that
   * does not fit into a half.
   */
  it('never estimates a label narrower than Inter SemiBold draws it', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const font = fs.readFileSync(
      path.join(
        process.cwd(),
        'node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf',
      ),
    );
    const u16 = (o: number) => font.readUInt16BE(o);
    const tables: Record<string, number> = {};
    for (let i = 0; i < u16(4); i++) {
      tables[font.toString('latin1', 12 + 16 * i, 16 + 16 * i)] = font.readUInt32BE(
        20 + 16 * i,
      );
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
    const ems = (label: string) =>
      [...label].reduce((sum, ch) => sum + advance(glyphOf(ch.charCodeAt(0))), 0) / unitsPerEm;

    for (const [label, em] of Object.entries(PAIR_LABEL_EM)) {
      expect(ems(label)).toBeCloseTo(em, 3);
    }
    for (const label of [...Object.keys(PAIR_LABEL_EM), 'Import', 'Not now']) {
      for (const scale of [1, 1.3, 2]) {
        const drawn =
          ems(label) * theme.typography.headline.fontSize * scale + 2 * theme.space[3] + 4;
        expect(pairLabelWidth(label, scale)).toBeGreaterThanOrEqual(drawn);
      }
    }
  });
});
