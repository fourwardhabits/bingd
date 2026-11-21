import { theme } from '@/ui/tokens';

import {
  RANK_LABEL,
  RANK_LABEL_MAX_SCALE,
  RANK_LABEL_MIN_FIT,
  rankLabelMinimumScale,
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
 * **The four-control row** (founder's review of the live build, 2026-11-21): the labelled
 * control, the bookmark, Recommend and the ⋯ — three glyphs. What the screen passes is
 * `icons: 3` and the word the control will say.
 *
 * Where it sits:
 *   - the original page puts it beside the poster only where it fits at the reader's text
 *     size — a 430pt phone at default text for Rank Movie and Rank Show — and otherwise
 *     in the existing full-width row under the poster (every 320–412pt phone);
 *   - the Cinematic card is always the card's full width.
 * In both, at the word's floor (`RANK_LABEL_MIN_FIT` of its default size) the row fits at
 * every width this app runs at, so nothing wraps, clips or scrolls.
 */
describe('titleActionsFit, for Rank / Log rewatch · bookmark · Recommend · ⋯', () => {
  const row = (label: string) => ({ rank: true, icons: 3, label });
  const words = [...Object.values(RANK_LABEL), 'Log rewatch'];
  /** The original page's full-width row: the screen less two gutters. */
  const fullWidth = (screen: number) => screen - theme.layout.gutter * 2;
  /** The Cinematic card's content: the screen less the sheet's inset and padding a side. */
  const card = (screen: number) => screen - (theme.space[3] + theme.space[4]) * 2;

  it('keeps Rank Movie and Rank Show beside the poster on a 430pt phone', () => {
    expect(titleActionsFit(column(430), 1, row(RANK_LABEL.movie))).toBe(true);
    expect(titleActionsFit(column(430), 1, row(RANK_LABEL.series))).toBe(true);
  });

  it.each(words)('moves "%s" under the poster on the 320–412pt phones', (label) => {
    for (const width of [320, 360, 375, 390, 393, 412]) {
      expect(titleActionsFit(column(width), 1, row(label))).toBe(false);
    }
  });

  it.each(words)('moves "%s" under the poster at large text sizes, even at 430pt', (label) => {
    for (const scale of [1.3, 1.5, 2, 3.1]) {
      expect(titleActionsFit(column(430), scale, row(label))).toBe(false);
    }
  });

  it.each(words)('fits "%s" in the full-width row at its own size from 320pt', (label) => {
    for (const width of [320, 360, 390, 412]) {
      expect(titleActionsFit(fullWidth(width), 1, row(label))).toBe(true);
    }
  });

  it.each(words)('fits "%s" on the Cinematic card at its own size from 360pt', (label) => {
    for (const width of [360, 390, 412]) {
      expect(titleActionsFit(card(width), 1, row(label))).toBe(true);
    }
  });

  /**
   * **No clipping at the extreme.** At 320pt and any text size, both placements hold the
   * row with the word at no less than its floor, so `adjustsFontSizeToFit` always has
   * room to land on a size the reader can read.
   */
  it.each(words)('holds "%s" at its floor in both placements at 320pt', (label) => {
    expect(titleActionsFit(fullWidth(320), RANK_LABEL_MIN_FIT, row(label))).toBe(true);
    expect(titleActionsFit(card(320), RANK_LABEL_MIN_FIT, row(label))).toBe(true);
  });
});

/**
 * **The word's floor is absolute** (2026-11-21): never smaller than 0.7 of its default
 * size, whatever the reader's text setting.
 */
describe('rankLabelMinimumScale', () => {
  it('is 0.7 at and below the default text size, as it always was', () => {
    expect(rankLabelMinimumScale(1)).toBeCloseTo(0.7);
    expect(rankLabelMinimumScale(0.85)).toBeCloseTo(0.7);
  });

  it.each([1.15, 1.3, 1.5, 2, 3.1])('lands on 0.7 of the default size at %fx text', (scale) => {
    const drawn = Math.min(scale, RANK_LABEL_MAX_SCALE);
    expect(rankLabelMinimumScale(scale) * drawn).toBeCloseTo(RANK_LABEL_MIN_FIT);
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
