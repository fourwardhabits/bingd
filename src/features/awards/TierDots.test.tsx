import { render } from '@testing-library/react-native';

import { tier } from '@/ui/tokens';

import { TierDots } from './TierDots';

/**
 * Three dots, each keeping its own metal.
 *
 * The tempting shortcut is to colour every earned dot with the highest metal reached,
 * and it throws away the thing the strip is for: a bronze dot beside a silver one *is*
 * the progression, where three identical gold dots say only "finished" — which the badge
 * art already says.
 *
 * Asserted over the rendered tree rather than through a query helper, because what is
 * being checked is a fill colour on a decorative view, and the strip is deliberately
 * hidden from the accessibility tree — the row above it announces the tier in words.
 */

type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;

const flatten = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Record<string, unknown>;
};

function walk(node: Node, out: Record<string, unknown>[] = []) {
  if (!node || typeof node === 'string') return out;
  out.push(flatten(node.props?.style));
  for (const child of node.children ?? []) walk(child as Node, out);
  return out;
}

/** The fill of each dot, in order, or null where the dot is an empty ring. */
const dotsOf = async (earnedTierIndex: number) => {
  const view = await render(<TierDots earnedTierIndex={earnedTierIndex} />);
  return walk(view.toJSON() as Node)
    .filter((style) => style.borderRadius === 2.5)
    .map((style) => (style.backgroundColor as string | undefined) ?? null);
};

describe('the tier dots', () => {
  it('draws three empty rings before anything is earned', async () => {
    expect(await dotsOf(-1)).toEqual([null, null, null]);
  });

  it('fills one, in bronze, at the first tier', async () => {
    expect(await dotsOf(0)).toEqual([tier.bronze, null, null]);
  });

  it('keeps the bronze dot bronze when the second is earned', async () => {
    // The specific mistake this guards: recolouring both to silver.
    expect(await dotsOf(1)).toEqual([tier.bronze, tier.silver, null]);
  });

  it('keeps all three individually coloured at the top', async () => {
    expect(await dotsOf(2)).toEqual([tier.bronze, tier.silver, tier.gold]);
  });

  it('gives the three metals three different colours', async () => {
    // A strip whose metals were indistinguishable would be decoration that claims to
    // carry information.
    expect(new Set([tier.bronze, tier.silver, tier.gold]).size).toBe(3);
  });

  it('is hidden from the accessibility tree', async () => {
    // The row announces "Dabbler earned"; three dots read aloud would repeat it in a
    // form nobody can act on. Colour is never the only carrier here.
    const view = await render(<TierDots earnedTierIndex={1} />);
    const root = view.toJSON() as { props?: Record<string, unknown> };
    expect(root.props?.accessibilityElementsHidden).toBe(true);
    expect(root.props?.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('costs the row no height, because it sits over the badge', async () => {
    // Absolutely positioned inside the badge's own box. If this ever became a flow
    // element the whole sheet would grow by a band per row.
    const view = await render(<TierDots earnedTierIndex={0} />);
    const root = view.toJSON() as { props?: { style?: unknown } };
    expect(flatten(root.props?.style).position).toBe('absolute');
  });
});
