/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Exists so docs/design/design-system.md §11's contrast test can assert on real
 * numbers. The Amber and Sage failures in §1 were found by measurement, and
 * measurement is how they stay found.
 */

const channelToLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export const parseHex = (hex: string): { r: number; g: number; b: number } => {
  const cleaned = hex.replace('#', '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;

  if (full.length < 6) {
    throw new Error(`Not a parseable hex color: ${hex}`);
  }

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
};

export const relativeLuminance = (hex: string): number => {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
};

export const contrastRatio = (foreground: string, background: string): number => {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
};

export const WCAG = {
  /** Normal-size text. */
  AA_BODY: 4.5,
  /** 18pt+, or 14pt+ bold. */
  AA_LARGE: 3,
  /** Borders, icons, and other non-text elements. */
  AA_NON_TEXT: 3,
} as const;
