import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useFeed } from './use-feed';

let mockFeedRows: unknown[] = [];
let mockNoteRows: unknown[] = [];
let mockNoteError: unknown = null;
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: mockNoteError ? null : mockNoteRows, error: mockNoteError });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const result = () =>
        Promise.resolve({
          data: table === 'follows' ? [{ followee_id: 'friend' }] : mockFeedRows,
          error: null,
        });
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => result(),
        then: (resolve: (value: unknown) => unknown) => result().then(resolve),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const media = {
  kind: 'movie',
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: '/p.jpg',
  genres: ['Science Fiction'],
  runtime_minutes: 148,
  parent: null,
};

const profile = { username: 'sai', display_name: 'Sai', avatar_path: null };

const event = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  type: 'title_ranked',
  actor_id: 'user-1',
  media_item_id: 'film-1',
  created_at: '2026-08-15T00:00:00Z',
  payload: { position: 1, category: 'movies', bucket: 'loved', score: 8.7 },
  media_items: media,
  profiles: profile,
  ...over,
});

const load = async () => {
  const view = await renderHookWithProviders(() => useFeed('user-1'));
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  return view.result.current.data ?? [];
};

/** The single item under test, so each assertion is not preceded by a null check. */
const only = async () => {
  const [item] = await load();
  if (!item) throw new Error('the feed returned nothing');
  return item;
};

beforeEach(() => {
  mockFeedRows = [];
  mockNoteRows = [];
  mockNoteError = null;
  rpcCalls.length = 0;
});

describe('the embedded profile', () => {
  it('reads a to-one embed returned as an object', async () => {
    // The whole "Someone ranked a title." bug in one assertion. PostgREST hands
    // back an object here and its types say array, so `profiles[0]` was
    // undefined on every row and every fallback fired at once.
    mockFeedRows = [event()];

    const item = await only();
    expect(item.actorName).toBe('Sai');
    expect(item.title).toBe('Inception');
  });

  it('still reads one returned as an array', async () => {
    // Belt and braces: a to-many embed, or a PostgREST version that shapes this
    // differently, must not reintroduce the bug in the other direction.
    mockFeedRows = [event({ profiles: [profile], media_items: [media] })];

    const item = await only();
    expect(item.actorName).toBe('Sai');
    expect(item.title).toBe('Inception');
  });

  it('falls back to the username when there is no display name', async () => {
    mockFeedRows = [event({ profiles: { ...profile, display_name: null } })];

    const item = await only();
    expect(item.actorName).toBe('sai');
  });

  it('drops an item whose actor cannot be named', async () => {
    // Omission, not "Someone". A feed with one item is honest; two, one of them
    // about nobody, is not. screens.md §7.
    mockFeedRows = [event(), event({ id: 'event-2', profiles: null })];

    const items = await load();
    expect(items.map((item) => item.id)).toEqual(['event-1']);
  });

  it('drops an item whose profile has only an empty name', async () => {
    mockFeedRows = [event({ profiles: { username: '', display_name: '', avatar_path: null } })];
    expect(await load()).toHaveLength(0);
  });
});

describe('the score', () => {
  it('comes from the payload, not from a derivation', async () => {
    // A viewer cannot compute a friend's score: it needs that friend's band
    // sizes, and `rankings` is scoped to its owner by RLS. `_rank_finalize`
    // snapshots it instead (20260815010000).
    mockFeedRows = [event()];

    const item = await only();
    expect(item.score).toBe(8.7);
    expect(item.bucket).toBe('loved');
  });

  it('is null on an event written before the snapshot existed', async () => {
    mockFeedRows = [event({ payload: { position: 3, category: 'movies' } })];

    const item = await only();
    expect(item.score).toBeNull();
    expect(item.bucket).toBeNull();
  });
});

describe('the title card', () => {
  it('carries the year, runtime and genres the compact row needs', async () => {
    mockFeedRows = [event()];

    const item = await only();
    expect(item.year).toBe(2010);
    expect(item.runtimeMinutes).toBe(148);
    expect(item.genres).toEqual(['Science Fiction']);
  });

  it('survives a media row with nothing but a title', async () => {
    mockFeedRows = [
      event({
        media_items: {
          kind: 'movie',
          title: 'Untitled',
          release_date: null,
          poster_path: null,
          genres: null,
          runtime_minutes: null,
          parent: null,
        },
      }),
    ];

    const item = await only();
    expect(item.year).toBeNull();
    expect(item.genres).toEqual([]);
  });
});

