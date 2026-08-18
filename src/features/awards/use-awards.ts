import { useQuery } from '@tanstack/react-query';

import { bandSizes, scoreFor, type Bucket } from '@/features/collection/score';
import { resolveMetadata, type EmbeddedParent } from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';

import { awardsFor, type AwardProgress } from './progress';
import type {
  AwardFacts,
  ContributionKind,
  PersonRef,
  ReactedItem,
  RecommendationSent,
  WatchedTitle,
  WrittenContribution,
} from './tracks';

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
 * **Rows, not counts, and that is the change of this pass.** Every fact used to arrive
 * as `head: true` with `count: 'exact'` — the number and none of the rows — which was
 * cheap and made a drill-down impossible: a second query written to explain the first
 * is a second query that can disagree with it. Now each read returns the rows, the
 * count *is* their length, and the breakdown behind a row is the same array the metric
 * measured. One source of truth, structurally rather than by discipline
 * (`tracks.ts`, `contributions`).
 *
 * The cost is bounded by what the awards are about: the reader's own collection, their
 * own rankings and watchlist, what they wrote, what they sent, and the reactions and
 * follows pointed at them. The watched collection was already being read in full for
 * the thirteen tracks that need genres, so the shape of this was never a count anyway.
 *
 * **Seasons inherit their series' metadata here**, through the same resolver the
 * collection uses (`lib/media-metadata.ts`). Before this pass a season carried no
 * genres and no language at all, so nine of the twenty tracks were quietly movie-only
 * and `The Last of Us, S1` counted toward nothing but Season Snacker.
 *
 * **Row level security is the authorization and nothing here repeats it.** Every one of
 * these tables is already scoped: `user_media`, `watchlist` and `rankings` to the owner;
 * `title_recommendations` and `invite_attributions` to their two parties; `comments`,
 * `reactions` and `profiles` to what the caller may see. This asks for its own rows and
 * the database decides what that means — which is also why a drill-down cannot show
 * more than the count already counted.
 */

/** The columns every media embed on this screen needs, in one place. */
const MEDIA = [
  'kind',
  'title',
  'season_number',
  'poster_path',
  'release_date',
  'genres',
  'original_language',
  'parent:parent_id(title, genres, original_language)',
].join(', ');

/**
 * Mutual Mania's read, and the `!inner` on it is the privacy control.
 *
 * Mutuality is a property of a pair, so both directions have to arrive and be
 * intersected — this cannot be a count. Which makes the question "who is allowed to be
 * in the intersection", and the answer is not in this file: each embed resolves through
 * the foreign key to `profiles`, whose policy is `can_i_view(id)`, so **an inner join
 * drops a suspended or otherwise unreachable account** rather than this code having to
 * know what "unreachable" means.
 *
 * **The two `!inner`s are load-bearing and were measured, not assumed.** `follows_read`
 * admits any row the caller is an end of, so it does no filtering here whatsoever — the
 * embeds are the only thing standing between a suspended account and Mutual Mania's
 * numerator. Drop them and the join becomes a left join: the row still arrives, with
 * `followee: null`, `personFrom` renders it "Someone on Bingd", and it **still counts**.
 * That exact contrast is probed against the deployed database in
 * `supabase/tests/award-privacy.mjs`, which reads this constant out of this file so that
 * removing an `!inner` fails a test rather than quietly widening a count.
 *
 * The other two eligibility conditions need nothing here, and it is worth saying why:
 * a **block** deletes the follow rows in both directions (`block`, 20260817000200), and
 * a **deleted** account takes them with it (`follows.follower_id references profiles on
 * delete cascade`). Neither leaves anything to intersect.
 */
export const FOLLOWS_SELECT =
  'follower_id, followee_id, state, ' +
  'follower:follower_id!inner(id, username, display_name, avatar_path), ' +
  'followee:followee_id!inner(id, username, display_name, avatar_path)';

