import { artworkHeight, feedArtwork, takesFeedCard } from './feed-artwork';
import { latestReadable } from './use-latest-comments';

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

describe('latestReadable', () => {
  const row = (
    id: string,
    at: string,
    body: string | null,
    deleted = false,
    parent_id: string | null = null,
  ) => ({
    id,
    parent_id,
    author_id: `a-${id}`,
    username: `u${id}`,
    display_name: null,
    avatar_path: null,
    body,
    has_spoilers: false,
    created_at: at,
    deleted_at: deleted ? at : null,
  });

  it('is the newest comment by time, replies included', () => {
    const latest = latestReadable([
      row('root', '2026-11-04T10:00:00Z', 'first'),
      row('reply', '2026-11-04T10:05:00Z', 'answer', false, 'root'),
      row('root2', '2026-11-04T10:02:00Z', 'second'),
    ]);
    expect(latest?.id).toBe('reply');
    expect(latest?.authorName).toBe('ureply');
  });

  it('never previews a retracted comment', () => {
    const latest = latestReadable([
      row('kept', '2026-11-04T10:00:00Z', 'kept'),
      row('gone', '2026-11-04T10:09:00Z', null, true),
    ]);
    expect(latest?.id).toBe('kept');
    expect(latestReadable([row('gone', '2026-11-04T10:09:00Z', null, true)])).toBeNull();
  });

  it('skips a reply whose root the server withheld, as the sheet does', () => {
    // The root's author is hidden from this reader, so `activity_comments` returned the
    // reply alone. `threadsOf` drops it; the preview must not show it either.
    const latest = latestReadable([
      row('visible', '2026-11-04T10:00:00Z', 'visible root'),
      row('orphan', '2026-11-04T10:09:00Z', 'reply to a hidden root', false, 'hidden-root'),
    ]);
    expect(latest?.id).toBe('visible');
  });

  it('keeps a reply under a retracted root, as the sheet does', () => {
    const latest = latestReadable([
      row('tomb', '2026-11-04T10:00:00Z', null, true),
      row('reply', '2026-11-04T10:09:00Z', 'still here', false, 'tomb'),
    ]);
    expect(latest?.id).toBe('reply');
  });
});
