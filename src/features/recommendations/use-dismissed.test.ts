import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import { dismissedKey, useDismissTitle, useDismissedTitles } from './use-dismissed';

/**
 * The dismissal's client half (founder tranche 2026-08-27 §12).
 *
 * The card must go on the tap and stay gone on the server — but those are two
 * different systems, and what this file pins is the seam between them: the
 * optimistic set, and what happens to it under each of the three ways a write can
 * come back. The server's own contracts — durability, idempotency, not touching
 * the collection — are pinned in `supabase/tests/recommendation-feedback.test.mjs`.
 */

let mockSelectRows: { media_item_id: string }[] = [];
let mockRpcError: { code?: string; message: string } | null = null;
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: mockRpcError ? null : { status: 'ok' }, error: mockRpcError });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: mockSelectRows, error: null }).then(resolve),
      };
      return chain;
    },
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

const harness = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
};

beforeEach(() => {
  mockSelectRows = [];
  mockRpcError = null;
  mockRpcCalls.length = 0;
});

describe('the dismissed set', () => {
  it('reads the dismiss rows back as a set of title ids', async () => {
    mockSelectRows = [{ media_item_id: 'm1' }, { media_item_id: 'm2' }];
    const { wrapper } = harness();

    const { result } = await renderHook(() => useDismissedTitles('viewer'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(new Set(['m1', 'm2']));
  });
});

describe('dismissing a title', () => {
  it('grows the cached set before the server answers, and sends one held-shape write', async () => {
    const { client, wrapper } = harness();
    client.setQueryData(dismissedKey('viewer'), new Set(['old']));

    const { result } = await renderHook(() => useDismissTitle('viewer'), { wrapper });
    const outcome = await result.current('m9');

    expect(outcome).toEqual({ ok: true });
    expect(client.getQueryData(dismissedKey('viewer'))).toEqual(new Set(['old', 'm9']));
    expect(mockRpcCalls).toEqual([
      {
        name: 'dismiss_for_you',
        args: { p_operation_id: 'operation-id', p_media_item_id: 'm9' },
      },
    ]);
  });

  it('rolls the optimistic entry back on a proven refusal', async () => {
    // An app-raised SQLSTATE proves nothing was stored. Keeping the tile hidden
    // would be showing the reader a veto the server refused to keep.
    mockRpcError = { code: 'P0002', message: 'no such title' };
    const { client, wrapper } = harness();
    client.setQueryData(dismissedKey('viewer'), new Set(['old']));

    const { result } = await renderHook(() => useDismissTitle('viewer'), { wrapper });
    const outcome = await result.current('m9');

    expect(outcome).toEqual({ ok: false, message: 'no such title' });
    expect(client.getQueryData(dismissedKey('viewer'))).toEqual(new Set(['old']));
  });

  it('keeps the overlay and refetches when the outcome is unknown', async () => {
    // 08007: the commit may have landed. The overlay stands — yanking the tile back
    // over a write that probably succeeded is worse — and the refetch settles it.
    mockRpcError = { code: '08007', message: 'connection lost' };
    mockSelectRows = [{ media_item_id: 'm9' }];
    const { client, wrapper } = harness();
    client.setQueryData(dismissedKey('viewer'), new Set<string>());

    const { result } = await renderHook(() => useDismissTitle('viewer'), { wrapper });
    const outcome = await result.current('m9');

    expect(outcome).toEqual({ ok: true });
    expect(client.getQueryData(dismissedKey('viewer'))).toEqual(new Set(['m9']));
  });
});
