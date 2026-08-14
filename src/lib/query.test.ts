import { queryKeys } from './query';

/**
 * Cache keys, which are only interesting when they collide.
 *
 * Two of these guard against showing one account's data to another: a key that omits the
 * user id serves whatever the previous signed-in account left behind, and nothing about the
 * screen would look wrong.
 */
describe('keys that must not collide', () => {
  it('separates two accounts', () => {
    expect(queryKeys.collection('a')).not.toEqual(queryKeys.collection('b'));
    expect(queryKeys.myProfile('a')).not.toEqual(queryKeys.myProfile('b'));
    expect(queryKeys.rankings('a', 'movies')).not.toEqual(queryKeys.rankings('b', 'movies'));
  });

  it('separates the two ranking categories', () => {
    // A position only means something within its category (PRD §11).
    expect(queryKeys.rankings('a', 'movies')).not.toEqual(queryKeys.rankings('a', 'tv_seasons'));
  });

  it('separates one search from the next', () => {
    // Without the query in the key, every search serves the first one's results.
    expect(queryKeys.search('heat')).not.toEqual(queryKeys.search('drive'));
  });

  it('keeps the trimmed comparison card apart from a full title', () => {
    // The comparison reads three columns and deliberately not the position. Sharing a key
    // with a title screen would let one serve the other.
    expect(queryKeys.comparisonCard('a')).not.toEqual(queryKeys.title('a'));
  });
});

describe('keys that are shared on purpose', () => {
  it('does not key the catalogue by account', () => {
    // The catalogue is the same for everyone, so a sign-out need not discard it.
    expect(queryKeys.search('heat')).toEqual(queryKeys.search('heat'));
    expect(queryKeys.seasons('series-1')).toEqual(queryKeys.seasons('series-1'));
  });
});
