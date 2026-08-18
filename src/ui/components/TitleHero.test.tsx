import { render } from '@testing-library/react-native';

import { TitleHero } from './TitleHero';

/**
 * The hero's fade, which the founder rejected twice.
 *
 * The banded implementation stacked sixty views down the bottom of the frame, each
 * stepping about one and a half percent of alpha — arithmetic that says invisible and a
 * screen that said stripes. Eight-bit alpha on a large smooth ramp produces contour
 * bands precisely *because* the ramp is smooth, so more and thinner bands made it worse.
 * The technique was the defect.
 *
 * These tests pin the two things a device cannot be relied on to reveal in review: that
 * the bands are gone, and that what replaced them is one gradient rather than a
 * differently-shaped stack.
 *
 * Asserted over the rendered JSON rather than through a query helper, because what is
 * being checked is the *shape of the tree* — how many views carry a fade — and there is
 * no accessible role or label for "a band".
 */

const BACKDROP = 'https://image.tmdb.org/t/p/w1280/backdrop.jpg';

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null;

const flatten = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Record<string, unknown>;
};

/** Every node in the rendered tree, flattened. */
function walk(node: Node, out: { type: string; style: Record<string, unknown>; props: Record<string, unknown> }[] = []) {
  if (!node || typeof node === 'string') return out;
  out.push({
    type: node.type ?? '',
    style: flatten(node.props?.style),
    props: node.props ?? {},
  });
  for (const child of node.children ?? []) walk(child as Node, out);
  return out;
}

const treeOf = async (element: Parameters<typeof render>[0]) =>
  walk((await render(element)).toJSON() as Node);

describe('the hero fade', () => {
  it('is one view, not a stack of bands', async () => {
    const nodes = await treeOf(<TitleHero uri={BACKDROP} />);

    // Sixty views with a fixed two-point height and a background colour is exactly what
    // the old implementation looked like in a tree. One view is the whole change.
    const banded = nodes.filter(
      (node) => node.style.height === 2 && typeof node.style.backgroundColor === 'string',
    );

    expect(banded).toHaveLength(0);
  });

  it('draws a continuous gradient the platform interpolates', async () => {
    const nodes = await treeOf(<TitleHero uri={BACKDROP} />);

    const gradients = nodes
      .map((node) => node.style.experimental_backgroundImage)
      .filter(Boolean) as string[];

    expect(gradients).toHaveLength(1);
    expect(gradients[0]).toContain('linear-gradient(to bottom,');
  });

  it('leaves most of the artwork alone', async () => {
    // The founder's range is "approximately the bottom 30–40%". The old version faded
    // 62% of the frame, which is why the image "ended too high" even after the hero was
    // made taller.
    const nodes = await treeOf(<TitleHero uri={BACKDROP} />);
    const gradient = String(
      nodes.map((node) => node.style.experimental_backgroundImage).find(Boolean),
    );

    // The last fully-transparent stop is where the fade begins.
    const start = Number(/([0-9]+)%,\s*rgba\([^)]*0\.08\)/.exec(gradient)?.[1]);
    expect(start).toBeGreaterThanOrEqual(60);
  });

  /**
   * **The alignment, recorded rather than re-litigated.**
   *
   * Asked again in the founder's final pass, where the hero still read "somewhat like a
   * cropped cutoff". The answer, checked against the arithmetic rather than adjusted by
   * eye:
   *
   * `contentPosition="top center"` is what the Image carries, and expo-image does apply
   * it — this test asserts the resolved object, not the string that was written.
   *
   * **For a real backdrop the vertical half is a no-op.** `cover` scales until both
   * dimensions are filled. A 16:9 backdrop (1.78) in a 1.62 frame is wider than the
   * frame once scaled to its height, so the crop comes off the *sides* and nothing is
   * lost vertically at all. Top, centre and bottom would render identically. What the
   * founder is seeing is the ~10% horizontal loss `HERO_RATIO` already documents, and
   * no alignment value can return it: `left: '50%'` is the middle, and moving it left
   * or right would drop one side of the frame entirely.
   *
   * **For the poster fallback the vertical half is load-bearing**, which is the case
   * below. A 2:3 poster in a 1.62 frame is far taller than the frame, so `cover` takes
   * the crop from the height — and taking it from the bottom keeps the part somebody
   * composed. Centre or bottom would be a strictly worse choice there.
   *
   * So: no supported one-line change is an improvement, and the hero is left alone.
   */
  it('anchors the crop to the top, so faces survive it', async () => {
    const nodes = await treeOf(<TitleHero uri={BACKDROP} />);
    const positioned = nodes.filter((node) => node.props.contentPosition);

    expect(positioned).toHaveLength(1);
    expect(positioned[0]!.props.contentPosition).toEqual({ top: 0, left: '50%' });
  });

  it('anchors the poster fallback the same way, which is where it decides anything', async () => {
    // A season borrows the series' key art and falls back to a poster where there is
    // none. This is the case the top anchor exists for.
    const nodes = await treeOf(<TitleHero uri={BACKDROP} blurred />);
    const positioned = nodes.filter((node) => node.props.contentPosition);

    expect(positioned).toHaveLength(1);
    expect(positioned[0]!.props.contentPosition).toEqual({ top: 0, left: '50%' });
  });

  it('draws a warm band and no artwork when there is none', async () => {
    // The seed catalogue ships without backdrops. A short band is not a failure state
    // and must not pretend to be an image.
    const nodes = await treeOf(<TitleHero uri={null} collapsedHeight={96} />);

    expect(nodes.some((node) => node.props.source)).toBe(false);
    expect(nodes.some((node) => node.style.height === 96)).toBe(true);
  });
});
