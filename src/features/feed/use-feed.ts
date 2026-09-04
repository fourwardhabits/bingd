import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';

import { awardAnnouncement } from '@/features/awards/announcement';
import { GOAL_LABEL } from '@/features/goals/goals';
import type { Bucket } from '@/features/collection/score';
import { avatarUri } from '@/lib/images';
import { effectiveCertification, productGenres } from '@/lib/media-metadata';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { compactName, type MediaKind } from '@/lib/titles';

import { ACTIVITY_TYPES, isWatchActivity, type ActivityType } from './activity';

export type FeedNote = {
  text: string;
  hasSpoilers: boolean;
};

export type FeedItem = {
  id: string;
  type: ActivityType;
  actorId: string;
  actorUsername: string;
  actorName: string;
  actorAvatarUri: string | null;
  mediaItemId: string | null;
  kind: MediaKind | null;
  /**
   * The name to print. For a season this is "Parks and Recreation, S2", because a
   * feed never shows the parent series alongside it and "Season 2" on its own names
   * nothing (founder amendments, 2026-08-16 and 2026-08-18). The year is separate,
   * below, so the row can print it in its own weight.
   */
  title: string | null;
  year: number | null;
  posterPath: string | null;
  /**
   * The genres to print — the row's own, or the parent series' where a season has
   * none, which is every season the catalogue holds (`lib/media-metadata.ts`).
   *
   * Resolved here rather than at the row, so the three surfaces that render an
   * activity cannot disagree about what a season's genres are.
   */
  genres: string[];
  /** The US rating, resolved the same own-then-parent way. `PG-13`, `TV-MA`, null. */
  certification: string | null;
  /** A movie's length. Null for a season and a series — see `activityMetadata`. */
  runtimeMinutes: number | null;
  /** A season's episode count (`20260820000400`). Null everywhere else. */
  episodeCount: number | null;
  createdAt: string;
  position: number | null;
  /**
   * Snapshotted at rank time, not derived here.
   *
   * A score is a title's place within its owner's band, so computing one needs
   * that person's whole ranking — which a viewer cannot read and should not be
   * able to. `_rank_finalize` writes it into the payload instead
   * (20260815010000). A snapshot is arguably the more correct thing for an
   * activity item anyway: it records what the moment was.
   */
  score: number | null;
  bucket: Bucket | null;
  category: 'movies' | 'tv_seasons' | null;
  /**
   * The actor's public note on this title, live rather than snapshotted.
   *
   * The opposite choice from the score, and for a reason: a score is a fact about a
   * moment, and a note is a piece of writing its author can correct, retract or make
   * private. Showing a stale copy of one would mean a note deleted an hour ago is
   * still being read, which is the whole point of the visibility control.
   */
  note: FeedNote | null;
  /**
   * Who the actor says they watched it with (PRD §14), as names.
   *
   * Read live rather than snapshotted into the payload, for the same reason the note
   * is: the tagged person can hide a tag from their side at any time, and a
   * denormalised copy would keep showing them in other people's feeds after they
   * had said not to.
   */
  companions: string[];
  /**
   * The award, for an `award_earned` row — and only there (20260828000100).
   *
   * Keys resolve the badge through `badgeFor`. **The two strings come from
   * `awardAnnouncement` rather than from the payload** (2026-08-29): the earned tier's
   * name, and the threshold sentence explaining what was done for it. The payload's own
   * names are that function's fallback for a track this bundle predates, which is why
   * they are not carried separately here — a second copy is a second thing to disagree.
   *
   * `title` rides the announcement's name, which is what makes the sentence read
   * "Abisola earned the Whisper award" through the ordinary grammar.
   */
  award: {
    key: string;
    tierKey: string;
    /** The emphasised name: the earned tier, or the family name on a metal track. */
    title: string;
    /** "Wrote 20 comments" — the row's second line. Null for an unknown track. */
    achievement: string | null;
  } | null;
  /**
   * The goal, for a `goal_completed` row — and only there (20260829000200).
   *
   * Shaped like `award` above and for the same reason: the sentence slot carries the
   * goal's name ("their 2026 Movies goal"), and this is what the row needs to draw its
   * lead and route its tap. Null on every other type.
   */
  goal: { year: number; category: 'movies' | 'tv_seasons'; target: number } | null;
};