/**
 * "Suraj Kandukuri ranked Season 2" was the device-test finding. A feed never shows
 * the parent series beside the season, so the season's own title names nothing.
 */
describe('a season in the feed', () => {
  const season = (parent: unknown) => ({
    kind: 'season',
    title: 'Season 2',
    release_date: '2010-09-17',
    poster_path: null,
    genres: ['Comedy'],
    runtime_minutes: 22,
    parent,
  });

  it('carries the series name with it', async () => {
    mockFeedRows = [event({ media_items: season({ title: 'Parks and Recreation' }) })];

    const item = await only();
    expect(item.title).toBe('Parks and Recreation, S2');
    expect(item.kind).toBe('season');
  });

  it('reads the parent embed whether it arrives as an object or an array', async () => {
    mockFeedRows = [event({ media_items: season([{ title: 'Parks and Recreation' }]) })];
    expect((await only()).title).toBe('Parks and Recreation, S2');
  });

  it('falls back to the season alone rather than to nothing', async () => {
    mockFeedRows = [event({ media_items: season(null) })];
    expect((await only()).title).toBe('Season 2');
  });
});

describe('the note attached to an activity', () => {
  it('asks for public notes by the actors and titles on screen', async () => {
    mockFeedRows = [event()];
    await load();

    const call = rpcCalls.find((c) => c.name === 'public_notes');
    expect(call?.args.p_user_ids).toEqual(['user-1']);
    expect(call?.args.p_media_item_ids).toEqual(['film-1']);
  });

  it('matches a note to its own author and title, not to the other pairing', async () => {
    mockFeedRows = [
      event(),
      event({ id: 'event-2', actor_id: 'friend', media_item_id: 'film-2' }),
    ];
    // The RPC filters are a cross product, so it can legitimately return a pair
    // that belongs to neither event. Matching on both halves is what stops one
    // person's note appearing under another person's activity.
    mockNoteRows = [
      { user_id: 'user-1', media_item_id: 'film-2', note: 'wrong pairing', has_spoilers: false },
      { user_id: 'friend', media_item_id: 'film-2', note: 'the right one', has_spoilers: true },
    ];

    const [mine, theirs] = await load();
    expect(mine?.note).toBeNull();
    expect(theirs?.note).toEqual({ text: 'the right one', hasSpoilers: true });
  });

  it('keeps the feed when the note read fails', async () => {
    // A note is an enrichment. Losing the whole feed because it could not be
    // fetched trades a small absence for a total one.
    mockFeedRows = [event()];
    mockNoteError = { message: 'nope' };

    const item = await only();
    expect(item.title).toBe('Inception');
    expect(item.note).toBeNull();
  });
});

/**
 * Founder Feed finalization, 2026-08-20, items 2, 7 and 8.
 *
 * A watchlist add is now activity, and the standardised subheading needs two fields
 * the read was not asking for — the content rating, and a season's episode count.
 */
describe('a watchlist add in the feed', () => {
  it('is fetched, and is not mistaken for a watch', async () => {
    mockFeedRows = [event({ type: 'watchlist_added', payload: {} })];

    const item = await only();
    expect(item.type).toBe('watchlist_added');
    expect(item.title).toBe('Inception');
    // No ranking happened, so there is no score and the badge does not draw.
    expect(item.score).toBeNull();
  });

  it('carries neither a note nor companions, even when the actor wrote one', async () => {
    // The trap this closes. Notes and tags are matched on (actor, title) rather than
    // on the event — deliberately, so both stay live and retractable — which means a
    // watchlist row for a film its actor later watched, reviewed and tagged would
    // otherwise render "added Dune to their watchlist with Anna" under a verdict on
    // the film. An intention is not a viewing.
    mockFeedRows = [
      event({ id: 'watch-1', type: 'title_ranked' }),
      event({ id: 'watch-2', type: 'watchlist_added', payload: {} }),
    ];
    mockNoteRows = [
      { user_id: 'user-1', media_item_id: 'film-1', note: 'Best of the year.', has_spoilers: false },
    ];

    const [ranked, saved] = await load();
    expect(ranked?.note).toEqual({ text: 'Best of the year.', hasSpoilers: false });
    expect(saved?.note).toBeNull();
    expect(saved?.companions).toEqual([]);
  });

  it('does not ask the note RPC about an activity that cannot have one', async () => {
    mockFeedRows = [event({ type: 'watchlist_added', payload: {} })];
    await load();

    expect(rpcCalls.find((c) => c.name === 'public_notes')).toBeUndefined();
  });
});

