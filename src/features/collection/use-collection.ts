import { useQuery } from '@tanstack/react-query';

import { resolveMetadata, type EmbeddedParent } from '@/lib/media-metadata';
import { queryKeys } from '@/lib/query';
import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

/**
 * The user's own collection.
 *
 * Read straight from `user_media`, `rankings` and `watchlist`. The owner is entitled to
 * all of it, and RLS already scopes every one of these tables to `auth.uid()`.
 *
 * This used to say that `visible_collection` "exists" for reading somebody else's
 * collection. **It does not** — no migration ever created it (checked 2026-08-23), so
 * `user_media` has one owner-only policy and no second path. Somebody else's *ranked*
 * titles come from `rankings`; their logged-but-unranked ones are readable by nobody but
 * them. See `architecture/data-model.md` for why that is a gap in the feature rather
 * than in the privacy contract.
 *
 * **Every read here goes to exhaustion, by keyset** (`lib/read-all.ts`), and the reason is
 * worth stating because deferring it was a mistake made deliberately and in writing.
 * PostgREST caps an unbounded select at 1,000 rows, and the first reading of that was
 * that these hooks return *lists* — a truncated list is a display problem, and a display
 * problem can wait. It is not what these hooks return. `loggedCount` and `rankedCount`
 * below are `.length` on those arrays, and `use-score.ts` takes the ranking total the
 * same way and **feeds it into the score**. An account with 1,001 ranked films saw
 * "#1,001 of 1,000" with a derived score computed against the wrong denominator.
 *
 * So the rule this file now follows: **a capped read may never become a denominator.**
 * Check what is derived from a read before deciding the read is cosmetic — that is the
 * correction, and independent review 21b is where it came from.
 *
 * Two consequences of keyset paging show up throughout:
 *
 * - The cursor has to be the column the request sorts by, and it has to be unique. Every
 *   one of these tables is keyed by `(user_id, media_item_id)` and every read here pins
 *   the account, so `media_item_id` is that column in all three.
 * - Which means the **order the screen wants is applied in JS**, over the assembled rows.
 *   That costs nothing: the read has to reach the end anyway, so the server's order was
 *   never carrying any information the client did not already have.
 */

export type RankedEntry = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  kind: 'movie' | 'season' | 'series';
  /**
   * The parent series, for a season.
   *
   * A ranked list of TV is a column of rows called "Season 2", so the name is only
   * complete with the show attached (`lib/titles.ts`). Carried on the entry rather
   * than resolved per row at render time, because a second query per season would be
   * a request per visible row.
   */
  seriesTitle: string | null;
  /** `media_items.season_number`, so a row can read "The Last of Us, S1" without parsing. */
  seasonNumber?: number | null;
  /**
   * The parent series' id, for a season.
   *
   * Carried because a season is not a unit anything upstream reasons about: TMDB
   * publishes recommendations for a series and none for a season, so a ranked
   * season's contribution to For You has to be made through its show.
   */
  seriesId: string | null;
  /** ISO 639-1, for the hero's language rank context (`hero-rank.ts`). */
  language: string | null;
  bucket: 'loved' | 'fine' | 'not_for_me';
  position: number;
  category: RankingCategory;
};

export type LoggedEntry = {
  mediaItemId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  kind: 'movie' | 'season' | 'series';
  /** The parent series, for a season — the same rule as RankedEntry. */
  seriesTitle: string | null;
  /** The season's number, for the same reason. */
  seasonNumber?: number | null;
  /** ISO 639-1, for the collection filters. */
  language: string | null;
  bucket: 'loved' | 'fine' | 'not_for_me' | null;
  watchedOn: string | null;
};

export type RankingCategory = 'movies' | 'tv_seasons';

const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);

type MediaShape = {
  title: string;
  season_number?: number | null;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
  runtime_minutes: number | null;
  kind: 'movie' | 'season' | 'series';
  original_language?: string | null;
  parent_id?: string | null;
  parent?: EmbeddedParent;
};

