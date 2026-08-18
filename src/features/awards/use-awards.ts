import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { awardsFor, type AwardProgress } from './progress';
import type { AwardFacts, WatchedTitle } from './tracks';

/**
 * Everything the twenty awards know about one reader, in one read.
 *
 * **Derived, never stored.** There is no unlock ledger, no achievement table and no
 * scheduler. An award is a question asked of canonical data at the moment somebody
 * opens the sheet, which is why this feature needed no migration and why an award
 * cannot drift out of step with the collection it describes. It also means an award
 * can go *down* — unlog a horror film and Scream Snack loses one — and that is correct:
 * the alternative is a badge that remembers a title the database says is gone.
 *
 * **Nine reads, seven of which are counts.** `head: true` with `count: 'exact'` asks
 * PostgREST for the number and none of the rows. Two come back with rows: the watched
 * collection, because seven tracks need the genres, the language and the year of every
 * title; and the follow edges, because mutuality is a property of a *pair* and cannot be
 * counted without intersecting both directions.
 *
 * **The follow embed is `follower:follower_id!inner(id)`, and the FK-column form is
 * deliberate.** PostgREST resolves an embed named for a foreign key column to that key's
 * target, which is `profiles` here, and `!inner` on it is a real inner join rather than
 * a hint it ignores. Independent review 20 read this as malformed and asked for
 * `profiles!follower_id`; it was checked against the deployed database instead of
 * argued about, and both forms return 200 while a genuinely unknown relationship returns
 * PGRST200. The inner join was confirmed separately: the same form over
 * `media_items.parent_id` returns only seasons, which is what an inner join does and
 * what an ignored hint would not.
 *
 * **Row level security is the authorization and nothing here repeats it.** Every one of
 * these tables is already scoped: `user_media`, `watchlist` and `rankings` to the owner;
 * `title_recommendations` to its two parties; `invite_link_creations` to its inviter;
 * `comments` and `reactions` to what the caller may see. This asks for its own rows and
 * the database decides what that means.
 */
