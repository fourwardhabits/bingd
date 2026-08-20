import { shouldMask } from './use-watched';

/**
 * The spoiler rule, on its own.
 *
 * It is four lines of code and it is the only thing standing between an author's
 * "Contains spoilers" and a reader who has not seen the film, so independent review
 * asked for it to be tested directly rather than through the feed. The cases below
 * are the ones the founder named: watching Season 1 must not unmask Season 2,
 * watching a season must not imply the series, and series-level state must not
 * unmask a season.
 */

const VIEWER = 'viewer';
const AUTHOR = 'author';

const base = {
  hasSpoilers: true,
  viewerId: VIEWER,
  authorId: AUTHOR,
};

describe('shouldMask', () => {
  it('does not mask a note nobody claimed spoils anything', () => {
    expect(
      shouldMask({ ...base, hasSpoilers: false, mediaItemId: 'film', watched: new Set() }),
    ).toBe(false);
  });

  it('never masks an author from their own writing', () => {
    expect(
      shouldMask({ ...base, viewerId: AUTHOR, mediaItemId: 'film', watched: new Set() }),
    ).toBe(false);
  });

  it('masks a spoiler for someone who has not watched the exact title', () => {
    expect(shouldMask({ ...base, mediaItemId: 'film', watched: new Set(['other']) })).toBe(true);
  });

  it('unmasks for someone who has watched the exact title', () => {
    expect(shouldMask({ ...base, mediaItemId: 'film', watched: new Set(['film']) })).toBe(false);
  });

  describe('television, where the exactness is the whole point', () => {
    // Ids stand in for four distinct media_items rows: a series and two of its
    // seasons are three separate entities, and nothing in this rule walks the
    // parent_id edge between them.
    const SERIES = 'parks-series';
    const S1 = 'parks-s1';
    const S2 = 'parks-s2';

    it('does not let Season 1 unmask Season 2', () => {
      expect(shouldMask({ ...base, mediaItemId: S2, watched: new Set([S1]) })).toBe(true);
    });

    it('does not let a season imply the series', () => {
      expect(shouldMask({ ...base, mediaItemId: SERIES, watched: new Set([S1, S2]) })).toBe(true);
    });

    it('does not let the series unmask any season of it', () => {
      expect(shouldMask({ ...base, mediaItemId: S1, watched: new Set([SERIES]) })).toBe(true);
      expect(shouldMask({ ...base, mediaItemId: S2, watched: new Set([SERIES]) })).toBe(true);
    });

    it('unmasks the exact season and only that one', () => {
      const watched = new Set([S1]);
      expect(shouldMask({ ...base, mediaItemId: S1, watched })).toBe(false);
      expect(shouldMask({ ...base, mediaItemId: S2, watched })).toBe(true);
    });
  });

  describe('when the watched set has not arrived', () => {
    it('masks rather than revealing', () => {
      // The failure modes are not symmetric. A mask shown to someone who has seen
      // the film is one extra tap; an unmask shown to someone who has not is the
      // thing the feature exists to prevent — and a feed renders before its
      // queries settle, every time.
      expect(shouldMask({ ...base, mediaItemId: 'film', watched: undefined })).toBe(true);
    });

    it('still lets the author read their own note', () => {
      expect(
        shouldMask({ ...base, viewerId: AUTHOR, mediaItemId: 'film', watched: undefined }),
      ).toBe(false);
    });
  });

  it('masks when the activity has no media item to check against', () => {
    expect(shouldMask({ ...base, mediaItemId: null, watched: new Set(['film']) })).toBe(true);
  });
});
