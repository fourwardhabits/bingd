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
 * next ordinary refresh, and one that did not is served from the cache.
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

/** The cache key for one post's preview: its id and its count. */
export const previewKey = (event: Pick<FeedItem, 'id'>, count: number) =>
  `${event.id}#${count}`;

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
      score: row.ranked === false || !Number.isFinite(score) ? null : score,
    });
  }
  return out;
}

export function useGroupPreviews(events: FeedItem[], viewerId: string) {
  const keys = useMemo(
    () =>
      events.flatMap((event) => {
        const count = groupCount(event);
        return count ? [previewKey(event, count)] : [];
      }),
    [events],
  );
  return useChunkedById<GroupPreviewTitle[]>(
    ['feed-group-previews', viewerId],
    keys,
    readGroupPreviews,
  );
}

/**
 * **Which previewed titles of a ranking group carry the author's review**
 * (20261130000800).
 *
 * A reviewed first ranking joins its half-hour group rather than posting a card of its own,
 * so the review is no longer on a card in the Feed. The rail marks the poster instead, and
 * the group's sheet shows the text. This is that mark's read: `public_notes`, the only
 * cross-user path to a note, which answers only for reviews this reader may read
 * (`can_view_profile`: blocks, private accounts, suspension), so a mark never says more
 * than the text would.
 *
 * Keyed by `author:title` pair, chunked like the previews, and asked **one author at a
 * time** (Codex, PR 347): `public_notes` filters authors and titles independently and caps
 * its answer at 100 by recency, so several authors in one call could be answered with
 * reviews of pairs nobody asked about and crowd out the ones that were. Per author, a
 * chunk's titles (at most `ID_CHUNK`) bound the answer well under that cap. A failure is
 * swallowed into "no marks": the mark is an enrichment, and the sheet still shows every
 * review.
 */
export const reviewKey = (actorId: string, mediaItemId: string) => `${actorId}:${mediaItemId}`;

export async function readGroupReviews(pairs: string[]): Promise<Map<string, true>> {
  const out = new Map<string, true>();
  const byActor = new Map<string, string[]>();
  for (const pair of new Set(pairs)) {
    const [actor, title] = pair.split(':');
    if (!actor || !title) continue;
    byActor.set(actor, [...(byActor.get(actor) ?? []), title]);
  }
  await Promise.all(
    [...byActor].map(async ([actor, titles]) => {
      const { data, error } = await supabase.rpc('public_notes', {
        p_user_ids: [actor],
        p_media_item_ids: titles,
        p_limit: 100,
      });
      if (error || !Array.isArray(data)) return;
      const wanted = new Set(titles);
      for (const row of data as { user_id: string; media_item_id: string }[]) {
        if (row.user_id === actor && wanted.has(row.media_item_id)) {
          out.set(reviewKey(actor, row.media_item_id), true);
        }
      }
    }),
  );
  return out;
}

export function useGroupReviews(
  events: FeedItem[],
  previews: Map<string, GroupPreviewTitle[]> | undefined,
  viewerId: string,
) {
  const pairs = useMemo(() => {
    const keys = new Set<string>();
    for (const event of events) {
      if (event.type !== 'ranking_batch') continue;
      const count = groupCount(event);
      const rows = count ? previews?.get(previewKey(event, count)) : undefined;
      for (const row of rows ?? []) keys.add(reviewKey(event.actorId, row.mediaItemId));
    }
    return [...keys].sort();
  }, [events, previews]);
  return useChunkedById<true>(['feed-group-reviews', viewerId], pairs, readGroupReviews);
}
