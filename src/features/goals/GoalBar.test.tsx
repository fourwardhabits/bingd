import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { GoalBar } from './GoalBar';
import type { GoalStatus } from './goals';

/**
 * **Which colour means arrival** (founder, post-RC).
 *
 * The bar filled Sage while the goal was open and Amber once it was met. Both are warm,
 * so a finished goal and a nearly-finished one were the same picture at a glance — only
 * longer. It now fills **Amber** while open and **Maroon** once complete, so completion is
 * a change of colour rather than a change of length.
 *
 * The assertions read the resolved style off the rendered tree rather than checking that a
 * named style object exists, because the thing that broke is what the reader sees: a
 * `fillComplete` entry that is never applied looks identical in the source and wrong on the
 * screen. Colours come from `theme`, so the palette stays the one place a value is written.
 *
 * The tree is walked over `toJSON()` rather than through RNTL's `UNSAFE_*` type queries,
 * which this version no longer exposes — and a testID was not added, because the component
 * should not carry a prop that exists only for this file.
 */

const status = (over: Partial<GoalStatus> = {}): GoalStatus =>
  ({
    category: 'movies',
    target: 52,
    count: 12,
    remaining: 40,
    fraction: 12 / 52,
    complete: false,
    ...over,
  }) as GoalStatus;

type Node = { props?: Record<string, unknown>; children?: unknown } | string | null;

/** Every resolved style in the tree that has both a height and a background. */
function sizedStyles(node: Node): { backgroundColor?: string; width?: unknown }[] {
  if (!node || typeof node === 'string') return [];
  const out: { backgroundColor?: string; width?: unknown }[] = [];
  const flat = StyleSheet.flatten(node.props?.style as never) as
    | Record<string, unknown>
    | undefined;
  if (flat && 'height' in flat && 'backgroundColor' in flat) {
    out.push(flat as { backgroundColor?: string; width?: unknown });
  }
  const kids = (node as { children?: unknown }).children;
  for (const child of Array.isArray(kids) ? kids : kids ? [kids] : []) {
    out.push(...sizedStyles(child as Node));
  }
  return out;
}

/** The track is the outer sized box; the fill, when drawn, is the one inside it. */
const barStyles = (view: { toJSON: () => unknown }) => {
  const all = sizedStyles(view.toJSON() as Node);
  return { track: all[0], fill: all[1] };
};

describe('the goal bar’s two colours', () => {
  it('fills with the yellow token while the goal is in progress', async () => {
    const view = await renderWithProviders(<GoalBar status={status()} />);
    const { fill } = barStyles(view);
    expect(fill?.backgroundColor).toBe(theme.semantic.emphasis);
  });

  it('fills with the maroon token once the goal is complete', async () => {
    const view = await renderWithProviders(
      <GoalBar status={status({ count: 52, remaining: 0, fraction: 1, complete: true })} />,
    );
    const { fill } = barStyles(view);
    expect(fill?.backgroundColor).toBe(theme.semantic.action);
  });

  it('uses two different colours, which is the whole point', () => {
    // Guards the swap against a future edit that points both states at one token: the two
    // tests above would still pass if `emphasis` and `action` ever became the same hex.
    expect(theme.semantic.emphasis).not.toBe(theme.semantic.action);
  });

  it('keeps the track underneath both states', async () => {
    const open = barStyles(await renderWithProviders(<GoalBar status={status()} />));
    expect(open.track?.backgroundColor).toBe(theme.surface.sunken);
  });

  it('draws no fill at all at zero, rather than a hairline of either colour', async () => {
    const view = await renderWithProviders(
      <GoalBar status={status({ count: 0, remaining: 52, fraction: 0 })} />,
    );
    const { track, fill } = barStyles(view);
    expect(track?.backgroundColor).toBe(theme.surface.sunken);
    expect(fill).toBeUndefined();
  });
});
