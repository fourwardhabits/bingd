import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { posterUri, avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { compactName, type MediaKind } from '@/lib/titles';

import type {
  ListItem,
  ListMembership,
  ListOrderStyle,
  ListProgress,
  ListView,
  ListVisibility,
  MyListSummary,
  ProfileListSummary,
} from './types';

/**
 * The client half of the list readers (20261010000100).
 *
 * ---------------------------------------------------------------------------
 * ZERO ROWS IS NOT AN ERROR HERE
 *
 * Every list reader answers a list the caller may not read with **zero rows**, not with
 * a refusal — private, deleted, hidden, suspended, blocked and "no such uuid" are one
 * answer by design (§F). So `useListView` resolves to `null` and the screen draws the
 * unavailable state; a thrown error would make a private list look like a broken app,
 * and a retry loop would then hammer the server for a row that is never coming.
 *
 * The one thing that *is* an error is the request failing, and that still throws, so
 * `ScreenError` can offer a retry for the case a retry can fix.
 */

const POSTERS = (paths: unknown): string[] =>
  Array.isArray(paths)
    ? paths
        .map((p) => posterUri(typeof p === 'string' ? p : null, 'card'))
        .filter((uri): uri is string => Boolean(uri))
        .slice(0, 4)
    : [];

/** The page size for a list's own items. The server caps at 100 regardless. */
export const LIST_PAGE_SIZE = 100;

/** How many cards a profile shelf draws before `See all` becomes the way through. */
export const PROFILE_SHELF_SIZE = 10;

type MyListRow = {
  id: string;
  title: string;
  item_count: number;
  order_style: ListOrderStyle;
  visibility: ListVisibility;
  hidden: boolean;
  updated_at: string;
  posters: string[] | null;
};

const toMyList = (row: MyListRow): MyListSummary => ({
  id: row.id,
  title: row.title,
  itemCount: row.item_count ?? 0,
  orderStyle: row.order_style,
  visibility: row.visibility,
  hidden: Boolean(row.hidden),
  updatedAt: row.updated_at,
  posterUris: POSTERS(row.posters),
});

/**
 * Every list the caller owns, newest-edited first, paged on `updated_at`.
 *
 * **No sort control**, per §I: `Updated <date>` is line three of every row *and* the
 * sort key, so the order explains itself. A control offering "by name" would be a
 * preference to store and a second order to reason about, for a screen most people will
 * have four rows on.
 */
export function useMyLists(userId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.myLists(userId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.rpc('my_lists', {
        p_before_updated_at: pageParam,
        p_limit: 30,
      });
      if (error) throw error;
      return ((data ?? []) as MyListRow[]).map(toMyList);
    },
    // The cursor is the last row's `updated_at`, which is strictly decreasing and is
    // what the server compares against. A short page is the end.
    getNextPageParam: (last) => (last.length < 30 ? undefined : last.at(-1)?.updatedAt ?? undefined),
  });
}

type ProfileListRow = Omit<MyListRow, 'visibility' | 'hidden'>;

/**
 * A profile's **public** lists. The same answer for every caller, the owner included.
 *
 * There is no viewer branch in here and there must not be: the own-profile shelf shows
 * what a visitor sees, which is how an owner learns the privacy model by looking at it
 * (§Q.4). The server enforces it; this hook could not widen it if it tried.
 */
export function useProfileLists(ownerId: string | null | undefined, limit = PROFILE_SHELF_SIZE) {
  return useQuery({
    queryKey: queryKeys.profileLists(ownerId ?? '', limit),
    enabled: Boolean(ownerId),
    queryFn: async (): Promise<ProfileListSummary[]> => {
      const { data, error } = await supabase.rpc('profile_lists', {
        p_owner_id: ownerId,
        p_before_updated_at: null,
        p_limit: limit,
      });
      if (error) throw error;
      return ((data ?? []) as ProfileListRow[]).map((row) => ({
        id: row.id,
        title: row.title,
        itemCount: row.item_count ?? 0,
        orderStyle: row.order_style,
        updatedAt: row.updated_at,
        posterUris: POSTERS(row.posters),
      }));
    },
  });
}

type ListViewRow = {
  id: string;
  title: string;
  description?: string | null;
  order_style: ListOrderStyle;
  item_count: number;
  updated_at: string;
  is_owner: boolean;
  shareable_by_viewer: boolean;
  visibility?: ListVisibility;
  hidden?: boolean;
  owner?: {
    id?: string;
    username: string;
    display_name: string;
    avatar_path?: string | null;
    profile_visible: boolean;
  } | null;
};

/** One list's header, or `null` for every one of §F's refusals. */
export function useListView(listId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.list(listId ?? ''),
    enabled: Boolean(listId),
    queryFn: async (): Promise<ListView | null> => {
      const { data, error } = await supabase.rpc('list_view', { p_list_id: listId });
      if (error) throw error;

      const row = (Array.isArray(data) ? data[0] : data) as ListViewRow | null;
      if (!row) return null;

      return {
        id: row.id,
        title: row.title,
        description: row.description ?? null,
        orderStyle: row.order_style,
        itemCount: row.item_count ?? 0,
        updatedAt: row.updated_at,
        isOwner: Boolean(row.is_owner),
        shareableByViewer: Boolean(row.shareable_by_viewer),
        visibility: row.visibility ?? null,
        hidden: Boolean(row.hidden),
        owner: row.owner
          ? {
              id: row.owner.id,
              username: row.owner.username,
              displayName: row.owner.display_name,
              avatarUri: avatarUri(row.owner.avatar_path),
              profileVisible: Boolean(row.owner.profile_visible),
            }
          : null,
      };
    },
  });
}

