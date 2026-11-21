import { theme } from '@/ui/tokens';

import {
  RANK_LABEL,
  RANK_LABEL_MAX_SCALE,
  titleActionsFit,
  titleEditLabel,
} from './TitleActions';

/** What `app/title/[id].tsx` passes: the screen, less two gutters, the gap and the framed poster. */
const column = (screen: number) =>
  screen -
  theme.layout.gutter * 2 -
  theme.space[4] -
  (theme.poster.detail.width + theme.space[1] * 2);

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

  it('keeps a cluster with no rank control beside the poster at every width', () => {
    expect(titleActionsFit(column(320), 1, { rank: false, icons: 2 })).toBe(true);
    expect(titleActionsFit(column(320), 2, { rank: false, icons: 2 })).toBe(true);
  });

  /**
   * **The longer words** (TV show & season ranking, 2026-11-14): Rank Movie, Rank Show,
   * Rank Season and Log rewatch are measured as the words they are, so the row moves under
   * the poster before a longer label could crowd it, rather than after.
   */
  describe('measured by the label it will say', () => {
    const labels = [...Object.values(RANK_LABEL), 'Log rewatch'];

    it.each(labels)('never fits "%s" where "Ranked" would not', (label) => {
      for (const width of [320, 360, 375, 390, 393, 402, 412, 430]) {
        for (const scale of [0.9, 1, 1.3, 2]) {
          if (titleActionsFit(column(width), scale, { ...rankable, label })) {
            expect(titleActionsFit(column(width), scale, rankable)).toBe(true);
          }
        }
      }
    });

    it('moves Rank Season under the poster on a 390pt phone', () => {
      expect(titleActionsFit(column(390), 1, { ...rankable, label: RANK_LABEL.season })).toBe(
        false,
      );
    });

    it('measures no wider than the cap the label renders with', () => {
      const at = (scale: number) =>
        titleActionsFit(column(430), scale, { ...rankable, label: RANK_LABEL.series });
      expect(at(3)).toBe(at(RANK_LABEL_MAX_SCALE));
    });
  });
});

/**
 * **The three-control row** (founder's final specification, 2026-11-21): the labelled
 * control, the bookmark and the ⋯ — two glyphs where there were three. What the screen
 * passes is `icons: 2` and the word the control will say, so the narrow phones and the
 * large text sizes still move the row under the poster rather than crowd it.
 */
describe('titleActionsFit, for Rank / Log rewatch · bookmark · ⋯', () => {
  const row = (label: string) => ({ rank: true, icons: 2, label });
  const words = [...Object.values(RANK_LABEL), 'Log rewatch'];

  it.each(words)('keeps "%s" beside the poster on a 412pt and a 430pt phone', (label) => {
    expect(titleActionsFit(column(412), 1, row(label))).toBe(true);
    expect(titleActionsFit(column(430), 1, row(label))).toBe(true);
  });

  it.each(words)('moves "%s" under the poster on the narrow phones', (label) => {
    for (const width of [320, 360, 375]) {
      expect(titleActionsFit(column(width), 1, row(label))).toBe(false);
    }
  });

  it.each(words)('moves "%s" under the poster at the largest text sizes', (label) => {
    for (const scale of [1.5, 2, 3.1]) {
      expect(titleActionsFit(column(412), scale, row(label))).toBe(false);
    }
  });

  it.each(words)('always fits "%s" in the full-width row at 320pt and default text', (label) => {
    expect(titleActionsFit(320 - theme.layout.gutter * 2, 1, row(label))).toBe(true);
  });

  it('never needs more room than the four-control row it replaces', () => {
    for (const label of words) {
      for (const width of [320, 360, 375, 390, 393, 402, 412, 430]) {
        for (const scale of [0.9, 1, 1.3, 2]) {
          if (titleActionsFit(column(width), scale, { rank: true, icons: 3, label })) {
            expect(titleActionsFit(column(width), scale, row(label))).toBe(true);
          }
        }
      }
    }
  });
});

/**
 * **The ⋯ menu's one editing row, by state** (founder's final specification, 2026-11-21).
 * It never implies a ranking that does not exist, and it is absent where there is no log
 * to edit: there, Rank is already the door to the same sheet.
 */
describe('titleEditLabel', () => {
  const none = { hasReview: false, hasPrivateNote: false };
  const note = { hasReview: false, hasPrivateNote: true };
  const review = { hasReview: true, hasPrivateNote: false };

  it('offers nothing for a title with no log', () => {
    expect(titleEditLabel({ ranked: false, logged: false, ...none })).toBeNull();
  });

  it('says Edit ranking once ranked, naming the writing that is there', () => {
    expect(titleEditLabel({ ranked: true, logged: true, ...none })).toBe(
      'Edit ranking / Add note',
    );
    expect(titleEditLabel({ ranked: true, logged: true, ...note })).toBe('Edit ranking / note');
    expect(titleEditLabel({ ranked: true, logged: true, ...review })).toBe(
      'Edit ranking / review',
    );
  });

  it('says Edit log for a logged or imported title with no ranking', () => {
    expect(titleEditLabel({ ranked: false, logged: true, ...none })).toBe('Edit log / Add note');
    expect(titleEditLabel({ ranked: false, logged: true, ...note })).toBe('Edit log / note');
    expect(titleEditLabel({ ranked: false, logged: true, ...review })).toBe('Edit log / review');
  });

  it('still says Edit ranking while the log row is in flight behind a ranking', () => {
    expect(titleEditLabel({ ranked: true, logged: false, ...none })).toBe(
      'Edit ranking / Add note',
    );
  });
});