async function readFacts(userId: string): Promise<AwardFacts> {
  const [
    watched,
    ranked,
    watchlist,
    invites,
    comments,
    notes,
    recommendations,
    reactions,
    follows,
  ] = await Promise.all([
    supabase
      .from('user_media')
      .select('media_item_id, media_items(kind, genres, original_language, release_date)')
      .eq('user_id', userId),

    supabase.from('rankings').select('media_item_id', { count: 'exact', head: true }).eq('user_id', userId),

    supabase.from('watchlist').select('media_item_id', { count: 'exact', head: true }).eq('user_id', userId),

    supabase
      .from('invite_link_creations')
      .select('id', { count: 'exact', head: true })
      .eq('inviter_id', userId),

    supabase.from('comments').select('id', { count: 'exact', head: true }).eq('author_id', userId),

    // A note is one row on `user_media` and it appears on two surfaces — the activity
    // row and Bingd Reviews. Counted once, here, and only when it is public: a private
    // note is not social content and Comment Gremlin is an award for talking to people.
    supabase
      .from('user_media')
      .select('media_item_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .not('note', 'is', null)
      .eq('note_visibility', 'public'),

    supabase
      .from('title_recommendations')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId),

    // Reactions on the reader's own activity, from anybody but the reader.
    // `neq('user_id', userId)` is the self-reaction rule and it is stated here because
    // the database has no opinion about it: reacting to your own row is allowed, it is
    // simply not an award for being liked.
    supabase
      .from('reactions')
      .select('feed_event_id, feed_events!inner(actor_id)', { count: 'exact', head: true })
      .eq('feed_events.actor_id', userId)
      .neq('user_id', userId),

    // Mutual follows, and this one cannot be a count: mutuality is a property of a
    // pair, so both directions have to arrive and be intersected. The two embeds are
    // the filter — each resolves through the foreign key to `profiles`, whose policy is
    // `can_i_view(id)`, so an inner join drops a suspended or unreachable account
    // rather than this code having to know what "unreachable" means. A block deletes
    // the follow rows on both sides (`block`, 20260813001700), so a blocked pair has
    // nothing left to intersect.
    supabase
      .from('follows')
      .select('follower_id, followee_id, state, follower:follower_id!inner(id), followee:followee_id!inner(id)')
      .eq('state', 'approved')
      .or(`follower_id.eq.${userId},followee_id.eq.${userId}`),
  ]);

  if (watched.error) throw watched.error;

  const rows = (watched.data ?? []) as unknown as {
    media_item_id: string;
    media_items:
      | { kind: string; genres: string[] | null; original_language: string | null; release_date: string | null }
      | { kind: string; genres: string[] | null; original_language: string | null; release_date: string | null }[]
      | null;
  }[];

  const titles: WatchedTitle[] = [];
  for (const row of rows) {
    const media = Array.isArray(row.media_items) ? row.media_items[0] : row.media_items;
    // A series cannot be logged, so this should never fire — but an award that counted
    // one would be counting a thing nobody watched, and PRD §10 is explicit that the
    // rankable and watchable unit is the season.
    if (!media || (media.kind !== 'movie' && media.kind !== 'season')) continue;
    titles.push({
      mediaItemId: row.media_item_id,
      kind: media.kind,
      genres: media.genres ?? [],
      language: media.original_language ?? null,
      year: media.release_date ? Number(media.release_date.slice(0, 4)) : null,
    });
  }

  /**
   * Which fields could not be read, so a failure is never dressed up as a zero.
   *
   * Independent review 20's finding, and the founder's Phase 7 instruction, are the
   * same instruction: an award that cannot be calculated reliably says so. A failed
   * count rendered as 0 is the app making a statement about the reader — you have sent
   * no recommendations — on the strength of a request that never came back.
   *
   * Still per-field rather than fatal. Losing Mutual Mania to a network blip should
   * not cost somebody the nineteen awards that did load; only `watched` throws, above,
   * because seven tracks are meaningless without it.
   */
  const unavailable = new Set<keyof AwardFacts>();
  const count = (result: { count: number | null; error: unknown }, field: keyof AwardFacts) => {
    if (result.error) unavailable.add(field);
    return result.count ?? 0;
  };

  // Two reads, one number. Either failing makes the number wrong rather than small.
  const written = count(comments, 'writtenCount') + count(notes, 'writtenCount');

  return {
    watched: titles,
    rankedCount: count(ranked, 'rankedCount'),
    watchlistCount: count(watchlist, 'watchlistCount'),
    invitesCreated: count(invites, 'invitesCreated'),
    writtenCount: written,
    recommendationsSent: count(recommendations, 'recommendationsSent'),
    reactionsReceived: count(reactions, 'reactionsReceived'),
    mutualFollows: follows.error
      ? (unavailable.add('mutualFollows'), 0)
      : mutualFollowCount(follows.data as FollowRow[] | null, userId),
    unavailable,
  };
}

type FollowRow = { follower_id: string; followee_id: string };

/**
 * How many people follow the reader back.
 *
 * The rows are every approved edge the reader is an end of, in both directions. A
 * mutual is an id that appears on both sides. Counted from a set intersection rather
 * than from two queries, because two queries can be answered a second apart and a
 * follow that lands between them makes the number wrong in a way nothing can detect.
 */
export function mutualFollowCount(rows: FollowRow[] | null | undefined, userId: string): number {
  const following = new Set<string>();
  const followers = new Set<string>();
  for (const row of rows ?? []) {
    if (row.follower_id === userId) following.add(row.followee_id);
    if (row.followee_id === userId) followers.add(row.follower_id);
  }
  let mutual = 0;
  for (const id of following) {
    // Never yourself. `follow` refuses a self-follow, so this is belt and braces
    // rather than a live case.
    if (id !== userId && followers.has(id)) mutual += 1;
  }
  return mutual;
}

export type AwardsQuery = {
  awards: AwardProgress[];
  facts: AwardFacts;
};

/**
 * The awards for one account.
 *
 * `staleTime` is a minute. Awards move when the reader watches, ranks or is reacted to,
 * and all three of those already invalidate the collection keys this shares a screen
 * with; a minute is short enough that reopening the sheet after logging a film shows
 * the new number, and long enough that scrolling out and back does not refetch nine
 * things.
 */
export function useAwards(userId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['awards', userId],
    enabled: (options.enabled ?? true) && Boolean(userId),
    staleTime: 60_000,
    queryFn: async (): Promise<AwardsQuery> => {
      const facts = await readFacts(userId);
      return { facts, awards: awardsFor(facts) };
    },
  });
}