type ListItemRow = {
  media_item_id: string;
  kind: MediaKind;
  title: string;
  year: number | null;
  poster_path: string | null;
  season_number: number | null;
  parent_title: string | null;
  position: number;
  ordinal: number;
  viewer_seen: boolean | null;
  viewer_watchlisted: boolean | null;
};

/**
 * A list's items, paged on `position`.
 *
 * The cursor is the last row's stored `position`, not its ordinal: the ordinal is
 * derived at read time and is not what the server compares against. Mixing them would
 * work on a list that has never had a removal and silently skip rows on one that has.
 */
export function useListItems(listId: string | null | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.listItems(listId ?? ''),
    enabled: Boolean(listId) && enabled,
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }): Promise<ListItem[]> => {
      const { data, error } = await supabase.rpc('list_items_page', {
        p_list_id: listId,
        p_after_position: pageParam,
        p_limit: LIST_PAGE_SIZE,
      });
      if (error) throw error;

      return ((data ?? []) as ListItemRow[]).map((row) => ({
        mediaItemId: row.media_item_id,
        kind: row.kind,
        name:
          compactName({
            kind: row.kind,
            title: row.title,
            seriesTitle: row.parent_title,
            seasonNumber: row.season_number,
          }) ?? row.title,
        year: row.year ?? null,
        posterUri: posterUri(row.poster_path, 'row'),
        position: row.position,
        ordinal: row.ordinal,
        seen: row.viewer_seen,
        watchlisted: row.viewer_watchlisted,
      }));
    },
    getNextPageParam: (last) =>
      last.length < LIST_PAGE_SIZE ? undefined : last.at(-1)?.position ?? undefined,
  });
}

/**
 * "You've seen X of N", **for whoever is reading** — the owner included (§Q.5).
 *
 * Its own query rather than a count over the loaded pages, because it is defined over
 * the *whole* list and the screen may only have loaded the first hundred. A number that
 * grew as you scrolled would be worse than no number.
 */
export function useListProgress(listId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.listProgress(listId ?? ''),
    enabled: Boolean(listId) && enabled,
    queryFn: async (): Promise<ListProgress | null> => {
      const { data, error } = await supabase.rpc('list_viewer_progress', { p_list_id: listId });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as ListProgress | null;
      return row ?? null;
    },
  });
}

type MembershipRow = {
  id: string;
  title: string;
  item_count: number;
  visibility: ListVisibility;
  contains: boolean;
  // 20261017000100. Absent on a backend that predates it, which reads as none.
  description?: string | null;
  posters?: string[] | null;
};

/** The Add-to-list sheet's rows: the caller's lists, with a flag for one title. */
export function useMyListsForTitle(mediaItemId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.listsForTitle(mediaItemId ?? ''),
    enabled: Boolean(mediaItemId) && enabled,
    queryFn: async (): Promise<ListMembership[]> => {
      const { data, error } = await supabase.rpc('my_lists_for_title', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;
      return ((data ?? []) as MembershipRow[]).map((row) => ({
        id: row.id,
        title: row.title,
        itemCount: row.item_count ?? 0,
        visibility: row.visibility,
        contains: Boolean(row.contains),
        description: row.description?.trim() ? row.description.trim() : null,
        posterUris: POSTERS(row.posters),
      }));
    },
  });
}

/**
 * The artwork a list's hero borrows: its **first title's** backdrop, falling back the way
 * the title page does (`heroArtwork`) — the series' key art for a season, then a blurred
 * poster, then the plain collapsed band (founder QA, 2026-09-21).
 *
 * A plain read of one `media_items` row, which is public catalogue data; it carries
 * nothing about the list's owner.
 */
export function useListHero(firstMediaItemId: string | null) {
  return useQuery({
    queryKey: ['list-hero', firstMediaItemId],
    enabled: Boolean(firstMediaItemId),
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('media_items')
        .select('backdrop_path, poster_path, parent:parent_id(backdrop_path, poster_path)')
        .eq('id', firstMediaItemId as string)
        .maybeSingle();
      if (error) throw error;
      const row = data as {
        backdrop_path: string | null;
        poster_path: string | null;
        parent:
          | { backdrop_path: string | null; poster_path: string | null }
          | { backdrop_path: string | null; poster_path: string | null }[]
          | null;
      } | null;
      const parent = Array.isArray(row?.parent) ? row?.parent[0] : row?.parent;
      return {
        backdropPath: row?.backdrop_path ?? null,
        posterPath: row?.poster_path ?? null,
        parentBackdropPath: parent?.backdrop_path ?? null,
        parentPosterPath: parent?.poster_path ?? null,
      };
    },
  });
}
