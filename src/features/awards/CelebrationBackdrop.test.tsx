import { render, screen } from '@testing-library/react-native';
import { useWindowDimensions } from 'react-native';

import { CelebrationBackdrop } from './CelebrationBackdrop';
import { SMALL_GRID, LARGE_GRID } from './celebration-posters';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions');

const setViewport = (width: number, height: number) =>
  (useWindowDimensions as unknown as jest.Mock).mockReturnValue({
    width,
    height,
    scale: 2,
    fontScale: 1,
  });

const gridOf = (shape: { columns: number; rows: number }) => ({
  ...shape,
  posters: Array.from({ length: shape.columns * shape.rows }, (_, i) => ({
    key: `p${i}`,
    posterPath: `/p${i}.jpg`,
  })),
});

/** The wall view: the one with an explicit height, inside the decorative container. */
const wall = () => {
  const root = screen.toJSON();
  let found: { props?: { style?: unknown } } | null = null;
  const walk = (node: unknown) => {
    if (!node || typeof node === 'string' || found) return;
    if (Array.isArray(node)) return void node.forEach(walk);
    const n = node as { props?: { style?: unknown }; children?: unknown[] };
    const style = [n.props?.style].flat(3).filter(Boolean) as Record<string, unknown>[];
    const flat = Object.assign({}, ...style) as Record<string, unknown>;
    if (typeof flat.height === 'number' && typeof flat.top === 'number') {
      found = { props: { style: flat } };
      return;
    }
    walk(n.children ?? []);
  };
  walk(root);
  if (!found) throw new Error('no wall found');
  return Object.assign({}, ...[(found as { props: { style: unknown } }).props.style].flat()) as {
    height: number;
    top: number;
    width: number;
  };
};

/**
 * **The wall covers, and never leaves a band above it** (founder, physical Android,
 * 2026-09-07).
 *
 * The reported symptom was a large empty region between the app bar and the first row of
 * posters on the celebration screen. The cause was here rather than on the screen: cells
 * were sized from the width alone, so a 3×3 wall came out shorter than the view it fills
 * and the centring offset pushed it *down*, leaving background colour at the top — the
 * one edge a reader looks at first.
 *
 * The invariant these pin is the one the component always claimed: the wall is at least
 * as tall as the area it covers, so it is cropped by the edges rather than framed by
 * them. Asserted for both grid shapes and for a tall, narrow viewport, because the small
 * grid on a large phone is exactly the case that broke.
 */
describe('the wall behind a celebration', () => {
  beforeEach(() => setViewport(390, 844));

  it('is at least as tall as the screen with the small grid', async () => {
    await render(<CelebrationBackdrop grid={gridOf(SMALL_GRID)} />);

    expect(wall().height).toBeGreaterThanOrEqual(844);
  });

  it('is at least as tall as the screen with the large grid', async () => {
    await render(<CelebrationBackdrop grid={gridOf(LARGE_GRID)} />);

    expect(wall().height).toBeGreaterThanOrEqual(844);
  });

  it('never starts below the top edge, which is where the band was', async () => {
    await render(<CelebrationBackdrop grid={gridOf(SMALL_GRID)} />);

    // Zero or negative: flush with the top, or cropped by it. Never pushed down.
    expect(wall().top).toBeLessThanOrEqual(0);
  });

  it('still reaches both side edges', async () => {
    await render(<CelebrationBackdrop grid={gridOf(SMALL_GRID)} />);

    expect(wall().width).toBeGreaterThanOrEqual(390);
  });

  it('covers a tall narrow phone too, where the shortfall is worst', async () => {
    setViewport(360, 1000);
    await render(<CelebrationBackdrop grid={gridOf(SMALL_GRID)} />);

    const measured = wall();
    expect(measured.height).toBeGreaterThanOrEqual(1000);
    expect(measured.width).toBeGreaterThanOrEqual(360);
    expect(measured.top).toBeLessThanOrEqual(0);
  });

  it('keeps every poster at the catalogue ratio', async () => {
    await render(<CelebrationBackdrop grid={gridOf(SMALL_GRID)} />);

    // Height follows width through the 2:3 poster aspect, whichever constraint set the
    // cell size — so a bigger wall is bigger posters and never stretched ones.
    const cellHeight = wall().height / SMALL_GRID.rows;
    const cellWidth = wall().width / SMALL_GRID.columns;
    expect(cellHeight / cellWidth).toBeCloseTo(3 / 2, 1);
  });
});
