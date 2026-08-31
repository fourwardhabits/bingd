import {
  coerceSortState,
  directionWords,
  isDirectional,
  nextSortState,
  sortDirectionIcon,
  spokenSortLabel,
  type SortAxisSpec,
  type SortState,
} from './sort';

/**
 * The state machine every sort control in the app runs on.
 *
 * These are the rules `ui/sort.ts` states, asserted rather than described — because the
 * defect that produced the module was a control whose label, arrow and order were each
 * defensible alone and wrong together. What that costs is invisible in a diff and
 * obvious in a photograph, so it is pinned here.
 */

type Axis = 'rating' | 'added' | 'title' | 'shuffle';

const AXES: readonly SortAxisSpec<Axis>[] = [
  {
    axis: 'rating',
    label: 'Rating',
    directions: { desc: 'highest first', asc: 'lowest first' },
    defaultDirection: 'desc',
  },
  {
    axis: 'added',
    label: 'Recently added',
    directions: { desc: 'newest first', asc: 'oldest first' },
    defaultDirection: 'desc',
  },
  {
    axis: 'title',
    label: 'Title',
    directions: { desc: 'Z–A', asc: 'A–Z' },
    defaultDirection: 'asc',
  },
  { axis: 'shuffle', label: 'Shuffle' },
];

const at = (axis: Axis, direction: 'desc' | 'asc'): SortState<Axis> => ({ axis, direction });

describe('rule 2 — a new axis starts in its own intuitive direction', () => {
  it('starts Rating at highest first, whatever the previous axis pointed at', () => {
    expect(nextSortState(at('added', 'asc'), 'rating', AXES)).toEqual(at('rating', 'desc'));
    expect(nextSortState(at('title', 'asc'), 'rating', AXES)).toEqual(at('rating', 'desc'));
  });

  it('starts Recently added at newest first', () => {
    expect(nextSortState(at('rating', 'asc'), 'added', AXES)).toEqual(at('added', 'desc'));
  });

  it('starts Title at A–Z, which is the ascending one', () => {
    // The axis whose intuitive direction is *not* descending — proof that the default
    // is read from the axis rather than assumed to be one value for all of them.
    expect(nextSortState(at('rating', 'desc'), 'title', AXES)).toEqual(at('title', 'asc'));
  });

  it(`never inherits the previous axis's direction`, () => {
    // Rating descending → Title must be A–Z, not Z–A.
    expect(nextSortState(at('rating', 'desc'), 'title', AXES).direction).toBe('asc');
    // Title A–Z → Rating must be highest first, not lowest.
    expect(nextSortState(at('title', 'asc'), 'rating', AXES).direction).toBe('desc');
  });
});

describe('rule 3 — the axis already on toggles its direction', () => {
  it('flips descending to ascending and back', () => {
    const first = nextSortState(at('rating', 'desc'), 'rating', AXES);
    expect(first).toEqual(at('rating', 'asc'));
    expect(nextSortState(first, 'rating', AXES)).toEqual(at('rating', 'desc'));
  });

  it('flips every directional axis, in both directions', () => {
    for (const spec of AXES.filter(isDirectional)) {
      const start = at(spec.axis, spec.defaultDirection ?? 'desc');
      const flipped = nextSortState(start, spec.axis, AXES);
      expect(flipped.axis).toBe(spec.axis);
      expect(flipped.direction).not.toBe(start.direction);
      expect(nextSortState(flipped, spec.axis, AXES)).toEqual(start);
    }
  });

  it('keeps the axis — and so the label — unchanged while the direction moves', () => {
    const before = at('added', 'desc');
    const after = nextSortState(before, 'added', AXES);
    expect(after.axis).toBe(before.axis);
    expect(spokenSortLabel(before, AXES)).toContain('Recently added');
    expect(spokenSortLabel(after, AXES)).toContain('Recently added');
  });

  it('does not toggle an axis with nothing to reverse', () => {
    // Shuffle re-seeds; the surface handles that. The state itself does not flip into a
    // direction no comparator of an unordered axis reads.
    expect(nextSortState(at('shuffle', 'desc'), 'shuffle', AXES)).toEqual(at('shuffle', 'desc'));
  });

  it('leaves the state alone when handed an axis this surface does not offer', () => {
    const state = at('rating', 'desc');
    expect(nextSortState(state, 'nope' as Axis, AXES)).toEqual(state);
  });
});

describe('rule 5 — the arrow is the direction, and the words say it aloud', () => {
  it('points down for descending and up for ascending', () => {
    expect(sortDirectionIcon('desc')).toBe('arrow-down-outline');
    expect(sortDirectionIcon('asc')).toBe('arrow-up-outline');
  });

  it('reads the axis and the direction in words', () => {
    expect(spokenSortLabel(at('rating', 'desc'), AXES)).toBe('Sort. Rating, highest first');
    expect(spokenSortLabel(at('rating', 'asc'), AXES)).toBe('Sort. Rating, lowest first');
    expect(spokenSortLabel(at('added', 'desc'), AXES)).toBe('Sort. Recently added, newest first');
    expect(spokenSortLabel(at('title', 'asc'), AXES)).toBe('Sort. Title, A–Z');
  });

  it('says only the axis for one with no direction', () => {
    expect(spokenSortLabel(at('shuffle', 'desc'), AXES)).toBe('Sort. Shuffle');
    expect(directionWords(AXES[3]!, 'desc')).toBeNull();
  });

  it('falls back to a bare Sort rather than inventing a label', () => {
    expect(spokenSortLabel(at('nope' as Axis, 'desc'), AXES)).toBe('Sort');
  });
});

describe('a surface that cannot offer the axis it was handed', () => {
  const withoutRating = AXES.filter((spec) => spec.axis !== 'rating');

  it(`falls back to the first offered axis in that axis's default direction`, () => {
    // Carrying Rating from the Watched tab into a watchlist. The label must land on an
    // axis that has data, pointing the way that axis points by default — not keep the
    // direction of an axis nothing on screen has a value for.
    expect(coerceSortState(at('rating', 'asc'), withoutRating)).toEqual(at('added', 'desc'));
  });

  it('leaves an offered axis exactly as it is, direction and all', () => {
    expect(coerceSortState(at('added', 'asc'), withoutRating)).toEqual(at('added', 'asc'));
    expect(coerceSortState(at('title', 'desc'), withoutRating)).toEqual(at('title', 'desc'));
  });

  it('returns the state unchanged when a surface offers nothing at all', () => {
    expect(coerceSortState(at('rating', 'desc'), [])).toEqual(at('rating', 'desc'));
  });
});

describe('rule 1 — a label names an axis and never a direction', () => {
  it('holds for every axis in this battery', () => {
    for (const spec of AXES) {
      for (const word of ['first', 'high', 'low', 'newest', 'oldest', 'a–z', 'z–a', 'watched']) {
        expect(spec.label.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('gives every directional axis a default direction to start in', () => {
    for (const spec of AXES) {
      expect(isDirectional(spec)).toBe(spec.defaultDirection !== undefined);
    }
  });
});
