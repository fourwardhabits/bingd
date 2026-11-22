import { render } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { theme } from '@/ui/tokens';

import { FEED_HEADING_MAX_SCALE, FeedHeading } from './FeedHeading';

/**
 * **The Feed tab's one heading** (header consistency, founder spec 2026-11-22): TRENDING NOW,
 * LEADERBOARD, DISCOVER PEOPLE and RECENT ACTIVITY are this component, so they are one size
 * by construction. What each must match is read off the style and the props, because the
 * production defect was three headings whose words were right and whose sizes were not.
 */
describe('FeedHeading', () => {
  const TITLES = ['Trending now', 'Leaderboard', 'Discover people', 'Recent activity'];

  const treatment = async (title: string, tight = false) => {
    const view = await render(<FeedHeading title={title} tight={tight} />);
    const text = view.getByText(title.toUpperCase());
    const style = StyleSheet.flatten(text.props.style) as TextStyle;
    return {
      header: view.getByLabelText(title).props.accessibilityRole,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontFamily: style.fontFamily,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform,
      color: style.color,
      maxFontSizeMultiplier: text.props.maxFontSizeMultiplier,
      adjustsFontSizeToFit: text.props.adjustsFontSizeToFit,
      numberOfLines: text.props.numberOfLines,
    };
  };

  it('draws every heading on the tab in one treatment', async () => {
    const token = theme.typography.sectionHeaderLarge;
    const expected = {
      header: 'header',
      fontSize: token.fontSize,
      lineHeight: token.lineHeight,
      fontFamily: token.fontFamily,
      letterSpacing: token.letterSpacing,
      textTransform: 'uppercase',
      color: theme.semantic.action,
      maxFontSizeMultiplier: FEED_HEADING_MAX_SCALE,
      adjustsFontSizeToFit: undefined,
      numberOfLines: undefined,
    };
    for (const title of TITLES) {
      expect(await treatment(title)).toEqual(expected);
    }
    // RECENT ACTIVITY's secondary place changes its spacing, never its type.
    expect(await treatment('Recent activity', true)).toEqual(
      await treatment('Recent activity'),
    );
  });

  it('uses the type scale’s own display ceiling rather than a number of its own', () => {
    expect(FEED_HEADING_MAX_SCALE).toBe(theme.typography.display.maxFontSizeMultiplier);
    expect(FEED_HEADING_MAX_SCALE).toBe(1.3);
  });
});

/**
 * **The ceiling, against the font.** A heading in the content heading row shares its line
 * with the three-way mode toggle, and no word in it may break: so the longest single word at
 * the ceiling must fit the width the row leaves it on the narrowest supported phone. Advance
 * widths are read from Inter SemiBold's own `hmtx`, as `StatRow.test.tsx` reads Regular, with
 * the same 4% allowance, and the letter spacing taken as scaling with the text.
 *
 *     width beside the toggle = W - gutter (row) - toggle - 2 * gutter (heading's own)
 *                             = 320 - 16 - (3 * 36 + 2 * 1) - 32 = 162pt
 *
 *     word          at 100%   at 130% (the ceiling)   at 200% (no ceiling)
 *     LEADERBOARD   123.3     160.2                   246.5
 *     DISCOVER       85.8     111.5
 *     TRENDING       86.5     112.4
 *
 * So at the ceiling every word fits and a two-word heading wraps at its space; without one
 * LEADERBOARD would break inside the word, which is why `fit` used to shrink it.
 */
describe('FeedHeading, measured from the font', () => {
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

  const ems = (() => {
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
    return (label: string) =>
      [...label].reduce((sum, ch) => sum + advance(glyphOf(ch.charCodeAt(0))), 0) / unitsPerEm;
  })();

  const token = theme.typography.sectionHeaderLarge;
  const widthAt = (word: string, scale: number) =>
    ems(word) * token.fontSize * scale * 1.04 + token.letterSpacing * scale * word.length;

  /** The toggle is three 36pt cells and two hairline-doubled borders, at most 1pt each. */
  const TOGGLE = 3 * (theme.layout.minTapTarget - theme.space[2]) + 2;
  const besideToggle = (screen: number) =>
    screen - theme.layout.gutter - TOGGLE - 2 * theme.layout.gutter;

  it('fits every word of every mode heading beside the toggle at the ceiling, from 320pt', () => {
    expect(besideToggle(320)).toBe(162);
    const words = ['Leaderboard', 'Discover people', 'Trending now'].flatMap((title) =>
      title.toUpperCase().split(' '),
    );
    for (const word of words) {
      expect(widthAt(word, FEED_HEADING_MAX_SCALE)).toBeLessThanOrEqual(besideToggle(320));
    }
    expect(widthAt('LEADERBOARD', FEED_HEADING_MAX_SCALE)).toBeCloseTo(160.2, 1);
    // And the ceiling is what makes it so: at 200% the one-word heading would break.
    expect(widthAt('LEADERBOARD', 2)).toBeGreaterThan(besideToggle(320));
  });
});
