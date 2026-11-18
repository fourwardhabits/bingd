import {
  AUTO_SCROLL_EDGE,
  AUTO_SCROLL_MAX,
  autoScrollSpeed,
  displacement,
  hitIndex,
  slotOf,
  type Rect,
} from './drag-geometry';

/** A three-across grid of 100×150 cells, as FlashList lays the poster wall out. */
const grid = (count: number) => {
  const rects: Rect[] = Array.from({ length: count }, (_, i) => ({
    x: (i % 3) * 100,
    y: Math.floor(i / 3) * 150,
    width: 100,
    height: 150,
  }));
  return (i: number) => rects[i];
};

/** A column of rows of uneven height: titles that wrap make taller rows. */
const column = (heights: number[]) => {
  let y = 0;
  const rects = heights.map((height) => {
    const rect = { x: 0, y, width: 390, height };
    y += height;
    return rect;
  });
  return (i: number) => rects[i];
};

describe('hitIndex on the poster grid', () => {
  const layout = grid(12);

  it('finds the cell under a point', () => {
    expect(hitIndex({ x: 50, y: 75 }, 12, layout)).toBe(0);
    expect(hitIndex({ x: 150, y: 75 }, 12, layout)).toBe(1);
    expect(hitIndex({ x: 250, y: 75 }, 12, layout)).toBe(2);
    expect(hitIndex({ x: 150, y: 310 }, 12, layout)).toBe(7);
  });

  it('clamps above, below and beside the grid', () => {
    expect(hitIndex({ x: 150, y: -40 }, 12, layout)).toBe(0);
    expect(hitIndex({ x: 150, y: 9000 }, 12, layout)).toBe(11);
    expect(hitIndex({ x: 900, y: 10 }, 12, layout)).toBe(2);
    expect(hitIndex({ x: -10, y: 10 }, 12, layout)).toBe(0);
  });

  it('handles a short last row', () => {
    expect(hitIndex({ x: 250, y: 610 }, 13, grid(13))).toBe(12);
  });

  it('counts only the rungs it is given, so an unranked title is never a target', () => {
    // 12 laid out, 5 droppable: a point over index 9, an unranked title, is the last rung.
    expect(hitIndex({ x: 50, y: 460 }, 5, layout)).toBe(4);
    // Inside the last rung's row it is still the column.
    expect(hitIndex({ x: 50, y: 200 }, 5, layout)).toBe(3);
  });

  it('answers -1 when nothing is laid out', () => {
    expect(hitIndex({ x: 0, y: 0 }, 0, layout)).toBe(-1);
    expect(hitIndex({ x: 0, y: 0 }, 3, () => undefined)).toBe(-1);
  });
});

describe('hitIndex on the list', () => {
  const layout = column([72, 72, 96, 72, 72]);

  it('follows uneven rows', () => {
    expect(hitIndex({ x: 10, y: 10 }, 5, layout)).toBe(0);
    expect(hitIndex({ x: 10, y: 150 }, 5, layout)).toBe(2);
    expect(hitIndex({ x: 10, y: 239 }, 5, layout)).toBe(2);
    expect(hitIndex({ x: 10, y: 241 }, 5, layout)).toBe(3);
  });

  it('is fast over a very long list', () => {
    const long = column(Array.from({ length: 5000 }, () => 72));
    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) hitIndex({ x: 10, y: i * 300 }, 5000, long);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('slotOf: the titles between close up, which opens the gap at the target', () => {
  it('moving down shifts the ones between up', () => {
    expect([0, 1, 2, 3, 4].map((i) => slotOf(i, 1, 3))).toEqual([null, null, 1, 2, null]);
  });

  it('moving up shifts the ones between down', () => {
    expect([0, 1, 2, 3, 4].map((i) => slotOf(i, 3, 1))).toEqual([null, 2, 3, null, null]);
  });

  it('nothing moves when held where it started', () => {
    expect([0, 1, 2].map((i) => slotOf(i, 1, 1))).toEqual([null, null, null]);
  });
});

describe('displacement', () => {
  it('wraps between grid rows', () => {
    // Index 3 (row 1, col 0) moving into slot 2 (row 0, col 2).
    expect(displacement(3, 0, 5, grid(9))).toEqual({ x: 200, y: -150 });
  });

  it('moves a row by its neighbour’s offset', () => {
    expect(displacement(1, 3, 0, column([72, 72, 72, 72]))).toEqual({ x: 0, y: 72 });
  });

  it('is null for a title that stays', () => {
    expect(displacement(4, 0, 2, grid(9))).toBeNull();
  });
});

describe('autoScrollSpeed', () => {
  it('is still in the middle of the viewport', () => {
    expect(autoScrollSpeed(400, 800)).toBe(0);
  });

  it('scrolls up near the top and down near the bottom, faster deeper in', () => {
    expect(autoScrollSpeed(AUTO_SCROLL_EDGE / 2, 800)).toBeLessThan(0);
    expect(autoScrollSpeed(0, 800)).toBe(-AUTO_SCROLL_MAX);
    expect(autoScrollSpeed(800 - AUTO_SCROLL_EDGE / 2, 800)).toBeGreaterThan(0);
    expect(autoScrollSpeed(900, 800)).toBe(AUTO_SCROLL_MAX);
    expect(Math.abs(autoScrollSpeed(10, 800))).toBeGreaterThan(Math.abs(autoScrollSpeed(50, 800)));
  });

  it('never scrolls a viewport too short to have a middle', () => {
    expect(autoScrollSpeed(10, AUTO_SCROLL_EDGE * 2)).toBe(0);
  });
});
