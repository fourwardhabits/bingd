/**
 * Deterministic large-data rows, for testing a surface at the size a real account reaches
 * before a real account finds the ceiling (2026-09-16).
 *
 * Every defect in the pre-outreach reliability passes was invisible at fixture sizes of
 * three: a 688-title Collection that mounted every tile, a Feed read whose URL outgrew what
 * the gateway accepts, a count that PostgREST cut at 1,000 without an error. So these build
 * hundreds or thousands of rows in the shapes the client reads, with no randomness: the
 * same call gives the same ids in the same order, and a failure reproduces.
 *
 * Pair them with `createPostgrest()` and turn on what a deployment really has:
 *
 *   client.tables.reactions = reactionsOn(eventIds(400), 3);
 *   client.maxRows = 1000;
 *   client.maxInList = MEASURED_IN_LIST_CEILING;
 *
 * Test-only. Nothing here seeds a real project; `supabase/tests` owns database-side scale
 * (`perf/import-scale.mjs`), and no fixture should ever be pointed at production.
 */

/** A UUID-shaped id that sorts in creation order within a namespace. */
export const idAt = (namespace: number, index: number) =>
  `00000000-0000-4000-8${String(namespace).padStart(3, '0')}-${String(index).padStart(12, '0')}`;

const NS = {
  user: 1,
  media: 2,
  event: 3,
  notification: 4,
} as const;

/** An instant `index` minutes before a fixed epoch, so newest-first is index order. */
const minutesBefore = (index: number) =>
  new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString();

export const userIds = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => idAt(NS.user, from + i));

export const mediaIds = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => idAt(NS.media, from + i));

export const eventIds = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => idAt(NS.event, from + i));

const media = (index: number) => ({
  title: `Title ${index}`,
  season_number: null,
  release_date: `${1950 + (index % 75)}-01-01`,
  poster_path: `/poster-${index}.jpg`,
  genres: [['Drama', 'Comedy', 'Thriller', 'Horror'][index % 4]],
  runtime_minutes: 90 + (index % 60),
  kind: 'movie',
  original_language: 'en',
  parent_id: null,
  parent: null,
});

const BANDS = ['loved', 'fine', 'not_for_me'] as const;

/** `rankings` rows for one category, positions 1..count, bands in thirds. */
export const rankedLibrary = (userId: string, count: number, category = 'movies') =>
  mediaIds(count).map((id, i) => ({
    user_id: userId,
    media_item_id: id,
    category,
    position: i + 1,
    bucket: BANDS[Math.min(2, Math.floor((i * 3) / count))],
    created_at: minutesBefore(i),
    media_items: media(i),
  }));

/** `user_media` rows, the Logged collection. */
export const loggedLibrary = (userId: string, count: number) =>
  mediaIds(count).map((id, i) => ({
    user_id: userId,
    media_item_id: id,
    bucket: BANDS[i % 3],
    watched_on: null,
    created_at: minutesBefore(i),
    media_items: media(i),
  }));

/** `watchlist` rows, newest first. */
export const watchlistRows = (userId: string, count: number) =>
  mediaIds(count, 100_000).map((id, i) => ({
    user_id: userId,
    media_item_id: id,
    created_at: minutesBefore(i),
    media_items: media(100_000 + i),
  }));

/** Approved `follows` rows, `userId` following `count` people (or followed by them). */
export const followRows = (
  userId: string,
  count: number,
  direction: 'following' | 'followers' = 'following',
) =>
  userIds(count, 10_000).map((other, i) => ({
    follower_id: direction === 'following' ? userId : other,
    followee_id: direction === 'following' ? other : userId,
    state: 'approved',
    created_at: minutesBefore(i),
  }));

/** `feed_events` rows spread across `actors`, newest first. */
export const feedEventRows = (count: number, actors: readonly string[]) =>
  eventIds(count).map((id, i) => ({
    id,
    actor_id: actors[i % actors.length],
    type: 'title_ranked',
    media_item_id: idAt(NS.media, i % 5_000),
    created_at: minutesBefore(i),
    causal_at: minutesBefore(i),
    causal_step: 0,
  }));

/** `reactions` rows: `perEvent` distinct reactors on every event. */
export const reactionsOn = (events: readonly string[], perEvent: number) =>
  events.flatMap((eventId) =>
    userIds(perEvent, 50_000).map((userId, i) => ({
      feed_event_id: eventId,
      user_id: userId,
      kind: 'love',
      profiles: {
        id: userId,
        display_name: `Reactor ${i}`,
        username: `reactor${i}`,
        avatar_path: null,
      },
    })),
  );

/** `my_notifications` rows, newest first. */
export const notificationRows = (count: number, actors: readonly string[]) =>
  Array.from({ length: count }, (_, i) => ({
    id: idAt(NS.notification, i),
    kind: 'follow',
    created_at: minutesBefore(i),
    read_at: null,
    actor_id: actors[i % actors.length],
    actor_username: `actor${i % actors.length}`,
    actor_display_name: null,
    actor_avatar_path: null,
    media_item_id: null,
    media_title: null,
    media_kind: null,
    series_title: null,
    subject_type: null,
    subject_id: null,
    payload: null,
  }));