type Embedded<T> = T | T[] | null;

/**
 * The parent series of a season, which this read has always embedded for its title.
 *
 * It now carries two more columns, and they are the cheap half of the founder's
 * standardised subheading: TMDB publishes genres and a content rating on the *series*
 * and never on a season, so before this a feed row about `Severance, S2` had no genres
 * and no rating to print — not because they were unknown, but because they were one
 * join away on a join that was already being made.
 */
type ParentShape = {
  title: string | null;
  genres: string[] | null;
  original_language: string | null;
  certification: string | null;
};

type MediaShape = {
  kind: MediaKind;
  title: string;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
  original_language: string | null;
  certification: string | null;
  runtime_minutes: number | null;
  episode_count: number | null;
  parent: Embedded<ParentShape>;
};

type ProfileShape = {
  username: string;
  display_name: string | null;
  avatar_path: string | null;
};

type FeedRow = {
  id: string;
  type: string;
  actor_id: string;
  media_item_id: string | null;
  created_at: string;
  /** Both 20260901000100. Optional for a bundle reading a database without them. */
  causal_at?: string | null;
  causal_step?: number | null;
  payload: {
    position?: number;
    category?: 'movies' | 'tv_seasons';
    score?: number;
    bucket?: Bucket;
    /** award_earned rows only (20260828000100). */
    award?: string;
    tier?: string;
    award_name?: string;
    tier_label?: string;
    /** goal_completed rows only (20260829000200). `category` is shared with rankings. */
    year?: number;
    target?: number;
  } | null;
  media_items: Embedded<MediaShape>;
  profiles: Embedded<ProfileShape>;
};

type NoteRow = {
  user_id: string;
  media_item_id: string;
  note: string;
  has_spoilers: boolean;
};

type CompanionRow = {
  tagger_id: string;
  media_item_id: string;
  profiles: Embedded<{ display_name: string | null; username: string }>;
};

/**
 * PostgREST returns a to-one embed as an object and a to-many as an array, and
 * its generated types say array for both.
 *
 * Indexing `[0]` into the object therefore yields undefined and every fallback
 * fires at once — which is exactly how the feed came to read "Someone ranked a
 * title." on every row, including the user's own activity, where an unnamed
 * actor is impossible by construction.
 */
const one = <T>(value: Embedded<T>): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * How many activities one page of the feed is.
 *
 * Twenty, for two reasons that pull in opposite directions and meet here. The list is a
 * `ScrollView` of full-height rows, not a virtualised list, so every row in a page is
 * mounted and every poster in it is fetched — which argues for a small page. And the
 * next page is requested a screenful before the reader reaches the end, so a page has to
 * be longer than a screen or the fetch starts the moment the previous one lands — which
 * argues for a large one. Twenty is roughly two phone screens of activity.
 *
 * **It was 30, fetched once, with no second page at all**, and that is the defect this
 * replaces: a reader whose network had produced 31 eligible activities saw the thirtieth
 * and then nothing, with no way to tell that from having reached the end.
 */
export const FEED_PAGE_SIZE = 20;

/**
 * Where the next page starts: the last row of the previous one, by the feed's own sort.
 *
 * All three keys, because the sort is `(causal_at desc, causal_step desc, id asc)` and a
 * cursor naming fewer of them cannot say "strictly after this row" — the three feed
 * events one ranking writes share a `causal_at` to the microsecond by construction
 * (20260901000100), so a timestamp alone would either re-serve them or skip them.
 */
export type FeedCursor = {
  causalAt: string;
  causalStep: number;
  id: string;
};

/** One page of the feed. `cursor` is null once the server has no more rows. */
export type FeedPage = {
  items: FeedItem[];
  cursor: FeedCursor | null;
};

