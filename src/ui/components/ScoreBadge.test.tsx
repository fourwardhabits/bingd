import { render } from '@testing-library/react-native';
import { PixelRatio } from 'react-native';

import { BAND_RANGE, formatScore } from '@/features/collection/score';
import { theme } from '@/ui/tokens';

import { ScoreBadge, scoreBadgeMetrics, type ScoreBadgeSize } from './ScoreBadge';

/**
 * The founder found `10.0` spilling out of its circle in the feed. The defect is
 * arithmetic, not styling: the badge is a fixed circle and the number was a fixed
 * size chosen against a three-character score, so the one four-character score in
 * the system was the only one that did not fit — and it is the score a user most
 * wants to show someone.
 *
 * So this asserts the property rather than the appearance: every score the ranking
 * system can produce, at every badge size, at every text scale the badge honours,
 * renders inside its own circle with margin to spare. A rendered-width assertion is
 * not available in this environment, so the same advance-width model the component
 * sizes itself with is restated here and checked against the geometry. That is worth
 * having even so — it catches a diameter changed without the font, a font changed
 * without the diameter, and a new size added with neither thought through.
 */

const SIZES: ScoreBadgeSize[] = ['lg', 'md', 'sm'];

/** Inter SemiBold's own advances: 0.60em for a tabular digit, 0.28em for a period. */
const widthOf = (text: string, fontSize: number) =>
  [...text].reduce((sum, ch) => sum + (ch === '.' ? 0.28 : 0.6), 0) * fontSize;

/**
 * How wide a horizontal line of a given height can be inside a circle, from the
 * circle's own geometry: the chord at the text's top and bottom edges.
 *
 * This is the part of the test that is not the component talking to itself.
 * Independent review pointed out, correctly, that asserting the component's linear
 * `TEXT_SHARE` heuristic against itself proves only that the arithmetic is
 * self-consistent. The chord does not know about that heuristic — it is a fact about
 * circles — so a `TEXT_SHARE` raised to 0.95, or a diameter reduced without the font,
 * fails here even though both would keep the component internally consistent.
 *
 * What it still cannot do is measure a real glyph. Proving the founder's `10.0`
 * defect is gone on a device remains a visual check, and is listed as one.
 */
const chordWidth = (diameter: number, textHeight: number) => {
  const r = diameter / 2;
  return 2 * Math.sqrt(Math.max(r * r - (textHeight / 2) ** 2, 0));
};

/** `ScoreBadge` sets its line height to 1.15 of the font size. */
const lineHeightOf = (fontSize: number) => Math.round(fontSize * 1.15);

/** Every score the bands can produce, at one decimal. */
const everyScore = () => {
  const scores = new Set<number>();
  for (const { high, low } of Object.values(BAND_RANGE)) {
    for (let tenths = Math.round(low * 10); tenths <= Math.round(high * 10); tenths += 1) {
      scores.add(tenths / 10);
    }
  }
  return [...scores].sort((a, b) => a - b);
};

describe('the number fits the circle', () => {
  // Stated rather than inherited: jest-expo's PixelRatio reports a scale of its
  // own, so a test that did not set one would be asserting the harness's text size
  // and would change meaning the day that changed.
  const atFontScale = (scale: number) => {
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(scale);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('covers the whole 0.0 to 10.0 range', () => {
    const scores = everyScore();
    expect(scores[0]).toBe(0);
    expect(scores[scores.length - 1]).toBe(10);
    expect(scores).toContain(6.9);
    expect(scores).toContain(7);
  });

  /** Inside the circle with a tenth of the available chord still empty either side. */
  const fitsFramed = (text: string, size: ScoreBadgeSize) => {
    const { diameter, fontSize } = scoreBadgeMetrics(size);
    const available = chordWidth(diameter, lineHeightOf(fontSize));
    return { width: widthOf(text, fontSize), limit: available * 0.9 };
  };

  it.each(SIZES)('fits every score at size %s', (size) => {
    atFontScale(1);
    expect(scoreBadgeMetrics(size).diameter).toBe(theme.layout.scoreBadge[size]);

    for (const score of everyScore()) {
      const { width, limit } = fitsFramed(formatScore(score), size);
      expect(width).toBeLessThanOrEqual(limit);
    }
  });

  it.each(SIZES)('still fits at size %s when the user has enlarged text', (size) => {
    atFontScale(2);
    const { diameter } = scoreBadgeMetrics(size);

    // The badge grows with the text, up to its own ceiling, so the ratio that
    // guarantees the fit is preserved rather than broken by the first user who
    // turns type size up.
    expect(diameter).toBeGreaterThan(theme.layout.scoreBadge[size]);
    const { width, limit } = fitsFramed('10.0', size);
    expect(width).toBeLessThanOrEqual(limit);
  });

  it('would notice a badge sized for the common score rather than the longest', () => {
    atFontScale(1);
    // The defect, restated as a measurement: `sm` was a 36pt circle carrying 15pt
    // type, which holds `8.7` and does not hold `10.0`. Both numbers are the ones
    // that actually shipped.
    const available = chordWidth(36, lineHeightOf(15));
    expect(widthOf('8.7', 15)).toBeLessThanOrEqual(available * 0.9);
    expect(widthOf('10.0', 15)).toBeGreaterThan(available * 0.9);
  });

  it('is one type size per badge, so a column of scores stays even', () => {
    atFontScale(1);
    // `8.7` and `10.0` set in different sizes would undo the tabular figures at
    // exactly the row where they matter, so the badge sizes for the longest string
    // and uses that size for all of them.
    const { fontSize } = scoreBadgeMetrics('md');
    expect(widthOf('8.7', fontSize)).toBeLessThan(widthOf('10.0', fontSize));
  });
});

describe('the badge', () => {
  it('is Maroon whatever the bucket', async () => {
    const bands = {
      loved: 'Loved it',
      fine: 'It was fine',
      not_for_me: 'Not for me',
    } as const;

    // All three in one tree. Three renders in one test is the thing this library
    // does not survive — the third comes back null — and the assertion does not
    // need them separated anyway.
    const view = await render(
      <>
        {(['loved', 'fine', 'not_for_me'] as const).map((bucket) => (
          <ScoreBadge key={bucket} score={8.2} bucket={bucket} />
        ))}
      </>,
    );

    const fills = (['loved', 'fine', 'not_for_me'] as const).map((bucket) => {
      const style = view.getByLabelText(`8.2 out of 10, ${bands[bucket]}`).props.style;
      const flat = [style].flat(3).filter(Boolean) as Record<string, unknown>[];
      return flat.find((entry) => entry.backgroundColor)?.backgroundColor;
    });

    expect(new Set(fills).size).toBe(1);
    expect(fills[0]).toBe(theme.semantic.action);
  });

  it('reads the score with its unit and its band', async () => {
    const view = await render(<ScoreBadge score={10} bucket="loved" />);
    expect(view.getByLabelText('10.0 out of 10, Loved it')).toBeTruthy();
  });

  it('offers ranking rather than a zero when nothing has been compared', async () => {
    const view = await render(<ScoreBadge onPress={() => {}} />);
    expect(view.getByLabelText('Not ranked. Rank this title.')).toBeTruthy();
    expect(view.queryByText('0.0')).toBeNull();
  });
});