type MediaRow = {
  kind: string;
  title: string | null;
  season_number: number | null;
  poster_path: string | null;
  release_date: string | null;
  genres: string[] | null;
  original_language: string | null;
  parent?: EmbeddedParent;
};

/** PostgREST returns a to-one embed as an object and types it as an array. */
const one = <T>(value: T | T[] | null | undefined): T | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * How many rows one request may return, and how many requests one fact may take.
 *
 * **PostgREST silently caps an unbounded select**, and this was measured against
 * bingd-nonprod rather than assumed: `media_items` holds 2,835 rows, a select with no
 * range returns exactly 1,000, and the only sign of it is a `Content-Range: 0-999/*`
 * header that supabase-js discards. No error, no flag, no short read — just a shorter
 * array than the truth.
 *
 * That is a wrong number rather than a slow one, and it lands exactly where it hurts
 * most: **Movie Muncher's gold tier is 1,000 movies.** A collection of 1,000 films and
 * any television at all puts `user_media` past the cap, so the read comes back short and
 * the award reports a number below the tier the reader has actually reached — a badge
 * they have earned and cannot unlock, for a reason nothing on the screen could explain.
 * Heart Magnet and Mutual Mania fail the same way on a popular account.
 *
 * So every fact is paged to exhaustion. A page shorter than `PAGE_ROWS` is the end;
 * anything else asks for the next one.
 *
 * **The ceiling exists so this can never quietly lie again.** Twelve pages is 12,000
 * rows, far past any real collection. Hitting it does not truncate — it returns an error,
 * which `rowsOf` turns into the `unavailable` state review 20 established, so the row
 * draws "Could not load this one" and a dash instead of a confident wrong number. A cap
 * that degrades into a plausible figure is the defect this comment exists about.
 */
const PAGE_ROWS = 1000;
const MAX_PAGES = 12;

type PageResult = { data: unknown; error: unknown };
type Paged = (from: number, to: number) => PromiseLike<PageResult>;

/**
 * One fact, however many requests it takes.
 *
 * Takes a factory rather than a query because a supabase-js builder is single-use: it is
 * a thenable that issues its request on the first `await`, so the same object cannot ask
 * for a second page.
 */
async function readAll(page: Paged): Promise<PageResult> {
  const rows: unknown[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_ROWS;
    const result = await page(from, from + PAGE_ROWS - 1);
    if (result.error) return { data: null, error: result.error };

    const batch = (result.data ?? []) as unknown[];
    rows.push(...batch);
    // Short page means the end. Equality means there may be more, including the exact
    // case where the total is a multiple of the page size — which costs one empty
    // request and is the price of not guessing.
    if (batch.length < PAGE_ROWS) return { data: rows, error: null };
  }
  return {
    data: null,
    error: {
      code: 'BINGD_TOO_MANY_ROWS',
      message: `More than ${MAX_PAGES * PAGE_ROWS} rows; refusing to report a partial count.`,
    },
  };
}

/** A media row as the awards need it, with a season's inheritance applied. */
function titleFrom(mediaItemId: string, media: MediaRow | null): WatchedTitle | null {
  // A series cannot be logged, ranked or watchlisted — `_assert_loggable` refuses one —
  // so this should never fire. An award that counted one would be counting a thing
  // nobody watched, and PRD §10 is explicit that the unit is the season.
  if (!media || (media.kind !== 'movie' && media.kind !== 'season')) return null;

  const meta = resolveMetadata({
    kind: media.kind,
    genres: media.genres,
    original_language: media.original_language,
    parent: media.parent ?? null,
  });

  return {
    mediaItemId,
    kind: media.kind,
    title: media.title ?? '',
    seriesTitle: meta.seriesTitle,
    seasonNumber: media.season_number ?? null,
    posterPath: media.poster_path ?? null,
    genres: meta.genres,
    language: meta.language,
    year: media.release_date ? Number(media.release_date.slice(0, 4)) : null,
    watchedOn: null,
  };
}

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_path: string | null;
};

