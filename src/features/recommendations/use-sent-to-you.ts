import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CollectionItem } from '@/features/collection/filters';
import { track, type MediaKind } from '@/lib/analytics';
import { avatarUri } from '@/lib/images';
import { effectiveLanguage, parentOf, productGenres, type EmbeddedParent } from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';

/**
 * `Sent to you`: the human half of the recommendations tab.
 *
 * Deliberately not merged into For You. The algorithm's slate is built from the
 * reader's own taste and a popularity prior, and PRD §13 requires every reason it
 * gives to be reproducible from stored signals — a friend's opinion is neither, and
 * mixing the two would make the engine assert something it did not compute.
 */

export type SentRecommendation = {
  id: string;
  senderId: string;
  senderUsername: string;
  senderName: string;
  senderAvatarUri: string | null;
  mediaItemId: string;
  kind: 'movie' | 'season' | 'series';
  title: string;
  seriesTitle: string | null;
  posterPath: string | null;
  year: number | null;
  genres: string[];
  language: string | null;
  runtimeMinutes: number | null;
  recommendedAt: string;
  openedAt: string | null;
};

type Row = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string | null;
  sender_avatar_path: string | null;
  media_item_id: string;
  media_kind: 'movie' | 'season' | 'series';
  media_title: string;
  series_title: string | null;
  poster_path: string | null;
  release_date: string | null;
  genres: string[] | null;
  original_language: string | null;
  runtime_minutes: number | null;
  recommended_at: string;
  opened_at: string | null;
};

const yearOf = (date: string | null): number | null => {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
};

/**
 * The list, in the order the server returns it.
 *
 * Ordering is the database's — unopened first, then newest — and is deliberately not
 * re-sorted here. Two sorts over the same list is how a screen comes to disagree with
 * the badge above it.
 */
export function useSentToYou(viewerId: string) {
  return useQuery({
    queryKey: ['sent-to-you', viewerId],
    staleTime: 30_000,
    queryFn: async (): Promise<SentRecommendation[]> => {
      const { data, error } = await supabase.rpc('recommendations_to_me', {
        p_limit: SENT_LIMIT,
      });
      if (error) throw error;

      const served = (data ?? []) as Row[];
      /**
       * **A title this reader has already ranked is not a recommendation any more.**
       *
       * The founder found *The Last of Us* sitting in Sent to you on a physical build,
       * on an account that had ranked it. It was not a stale row in the historical
       * sense — it was the current invariant. `recommendations_to_me` returns every
       * delivered recommendation the recipient policy admits, and nothing anywhere
       * asked whether the recipient had since watched the thing. `fulfilled_at` exists
       * (`20260827000600`) and is written by `_rank_finalize`, but it is granted to
       * nobody, is not in the RPC's result, and is null on every recommendation older
       * than that migration — so it could not have answered this even if it were read.
       *
       * Answered here, against `rankings`, for three reasons:
       *
       *   · **It is robust to history.** The question asked is "has this reader ranked
       *     this media item", which is true of a recommendation from any era, with or
       *     without a fulfilment stamp. Nothing has to be backfilled, and no row is
       *     destroyed to make the list right.
       *   · **It needs no migration**, so it is true on every backend this client can
       *     reach, including the one build 8 is running against.
       *   · **It is one bounded request.** At most `SENT_LIMIT` ids, on the reader's own
       *     rows under `rankings_read`, only when the list has anything in it.
       *
       * The identity is the media item, which is what makes a season right: ranking
       * Season 1 retires a recommendation of Season 1 and leaves one of Season 2 alone.
       *
       * Nothing is written and no sender is told anything. Fulfilment notifications stay
       * exactly where they are — inside the ranking transaction, once each, for
       * recommendations that were outstanding at the moment somebody ranked.
       */
      const rows = await withoutRanked(viewerId, served);
      const inherited = await inheritedMetadata(rows);

      return rows.map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        senderName: row.sender_display_name || row.sender_username,
        senderAvatarUri: avatarUri(row.sender_avatar_path),
        mediaItemId: row.media_item_id,
        kind: row.media_kind,
        title: row.media_title,
        seriesTitle: row.series_title,
        posterPath: row.poster_path,
        year: yearOf(row.release_date),
        ...(inherited.get(row.media_item_id) ?? {
          genres: row.genres ?? [],
          language: row.original_language,
        }),
        runtimeMinutes: row.runtime_minutes,
        recommendedAt: row.recommended_at,
        openedAt: row.opened_at,
      }));
    },
  });
}