/**
 * The viewer's feed, a page at a time.
 *
 * Keyset rather than `OFFSET`, and the reason is the one thing a social feed does
 * constantly: it grows at the top. Under `OFFSET`, an activity posted while the reader
 * is on page 2 shifts every later row down by one, and page 3 then re-serves a row page 2
 * already showed — a duplicate for every insert, and a skipped row for every delete. A
 * keyset asks "the rows after *this* row", which is a question a write at the top of the
 * list cannot change the answer to.
 *
 * The follow set is re-read on every page rather than threaded through the page params.
 * It is one indexed select against a table the reader owns half of, and holding it still
 * would mean somebody who followed an account mid-scroll kept paging through the old set
 * until they refreshed.
 */
export function useFeed(userId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.feed(userId),
    initialPageParam: null as FeedCursor | null,
    // React Query stops asking the moment this returns null, which is what makes
    // `hasNextPage` false at the true end — and what stops the bottom of the list from
    // requesting a page that does not exist.
    getNextPageParam: (last: FeedPage) => last.cursor,
    queryFn: async ({ pageParam }): Promise<FeedPage> => {
      const { data: follows, error: followsError } = await supabase
        .from('follows')
        .select('followee_id')
        .eq('follower_id', userId)
        .eq('state', 'approved');
      if (followsError) throw followsError;

      return activityPage(
        [userId, ...(follows ?? []).map((row) => row.followee_id)],
        FEED_PAGE_SIZE,
        pageParam,
      );
    },
  });
}

/**
 * Drop every page but the first, so a refresh re-reads one page instead of all of them.
 *
 * `refetch()` on an infinite query re-runs every page it is currently holding, in order:
 * somebody who had scrolled to page 5 and pulled to refresh would spend five round trips
 * to see what is new at the top. Trimming first makes the gesture mean what it looks like
 * — go back to the newest page — and it deliberately does **not** clear the entry, so the
 * rows already on screen stay drawn under the spinner instead of flashing to a skeleton.
 *
 * Nothing here touches the scroll position. Pull-to-refresh happens at the top of the
 * list by definition, so there is nothing below to preserve and nothing to jump.
 */
export function trimFeedToFirstPage(queryClient: QueryClient, userId: string) {
  queryClient.setQueryData(
    queryKeys.feed(userId),
    (old: { pages: FeedPage[]; pageParams: unknown[] } | undefined) =>
      old && old.pages.length > 1
        ? { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) }
        : old,
  );
}

/**
 * The loaded pages as one list, with any activity that appears twice kept once.
 *
 * The keyset makes a duplicate impossible between two *adjacent* pages, but not across a
 * refresh: `trimFeedToFirstPage` shortens the list, and the next page after that is read
 * against a first page that has moved. Deduping by `id` where the pages are joined is a
 * cheap total guarantee, and it is also what keeps React's keys unique — a duplicated key
 * is a rendering fault and not merely a cosmetic one.
 */