/** PostgREST returns an embedded row as an object, but types it as an array. */
const media = (value: MediaShape | MediaShape[] | null): MediaShape =>
  (Array.isArray(value) ? value[0] : value) ?? {
    title: '',
    release_date: null,
    poster_path: null,
    genres: [],
    runtime_minutes: null,
    kind: 'movie',
  };

/**
 * The descriptive metadata of one row, with a season's inheritance already applied.
 *
 * Every mapper below goes through this rather than reading `genres` and
 * `original_language` off the row, which is what makes `The Last of Us, S1` a drama
 * everywhere at once — collection filters, For You anchors, the hero's rank line and
 * the genre awards — rather than in whichever surface remembered to look at the parent.
 *
 * See `lib/media-metadata.ts` for why this resolves at read time and copies nothing.
 */
const descriptive = (shape: MediaShape) =>
  resolveMetadata({
    kind: shape.kind,
    genres: shape.genres,
    original_language: shape.original_language,
    parent: shape.parent ?? null,
  });

/**
 * The ranked list for one category, in position order.
 *
 * Movies and TV seasons are separate rankings and are never merged — a position is only
 * meaningful within its category (PRD §11), and a combined list would imply an ordering
 * across the two that nobody ever expressed.
 */
export function useRankedCollection(
  userId: string,
  category: RankingCategory,
  // Off by default nowhere, but a caller that only wants this list under a condition —
  // a series page reading the viewer's ranked seasons — would otherwise pay for it on
  // every title page in the app.
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: queryKeys.rankings(userId, category),
    queryFn: async (): Promise<RankedEntry[]> => {
      const { data, error } = await readAllByKey<any>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select(
                'media_item_id, bucket, position, category, ' +
                  'media_items(title, season_number, release_date, poster_path, genres, runtime_minutes, kind, original_language, parent_id, parent:parent_id(title, genres, original_language))',
              )
              .eq('user_id', userId)
              .eq('category', category),
            'media_item_id',
            cursor,
          )
            // Not `position`, though it is unique per category and is the order this list
            // is shown in. Inserting a ranking **shifts every position below it**, so a
            // position cursor can be moved out from under the read by a concurrent
            // ranking session — the same defect keyset exists to remove, one level down.
            // `media_item_id` never changes.
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;

      // Position order, applied here now that the request is sorted by the key.
      return [...((data ?? []) as any[])]
        .sort((a, b) => a.position - b.position)
        .map((row: any) => {
        const shape = media(row.media_items);
        const meta = descriptive(shape);
        return {
          mediaItemId: row.media_item_id,
          title: shape.title,
          year: yearOf(shape.release_date),
          posterPath: shape.poster_path,
          genres: meta.genres,
          runtimeMinutes: shape.runtime_minutes,
          kind: shape.kind,
          seriesTitle: meta.seriesTitle,
          seasonNumber: shape.season_number ?? null,
          seriesId: shape.parent_id ?? null,
          language: meta.language,
          bucket: row.bucket,
          position: row.position,
          category: row.category,
        };
      });
    },
  });
}

/**
 * Everything logged, and which of it has a position.
 *
 * Two requests inside one query, rather than one request with an embed. PostgREST embeds
 * across a foreign key and there is none between `user_media` and `rankings` — they share
 * a primary key shape and nothing else, since the ranking RPCs are the only writers of
 * `rankings` and a constraint between the two would say something about ordering that is
 * not true. Asking for `rankings(position)` from `user_media` fails outright.
 *
 * They settle together because the Logged tab states the split — "142 ranked · 380 logged"
 * (PRD §5) — and two independently cached fetches produce a pair of numbers that disagree
 * for a moment every time either one lands.
 */