/**
 * The recommendations this reader has not already ranked.
 *
 * **A read that fails leaves the list alone**, which is the safe direction and the same
 * one `inheritedMetadata` takes below: the cost of not knowing is a recommendation that
 * stays on screen for one more refresh, and the cost of the other answer would be a
 * reader's whole Sent to you disappearing because one supplementary query timed out.
 *
 * Not `readAllByKey`: this is not a whole-table read. It is a membership test over the
 * ids actually on screen, which the server bounds at `SENT_LIMIT` — well inside
 * PostgREST's own cap, so there is no page to be silently dropped.
 */
async function withoutRanked(viewerId: string, rows: readonly Row[]): Promise<Row[]> {
  if (rows.length === 0) return [...rows];

  const ids = [...new Set(rows.map((row) => row.media_item_id))];
  const { data, error } = await supabase
    .from('rankings')
    .select('media_item_id')
    .eq('user_id', viewerId)
    .in('media_item_id', ids);
  if (error) return [...rows];

  const ranked = new Set((data ?? []).map((row) => (row as { media_item_id: string }).media_item_id));
  return rows.filter((row) => !ranked.has(row.media_item_id));
}

/**
 * The genres and language of any **seasons** in the list, taken from their series.
 *
 * `recommendations_to_me` returns the media row's own `genres` and
 * `original_language`, and a season has neither — so a recommended season was
 * invisible the moment the reader put a genre filter on the tab, which is the same
 * defect the collection had before `lib/media-metadata.ts`.
 *
 * Resolved with one supplementary read of `media_items` rather than by widening the
 * RPC, because widening the RPC is a migration and this is a client-side composition
 * over a catalogue table every client can already read. One query, only when the list
 * actually contains a season, over at most the hundred rows the RPC returns.
 *
 * A failure here is not a failure of the list: the rows keep their own metadata, which
 * is what they had before, and the filter is the only thing that notices.
 */
