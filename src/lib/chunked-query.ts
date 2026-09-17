import { useQueries, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';

/**
 * How many ids one request carries. The Feed's page size, so a page that lands adds one
 * chunk rather than changing the ones already read.
 */
export const ID_CHUNK = 20;

/** What a caller reads, in the names `useQuery` gives them, so call sites did not change. */
export type ChunkedResult<V> = {
  data: Map<string, V> | undefined;
  /** Some chunk has no answer of its own yet. Borrowed placeholder values do not count. */
  isPending: boolean;
  /** Every chunk has answered for itself. Borrowed placeholder values do not count. */
  isSuccess: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
};

export const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const parts: T[][] = [];
  for (let at = 0; at < items.length; at += size) parts.push(items.slice(at, at + size));
  return parts;
};

const idsKey = (ids: readonly string[]) => [...ids].sort().join(',');

/**
 * What this cache already knows about `ids`, from any earlier read under `prefix` that
 * covered them, newest read winning.
 *
 * A cached read is authoritative for every id in its key, including ids missing from its
 * map (an event nobody reacted to is simply absent). So an id is filled in only when some
 * cached key names it, and the newest such read decides it.
 */
function known<V>(
  client: QueryClient,
  prefix: QueryKey,
  ids: readonly string[],
): Map<string, V> | undefined {
  const wanted = new Set(ids);
  const decidedAt = new Map<string, number>();
  const values = new Map<string, V>();

  for (const query of client.getQueryCache().findAll({ queryKey: prefix })) {
    const data = query.state.data as Map<string, V> | undefined;
    const covered = query.queryKey[prefix.length];
    if (!(data instanceof Map) || typeof covered !== 'string') continue;
    const at = query.state.dataUpdatedAt;
    for (const id of covered.split(',')) {
      if (!wanted.has(id) || (decidedAt.get(id) ?? -1) >= at) continue;
      decidedAt.set(id, at);
      const value = data.get(id);
      if (value === undefined) values.delete(id);
      else values.set(id, value);
    }
  }

  return decidedAt.size ? values : undefined;
}

/**
 * A per-id lookup over a list that grows, read a fixed-size chunk at a time.
 *
 * **Why not one query keyed by the whole list** (2026-09-16, pre-outreach hardening). The
 * Feed's reactions and comment counts were exactly that, keyed by every event loaded so
 * far. Each page that landed made a brand-new key, so:
 *
 *   - every page re-read everything above it, which is quadratic over a scroll;
 *   - the new key had no data, so every pill and count on screen blanked until the
 *     re-read answered, and a heart tapped in that gap read "not reacted" and could not
 *     be taken back;
 *   - the reactions read is a GET whose `in.(...)` list grows with the scroll. On
 *     staging the request stopped reaching PostgREST at roughly 390 ids (a ~15 KB URL),
 *     about twenty pages down, and a single read over hundreds of events also runs into
 *     PostgREST's 1,000-row cap and silently drops reactions.
 *
 * Chunks are cut in the order given, so appending ids leaves every complete chunk's key,
 * and its cached answer, untouched. A chunk whose key did change (the tail after a short
 * page, or everything after a refresh brings in a newer event) shows what the cache
 * already knew for its ids until its own read lands, rather than blanking.
 *
 * Keys are `[...prefix, sortedIds]`, the shape the single query used, so prefix
 * invalidation (`['reactions', viewerId]`) still reaches every chunk.
 */
export function useChunkedById<V>(
  prefix: QueryKey,
  ids: readonly string[],
  fetchChunk: (ids: string[]) => Promise<Map<string, V>>,
  size = ID_CHUNK,
): ChunkedResult<V> {
  const client = useQueryClient();
  const parts = useMemo(() => chunked(ids, size), [ids, size]);

  return useQueries({
    queries: parts.map((part) => ({
      queryKey: [...prefix, idsKey(part)],
      queryFn: () => fetchChunk(part),
      placeholderData: () => known<V>(client, prefix, part),
    })),
    // Module-level, so React Query can keep the combined object stable between renders
    // in which no chunk changed.
    combine: combine as (results: ChunkResult[]) => ChunkedResult<V>,
  });
}

type ChunkResult = {
  data: Map<string, unknown> | undefined;
  isSuccess: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  refetch: () => Promise<unknown>;
};

function combine(results: ChunkResult[]): ChunkedResult<unknown> {
  const settled = (result: ChunkResult) => result.isSuccess && !result.isPlaceholderData;

  let data: Map<string, unknown> | undefined;
  for (const result of results) {
    if (!result.data) continue;
    data ??= new Map();
    for (const [id, value] of result.data) data.set(id, value);
  }

  return {
    data,
    // No ids is "nothing asked yet", which is what a disabled `useQuery` reported.
    isPending: results.length === 0 || results.some((result) => !settled(result) && !result.isError),
    isSuccess: results.length > 0 && results.every(settled),
    isError: results.some((result) => result.isError),
    refetch: () => Promise.all(results.map((result) => result.refetch())),
  };
}