describe('an award in the feed (20260828000100)', () => {
  const awardEvent = () =>
    event({
      type: 'award_earned',
      media_item_id: null,
      media_items: null,
      payload: {
        award: 'movie-muncher',
        tier: 'bronze',
        award_name: 'Movie Muncher',
        tier_label: 'Bronze',
      },
    });

  it('puts the award name in the sentence slot, so the grammar reads "earned Movie Muncher"', async () => {
    mockFeedRows = [awardEvent()];

    const item = await only();
    expect(item.type).toBe('award_earned');
    // No media row at all — the title is the payload's award name, not a film.
    expect(item.mediaItemId).toBeNull();
    expect(item.title).toBe('Movie Muncher');
    expect(item.award).toEqual({ key: 'movie-muncher', tierKey: 'bronze', tierLabel: 'Bronze' });
    // Nothing film-shaped leaks onto the row: no score badge, no poster path.
    expect(item.score).toBeNull();
    expect(item.posterPath).toBeNull();
  });

  it('carries neither a note nor companions, and asks the note RPC nothing', async () => {
    // An award is not a watch claim, so the (actor, title) note/tag joins must not
    // run — the watchlist row's rule, restated for the second non-watch type.
    mockFeedRows = [awardEvent()];
    const item = await only();

    expect(item.note).toBeNull();
    expect(item.companions).toEqual([]);
    expect(rpcCalls.find((c) => c.name === 'public_notes')).toBeUndefined();
  });

  it('still says something honest when the payload predates the names', async () => {
    mockFeedRows = [
      event({
        type: 'award_earned',
        media_item_id: null,
        media_items: null,
        payload: { award: 'movie-muncher', tier: 'bronze' },
      }),
    ];

    const item = await only();
    // No leading article: the sentence supplies one now ("earned the …"), and
    // `tailFor` drops its trailing "award" for a name that already says it — so this
    // row reads "Abisola earned the bingd. Award" rather than stacking either word.
    expect(item.title).toBe('bingd. Award');
    expect(item.award?.tierLabel).toBeNull();
  });
});

describe('the fields the subheading needs', () => {
  it('reads a movie’s own rating and runtime', async () => {
    mockFeedRows = [
      event({ media_items: { ...media, certification: 'PG-13', episode_count: null } }),
    ];

    const item = await only();
    expect(item.certification).toBe('PG-13');
    expect(item.runtimeMinutes).toBe(148);
    expect(item.episodeCount).toBeNull();
  });

  it('gives a season its episode count and its series’ rating and genres', async () => {
    // `tmdb_upsert_seasons` writes neither genres nor a certification, and TMDB
    // publishes the rating on the series. Both come off the parent embed this query
    // was already making for the title.
    mockFeedRows = [
      event({
        media_items: {
          kind: 'season',
          title: 'Season 2',
          season_number: 2,
          release_date: '2025-01-17',
          poster_path: null,
          genres: [],
          certification: null,
          runtime_minutes: 50,
          episode_count: 8,
          parent: {
            title: 'Severance',
            genres: ['Drama', 'Thriller'],
            certification: 'TV-MA',
          },
        },
      }),
    ];

    const item = await only();
    expect(item.title).toBe('Severance, S2');
    expect(item.certification).toBe('TV-MA');
    expect(item.genres).toEqual(['Drama', 'Thriller']);
    expect(item.episodeCount).toBe(8);
  });

  it('leaves both absent when nobody published them', async () => {
    mockFeedRows = [event()];

    const item = await only();
    expect(item.certification).toBeNull();
    expect(item.episodeCount).toBeNull();
  });
});
