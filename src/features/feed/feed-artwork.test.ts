import { artworkHeight, feedArtwork, takesFeedCard } from './feed-artwork';

describe('feedArtwork', () => {
  it('prefers the title’s own backdrop, at the card bucket', () => {
    const art = feedArtwork({ backdropPath: '/own.jpg', parentBackdropPath: '/series.jpg' });
    expect(art).toEqual({ treatment: 'backdrop', uri: 'https://image.tmdb.org/t/p/w780/own.jpg' });
  });

  it('falls back to the series backdrop before any poster', () => {
    const art = feedArtwork({ posterPath: '/s1.jpg', parentBackdropPath: '/series.jpg' });
    expect(art.treatment).toBe('backdrop');
    expect(art.uri).toContain('/series.jpg');
  });

  it('uses the poster, then the series poster, when there is no backdrop anywhere', () => {
    expect(feedArtwork({ posterPath: '/s1.jpg', parentPosterPath: '/show.jpg' }).uri).toContain('/s1.jpg');
    expect(feedArtwork({ parentPosterPath: '/show.jpg' })).toEqual({
      treatment: 'poster',
      uri: 'https://image.tmdb.org/t/p/w342/show.jpg',
    });
  });

  it('says none rather than inventing artwork', () => {
    expect(feedArtwork({})).toEqual({ treatment: 'none', uri: null });
  });
});

describe('artworkHeight', () => {
  it('is 16:9 of the card, inside the 150–190pt band', () => {
    expect(artworkHeight(358)).toBe(190); // 390pt phone: 201 natural, clamped
    expect(artworkHeight(328)).toBe(185); // 360pt
    expect(artworkHeight(288)).toBe(162); // 320pt
    expect(artworkHeight(200)).toBe(150); // never shorter than the band
  });
});

describe('takesFeedCard', () => {
  it('draws a card for title activity and a row for everything else', () => {
    for (const type of ['title_ranked', 'title_logged', 'season_completed', 'watchlist_added', 'ranking_batch']) {
      expect(takesFeedCard({ type, mediaItemId: 'm' })).toBe(true);
    }
    for (const type of ['award_earned', 'goal_completed', 'follow_added']) {
      expect(takesFeedCard({ type, mediaItemId: null })).toBe(false);
    }
    // A title activity whose title did not resolve has nothing to frame.
    expect(takesFeedCard({ type: 'title_ranked', mediaItemId: null })).toBe(false);
  });
});
