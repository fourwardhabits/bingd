import { groupCount, previewKey, readGroupPreviews } from './use-group-previews';

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => mockRpc.mockReset());

describe('which posts are drawn as a rail', () => {
  it('a watchlist post or ranking sitting of two or more, and nothing else', () => {
    expect(groupCount({ type: 'watchlist_added', rankedCount: null, watchlistCount: 4 })).toBe(
      4,
    );
    expect(groupCount({ type: 'ranking_batch', rankedCount: 8, watchlistCount: null })).toBe(8);
    expect(
      groupCount({ type: 'watchlist_added', rankedCount: null, watchlistCount: 1 }),
    ).toBeNull();
    expect(
      groupCount({ type: 'watchlist_added', rankedCount: null, watchlistCount: null }),
    ).toBeNull();
    expect(
      groupCount({ type: 'ranking_batch', rankedCount: 1, watchlistCount: null }),
    ).toBeNull();
    expect(groupCount({ type: 'title_ranked', rankedCount: 5, watchlistCount: 5 })).toBeNull();
  });

  it('keys a preview by its count, so a group that grew is read again on refresh', () => {
    expect(previewKey({ id: 'e1' }, 3)).not.toBe(previewKey({ id: 'e1' }, 4));
    expect(previewKey({ id: 'e1' }, 3)).toBe(previewKey({ id: 'e1' }, 3));
  });
});

describe('reading a page of previews', () => {
  it('answers every asked-for post, in member order, a season named by its show', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          event_id: 'r1',
          ordinal: 2,
          media_item_id: 's1',
          kind: 'season',
          title: 'Season 1',
          season_number: 1,
          release_date: '2022-02-18',
          poster_path: null,
          parent_title: 'Severance',
          score: '9.8',
          ranked: true,
        },
        {
          event_id: 'r1',
          ordinal: 1,
          media_item_id: 'heat',
          kind: 'movie',
          title: 'Heat',
          season_number: null,
          release_date: '1995-12-15',
          poster_path: '/h.jpg',
          parent_title: null,
          score: null,
          ranked: false,
        },
      ],
      error: null,
    });
    const out = await readGroupPreviews(['r1#3', 'gone#2']);
    expect(mockRpc).toHaveBeenCalledWith('feed_group_previews', {
      p_event_ids: ['r1', 'gone'],
      p_limit: 12,
    });
    expect(out.get('gone#2')).toEqual([]);
    const rows = out.get('r1#3')!;
    expect(rows.map((row) => row.mediaItemId)).toEqual(['heat', 's1']);
    expect(rows[0]).toMatchObject({
      title: 'Heat',
      year: 1995,
      score: null,
      seasonNumber: null,
    });
    expect(rows[1]).toMatchObject({ title: 'Severance', seasonNumber: 1, score: 9.8 });
  });

  it('never shows a score for a title that is no longer ranked', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          event_id: 'r1',
          ordinal: 1,
          media_item_id: 'x',
          kind: 'movie',
          title: 'X',
          season_number: null,
          release_date: null,
          poster_path: null,
          parent_title: null,
          score: 7.1,
          ranked: false,
        },
      ],
      error: null,
    });
    const out = await readGroupPreviews(['r1#2']);
    expect(out.get('r1#2')![0]!.score).toBeNull();
  });

  it('throws on an error, so the Feed falls back to the representative card', async () => {
    mockRpc.mockResolvedValue({ data: null, error: new Error('nope') });
    await expect(readGroupPreviews(['r1#2'])).rejects.toThrow('nope');
  });
});
