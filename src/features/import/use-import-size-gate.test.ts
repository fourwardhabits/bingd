import { act, waitFor } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { DEFAULT_LIMITS } from './archive';
import { useImport } from './use-import';

/**
 * The first bomb guard: the picked file's own size, checked before a byte is read.
 *
 * Its own file for the reason `use-import-guards.test.ts` gives. It is pinned here because
 * the member-count ceiling rose from 50 to 1,000 on the strength of the byte caps, and
 * this is the byte cap that comes first. If it went, the rest would run on a file that was
 * already in memory.
 */

let mockPicked: { size: number; bytes: jest.Mock } | null = null;

jest.mock('expo-file-system', () => ({
  File: {
    pickFileAsync: () => Promise.resolve({ canceled: false, result: mockPicked }),
  },
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    },
  },
}));

jest.mock('@/lib/analytics', () => ({ track: () => {} }));

it('refuses a picked file larger than the archive cap without reading it', async () => {
  mockPicked = {
    size: DEFAULT_LIMITS.maxTotalBytes + 1,
    bytes: jest.fn(() => Promise.resolve(new Uint8Array(0))),
  };
  const { result } = await renderHookWithProviders(() => useImport('settings'));

  await act(async () => {
    await result.current.pick();
  });

  await waitFor(() => expect(result.current.state.phase).toBe('failed'));
  expect(result.current.state).toEqual({
    phase: 'failed',
    failure: { kind: 'archive', reason: 'too_large' },
  });
  expect(mockPicked.bytes).not.toHaveBeenCalled();
});