async function inheritedMetadata(
  rows: readonly Row[],
): Promise<Map<string, { genres: string[]; language: string | null }>> {
  const seasonIds = rows.filter((row) => row.media_kind === 'season').map((row) => row.media_item_id);
  if (seasonIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('media_items')
    .select('id, genres, original_language, parent:parent_id(genres, original_language)')
    .in('id', seasonIds);
  if (error) return new Map();

  type SeasonRow = {
    id: string;
    genres: string[] | null;
    original_language: string | null;
    parent: EmbeddedParent;
  };

  const resolved = new Map<string, { genres: string[]; language: string | null }>();
  for (const season of (data ?? []) as unknown as SeasonRow[]) {
    const parent = parentOf(season.parent);
    const subject = {
      kind: 'season' as const,
      genres: season.genres,
      language: season.original_language,
      parent: parent ? { genres: parent.genres, language: parent.original_language } : null,
    };
    resolved.set(season.id, {
      genres: productGenres(subject),
      language: effectiveLanguage(subject),
    });
  }
  return resolved;
}

/**
 * As many as this list can hold, which is as many as the server will return.
 *
 * `recommendations_to_me` clamps its `p_limit` to 200 (`20260817001300`), so this is the
 * ceiling and not a preference. It was 100, which is half of what was available for no
 * reason anybody wrote down.
 *
 * **What this cap is, and what it is not.** Independent review 21e asked for the audit
 * and this is its result, so that nobody has to redo it:
 *
 * - It is **not** behind any count that claims to be exact. `unopenedIsAtLeast` below is
 *   the guard, and it is exact rather than defensive because the server orders unopened
 *   first.
 * - It is **not** behind any award. Hype Courier and the rest read
 *   `title_recommendations` directly through `readAllByKey` (`awards/use-awards.ts`),
 *   which pages to exhaustion and refuses rather than truncates. This RPC feeds no
 *   award metric.
 * - It is **not** behind a completeness assertion. `SentList`'s `total` is only ever
 *   compared to zero, to choose between a list and an empty state.
 * - It **is** a presentation cap on the list itself. A reader with more than two hundred
 *   recommendations sees the two hundred the server ranks highest — unopened first, then
 *   newest — and the rest are not reachable from this screen.
 * - Since `withoutRanked`, the page the client holds can be **shorter** than the page the
 *   server served, and independent review asked for both consequences to be written down
 *   rather than discovered.
 *
 *   The first is harmless: a shorter page only ever makes `unopenedIsAtLeast` answer
 *   false where it would have answered true, so the chip says `199` rather than `200+` —
 *   an understatement of a capped list, which is the direction this rule permits. It
 *   cannot overstate.
 *
 *   The second is the empty state. **A reader holding more than two hundred delivered
 *   recommendations, of which the two hundred the server ranks highest are all already
 *   ranked, is told nothing has been sent their way while an unranked one sits at
 *   position 201.** That is a false sentence, and it is worth being exact about what it
 *   is and is not. It is not new unreachability: row 201 is not on this screen today
 *   either, by the cap. It is the cap becoming *visible* in a case where it used to be
 *   silent.
 *
 *   Closing it exactly means filtering **before** the limit, which is the RPC's job and
 *   therefore a migration — `and not exists (select 1 from rankings ...)` in
 *   `recommendations_to_me`. That is the right fix and it is deliberately not taken in a
 *   release fix pass: the client answer is complete for every account that can exist at
 *   this stage, it needs no deploy, and it is true on the backend the shipped build is
 *   already running against. Carried with the pagination debt above rather than
 *   approximated here.
 *
 * That last one is **deferred pagination debt, not a wrong number**. Paging it needs a
 * cursor the RPC does not take, which is a migration, and it is carried into Beta
 * Hardening §2 rather than approximated here. What this pass fixed was the number; the
 * list stays capped and says nothing false about itself.
 */
export const SENT_LIMIT = 200;

/** How many have not been opened, which is what the tab's dot carries. */
export const unopenedCount = (rows: SentRecommendation[] | undefined) =>
  (rows ?? []).filter((row) => !row.openedAt).length;

/**
 * Whether that number is the whole truth or a floor.
 *
 * **A capped list may not be presented as a total**, which is the rule this whole pass is
 * about, and this is the one place in the app where the cap is the server's rather than
 * PostgREST's — so it cannot be paged away without a migration. What it can be is honest.
 *
 * The server orders unopened first, so the unopened rows are a prefix of what arrives.
 * That makes the test exact rather than defensive: if the prefix does not fill the page,
 * every unopened recommendation is in hand and the count is the count. Only when the
 * whole page is unopened can there be more, and only then does the chip say "200+".
 *
 * Independent review 21c found this one, after the first sweep looked only at PostgREST's
 * cap and not at a limit the app asks for itself.
 */
export const unopenedIsAtLeast = (rows: SentRecommendation[] | undefined) =>
  (rows ?? []).length >= SENT_LIMIT && unopenedCount(rows) >= SENT_LIMIT;

/**
 * A recommendation as the shared filter sheet sees it.
 *
 * The same widening `asCollectionItem` performs for a For You candidate, and for the
 * same reason: one filter model over both tabs is what makes the founder's "Comedy on
 * For you, switch to Sent to you, still Comedy" true without a second implementation.
 *
 * Score, bucket and watch date are null. Nothing here has been ranked by the reader,
 * which is why the sheet is asked not to offer those controls.
 */
export const asCollectionItem = (row: SentRecommendation): CollectionItem => ({
  mediaItemId: row.mediaItemId,
  title: row.title,
  seriesTitle: row.seriesTitle,
  kind: row.kind,
  year: row.year,
  posterPath: row.posterPath,
  genres: row.genres,
  language: row.language,
  runtimeMinutes: row.runtimeMinutes,
  score: null,
  bucket: null,
  watchedOn: null,
  // These rows are candidates rather than collection members: nothing here has an
  // entry in user_media or watchlist, so there is no membership time to carry. The
  // filter model needs the field; the Recently-added axis is not offered over them.
  addedAt: null,
});

/**
 * Marks one opened, once.
 *
 * Fired when the reader taps through to the title, which is the only moment anybody
 * can honestly call it opened. The server refuses to move an existing timestamp, so a
 * second tap changes nothing — and a failure is swallowed rather than surfaced,
 * because "we could not record that you looked at this" is not a sentence worth
 * interrupting somebody with.
 */
/**
 * Which recommendations have already been reported as opened, for the life of the process.
 *
 * **Module-level, not a ref**, and independent review 24b is why: the recommendations tab
 * is a tab, so it unmounts whenever somebody moves to another one. A ref would be emptied
 * by that, and a reader who opened a recommendation, switched tabs and came back before
 * the list refetched would report a second open for one row.
 *
 * Keyed by viewer as well as by recommendation, like every other cache in this app: two
 * accounts on one device must not read each other's state, even where — as here — the
 * consequence is only a missing event.
 */
const reportedOpens = new Set<string>();

/** Exported for tests, which must not inherit what a previous one reported. */
export function resetReportedOpens() {
  reportedOpens.clear();
}

export function useMarkRecommendationOpened(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      recommendationId,
      mediaKind,
    }: {
      recommendationId: string;
      mediaKind: MediaKind;
    }) => {
      const { error } = await supabase.rpc('mark_recommendation_opened', {
        p_recommendation_id: recommendationId,
      });

      /**
       * `recommendation_opened`, **after the server answered and once per row**.
       *
       * The caller's `!row.openedAt` gate is necessary and not sufficient, which is what
       * independent review 24 found. It reads a cached list, so two taps before the
       * refetch lands both see a null timestamp — and the emission used to sit on the
       * tap, so a write that never committed still reported an open. Two things fix it:
       *
       * - **the error check**, so this follows the server rather than the press. The
       *   write itself stays fire-and-forget for the *person* — a failure must not stand
       *   between somebody and the title they were told to watch — but a failure is not
       *   an open, so it emits nothing. A failure also leaves the row **out** of the set,
       *   so a later successful open still reports;
       * - **`reportedOpens`**, which is module-level so that leaving the tab and coming
       *   back does not reset it, and makes this once per row per process regardless of
       *   how stale the list underneath was.
       *
       * `mark_recommendation_opened` refuses to move an existing timestamp, so a
       * genuinely repeated call is a no-op server-side; this is the client half of the
       * same guarantee. The residual is a reinstall or a second device, which would
       * report one more open for a row already opened elsewhere — bounded, and in the
       * same known direction as everything else here.
       */
      const seen = `${viewerId}:${recommendationId}`;
      if (!error && !reportedOpens.has(seen)) {
        reportedOpens.add(seen);
        track({
          name: 'recommendation_opened',
          props: { media_kind: mediaKind, surface: 'sent_to_you' },
        });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sent-to-you', viewerId] }),
  });
}

/**
 * "2d ago", and the handful of shapes around it.
 *
 * A date alone is wrong for this list: recency is half of what the row is telling you,
 * and "17/08/2026" makes the reader do the subtraction. Absolute once it is past a
 * fortnight, where the exact interval has stopped being the useful fact.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days <= 14) return `${days}d ago`;

  return new Date(then).toLocaleDateString();
}