export function feedItems(pages: FeedPage[] | undefined): FeedItem[] {
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/**
 * One person's activity, for their profile.
 *
 * Deliberately not "filter the viewer's feed down to this actor", which is what the
 * profile did first and which is wrong in a way that looks like emptiness: the feed
 * query spans the viewer's *follow set*, so a public account they have not followed
 * has no rows in it at all, and every such profile would show an empty Recent
 * activity while the person plainly has some.
 *
 * Asking about the actor directly is also no less safe. `feed_events_read` is
 * `can_i_view(actor_id)`, so a private account the viewer does not follow returns
 * nothing here exactly as it does anywhere else — the authorisation was never coming
 * from the follow set, it was coming from the policy.
 */
export function useActorActivity(actorId: string | null, limit = 5) {
  return useQuery({
    queryKey: ['actor-activity', actorId, limit],
    enabled: Boolean(actorId),
    queryFn: async () => (await activityPage([actorId as string], limit, null)).items,
  });
}

/**
 * Everything an activity row needs, as one projection.
 *
 * Named rather than repeated because three reads now use it — the feed, one person's
 * activity, and one single event for the comment-thread page — and a projection that
 * drifts between them is three surfaces disagreeing about what an activity *is*. It was
 * inline when there were two callers in one function; a third caller in another function
 * is where that stops being safe.
 */
const ACTIVITY_SELECT =
  'id, type, actor_id, media_item_id, created_at, causal_at, causal_step, payload, ' +
  // The parent series, so a season can be named — and, since the founder standardised
  // the subheading, so it can be described and rated too. A self-join through parent_id,
  // which PostgREST resolves as an embed like any other, and a left one: a movie comes
  // back with `parent: null`.
  // `original_language` is here for the product genre and for nothing else: a
  // Japanese animated title is Anime rather than Animation (2026-08-30), and the
  // predicate needs the language as well as the genres. A season inherits its show's,
  // which is why the parent embed takes it too.
  'media_items(kind, title, season_number, release_date, poster_path, genres, ' +
  'original_language, certification, runtime_minutes, episode_count, ' +
  'parent:parent_id(title, genres, original_language, certification)), ' +
  'profiles:actor_id(username, display_name, avatar_path)';

/**
 * Where the next page begins, taken from the **raw row** rather than the hydrated item.
 *
 * That distinction is load-bearing. `hydrate` drops a row whose actor cannot be named, so
 * a cursor built from the items would rewind past every dropped row and serve the tail of
 * the page a second time.
 *
 * The two fallbacks are for a bundle reading a database written before 20260901000100.
 * Both columns are `not null` today; the fallbacks exist so such a row produces a cursor
 * rather than `undefined` in a filter.
 */
function cursorFor(row: FeedRow): FeedCursor {
  return {
    causalAt: row.causal_at ?? row.created_at,
    causalStep: row.causal_step ?? 0,
    id: row.id,
  };
}

/**
 * "Strictly after this row, in the feed's order", as one PostgREST `or`.
 *
 * The lexicographic expansion of `(causal_at desc, causal_step desc, id asc)`, written
 * out because PostgREST has no row-value comparison. Read down it: an older instant; or
 * the same instant and an earlier step; or the same instant and the same step, and a
 * later id. Every remaining row satisfies exactly one branch, which is what makes this
 * boundary neither skip a row nor repeat one — and the `id` branch is what makes it
 * total across the three rows one ranking writes in a single transaction.
 *
 * The timestamp is quoted so PostgREST takes it whole. It holds no comma and no
 * parenthesis, so it cannot break out of the `and(...)` grouping either way.
 */
function keyset(cursor: FeedCursor): string {
  const at = `"${cursor.causalAt}"`;
  return [
    `causal_at.lt.${at}`,
    `and(causal_at.eq.${at},causal_step.lt.${cursor.causalStep})`,
    `and(causal_at.eq.${at},causal_step.eq.${cursor.causalStep},id.gt.${cursor.id})`,
  ].join(',');
}

/**
 * One page of activity, hydrated, with the cursor for the next one.
 *
 * The loop is here for a single case and is bounded because of it: `hydrate` drops rows,
 * so a page can come back full from the server and empty after hydration. Returning that
 * as it stands would end the feed on a page of nothing — `hasNextPage` would still be
 * true, but a page that adds no rows adds no scroll, and so nothing would ever ask for
 * the one after it. Four reads is far past anything a healthy database produces (a
 * dropped row means a broken join, or a policy hiding a row it should not), and the bound
 * is what stops a pathological account spinning here.
 */
async function activityPage(
  actorIds: string[],
  limit: number,
  cursor: FeedCursor | null,
): Promise<FeedPage> {
  if (!actorIds.length) return { items: [], cursor: null };

  const items: FeedItem[] = [];
  let next = cursor;
  for (let read = 0; read < 4; read += 1) {
    const rows = await activityRows(actorIds, limit, next);
    // A short page is the end of the feed, and it is the only end signal there is:
    // asking for one row more than needed, to find out, would cost a round trip on
    // every page to save one at the very last.
    next = rows.length === limit ? cursorFor(rows[rows.length - 1] as FeedRow) : null;
    items.push(...(await hydrate(rows)));
    if (items.length || !next) break;
  }
  return { items, cursor: next };
}

/** The shared read. `actorIds` is a filter, never the authorisation. */
async function activityRows(
  actorIds: string[],
  limit: number,
  cursor: FeedCursor | null,
): Promise<FeedRow[]> {
  const rows = supabase.from('feed_events').select(ACTIVITY_SELECT);

  const { data, error } = await (cursor ? rows.or(keyset(cursor)) : rows)
    .in('actor_id', actorIds)
    .in('type', [...ACTIVITY_TYPES])
    /**
     * **Three keys, and the last two are what make one action read in order**
     * (20260901000100, corrected 20260902000100).
     *
     * Ranking a film can complete a goal and earn an award, and all three rows have to
     * sit together in one place and in one order. Two different reasons, which is why
     * one key was not enough:
     *
     *   - **an award is written in the ranking's own transaction**, so `created_at` —
     *     which defaults to `now()`, and `now()` is transaction time — is identical to
     *     the microsecond. On a single sort key the order was then whatever the plan
     *     returned, and it moved between refetches and across page boundaries.
     *     `causal_step` is the writers stating it: 0 the act, 1 the goal it
     *     completed, 2 and up the awards it earned.
     *   - **a goal is not.** It is completed by a watch date, `log_watched` posts no
     *     activity of its own, and the completion commits seconds *after* the ranking.
     *     That is a real later timestamp and no tiebreak can reach it, so the row
     *     carries `causal_at`: its own instant, except that a completion inherits the
     *     timestamp of the activity it belongs under, which is what keeps the group
     *     together. `created_at` is untouched and is still what `relativeTime` draws.
     *
     * **`causal_step` DESCENDS, and that is the 2026-08-30 correction.** It ascended,
     * which put the ranking at the top of its own group and the award it earned beneath
     * it. This feed is **reverse chronological**: the award happened *after* the ranking
     * that earned it, so newest-first puts it *above*.
     *
     *     Suraj earned the Hitchhiker award       causal_step 2 -- the later event
     *     Suraj ranked Fullmetal Alchemist, S1    causal_step 0 -- the act that caused it
     *
     * The earlier pass reasoned "cause before consequence", which is the right order for
     * a sentence and the wrong one for a list read newest downwards. Descending states
     * the same causal fact -- a higher step is a later event -- in the direction the list
     * is actually read, and two awards earned by one action keep the fixed order
     * `_maybe_award_unlocks` gave them.
     *
     * `id` last makes the sort **total** — it is a primary key — which is what
     * pagination and refetch need. Two rows the first two keys cannot separate would
     * otherwise be free to swap between pages and drop or duplicate an activity.
     */
    .order('causal_at', { ascending: false })
    .order('causal_step', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw error;

  return (data ?? []) as unknown as FeedRow[];
}

/**
 * One activity, by its id.
 *
 * Exists for the comment-thread page, and it cannot be expressed as a filter over
 * `activityBy`: a notification is about the reader's **own** activity, which never
 * appears in their own feed — the feed spans the people they follow. Filtering a list
 * that structurally cannot contain the row is how the old routing concluded there was no
 * per-event surface to send anybody to.
 *
 * **The authorisation is `feed_events_read`, which is `can_i_view(actor_id)`, and nothing
 * here adds to it.** A row the caller may not see simply does not come back, and the
 * caller renders "This conversation is no longer available." That is the same silence a
 * deleted event gives, which is what stops a notification deep link confirming that a
 * particular activity exists on an account that has since gone private.
 *
 * `.limit(1)` and not `.single()`: `single()` treats no rows as an *error*, and an
 * unavailable conversation is an ordinary outcome on this path rather than a fault.
 */
async function oneActivity(eventId: string): Promise<FeedItem | null> {
  const { data, error } = await supabase
    .from('feed_events')
    .select(ACTIVITY_SELECT)
    .eq('id', eventId)
    .in('type', [...ACTIVITY_TYPES])
    .limit(1);
  if (error) throw error;

  const items = await hydrate((data ?? []) as unknown as FeedRow[]);
  return items[0] ?? null;
}

/**
 * The activity a comment notification is about, with its note and companions.
 *
 * Keyed by the viewer as well as the event, like every viewer-relative key in this app:
 * what a reader may see of one activity genuinely differs between accounts, and a key
 * without the account serves one reader another's answer after a switch on a shared
 * device (reviews 6, 10 and 10b).
 */
export function useActivityEvent(eventId: string | null, viewerId: string) {
  return useQuery({
    queryKey: ['activity-event', viewerId, eventId],
    enabled: Boolean(eventId),
    queryFn: () => oneActivity(eventId as string),
  });
}

/**
 * The award a row is about, resolved once.
 *
 * A named helper rather than an inline ternary because `hydrate` reads it twice — for
 * the sentence's emphasised slot and for the row's own award object — and two inline
 * copies of the same condition are two places for the fallback chain to drift.
 */
function award(row: FeedRow): FeedItem['award'] {
  if (row.type !== 'award_earned' || !row.payload?.award || !row.payload?.tier) return null;
  const said = awardAnnouncement(
    {
      key: row.payload.award,
      tierKey: row.payload.tier,
      name: row.payload.award_name ?? null,
      tierLabel: row.payload.tier_label ?? null,
    },
    // The feed's own last resort. Its sentence is "Abisola earned the … award", where
    // "a new Award" would read as a title nobody has heard of.
    'bingd. Award',
  );
  return {
    key: row.payload.award,
    tierKey: row.payload.tier,
    title: said.title,
    achievement: said.achievement,
  };
}

/** Rows to items: the actor rule, the season naming, the notes and the companions. */
async function hydrate(rows: FeedRow[]): Promise<FeedItem[]> {
  const items: FeedItem[] = [];

  for (const row of rows) {
    const profile = one(row.profiles);
    const media = one(row.media_items);

    // An activity item whose subject is "Someone" is not an activity item.
    // An unresolvable actor means a failed join or a policy hiding a row
    // that should be visible, and absorbing that behind a plausible
    // fallback is what let the bug above survive to a screenshot. A feed
    // with three items is honest; five, two of them about nobody, is not.
    const actorName = profile?.display_name || profile?.username;
    if (!actorName) continue;

    // Resolved once, here, against the parent embed above. `productGenres` is the
    // same helper the title page and the collection filter use, so a season's genres
    // mean one thing across the app rather than "whatever this query happened to
    // select" -- and an anime season reads Anime on every one of them.
    const parent = media ? one(media.parent) : null;
    const subject = media
      ? {
          kind: media.kind,
          genres: media.genres,
          language: media.original_language,
          certification: media.certification,
          parent: parent
            ? {
                genres: parent.genres,
                language: parent.original_language,
                certification: parent.certification,
              }
            : null,
        }
      : null;

    items.push({
      id: row.id,
      type: row.type as FeedItem['type'],
      actorId: row.actor_id,
      actorUsername: profile?.username ?? '',
      actorName,
      actorAvatarUri: avatarUri(profile?.avatar_path),
      mediaItemId: row.media_item_id,
      kind: media?.kind ?? null,
      // For an award the "title" is the award's name — the sentence slot is the
      // same slot, and "Abisola earned Movie Muncher" is the founder's copy.
      title: media
        ? compactName({
            kind: media.kind,
            title: media.title,
            seriesTitle: parent?.title ?? null,
            seasonNumber: media.season_number,
          })
        : row.type === 'award_earned'
          ? // The earned tier, resolved from `tracks.ts`. `awardAnnouncement` falls back
            // to the payload's names and finally to "bingd. Award", so this slot is never
            // a track key and never empty.
            (award(row)?.title ?? 'bingd. Award')
          : // And for a goal it is the goal's own name, so the sentence reads
            // "Abisola hit their 2026 Movies goal" through the same three slots.
            row.type === 'goal_completed' && row.payload?.year && row.payload?.category
            ? `${row.payload.year} ${GOAL_LABEL[row.payload.category]} goal`
            : null,
      year: media?.release_date ? Number(media.release_date.slice(0, 4)) : null,
      posterPath: media?.poster_path ?? null,
      genres: subject ? productGenres(subject) : [],
      certification: subject ? effectiveCertification(subject) : null,
      runtimeMinutes: media?.runtime_minutes ?? null,
      episodeCount: media?.episode_count ?? null,
      createdAt: row.created_at,
      position: row.payload?.position ?? null,
      score: row.payload?.score ?? null,
      bucket: row.payload?.bucket ?? null,
      category: row.payload?.category ?? null,
      note: null,
      companions: [],
      award: award(row),
      goal:
        row.type === 'goal_completed' && row.payload?.year && row.payload?.category
          ? {
              year: Number(row.payload.year),
              category: row.payload.category,
              target: Number(row.payload.target ?? 0),
            }
          : null,
    });
  }

  /**
   * Notes and companions attach to activities about having *watched* the thing, and
   * to no others.
   *
   * Both are matched on (actor, media item) rather than on event id, deliberately and
   * for good reasons documented below — a note is read live so its author can retract
   * it, a tag is read live so the tagged person can withdraw it. The cost of that key
   * is that it cannot tell one of an actor's events about a title from another, so a
   * `watchlist_added` row for a film its actor later watched would inherit the review
   * and the companions of the watching. "Suraj added Dune to their watchlist with
   * Anna", under a note calling it the best thing he saw all year.
   *
   * Filtering the input is the whole fix, and it also narrows the two queries.
   */
  const watched = items.filter((item) => isWatchActivity(item.type));
  await Promise.all([attachNotes(watched), attachCompanions(watched)]);
  return items;
}

/**
 * Public notes for the events just read, in one round trip.
 *
 * `public_notes` takes both filters and applies them together, so this asks for
 * "notes by these authors on these titles" and matches the pairs up here. The
 * cross-product is a superset of what is wanted and every row in it is one the
 * caller may read, so the only cost is a few rows that find no home.
 *
 * A failure here is swallowed rather than propagated. A note is an enrichment of an
 * activity item; losing the whole feed because the note read failed would trade a
 * small absence for a total one.
 */
async function attachNotes(items: FeedItem[]) {
  const authors = [...new Set(items.map((item) => item.actorId))];
  const titles = [...new Set(items.map((item) => item.mediaItemId).filter(Boolean))] as string[];
  if (!authors.length || !titles.length) return;

  const { data, error } = await supabase.rpc('public_notes', {
    p_user_ids: authors.slice(0, 50),
    p_media_item_ids: titles.slice(0, 50),
    p_limit: 100,
  });
  if (error || !data) return;

  const byPair = new Map<string, FeedNote>();
  for (const row of data as NoteRow[]) {
    byPair.set(`${row.user_id}:${row.media_item_id}`, {
      text: row.note,
      hasSpoilers: row.has_spoilers,
    });
  }

  for (const item of items) {
    if (!item.mediaItemId) continue;
    item.note = byPair.get(`${item.actorId}:${item.mediaItemId}`) ?? null;
  }
}

/**
 * Watch tags for the events just read, in one round trip.
 *
 * A plain select rather than an RPC: `watch_tags_read` resolves through
 * `watch_tag_visible(id)`, which already folds the block, the tagged person's removal
 * and the tagger's profile visibility into one answer. A tag this viewer may not see
 * simply does not come back, and nothing here has to know why.
 *
 * Swallowed on failure for the same reason the notes are — a companion line is an
 * enrichment, and losing the feed over one is a bad trade.
 */
async function attachCompanions(items: FeedItem[]) {
  const taggers = [...new Set(items.map((item) => item.actorId))].slice(0, 50);
  const titles = [
    ...new Set(items.map((item) => item.mediaItemId).filter(Boolean)),
  ].slice(0, 50) as string[];
  if (!taggers.length || !titles.length) return;

  const { data, error } = await supabase
    .from('watch_tags')
    .select('tagger_id, media_item_id, profiles:tagged_id(display_name, username)')
    .in('tagger_id', taggers)
    .in('media_item_id', titles)
    // Belt as well as braces: `watch_tag_visible` already hides a withdrawn tag from
    // everyone, so this filter changes no result. It is here so that a reader of
    // this query does not have to know that to know the list is the live one.
    .eq('removed_by_tagger', false);
  if (error || !data) return;

  const byPair = new Map<string, string[]>();
  for (const row of data as unknown as CompanionRow[]) {
    const profile = one(row.profiles);
    const name = profile?.display_name || profile?.username;
    if (!name) continue;
    const key = `${row.tagger_id}:${row.media_item_id}`;
    byPair.set(key, [...(byPair.get(key) ?? []), name]);
  }

  for (const item of items) {
    if (!item.mediaItemId) continue;
    item.companions = byPair.get(`${item.actorId}:${item.mediaItemId}`) ?? [];
  }
}
