import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { REACTIONS, useReactions } from './use-reactions';

let mockRows: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        in: () => Promise.resolve({ data: mockRows, error: null }),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const row = (over: Record<string, unknown> = {}) => ({
  feed_event_id: 'event-1',
  user_id: 'someone',
  kind: 'love',
  profiles: { display_name: 'Jerry', username: 'jerry' },
  ...over,
});

const summaries = async (viewer = 'me') => {
  const view = await renderHookWithProviders(() => useReactions(['event-1'], viewer));
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  return view.result.current.data;
};

beforeEach(() => {
  mockRows = [];
});

/**
 * The counting is done here rather than in an aggregate RPC, because `reactions_read`
 * already applies AD-5 to both the reactor and the event's actor. That is the reason
 * for the first test: a blocked reactor's row never arrives, so it must not be
 * counted, and the way to be sure of that is that nothing here invents a total from
 * anywhere but the rows themselves.
 */
describe('useReactions', () => {
  it('counts only the rows the database returned', async () => {
    mockRows = [row(), row({ user_id: 'other', kind: 'agree' })];

    const summary = (await summaries())?.get('event-1');
    expect(summary?.total).toBe(2);
  });

  it('finds the reader’s own reaction', async () => {
    mockRows = [row({ user_id: 'me', kind: 'moved' }), row({ user_id: 'other' })];

    const summary = (await summaries('me'))?.get('event-1');
    expect(summary?.mine).toBe('moved');
  });

  it('reports no reaction of the reader’s own when there is none', async () => {
    mockRows = [row({ user_id: 'other' })];
    expect((await summaries('me'))?.get('event-1')?.mine).toBeNull();
  });

  it('never names the reader among the reactors', async () => {
    // "You and Beth reacted" on a row in your own feed reads as being reported to
    // yourself.
    mockRows = [
      row({ user_id: 'me', profiles: { display_name: 'Me', username: 'me' } }),
      row({ user_id: 'other', profiles: { display_name: 'Beth', username: 'beth' } }),
    ];

    const summary = (await summaries('me'))?.get('event-1');
    expect(summary?.names).toEqual(['Beth']);
    expect(summary?.total).toBe(2);
    // And not in the residual either. Leaving the reader there only moved the
    // problem: "Beth and 1 other", where the other one is you.
    expect(summary?.others).toBe(0);
  });

  it('keeps the reader out of the residual count as well as out of the names', async () => {
    mockRows = ['Jerry', 'Beth', 'Morty'].map((name, index) =>
      row({ user_id: `u${index}`, profiles: { display_name: name, username: name } }),
    );
    mockRows.push(row({ user_id: 'me', profiles: { display_name: 'Me', username: 'me' } }));

    const summary = (await summaries('me'))?.get('event-1');
    expect(summary?.total).toBe(4);
    expect(summary?.names).toEqual(['Jerry', 'Beth']);
    expect(summary?.others).toBe(1);
  });

  it('names at most two and counts the rest', async () => {
    mockRows = ['Jerry', 'Beth', 'Morty', 'Summer'].map((name, index) =>
      row({ user_id: `u${index}`, profiles: { display_name: name, username: name } }),
    );

    const summary = (await summaries())?.get('event-1');
    expect(summary?.names).toEqual(['Jerry', 'Beth']);
    expect(summary?.others).toBe(2);
  });

  it('orders the glyphs by how common they are', async () => {
    mockRows = [
      row({ user_id: 'a', kind: 'agree' }),
      row({ user_id: 'b', kind: 'love' }),
      row({ user_id: 'c', kind: 'love' }),
    ];

    expect((await summaries())?.get('event-1')?.kinds).toEqual(['love', 'agree']);
  });

  it('reads a profile embed returned as an array', async () => {
    mockRows = [row({ profiles: [{ display_name: 'Jerry', username: 'jerry' }] })];
    expect((await summaries())?.get('event-1')?.names).toEqual(['Jerry']);
  });

  it('falls back to the username when there is no display name', async () => {
    mockRows = [row({ profiles: { display_name: null, username: 'jerry' } })];
    expect((await summaries())?.get('event-1')?.names).toEqual(['jerry']);
  });
});

describe('the reaction set', () => {
  it('is exactly PRD §14’s six, stored as meanings', async () => {
    expect(REACTIONS.map((r) => r.kind)).toEqual([
      'love',
      'agree',
      'disagree',
      'funny',
      'wow',
      'moved',
    ]);
  });

  it('gives every one a spoken label, since a glyph reads as nothing', async () => {
    for (const reaction of REACTIONS) {
      expect(reaction.label.length).toBeGreaterThan(0);
      expect(reaction.glyph.length).toBeGreaterThan(0);
    }
  });
});