/**
 * A person, or the honest absence of one.
 *
 * A plain embed onto `profiles` is filtered by `can_i_view`, so an account that has
 * blocked the reader, or been suspended, is returned as `null` rather than omitted. For
 * a **historical** fact that must not silently shrink — the recommendation *was* sent,
 * the invitee *did* join — a missing profile becomes a row that says so rather than no
 * row at all. Nothing about the hidden account is disclosed, including whether it ever
 * existed.
 *
 * **This fallback is for history, and Mutual Mania deliberately does not use it.** A
 * mutual follow is a claim about the present: "you and this person follow each other".
 * A suspended account is not a current mutual, so it must leave the count and not merely
 * lose its name — which is why that one read uses `!inner` (`FOLLOWS_SELECT`) and reaches
 * this function only for pairs that are genuinely eligible. Applying the present-tense
 * rule to the historical counts would be the mirror defect: a recommendation you sent
 * last month did not un-happen because the recipient was suspended today.
 */
const personFrom = (id: string, profile: ProfileRow | null): PersonRef =>
  profile?.username
    ? {
        id,
        name: profile.display_name?.trim() || profile.username,
        username: profile.username,
        avatarPath: profile.avatar_path,
      }
    : { id, name: 'Someone on Bingd', username: null, avatarPath: null };

