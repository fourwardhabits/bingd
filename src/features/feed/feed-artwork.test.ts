import {
  ARTWORK_ASPECT,
  ARTWORK_MAX_HEIGHT,
  ARTWORK_MIN_HEIGHT,
  artworkHeight,
  feedArtwork,
  takesFeedCard,
} from './feed-artwork';
import { feedCardContentWidth } from './FeedPostSurface';

describe('feedArtwork', () => {
  it('prefers the title’s own backdrop, at the card bucket', () => {
    const art = feedArtwork({ backdropPath: '/own.jpg', parentBackdropPath: '/series.jpg' });
    expect(art).toEqual({
      treatment: 'backdrop',
      uri: 'https://image.tmdb.org/t/p/w780/own.jpg',
    });
  });

  it('falls back to the series backdrop before any poster', () => {
    const art = feedArtwork({ posterPath: '/s1.jpg', parentBackdropPath: '/series.jpg' });
    expect(art.treatment).toBe('backdrop');
    expect(art.uri).toContain('/series.jpg');
  });

  it('uses the poster, then the series poster, when there is no backdrop anywhere', () => {
    expect(feedArtwork({ posterPath: '/s1.jpg', parentPosterPath: '/show.jpg' }).uri).toContain(
      '/s1.jpg',
    );
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
  /**
   * The artwork is the card's content width: the screen less 16pt gutters, the 1pt outline
   * and the 12pt inset on each side (`feedCardContentWidth`), so W - 58.
   */
  it('is 3:2 of the artwork, measured at 320 / 360 / 390 / 430pt', () => {
    expect(feedCardContentWidth(320)).toBe(262);
    expect(artworkHeight(feedCardContentWidth(320))).toBe(175); // was 162
    expect(artworkHeight(feedCardContentWidth(360))).toBe(201); // was 185
    expect(artworkHeight(feedCardContentWidth(390))).toBe(221); // was 190
    expect(artworkHeight(feedCardContentWidth(430))).toBe(248); // was 190
  });

  it('is clamped: never a sliver, never a screenful', () => {
    expect(ARTWORK_ASPECT).toBe(3 / 2);
    expect(artworkHeight(200)).toBe(ARTWORK_MIN_HEIGHT);
    expect(artworkHeight(1024)).toBe(ARTWORK_MAX_HEIGHT);
  });
});

describe('takesFeedCard', () => {
  it('draws a card for title activity and a row for everything else', () => {
    for (const type of [
      'title_ranked',
      'title_logged',
      'season_completed',
      'watchlist_added',
      'ranking_batch',
    ]) {
      expect(takesFeedCard({ type, mediaItemId: 'm' })).toBe(true);
    }
    for (const type of ['award_earned', 'goal_completed', 'follow_added']) {
      expect(takesFeedCard({ type, mediaItemId: null })).toBe(false);
    }
    // A title activity whose title did not resolve has nothing to frame.
    expect(takesFeedCard({ type: 'title_ranked', mediaItemId: null })).toBe(false);
  });
});
