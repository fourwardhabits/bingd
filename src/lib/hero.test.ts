import { heroArtwork } from './hero';

/**
 * The season page rendered blank at the top, and it was not a rendering bug: no
 * season in the catalogue has a backdrop, because TMDB's season endpoint does not
 * return one. All 1000 of them fell through to the collapsed band.
 *
 * These assert the order rather than the output, because the order is the decision.
 */
const SEASON_OWN = { backdropPath: '/season-bd.jpg', posterPath: '/season-po.jpg' };
const PARENT = { parentBackdropPath: '/series-bd.jpg', parentPosterPath: '/series-po.jpg' };

describe('heroArtwork', () => {
  it('prefers the entity’s own backdrop', () => {
    const art = heroArtwork({ ...SEASON_OWN, ...PARENT });
    expect(art.treatment).toBe('backdrop');
    expect(art.uri).toContain('season-bd.jpg');
  });

  it('falls back to the series backdrop, which is the case every season is in', () => {
    const art = heroArtwork({ backdropPath: null, posterPath: '/season-po.jpg', ...PARENT });
    expect(art.treatment).toBe('backdrop');
    expect(art.uri).toContain('series-bd.jpg');
  });

  it('prefers a series backdrop over any poster, since a backdrop is the right shape', () => {
    const art = heroArtwork({
      backdropPath: null,
      posterPath: '/season-po.jpg',
      parentBackdropPath: '/series-bd.jpg',
      parentPosterPath: null,
    });
    expect(art.uri).toContain('series-bd.jpg');
  });

  it('uses the poster, blurred, when no backdrop exists anywhere', () => {
    const art = heroArtwork({ backdropPath: null, posterPath: '/season-po.jpg' });
    expect(art.treatment).toBe('poster');
    expect(art.uri).toContain('season-po.jpg');
  });

  it('reaches the series poster when the season has neither', () => {
    const art = heroArtwork({
      backdropPath: null,
      posterPath: null,
      parentBackdropPath: null,
      parentPosterPath: '/series-po.jpg',
    });
    expect(art.treatment).toBe('poster');
    expect(art.uri).toContain('series-po.jpg');
  });

  it('gives up rather than inventing a surface', () => {
    // A film with no artwork keeps its collapsed band. That was the right answer
    // before and it stays the right answer — the fix is for seasons, which have a
    // parent to borrow from, not for titles that genuinely have nothing.
    expect(heroArtwork({}).treatment).toBe('none');
    expect(heroArtwork({ backdropPath: null, posterPath: null }).uri).toBeNull();
  });

  it('is unchanged for a film, which has no parent to fall back to', () => {
    const art = heroArtwork({ backdropPath: '/film-bd.jpg', posterPath: '/film-po.jpg' });
    expect(art.treatment).toBe('backdrop');
    expect(art.uri).toContain('film-bd.jpg');
  });
});
