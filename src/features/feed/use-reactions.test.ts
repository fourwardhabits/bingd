import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { DEFAULT_REACTION, REACTIONS, useReactions, useSetReaction } from './use-reactions';

let mockRows: unknown[] = [];
const mockRpc = jest.fn();

// A fresh id every call, so a held one is visibly held rather than two undefineds
// comparing equal. `expo-crypto` has no native module under jest.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${(issued += 1)}` }));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
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
  profiles: { id: 'someone', display_name: 'Jerry', username: 'jerry', avatar_path: null },
  ...over,
});

const summaries = async (viewer = 'me') => {
  const view = await renderHookWithProviders(() => useReactions(['event-1'], viewer));
  await waitFor(() => expect(view.result.current.isPending).toBe(false));
  return view.result.current.data;
};

beforeEach(() => {
  mockRows = [];
  issued = 0;
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

/**
 * **One operation id per reaction-on-an-event**, held across the retry a lost reply
 * invites (`lib/operation-intent.ts`).
 *
 * The row converges — `set_reaction` assigns — but the RPC is rate-limited, so a replay
 * under a fresh id spends a second slot for one tap and brings
 * `reactions.max_per_day` forward for somebody nowhere near it. Nothing raises.
 * Independent review 21j.
 */
describe('one operation id per reaction', () => {
  const idsSent = () =>
    mockRpc.mock.calls.map(([, args]) => (args as { p_operation_id: string }).p_operation_id);

  /**
   * The writer, wrapped so React sees the state it changes — the same treatment, and for
   * the same reason, as `settings/account-writes.test.ts`.
   *
   * `useSetReaction` updates state around its await. Called straight from a test those
   * updates happen outside React's knowledge, which is where this file's share of *"An
   * update to HookContainer inside a test was not wrapped in act(...)"* came from. It is
   * not only noise: until they are flushed, `result.current` is still the closure from
   * the previous render, and the paired calls below are entirely about what the second
   * call sees.
   */
  const mount = async () => {
    const view = await renderHookWithProviders(() => useSetReaction('me'));
    return {
      get current(): ReturnType<typeof useSetReaction> {
        const api = view.result.current;
        return new Proxy(api, {
          get: (target, key) => {
            const value = target[key as keyof typeof target];
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) =>
              act(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
          },
        });
      },
    };
  };

  it('replays an unanswered reaction under the id the first attempt used', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '', message: 'TypeError: Network request failed' },
    });
    const result = await mount();

    await result.current.setReaction('event-1', 'love');
    await result.current.setReaction('event-1', 'love');

    const [first, second] = idsSent();
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });

  it('takes a fresh id once the server has answered', async () => {
    const result = await mount();

    await result.current.setReaction('event-1', 'love');
    await result.current.setReaction('event-1', 'love');

    const [first, second] = idsSent();
    expect(second).not.toBe(first);
  });

  it('treats a change of mind as its own intent', async () => {
    // Replaying the first id for a different kind would have the server answer
    // `already_applied` — a pill that reports success and stores the previous reaction.
    mockRpc.mockResolvedValue({ data: null, error: { code: '08007', message: 'unknown' } });
    const result = await mount();

    await result.current.setReaction('event-1', 'love');
    await result.current.setReaction('event-1', 'disagree');

    const [first, second] = idsSent();
    expect(second).not.toBe(first);
  });
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

  it('collects everyone who reacted, the reader included', async () => {
    // The Feed row shows glyphs and a total; the detail sheet names people. Both
    // read from this one list, so it holds every reactor the database returned —
    // and the database has already applied AD-5 to both parties.
    mockRows = [
      row({ user_id: 'me', profiles: { id: 'me', display_name: 'Me', username: 'me', avatar_path: null } }),
      row({ user_id: 'other', kind: 'funny', profiles: { id: 'other', display_name: 'Beth', username: 'beth', avatar_path: null } }),
    ];

    const summary = (await summaries('me'))?.get('event-1');
    expect(summary?.total).toBe(2);
    expect(summary?.people.map((p) => p.name)).toEqual(['Me', 'Beth']);
    expect(summary?.people.find((p) => p.userId === 'other')?.kind).toBe('funny');
  });

  it('puts the reader first, since theirs is the one that can be changed here', async () => {
    mockRows = [
      row({ user_id: 'aaa', profiles: { id: 'aaa', display_name: 'Aaron', username: 'aaron', avatar_path: null } }),
      row({ user_id: 'me', profiles: { id: 'me', display_name: 'Zoe', username: 'zoe', avatar_path: null } }),
    ];

    expect((await summaries('me'))?.get('event-1')?.people[0]?.name).toBe('Zoe');
  });

  it('counts a reactor whose profile did not resolve, and does not name them', async () => {
    // The count comes from the reaction row, which the viewer may read; the name
    // comes from a profile embed, whose own policy may withhold it. Inventing
    // "Someone" for the gap is the feed's old bug in a new place.
    mockRows = [row(), row({ user_id: 'hidden', profiles: null })];

    const summary = (await summaries())?.get('event-1');
    expect(summary?.total).toBe(2);
    expect(summary?.people).toHaveLength(1);
  });

  it('counts each reaction kind, for the detail filters', async () => {
    mockRows = [
      row({ user_id: 'a', kind: 'love' }),
      row({ user_id: 'b', kind: 'love' }),
      row({ user_id: 'c', kind: 'funny' }),
    ];

    const summary = (await summaries())?.get('event-1');
    expect(summary?.byKind).toEqual({ love: 2, funny: 1 });
    expect(summary?.total).toBe(3);
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
    mockRows = [
      row({ profiles: [{ id: 'someone', display_name: 'Jerry', username: 'jerry', avatar_path: null }] }),
    ];
    expect((await summaries())?.get('event-1')?.people.map((p) => p.name)).toEqual(['Jerry']);
  });

  it('falls back to the username when there is no display name', async () => {
    mockRows = [
      row({ profiles: { id: 'someone', display_name: null, username: 'jerry', avatar_path: null } }),
    ];
    expect((await summaries())?.get('event-1')?.people.map((p) => p.name)).toEqual(['jerry']);
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

  it('uses the glyphs the founder chose', async () => {
    expect(REACTIONS.map((r) => r.glyph)).toEqual(['❤️', '👍', '👎', '😂', '😮', '😢']);
  });

  it('makes love the default a plain tap gives', async () => {
    expect(DEFAULT_REACTION).toBe('love');
  });
});
