import { useQuery } from '@tanstack/react-query';

import { GOAL_LABEL } from '@/features/goals/goals';
import type { Bucket } from '@/features/collection/score';
import { avatarUri } from '@/lib/images';
import { effectiveCertification, effectiveGenres } from '@/lib/media-metadata';
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
   * Keys resolve the badge through `badgeFor`; the names are the payload's
   * snapshot, so a row renders even if this bundle predates a future track. The
   * award's display name rides in `title`, which is what makes the sentence read
   * "Abisola earned Movie Muncher" through the ordinary grammar.
   */
  award: { key: string; tierKey: string; tierLabel: string | null } | null;
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
  certification: string | null;
};

type MediaShape = {
  kind: MediaKind;
  title: string;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
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

export function useFeed(userId: string) {
  return useQuery({
    queryKey: queryKeys.feed(userId),
    queryFn: async (): Promise<FeedItem[]> => {
      const { data: follows, error: followsError } = await supabase
        .from('follows')
        .select('followee_id')
        .eq('follower_id', userId)
        .eq('state', 'approved');
      if (followsError) throw followsError;

      return activityBy([userId, ...(follows ?? []).map((row) => row.followee_id)]);
    },
  });
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
    queryFn: () => activityBy([actorId as string], limit),
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
  'id, type, actor_id, media_item_id, created_at, payload, ' +
  // The parent series, so a season can be named — and, since the founder standardised
  // the subheading, so it can be described and rated too. A self-join through parent_id,
  // which PostgREST resolves as an embed like any other, and a left one: a movie comes
  // back with `parent: null`.
  'media_items(kind, title, season_number, release_date, poster_path, genres, ' +
  'certification, runtime_minutes, episode_count, ' +
  'parent:parent_id(title, genres, certification)), ' +
  'profiles:actor_id(username, display_name, avatar_path)';

/** The shared read. `actorIds` is a filter, never the authorisation. */
async function activityBy(actorIds: string[], limit = 30): Promise<FeedItem[]> {
  if (!actorIds.length) return [];

  const { data, error } = await supabase
    .from('feed_events')
    .select(ACTIVITY_SELECT)
    .in('actor_id', actorIds)
    .in('type', [...ACTIVITY_TYPES])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return hydrate((data ?? []) as unknown as FeedRow[]);
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

    // Resolved once, here, against the parent embed above. `effectiveGenres` is the
    // same helper the awards and the collection filter use, so a season's genres mean
    // one thing across the app rather than "whatever this query happened to select".
    const parent = media ? one(media.parent) : null;
    const subject = media
      ? {
          kind: media.kind,
          genres: media.genres,
          certification: media.certification,
          parent: parent
            ? { genres: parent.genres, certification: parent.certification }
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
          ? (row.payload?.award_name ?? 'a bingd. Award')
          : // And for a goal it is the goal's own name, so the sentence reads
            // "Abisola hit their 2026 Movies goal" through the same three slots.
            row.type === 'goal_completed' && row.payload?.year && row.payload?.category
            ? `${row.payload.year} ${GOAL_LABEL[row.payload.category]} goal`
            : null,
      year: media?.release_date ? Number(media.release_date.slice(0, 4)) : null,
      posterPath: media?.poster_path ?? null,
      genres: subject ? effectiveGenres(subject) : [],
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
      award:
        row.type === 'award_earned' && row.payload?.award && row.payload?.tier
          ? {
              key: row.payload.award,
              tierKey: row.payload.tier,
              tierLabel: row.payload.tier_label ?? null,
            }
          : null,
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
