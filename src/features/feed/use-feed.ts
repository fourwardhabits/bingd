import { useQuery } from '@tanstack/react-query';

import type { Bucket } from '@/features/collection/score';
import { avatarUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { compactName, type MediaKind } from '@/lib/titles';

export type FeedNote = {
  text: string;
  hasSpoilers: boolean;
};

export type FeedItem = {
  id: string;
  type: 'title_ranked' | 'title_logged' | 'season_completed';
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
  genres: string[];
  runtimeMinutes: number | null;
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
};

type Embedded<T> = T | T[] | null;

type ParentShape = { title: string | null };

type MediaShape = {
  kind: MediaKind;
  title: string;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  genres: string[] | null;
  runtime_minutes: number | null;
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

/** The shared read. `actorIds` is a filter, never the authorisation. */
async function activityBy(actorIds: string[], limit = 30): Promise<FeedItem[]> {
  if (!actorIds.length) return [];

  const { data, error } = await supabase
    .from('feed_events')
    .select(
      'id, type, actor_id, media_item_id, created_at, payload, ' +
        // The parent series, so a season can be named. A self-join through
        // parent_id, which PostgREST resolves as an embed like any other.
        'media_items(kind, title, season_number, release_date, poster_path, genres, ' +
        'runtime_minutes, ' +
        'parent:parent_id(title)), ' +
        'profiles:actor_id(username, display_name, avatar_path)',
    )
    .in('actor_id', actorIds)
    .in('type', ['title_ranked', 'title_logged', 'season_completed'])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as unknown as FeedRow[];

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

    items.push({
      id: row.id,
      type: row.type as FeedItem['type'],
      actorId: row.actor_id,
      actorUsername: profile?.username ?? '',
      actorName,
      actorAvatarUri: avatarUri(profile?.avatar_path),
      mediaItemId: row.media_item_id,
      kind: media?.kind ?? null,
      title: media
        ? compactName({
            kind: media.kind,
            title: media.title,
            seriesTitle: one(media.parent)?.title ?? null,
            seasonNumber: media.season_number,
          })
        : null,
      year: media?.release_date ? Number(media.release_date.slice(0, 4)) : null,
      posterPath: media?.poster_path ?? null,
      genres: media?.genres ?? [],
      runtimeMinutes: media?.runtime_minutes ?? null,
      createdAt: row.created_at,
      position: row.payload?.position ?? null,
      score: row.payload?.score ?? null,
      bucket: row.payload?.bucket ?? null,
      category: row.payload?.category ?? null,
      note: null,
      companions: [],
    });
  }

  await Promise.all([attachNotes(items), attachCompanions(items)]);
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
