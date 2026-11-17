import { waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useActivityEvent } from './use-feed';

/**
 * **A link to an activity now shown through a group** (20261128000100, Codex, PR 313).
 *
 * A grouped member is hidden from every client read, never deleted, so an old link to it
 * finds no row. The reader asks which visible group shows it and opens that instead; a
 * reader who may not see the group gets the ordinary "unavailable".
 */
const rows: Record<string, Record<string, unknown>> = {};
const presentation: Record<string, string | null> = {};
const calls: string[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'feed_event_presentation') {
        return Promise.resolve({
          data: presentation[args.p_event_id as string] ?? null,
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    },
    from: () => {
      let id: string | null = null;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        in: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'id') id = value;
          return chain;
        },
        limit: () => Promise.resolve({ data: id && rows[id] ? [rows[id]] : [], error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      });
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

const group = {
  id: 'group-1',
  type: 'ranking_batch',
  actor_id: 'friend',
  media_item_id: 'film-1',
  created_at: '2026-11-15T10:00:00Z',
  causal_at: '2026-11-15T10:00:00Z',
  causal_step: 0,
  payload: { count: 4 },
  media_items: {
    kind: 'movie',
    title: 'Heat',
    release_date: '1995-12-15',
    poster_path: null,
    parent: null,
  },
  profiles: { username: 'ada', display_name: 'Ada', avatar_path: null },
};

beforeEach(() => {
  for (const key of Object.keys(rows)) delete rows[key];
  for (const key of Object.keys(presentation)) delete presentation[key];
  calls.length = 0;
});

it('opens the group that now shows a hidden activity', async () => {
  rows['group-1'] = group;
  presentation['member-1'] = 'group-1';
  const { result } = await renderHookWithProviders(() =>
    useActivityEvent('member-1', 'viewer'),
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.id).toBe('group-1');
  expect(result.current.data?.rankedCount).toBe(4);
});

it('is unavailable when there is no group the reader may see', async () => {
  const { result } = await renderHookWithProviders(() => useActivityEvent('gone', 'viewer'));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
  expect(calls.filter((name) => name === 'feed_event_presentation')).toHaveLength(1);
});

it('asks nothing extra for an activity that is visible', async () => {
  rows['group-1'] = group;
  const { result } = await renderHookWithProviders(() => useActivityEvent('group-1', 'viewer'));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.id).toBe('group-1');
  expect(calls).not.toContain('feed_event_presentation');
});
