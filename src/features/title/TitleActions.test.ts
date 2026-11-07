import { theme } from '@/ui/tokens';

import { titleActionsFit } from './TitleActions';

/** What `app/title/[id].tsx` passes: the screen, less two gutters, the gap and the framed poster. */
const column = (screen: number) =>
  screen - theme.layout.gutter * 2 - theme.space[4] - (theme.poster.detail.width + theme.space[1] * 2);

const rankable = { rank: true, icons: 3 };

describe('titleActionsFit', () => {
  it.each([393, 402, 412, 430])('keeps the row beside the poster at %ipt', (width) => {
    expect(titleActionsFit(column(width), 1, rankable)).toBe(true);
  });

  /** A standard iPhone, and the width most phones this app has seen on a device. */
  it('keeps the row beside the poster at 390pt', () => {
    expect(titleActionsFit(column(390), 1, rankable)).toBe(true);
  });

  /** Left to `flexWrap`, these orphaned the last glyph on a line of its own. */
  it.each([375, 360, 320])('moves the row under the poster at %ipt', (width) => {
    expect(titleActionsFit(column(width), 1, rankable)).toBe(false);
  });

  it('moves the row at a larger text size on a phone that otherwise fits', () => {
    expect(titleActionsFit(column(390), 1.3, rankable)).toBe(false);
  });

  /** The padding and the tick do not shrink with the word, so 375pt still cannot hold it. */
  it('does not let a smaller text size talk a narrow phone into wrapping', () => {
    expect(titleActionsFit(column(375), 0.9, rankable)).toBe(false);
  });

  it('allows a text size smaller than default on a phone that already fits', () => {
    expect(titleActionsFit(column(390), 0.9, rankable)).toBe(true);
  });

  it('keeps a series beside the poster at every width, since it has no rank control', () => {
    expect(titleActionsFit(column(320), 1, { rank: false, icons: 2 })).toBe(true);
    expect(titleActionsFit(column(320), 2, { rank: false, icons: 2 })).toBe(true);
  });
});
