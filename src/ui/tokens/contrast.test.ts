import { brand, bucket, semantic, surface, text } from './color';
import { WCAG, contrastRatio } from './contrast';

/**
 * The mechanism from docs/design/design-system.md §11.
 *
 * Three jobs. It asserts that every foreground the design system permits clears
 * WCAG AA. It pins each ratio to the value printed in the design system tables,
 * so the documentation and the tokens cannot drift apart — this already caught
 * two values that were rounded wrongly by hand. And it asserts that Amber and
 * Sage still *fail* on Parchment, so the finding behind the fills-never-ink rule
 * cannot be quietly undone by someone who thinks the rule looks arbitrary.
 */

const round = (ratio: number) => Math.round(ratio * 10) / 10;

describe('text on Parchment clears WCAG AA', () => {
  it.each([
    { name: 'text.primary', fg: text.primary, documented: 13.3 },
    { name: 'text.secondary', fg: text.secondary, documented: 5.8 },
    { name: 'text.tertiary', fg: text.tertiary, documented: 4.7 },
    { name: 'semantic.action (Maroon)', fg: semantic.action, documented: 7.4 },
  ])('$name reaches $documented:1', ({ fg, documented }) => {
    const ratio = contrastRatio(fg, surface.base);
    expect(ratio).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(ratio)).toBe(documented);
  });
});

describe('Ink on a fill clears WCAG AA', () => {
  it.each([
    { name: 'the Amber reveal panel', bg: brand.amber, documented: 7.0 },
    { name: 'a Sage fill', bg: brand.sage, documented: 6.1 },
    { name: 'a Stone fill (Not for me)', bg: bucket.notForMe, documented: 4.9 },
  ])('Ink on $name reaches $documented:1', ({ bg, documented }) => {
    const ratio = contrastRatio(text.onFill, bg);
    expect(ratio).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(ratio)).toBe(documented);
  });

  it('Parchment on Maroon reaches 7.4:1', () => {
    const ratio = contrastRatio(text.inverse, semantic.action);
    expect(ratio).toBeGreaterThanOrEqual(WCAG.AA_BODY);
    expect(round(ratio)).toBe(7.4);
  });
});

describe('Amber and Sage are fills, never ink', () => {
  // A failure here means someone changed a brand value without reading §1. If
  // either colour ever passes, the rule is obsolete and the reveal composition
  // in §9 should be revisited deliberately rather than by accident.
  it.each([
    { name: 'Antique Amber', hex: brand.amber, documented: 1.9 },
    { name: 'Muted Sage', hex: brand.sage, documented: 2.2 },
  ])('$name fails even the large-text floor on Parchment', ({ hex, documented }) => {
    const ratio = contrastRatio(hex, surface.base);
    expect(ratio).toBeLessThan(WCAG.AA_LARGE);
    expect(round(ratio)).toBe(documented);
  });

  it('Stone is a fill too, despite reading as a neutral', () => {
    expect(contrastRatio(bucket.notForMe, surface.base)).toBeLessThan(WCAG.AA_BODY);
  });
});

describe('there is no fourth text tone', () => {
  it('tertiary is the weakest permitted foreground', () => {
    const weakest = Math.min(
      ...[text.primary, text.secondary, text.tertiary].map((tone) =>
        contrastRatio(tone, surface.base),
      ),
    );
    expect(weakest).toBeGreaterThanOrEqual(WCAG.AA_BODY);
  });
});
