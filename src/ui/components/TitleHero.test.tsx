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

  it('anchors the crop to the top, so faces survive it', async () => {
    // A 16:9 backdrop in a 1:1.4 frame loses a third of its height, and `cover` takes
    // that from both edges. Publicity stills are framed with the faces high.
    const nodes = await treeOf(<TitleHero uri={BACKDROP} />);
    const positioned = nodes.filter((node) => node.props.contentPosition);

    // expo-image normalises the shorthand to its object form, so the assertion is on
    // what it resolved to rather than on the string that was written.
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