async function readFacts(userId: string): Promise<AwardFacts> {
  const [watched, ranked, watchlist, invites, comments, recommendations, reactions, follows] =
    await Promise.all([
      /**
       * The collection, with everything thirteen tracks need on it.
       *
       * `watched_on` is here for the drill-down — Movie Muncher and Season Snacker show
       * the date beside a title — and `note`/`note_visibility` because a public note is
       * one of the two things Comment Gremlin counts. Reading them here rather than in a
       * second query is what makes double-counting impossible: one row is one
       * contribution, and the same row is the one Movie Muncher counted.
       */
      readAll((from, to) =>
        supabase
          .from('user_media')
          .select(`media_item_id, watched_on, note, note_visibility, media_items(${MEDIA})`)
          .eq('user_id', userId)
          // Ordered because a paged read without one is not a read of anything: the
          // database may return rows in any order per request, so page two could repeat
          // page one's rows and omit others entirely. The primary key is the cheap
          // stable tiebreak every one of these tables has.
          .order('media_item_id', { ascending: true })
          .range(from, to),
      ),

      // Bucket and position come too, so Rating Rascal's drill-down can show the score
      // the reader actually gave — which is derived from the band, not stored.
      readAll((from, to) =>
        supabase
          .from('rankings')
          .select(`media_item_id, bucket, position, category, media_items(${MEDIA})`)
          .eq('user_id', userId)
          .order('media_item_id', { ascending: true })
          .range(from, to),
      ),

      readAll((from, to) =>
        supabase
          .from('watchlist')
          .select(`media_item_id, media_items(${MEDIA})`)
          .eq('user_id', userId)
          // `created_at` is not unique, so on its own it is a page boundary that can drop
          // or repeat a row when several land in the same instant. The key breaks the tie.
          .order('created_at', { ascending: false })
          .order('media_item_id', { ascending: true })
          .range(from, to),
      ),

      /**
       * People who joined on this reader's invitation, not links they made.
       *
       * The founder's correction of 2026-08-18, unchanged by this pass: it counts
       * `invite_attributions` where `activated_at` is set. **Nothing writes that column
       * yet** — there is no link resolver, `app/i/[token].tsx` is a placeholder, and no
       * migration inserts an attribution — so this is a true zero rather than a missing
       * read, and the drill-down is honestly empty. See
       * `docs/product/growth-instrumentation.md` §1 for the five pieces Beta Hardening
       * owes it.
       */
      readAll((from, to) =>
        supabase
          .from('invite_attributions')
          .select('invitee_id, activated_at, invitee:invitee_id(id, username, display_name, avatar_path)')
          .eq('inviter_id', userId)
          .not('activated_at', 'is', null)
          .order('invitee_id', { ascending: true })
          .range(from, to),
      ),

      // The reader's own comments, with the title they are about. `comments_read` needs
      // the event's actor to be visible too, so a comment left on somebody who has since
      // blocked the reader is absent from both the count and the list, together.
      readAll((from, to) =>
        supabase
          .from('comments')
          .select(
            `id, created_at, feed_event_id, feed_events!inner(media_item_id, media_items(${MEDIA}))`,
          )
          .eq('author_id', userId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      ),

      readAll((from, to) =>
        supabase
          .from('title_recommendations')
          .select(
            `id, recommended_at, recipient_id, media_items(${MEDIA}), recipient:recipient_id(id, username, display_name, avatar_path)`,
          )
          .eq('sender_id', userId)
          .order('recommended_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      ),

      /**
       * Reactions on the reader's own activity, from anybody but the reader.
       *
       * `neq('user_id', userId)` is the self-reaction rule and it is stated here because
       * the database has no opinion about it: reacting to your own row is allowed, it is
       * simply not an award for being liked.
       *
       * The rows carry the event's title so the breakdown can be about *what* was
       * reacted to rather than about who reacted — which is both the more useful reading
       * and the one that discloses nothing. `reactions_read` already requires the
       * reactor to be visible to the caller, so a reaction from a blocked account is
       * outside the count and outside the list in the same motion.
       */
      readAll((from, to) =>
        supabase
          .from('reactions')
          .select(`feed_event_id, feed_events!inner(actor_id, media_item_id, media_items(${MEDIA}))`)
          .eq('feed_events.actor_id', userId)
          .neq('user_id', userId)
          // `reactions` is keyed by the pair, so the pair is what makes the order total.
          .order('feed_event_id', { ascending: true })
          .order('user_id', { ascending: true })
          .range(from, to),
      ),

      readAll((from, to) =>
        supabase
          .from('follows')
          .select(FOLLOWS_SELECT)
          .eq('state', 'approved')
          .or(`follower_id.eq.${userId},followee_id.eq.${userId}`)
          .order('follower_id', { ascending: true })
          .order('followee_id', { ascending: true })
          .range(from, to),
      ),
    ]);

  if (watched.error) throw watched.error;

  /**
   * Which fields could not be read, so a failure is never dressed up as a zero.
   *
   * Independent review 20's finding and the founder's Phase 7 instruction are the same
   * instruction: an award that cannot be calculated reliably says so. A failed read
   * rendered as 0 is the app making a statement about the reader — you have sent no
   * recommendations — on the strength of a request that never came back.
   *
   * Per-field rather than fatal: losing Mutual Mania to a network blip should not cost
   * the nineteen awards that did load. Only `watched` throws, above, because thirteen
   * tracks are meaningless without it.
   */
  const unavailable = new Set<keyof AwardFacts>();
  const rowsOf = <T>(
    result: { data: unknown; error: unknown },
    field: keyof AwardFacts,
  ): T[] => {
    if (result.error) {
      unavailable.add(field);
      return [];
    }
    return (result.data ?? []) as T[];
  };

  // --- The collection ------------------------------------------------------

  type WatchedRow = {
    media_item_id: string;
    watched_on: string | null;
    note: string | null;
    note_visibility: string | null;
    media_items: MediaRow | MediaRow[] | null;
  };

  const titles: WatchedTitle[] = [];
  const notes: WrittenContribution[] = [];

  for (const row of (watched.data ?? []) as unknown as WatchedRow[]) {
    const title = titleFrom(row.media_item_id, one(row.media_items));
    if (!title) continue;
    titles.push({ ...title, watchedOn: row.watched_on });

    // A note is one row on `user_media` and appears on two surfaces — the activity row
    // and Bingd Reviews. Counted once, here, and only when it is public: a private note
    // is not social content, and Comment Gremlin is an award for talking to people.
    // Deriving it from the collection read is what makes "counted once" structural.
    if (row.note && row.note.trim() !== '' && row.note_visibility === 'public') {
      notes.push({
        key: `note:${row.media_item_id}`,
        kind: 'note',
        title,
        // The body is never carried. The award counts that somebody wrote, and a
        // drill-down that reprinted the writing would be a second surface for it with
        // none of the spoiler handling the real ones have.
        writtenAt: null,
      });
    }
  }

  // --- Rankings ------------------------------------------------------------

  type RankedRow = {
    media_item_id: string;
    bucket: Bucket;
    position: number;
    category: 'movies' | 'tv_seasons';
    media_items: MediaRow | MediaRow[] | null;
  };

  const rankedRows = rowsOf<RankedRow>(ranked, 'rankings');
  // A score is a position within its band, so the band has to be sized over the whole
  // category — the same rule the collection follows. Two categories, two sets of sizes.
  const sizesFor = {
    movies: bandSizes(rankedRows.filter((row) => row.category === 'movies')),
    tv_seasons: bandSizes(rankedRows.filter((row) => row.category === 'tv_seasons')),
  };

  const rankings = rankedRows.flatMap((row) => {
    const title = titleFrom(row.media_item_id, one(row.media_items));
    if (!title) return [];
    return [{ ...title, score: scoreFor(row.bucket, row.position, sizesFor[row.category]) }];
  });

  // --- Everything else -----------------------------------------------------

  type SimpleRow = { media_item_id: string; media_items: MediaRow | MediaRow[] | null };

  const watchlistTitles = rowsOf<SimpleRow>(watchlist, 'watchlist').flatMap((row) => {
    const title = titleFrom(row.media_item_id, one(row.media_items));
    return title ? [title] : [];
  });

  type InviteRow = {
    invitee_id: string;
    activated_at: string | null;
    invitee: ProfileRow | ProfileRow[] | null;
  };

  const invitedSignups = rowsOf<InviteRow>(invites, 'invitedSignups').map((row) => ({
    person: personFrom(row.invitee_id, one(row.invitee)),
    activatedAt: row.activated_at,
  }));

  type CommentRow = {
    id: string;
    created_at: string;
    feed_events: { media_item_id: string | null; media_items: MediaRow | MediaRow[] | null }
      | { media_item_id: string | null; media_items: MediaRow | MediaRow[] | null }[]
      | null;
  };

  const commentRows = rowsOf<CommentRow>(comments, 'written').map((row) => {
    const event = one(row.feed_events);
    const title = event?.media_item_id ? titleFrom(event.media_item_id, one(event.media_items)) : null;
    return {
      key: `comment:${row.id}`,
      kind: 'comment' as ContributionKind,
      title,
      writtenAt: row.created_at,
    } satisfies WrittenContribution;
  });

  type RecommendationRow = {
    id: string;
    recommended_at: string;
    recipient_id: string;
    media_items: MediaRow | MediaRow[] | null;
    recipient: ProfileRow | ProfileRow[] | null;
  };

  const recommendationsSent: RecommendationSent[] = rowsOf<RecommendationRow>(
    recommendations,
    'recommendationsSent',
  ).map((row) => ({
    key: row.id,
    // A recommendation names a title the sender chose, so a missing media row is a
    // broken join rather than a hidden one — but the recommendation still happened and
    // still counts, so it keeps its row.
    title: titleFrom('', one(row.media_items)),
    recipient: personFrom(row.recipient_id, one(row.recipient)),
    sentAt: row.recommended_at,
  }));

  type ReactionRow = {
    feed_event_id: string;
    feed_events:
      | { media_item_id: string | null; media_items: MediaRow | MediaRow[] | null }
      | { media_item_id: string | null; media_items: MediaRow | MediaRow[] | null }[]
      | null;
  };

  /**
   * Reactions folded into the thing they were left on.
   *
   * Content-centric on purpose: "The Wolf of Wall Street, 18 reactions" is what the
   * reader wants to know and discloses nothing about who reacted. A list of reactors
   * would be a new social surface — and the founder's brief rules one out here.
   *
   * Keyed by feed event rather than by title, then merged by title, so two rankings of
   * the same film do not appear as two rows; the numerator is the sum either way.
   */
  const reactedByEvent = new Map<string, ReactedItem>();
  for (const row of rowsOf<ReactionRow>(reactions, 'reactionsReceived')) {
    const event = one(row.feed_events);
    const key = event?.media_item_id ?? row.feed_event_id;
    const existing = reactedByEvent.get(key);
    if (existing) {
      existing.reactions += 1;
      continue;
    }
    reactedByEvent.set(key, {
      key,
      title: event?.media_item_id ? titleFrom(event.media_item_id, one(event.media_items)) : null,
      reactions: 1,
    });
  }
  const reactionsReceived = [...reactedByEvent.values()].sort((a, b) => b.reactions - a.reactions);

  type FollowRow = {
    follower_id: string;
    followee_id: string;
    follower: ProfileRow | ProfileRow[] | null;
    followee: ProfileRow | ProfileRow[] | null;
  };

  const mutualFollows = mutualsFrom(rowsOf<FollowRow>(follows, 'mutualFollows'), userId);

  return {
    watched: titles,
    rankings,
    watchlist: watchlistTitles,
    invitedSignups,
    written: [...commentRows, ...notes],
    recommendationsSent,
    reactionsReceived,
    mutualFollows,
    unavailable,
  };
}

type FollowEdge = {
  follower_id: string;
  followee_id: string;
  follower?: ProfileRow | ProfileRow[] | null;
  followee?: ProfileRow | ProfileRow[] | null;
};

/**
 * The people who follow the reader back.
 *
 * The rows are every approved edge the reader is an end of, in both directions. A
 * mutual is an id that appears on both sides. Counted from a set intersection rather
 * than from two queries, because two queries can be answered a second apart and a
 * follow that lands between them makes the number wrong in a way nothing can detect.
 *
 * Returns the people rather than a number, because the count is the length and a
 * drill-down that had to ask again could disagree with the badge above it.
 */
export function mutualsFrom(
  rows: readonly FollowEdge[] | null | undefined,
  userId: string,
): PersonRef[] {
  const following = new Set<string>();
  const followers = new Set<string>();
  const profiles = new Map<string, ProfileRow | null>();

  for (const row of rows ?? []) {
    if (row.follower_id === userId) {
      following.add(row.followee_id);
      profiles.set(row.followee_id, one(row.followee ?? null));
    }
    if (row.followee_id === userId) {
      followers.add(row.follower_id);
      profiles.set(row.follower_id, one(row.follower ?? null));
    }
  }

  const mutuals: PersonRef[] = [];
  for (const id of following) {
    // Never yourself. `follow` refuses a self-follow, so this is belt and braces
    // rather than a live case.
    if (id !== userId && followers.has(id)) mutuals.push(personFrom(id, profiles.get(id) ?? null));
  }
  return mutuals.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Kept for the callers that only ever wanted the number. */
export const mutualFollowCount = (
  rows: readonly FollowEdge[] | null | undefined,
  userId: string,
): number => mutualsFrom(rows, userId).length;

export type AwardsQuery = {
  awards: AwardProgress[];
  facts: AwardFacts;
};

/**
 * The awards for one account.
 *
 * `staleTime` is a minute, and **the invalidation is what makes that safe** — which was
 * not true when this comment first claimed it was. Logging and ranking go through
 * `invalidateAfterCollectionChange`, and Awards was built after that list and never added
 * to it, so a badge earned by the film just logged did not move for up to a minute. The
 * comment asserted the opposite; independent review 21 found the gap. `['awards', userId]`
 * is on the list now, so a threshold crossed by a write shows immediately.
 *
 * The minute still earns its place for what no local write can invalidate: reactions and
 * follows arrive from other people, so Heart Magnet and Mutual Mania have nothing to hook
 * and a short staleness is the honest cost of not polling.
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