export function useLoggedCollection(userId: string) {
  return useQuery({
    queryKey: queryKeys.collection(userId),
    queryFn: async () => {
      const [logged, ranked] = await Promise.all([
        readAllByKey<any>(
          (cursor, limit) =>
            after(
              supabase
                .from('user_media')
                // `created_at` is selected rather than ordered on: it is not unique, so a
                // `.gt()` cursor on it would skip every row but the last of any group
                // written in the same instant. The order it expresses is applied below.
                .select(
                  'media_item_id, bucket, watched_on, created_at, media_items(title, season_number, release_date, poster_path, genres, runtime_minutes, kind, original_language, parent:parent_id(title, genres, original_language))',
                )
                .eq('user_id', userId),
              'media_item_id',
              cursor,
            )
              .order('media_item_id', { ascending: true })
              .limit(limit),
          (row) => [row.media_item_id],
        ),
        readAllByKey<{ media_item_id: string }>(
          (cursor, limit) =>
            after(
              supabase.from('rankings').select('media_item_id').eq('user_id', userId),
              'media_item_id',
              cursor,
            )
              .order('media_item_id', { ascending: true })
              .limit(limit),
          (row) => [row.media_item_id],
        ),
      ]);

      if (logged.error) throw logged.error;
      if (ranked.error) throw ranked.error;

      // A short read here would not shrink a list, it would turn a ranked title into an
      // unranked one — so `rankedCount` and the unranked queue both need this to be the
      // whole set, not the first page of it.
      const hasPosition = new Set((ranked.data ?? []).map((row) => row.media_item_id));

      const rows = [...((logged.data ?? []) as any[])]
        // Newest first, which is what the request used to ask for. The key breaks the tie
        // so two titles logged in the same instant do not swap places between renders.
        .sort(
          (a, b) =>
            String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
            String(a.media_item_id).localeCompare(String(b.media_item_id)),
        )
        .map((row: any) => {
        const shape = media(row.media_items);
        const meta = descriptive(shape);
        return {
          entry: {
            mediaItemId: row.media_item_id,
            title: shape.title,
            year: yearOf(shape.release_date),
            posterPath: shape.poster_path,
            genres: meta.genres,
            runtimeMinutes: shape.runtime_minutes,
            kind: shape.kind,
            seriesTitle: meta.seriesTitle,
            seasonNumber: shape.season_number ?? null,
            language: meta.language,
            bucket: row.bucket,
            watchedOn: row.watched_on,
          } satisfies LoggedEntry,
          ranked: hasPosition.has(row.media_item_id),
        };
      });

      return {
        entries: rows.map((r) => r.entry),
        // Titles without a position. PRD §5 is explicit that this is not a backlog and
        // must not be presented as one: no progress bar, no "380 remaining".
        unranked: rows.filter((r) => !r.ranked).map((r) => r.entry),
        // The Logged tab's whole header — "142 ranked · 380 logged" (PRD §5). Both are
        // `.length` on the arrays above, which is exactly why those reads may not stop
        // at a thousand: this is a number the app states, not a list it draws.
        rankedCount: rows.filter((r) => r.ranked).length,
        loggedCount: rows.length,
      };
    },
  });
}

export function useWatchlist(userId: string) {
  return useQuery({
    queryKey: [...queryKeys.collection(userId), 'watchlist'],
    queryFn: async (): Promise<LoggedEntry[]> => {
      const { data, error } = await readAllByKey<any>(
        (cursor, limit) =>
          after(
            supabase
              .from('watchlist')
              .select(
                'media_item_id, created_at, media_items(title, season_number, release_date, poster_path, genres, runtime_minutes, kind, original_language, parent:parent_id(title, genres, original_language))',
              )
              .eq('user_id', userId),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;

      // The watchlist is a list rather than a number here — but Queue Dragon counts it,
      // the Feed and Recommendations build a `saved` set from it, and a set missing its
      // thousand-and-first member draws the wrong bookmark on a row.
      return [...((data ?? []) as any[])]
        .sort(
          (a, b) =>
            String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
            String(a.media_item_id).localeCompare(String(b.media_item_id)),
        )
        .map((row: any) => {
        const shape = media(row.media_items);
        const meta = descriptive(shape);
        return {
          mediaItemId: row.media_item_id,
          title: shape.title,
          year: yearOf(shape.release_date),
          posterPath: shape.poster_path,
          genres: meta.genres,
          runtimeMinutes: shape.runtime_minutes,
          kind: shape.kind,
          seriesTitle: meta.seriesTitle,
          seasonNumber: shape.season_number ?? null,
          language: meta.language,
          bucket: null,
          watchedOn: null,
        };
      });
    },
  });
}

export const BAND_ORDER = ['loved', 'fine', 'not_for_me'] as const;
