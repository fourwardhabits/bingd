import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useChunkedById } from '@/lib/chunked-query';
import { supabase } from '@/lib/supabase';

import type { FeedItem } from './use-feed';

/**
 * **The posters a grouped post shows in the Feed** (Feed poster rails, 20261127000100).
 *
 * One read for the loaded page — chunked like the comment counts, so a new page asks only
 * for its own posts — of a short, ordered preview of each group's members. The complete
 * list stays the "View all" sheets' read (`watchlist_group_titles`, `ranking_batch_titles`).
 *
 * Keyed by event id **and** the post's count, so a group that grew is read again on the
 * next ordinary refresh, and one that did not is served from the cache. A session post
 * (20261130000900) adds its latest activity to the key, because a session can change its
 * newest title, and so its order, without its count changing (a title saved and then
 * ranked). The key moves only when the Feed's own rows are re-read, so the rail never
 * reorders between refreshes.
 */
export type GroupPreviewTitle = {
  mediaItemId: string;
  kind: 'movie' | 'season' | 'series' | null;
  /** What the poster is named by: a season by its show. */
  title: string;
  seasonNumber: number | null;
  year: number | null;
  posterPath: string | null;
  /** The author's current score on that title's own ladder; null if unranked, or a save. */
  score: number | null;
  /**
   * What the author did to it in this post (20261130000900): `ranked` carries the score,
   * `saved` the bookmark. An older backend sends nothing: a ranking group's members are
   * ranked and a watchlist post's saved, as they always were.
   */
  action: 'ranked' | 'saved' | null;
};

/** How many members a rail previews. The rest are one "View all" away. */
export const GROUP_PREVIEW_LIMIT = 12;

/** The post's own count of members, when it is a group the Feed draws as a rail. */
export function groupCount(event: Pick<FeedItem, 'type' | 'rankedCount' | 'watchlistCount'>) {
  const count =
    event.type === 'ranking_batch'
      ? event.rankedCount
      : event.type === 'watchlist_added'
        ? event.watchlistCount
        : null;
  return typeof count === 'number' && count > 1 ? Math.trunc(count) : null;
}

/** The cache key for one post's preview: its id, its count and, for a session, its version. */
export const previewKey = (
  event: Pick<FeedItem, 'id'> & Partial<Pick<FeedItem, 'session'>>,
  count: number,
) => (event.session ? `${event.id}#${count}#${event.session.version}` : `${event.id}#${count}`);

type Row = {
  event_id: string;
  ordinal: number;
  media_item_id: string;
  kind: GroupPreviewTitle['kind'];
  title: string | null;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  parent_title: string | null;
  score: number | string | null;
  ranked: boolean | null;
  action?: string | null;
};

const yearOf = (date: string | null) => {
  if (!date || date.length < 4) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
};

export async function readGroupPreviews(
  keys: string[],
): Promise<Map<string, GroupPreviewTitle[]>> {
  const byEvent = new Map(keys.map((key) => [key.split('#')[0], key]));
  const { data, error } = await supabase.rpc('feed_group_previews', {
    p_event_ids: [...byEvent.keys()],
    p_limit: GROUP_PREVIEW_LIMIT,
  });
  if (error) throw error;

  const out = new Map<string, GroupPreviewTitle[]>();
  // Every asked-for post gets an answer, empty included: an empty preview is "nothing to
  // show" (a post this reader may not see, or whose members are gone), not "still loading".
  for (const key of keys) out.set(key, []);
  const rows = (Array.isArray(data) ? (data as Row[]) : [])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
  for (const row of rows) {
    const key = byEvent.get(row.event_id);
    if (!key) continue;
    const score = row.score == null ? null : Number(row.score);
    out.get(key)!.push({
      mediaItemId: String(row.media_item_id),
      kind: row.kind ?? null,
      title:
        row.kind === 'season' && row.parent_title ? row.parent_title : String(row.title ?? ''),
      seasonNumber: row.kind === 'season' ? (row.season_number ?? null) : null,
      year: yearOf(row.release_date),
      posterPath: row.poster_path ?? null,
      score:
        row.ranked === false || row.action === 'saved' || !Number.isFinite(score)
          ? null
          : score,
      action: row.action === 'ranked' || row.action === 'saved' ? row.action : null,
    });
  }
  return out;
}

/**
 * The newest preview this cache holds for one post under any earlier key, so a session that
 * changed version on a refresh keeps drawing the posters it had until the new read lands,
 * rather than flashing to placeholders. Pure: it reads the cache and writes nothing.
 */
export function lastPreview(
  client: QueryClient,
  prefix: readonly unknown[],
  eventId: string,
): GroupPreviewTitle[] | undefined {
  let best: { at: number; rows: GroupPreviewTitle[] } | undefined;
  for (const query of client.getQueryCache().findAll({ queryKey: [...prefix] })) {
    const data = query.state.data;
    if (!(data instanceof Map)) continue;
    for (const [key, rows] of data as Map<string, GroupPreviewTitle[]>) {
      if (!key.startsWith(`${eventId}#`) || !Array.isArray(rows) || rows.length < 2) continue;
      if (!best || query.state.dataUpdatedAt > best.at) {
        best = { at: query.state.dataUpdatedAt, rows };
      }
    }
  }
  return best?.rows;
}

export function useGroupPreviews(events: FeedItem[], viewerId: string) {
  const client = useQueryClient();
  const keys = useMemo(
    () =>
      events.flatMap((event) => {
        const count = groupCount(event);
        return count ? [previewKey(event, count)] : [];
      }),
    [events],
  );
  const prefix = useMemo(() => ['feed-group-previews', viewerId] as const, [viewerId]);
  const result = useChunkedById<GroupPreviewTitle[]>(prefix, keys, readGroupPreviews);
  const data = useMemo(() => {
    let out = result.data;
    for (const key of keys) {
      if (out?.has(key)) continue;
      const rows = lastPreview(client, prefix, key.split('#')[0] ?? key);
      if (!rows) continue;
      out = new Map(out ?? []);
      out.set(key, rows);
    }
    return out;
  }, [client, keys, prefix, result.data]);
  return { ...result, data };
}
