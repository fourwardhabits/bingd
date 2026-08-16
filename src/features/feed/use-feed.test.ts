import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useFeed } from './use-feed';

let mockFeedRows: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
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
  title: 'Inception',
  release_date: '2010-07-16',
  poster_path: '/p.jpg',
  genres: ['Science Fiction'],
  runtime_minutes: 148,
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
          title: 'Untitled',
          release_date: null,
          poster_path: null,
          genres: null,
          runtime_minutes: null,
        },
      }),
    ];

    const item = await only();
    expect(item.year).toBeNull();
    expect(item.genres).toEqual([]);
  });
});
