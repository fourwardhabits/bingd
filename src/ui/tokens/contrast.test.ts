import { brand, bucket, bucketInk, semantic, surface, text } from './color';
import { WCAG, contrastRatio } from './contrast';

/**
 * The mechanism from docs/design/design-system.md §11.
 *
 * Three jobs. It asserts that every foreground the design system permits clears
 * WCAG AA. It pins each ratio to the value printed in the design system tables,
 * so the documentation and the tokens cannot drift apart — this already caught
 * two values that were rounded wrongly by hand. And it asserts that Amber and
 * Sage still *fail*, so the finding behind the fills-never-ink rule cannot be
 * quietly undone by someone who thinks the rule looks arbitrary.
 *
 * Every text tone is checked against *both* surfaces. Parchment stopped being
 * the background on 2026-08-15 but did not stop being a background — it is now
 * `surface.sunken`, and a metadata line inside a warm well is the tightest pair
 * in the system. Testing only the base would have missed it.
 */

const round = (ratio: number) => Math.round(ratio * 10) / 10;

describe('text clears WCAG AA on both surfaces', () => {
  it.each([
    { name: 'text.primary', fg: text.primary, onPaper: 14.8, onParchment: 13.3 },
    { name: 'text.secondary', fg: text.secondary, onPaper: 6.4, onParchment: 5.8 },
    { name: 'text.tertiary', fg: text.tertiary, onPaper: 5.2, onParchment: 4.7 },
    { name: 'semantic.action (Maroon)', fg: semantic.action, onPaper: 8.2, onParchment: 7.4 },
  ])('$name reaches $onPaper:1 on Paper and $onParchment:1 on Parchment', ({
    fg,
    onPaper,
    onParchment,
  }) => {
    const paper = contrastRatio(fg, surface.base);
    const parchment = contrastRatio(fg, surface.sunken);

    expect(paper).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(parchment).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(paper)).toBe(onPaper);
    expect(round(parchment)).toBe(onParchment);
  });

  it('a raised card is lighter than the page, so it never reduces contrast', () => {
    for (const tone of [text.primary, text.secondary, text.tertiary]) {
      expect(contrastRatio(tone, surface.raised)).toBeGreaterThan(
        contrastRatio(tone, surface.base),
      );
    }
  });
});

describe('the certified fills', () => {
  // design-system.md §3. These are the only pairs in the system where a brand
  // colour carries text, and they are what lets the score badge be chromatic.
  it.each([
    { name: 'Loved it', fill: bucket.loved, ink: bucketInk.loved, documented: 7.4 },
    { name: 'It was fine', fill: bucket.fine, ink: bucketInk.fine, documented: 6.1 },
    { name: 'Not for me', fill: bucket.notForMe, ink: bucketInk.notForMe, documented: 4.9 },
  ])('$name reaches $documented:1', ({ fill, ink, documented }) => {
    const ratio = contrastRatio(ink, fill);
    expect(ratio).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(ratio)).toBe(documented);
  });

  it('Ink on the Amber reveal panel reaches 7.0:1', () => {
    const ratio = contrastRatio(text.onFill, brand.amber);
    expect(ratio).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(ratio)).toBe(7);
  });
});

describe('Amber and Sage are fills, never ink', () => {
  // A failure here means someone changed a brand value without reading §1. If
  // either colour ever passes, the rule is obsolete and the reveal composition
  // in §9 should be revisited deliberately rather than by accident.
  //
  // The lighter base bought 0.2 of a point and changed nothing, which is the
  // useful part: it was never the background's fault.
  it.each([
    { name: 'Antique Amber', hex: brand.amber, onPaper: 2.1, onParchment: 1.9 },
    { name: 'Muted Sage', hex: brand.sage, onPaper: 2.4, onParchment: 2.2 },
  ])('$name fails even the large-text floor on both surfaces', ({
    hex,
    onPaper,
    onParchment,
  }) => {
    expect(contrastRatio(hex, surface.base)).toBeLessThan(WCAG.AA_LARGE);
    expect(contrastRatio(hex, surface.sunken)).toBeLessThan(WCAG.AA_LARGE);
    expect(round(contrastRatio(hex, surface.base))).toBe(onPaper);
    expect(round(contrastRatio(hex, surface.sunken))).toBe(onParchment);
  });

  it('Stone is a fill too, despite sitting close enough to pass for a border', () => {
    // 3.0:1 on Paper — over the non-text floor and well under the body floor,
    // which is the band that invites someone to try it as text.
    const ratio = contrastRatio(bucket.notForMe, surface.base);
    expect(ratio).toBeLessThan(WCAG.AA_BODY);
    expect(round(ratio)).toBe(3);
  });
});

describe('there is no fourth text tone', () => {
  it('tertiary is the weakest permitted foreground, on the warmest surface', () => {
    const weakest = Math.min(
      ...[text.primary, text.secondary, text.tertiary].map((tone) =>
        contrastRatio(tone, surface.sunken),
      ),
    );
    expect(weakest).toBeGreaterThanOrEqual(WCAG.AA_BODY);
  });
});
