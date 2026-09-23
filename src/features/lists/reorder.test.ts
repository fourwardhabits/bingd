import { reorder, shiftFor, targetIndex } from './reorder';

describe('reorder', () => {
  it('moves one entry and keeps the rest in order', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('clamps a target past either end, and ignores a source that is not there', () => {
    expect(reorder(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(reorder(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('targetIndex — a neighbour is passed at its middle', () => {
  const heights = [60, 60, 60, 60, 60];

  it('stays put until the lifted row crosses half a neighbour', () => {
    expect(targetIndex(heights, 5, 1, 29, 60)).toBe(1);
    expect(targetIndex(heights, 5, 1, 31, 60)).toBe(2);
    expect(targetIndex(heights, 5, 3, -31, 60)).toBe(2);
  });

  it('counts several rows, and stops at the ends', () => {
    expect(targetIndex(heights, 5, 0, 150, 60)).toBe(2);
    expect(targetIndex(heights, 5, 0, 151, 60)).toBe(3);
    expect(targetIndex(heights, 5, 0, 10_000, 60)).toBe(4);
    expect(targetIndex(heights, 5, 4, -10_000, 60)).toBe(0);
  });

  it('uses the fallback for a row it has not measured', () => {
    expect(targetIndex([60, undefined, 60], 3, 0, 45, 80)).toBe(1);
    expect(targetIndex([60, undefined, 60], 3, 0, 35, 80)).toBe(0);
  });
});

describe('shiftFor — the rows between make room', () => {
  it('moves the passed rows up when dragging down, and down when dragging up', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 60))).toEqual([0, -60, -60, 0]);
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 60))).toEqual([0, 60, 60, 0]);
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1, 60))).toEqual([0, 0, 0]);
  });
});
