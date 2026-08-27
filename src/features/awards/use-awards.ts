import { useQuery } from '@tanstack/react-query';

import { bandSizes, scoreFor, type Bucket } from '@/features/collection/score';
import { resolveMetadata, type EmbeddedParent } from '@/lib/media-metadata';
import { after, readAllByKey } from '@/lib/read-all';
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
 * **Row level security is the authorization and nothing here repeats it** — but this
 * file has to *know the policies*, because a policy that returns zero rows to the wrong
 * asker looks exactly like an empty collection. The sheet shows the **target's** awards
 * to whoever is looking (their own, or somebody else's profile), so every read is scoped
 * to the target and the collection read forks on whether the viewer *is* the target:
 * `user_media` is owner-only (PRD §22 — it carries the watch date and the note), so a
 * visitor reads the `logged_collection` projection instead, and the two facts with no
 * visitor-legal read at all (`title_recommendations`, `invite_attributions`, both
 * two-party) are declared withheld rather than read into a false zero. See `readFacts`.
 * The database still decides what every request means — which is also why a drill-down
 * cannot show more than the count already counted.
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
 * Every fact on this screen is read to exhaustion, by keyset, through `lib/read-all.ts`.
 *
 * Two defects sit behind that one sentence and independent review found both.
 * PostgREST **silently caps an unbounded select at 1,000 rows**, which lands exactly
 * where it hurts most — Movie Muncher's gold tier is 1,000 movies, so a collection of
 * 1,000 films and any television at all came back short and could not unlock a badge it
 * had earned. And paging that cap away with `.range()` **is not concurrency-safe**: each
 * page is its own request and therefore its own `READ COMMITTED` transaction, so a title
 * logged on another device mid-read shifts every later offset — one row arrives twice and
 * another is never seen. 999 films assemble to 1,000 and the gold badge unlocks anyway,
 * with no error and no sign that anything went wrong.
 *
 * Keyset has neither problem and `read-all.ts` explains why. What matters here is the
 * consequence for these reads: **the server's order carries no meaning any more, because
 * the read does not stop until there is nothing left.** So each one sorts by whichever
 * column is unique inside it, and the order the screen shows — newest comment first,
 * newest recommendation first — is applied in JS over the assembled rows. That is what
 * lets every cursor on this page be one unique column rather than a tuple.
 *
 * **Two reads are keyed by a pair rather than a column, and both stay one request per
 * page.** `reactions` is `(feed_event_id, user_id)` and `follows` is
 * `(follower_id, followee_id)`, so each compares a tuple in its predicate.
 *
 * `follows` was briefly split into two requests, one per direction, which makes each
 * cursor a single column and is the obvious thing to do. **It is wrong**, and independent
 * review 21c is where that was settled: an intersection taken from two snapshots can
 * report a pair that never coexisted — read `me → A`, have it deleted, have `A → me`
 * approved, read the other direction — and Mutual Mania is a present-tense claim about a
 * pair. One request per page cannot do that, and for every real account the whole read is
 * one request, so the read is a snapshot again.
 */


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
    : { id, name: 'Someone on bingd.', username: null, avatarPath: null };

/**
 * The row shapes, at module scope because the reads are now generic over them.
 *
 * They used to be declared beside the code that maps them, which read better; the reads
 * name them first now, and a type alias that is used above its declaration is legal but
 * not worth making a reader check.
 */

type WatchedRow = {
  media_item_id: string;
  watched_on: string | null;
  note: string | null;
  note_visibility: string | null;
  media_items: MediaRow | MediaRow[] | null;
};

/**
 * A collection row as `logged_collection` projects it for somebody else's awards.
 *
 * No `watched_on` — the date is private at every visibility level (PRD §22), so a
 * visitor's drill-down simply has no date line — and no note columns: the view carries
 * the *existence* of a public review, which is all Comment Gremlin ever counted.
 */
type VisitorWatchedRow = {
  media_item_id: string;
  has_public_note: boolean;
  media_items: MediaRow | MediaRow[] | null;
};

type RankedRow = {
  media_item_id: string;
  bucket: Bucket;
  position: number;
  category: 'movies' | 'tv_seasons';
  media_items: MediaRow | MediaRow[] | null;
};

type SimpleRow = {
  media_item_id: string;
  created_at: string;
  media_items: MediaRow | MediaRow[] | null;
};

type InviteRow = {
  invitee_id: string;
  activated_at: string | null;
  invitee: ProfileRow | ProfileRow[] | null;
};

type EventRef = {
  media_item_id: string | null;
  media_items: MediaRow | MediaRow[] | null;
};

type CommentRow = {
  id: string;
  created_at: string;
  feed_events: EventRef | EventRef[] | null;
};

type RecommendationRow = {
  id: string;
  recommended_at: string;
  recipient_id: string;
  media_items: MediaRow | MediaRow[] | null;
  recipient: ProfileRow | ProfileRow[] | null;
};

type ReactionRow = {
  feed_event_id: string;
  user_id: string;
  feed_events: EventRef | EventRef[] | null;
};

type FollowRow = {
  follower_id: string;
  followee_id: string;
  follower: ProfileRow | ProfileRow[] | null;
  followee: ProfileRow | ProfileRow[] | null;
};

/**
 * Newest first, over rows the server returned in key order.
 *
 * The presentational sort moved here from the request when the reads became keyset:
 * a cursor has to be the column the request sorts by, and `created_at` is not unique.
 * ISO-8601 sorts correctly as text, and the key breaks the tie so the order is total —
 * without which two rows written in the same instant could swap places between renders.
 */
const newestFirst = <Row>(rows: Row[], at: (row: Row) => string | null, key: (row: Row) => string) =>
  [...rows].sort((a, b) => (at(b) ?? '').localeCompare(at(a) ?? '') || key(a).localeCompare(key(b)));

/** The cursor column of a row, for the reads whose key is one column. */
const keyed =
  <Row, K extends keyof Row>(column: K) =>
  (row: Row): readonly string[] => [String(row[column])];

/**
 * `readFacts(userId, own)` — the one read, now honest about who is asking.
 *
 * **Every read here is scoped to the target and always was** — the defect the founder's
 * screenshot caught was never a wrong id. It was RLS answering a right one: `user_media`
 * is owner-only by policy (20260813000500; it carries `watched_on` and `note`, PRD §22
 * always-private), so a visitor's read of somebody else's collection returned **zero rows
 * and no error**, and Movie Muncher stated `0 / 50` over a profile that says 34 movies.
 * A zero the database never asserted, presented as a fact about somebody else.
 *
 * So the collection read forks on `own`, and on nothing else:
 *
 *   - **The owner reads `user_media`**, unchanged: their drill-downs show watch dates,
 *     and their public notes are derived from the same rows.
 *   - **A visitor reads `logged_collection`** (20260827000400), the PRD §22 projection:
 *     the same rows, gated by `can_i_view`, carrying the title and the *existence* of a
 *     public review and neither the date nor any note text. Same keyset, same embed,
 *     same cursor column. The two paths count the same base rows, which is what makes
 *     "your sheet about Ravi equals Ravi's own sheet" structural rather than luck.
 *
 * Two facts have no visitor-legal read at all: `title_recommendations` is a two-party
 * table and `invite_attributions` likewise, so a visitor asking about a third party gets
 * zero rows *by intent*. Those are **withheld** — a named state, not a zero and not a
 * failure: the award renders a dash with "Only they can see this one" rather than
 * claiming somebody has never recommended anything. Everything else — rankings,
 * watchlist, comments, reactions, follows — was already viewer-relative by policy and is
 * read identically in both modes.
 */
async function readFacts(userId: string, own: boolean): Promise<AwardFacts> {
  /** A read a visitor is not entitled to, shaped like one that returned nothing. */
  const withheldRead = Promise.resolve({ data: [], error: null, pages: 1 });

  const [
    watched,
    ranked,
    watchlist,
    invites,
    comments,
    recommendations,
    reactions,
    follows,
  ] = await Promise.all([
      /**
       * The collection, with everything thirteen tracks need on it.
       *
       * For the owner, `watched_on` is here for the drill-down — Movie Muncher and
       * Season Snacker show the date beside a title — and `note`/`note_visibility`
       * because a public note is one of the two things Comment Gremlin counts. Reading
       * them here rather than in a second query is what makes double-counting
       * impossible: one row is one contribution, and the same row is the one Movie
       * Muncher counted. A visitor gets the same rows through `logged_collection`,
       * minus exactly the private columns.
       */
      own
        ? readAllByKey<WatchedRow>(
            (cursor, limit) =>
              after(
                supabase
                  .from('user_media')
                  .select(`media_item_id, watched_on, note, note_visibility, media_items(${MEDIA})`)
                  .eq('user_id', userId),
                'media_item_id',
                cursor,
              )
                // The cursor column and the sort column are the same column, which is the
                // whole of what makes the traversal complete: `user_media` is keyed by
                // `(user_id, media_item_id)` and this read pins the account, so
                // `media_item_id` is unique across every row the request can return.
                .order('media_item_id', { ascending: true })
                .limit(limit),
            keyed('media_item_id'),
          )
        : readAllByKey<VisitorWatchedRow>(
            (cursor, limit) =>
              after(
                supabase
                  .from('logged_collection')
                  .select(`media_item_id, has_public_note, media_items(${MEDIA})`)
                  .eq('user_id', userId),
                'media_item_id',
                cursor,
              )
                // The view is a projection of `user_media`, so the same key is unique
                // under the same account filter, and the same keyset argument applies.
                .order('media_item_id', { ascending: true })
                .limit(limit),
            keyed('media_item_id'),
          ),

      // Bucket and position come too, so Rating Rascal's drill-down can show the score
      // the reader actually gave — which is derived from the band, not stored.
      readAllByKey<RankedRow>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select(`media_item_id, bucket, position, category, media_items(${MEDIA})`)
              .eq('user_id', userId),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        keyed('media_item_id'),
      ),

      readAllByKey<SimpleRow>(
        (cursor, limit) =>
          after(
            supabase
              .from('watchlist')
              // `created_at` is selected rather than ordered on, because the order it
              // expresses is now applied in JS once every row is in hand.
              .select(`media_item_id, created_at, media_items(${MEDIA})`)
              .eq('user_id', userId),
            'media_item_id',
            cursor,
          )
            // Not `created_at`, which is neither unique nor a safe cursor: two rows
            // written in the same instant share it, and `.gt()` on a shared value skips
            // every row but the last. Queue Dragon's list is shown in the order it was
            // added, and that ordering is applied to the assembled rows below.
            .order('media_item_id', { ascending: true })
            .limit(limit),
        keyed('media_item_id'),
      ),

      /**
       * People who joined on this reader's invitation, not links they made.
       *
       * The founder's correction of 2026-08-18: it counts `invite_attributions` where
       * `activated_at` is set, rather than links created — which had made it a badge for
       * pressing a button.
       *
       * **That read is unchanged and now returns people.** `20260819000500` gave the
       * column its writer, so this stopped being a structural zero without a line of this
       * file changing — which is the whole argument for having moved the metric to the
       * honest stage while it still read zero.
       *
       * What it counts and what it does not: a link created does not count, a link opened
       * does not count, and a redemption without activation does not count. See
       * `docs/product/growth-instrumentation.md` §1, including the store-install gap that
       * makes this number a floor.
       *
       * **Withheld for a visitor.** `invite_attributions_read` names the two parties,
       * so a third party's read is zero rows by design — a zero this feature must not
       * repeat as "brought nobody". No request is issued at all: a read whose answer is
       * predetermined by policy is bandwidth spent asking the database to say no.
       */
      !own ? withheldRead : readAllByKey<InviteRow>(
        (cursor, limit) =>
          after(
            supabase
              .from('invite_attributions')
              .select(
                'invitee_id, activated_at, invitee:invitee_id(id, username, display_name, avatar_path)',
              )
              .eq('inviter_id', userId)
              .not('activated_at', 'is', null),
            'invitee_id',
            cursor,
          )
            // `invitee_id` is the table's primary key, so it is unique with or without
            // the inviter filter.
            .order('invitee_id', { ascending: true })
            .limit(limit),
        keyed('invitee_id'),
      ),

      // The reader's own comments, with the title they are about. `comments_read` needs
      // the event's actor to be visible too, so a comment left on somebody who has since
      // blocked the reader is absent from both the count and the list, together.
      readAllByKey<CommentRow>(
        (cursor, limit) =>
          after(
            supabase
              .from('comments')
              .select(
                `id, created_at, feed_event_id, feed_events!inner(media_item_id, media_items(${MEDIA}))`,
              )
              .eq('author_id', userId),
            'id',
            cursor,
          )
            .order('id', { ascending: true })
            .limit(limit),
        keyed('id'),
      ),

      // Withheld for a visitor for the same reason as the invites: what somebody sent
      // is between them and their recipients (title_recommendations_sender/_recipient),
      // and a zero-row answer to a third party is policy, not a count.
      !own ? withheldRead : readAllByKey<RecommendationRow>(
        (cursor, limit) =>
          after(
            supabase
              .from('title_recommendations')
              .select(
                `id, recommended_at, recipient_id, media_items(${MEDIA}), recipient:recipient_id(id, username, display_name, avatar_path)`,
              )
              .eq('sender_id', userId),
            'id',
            cursor,
          )
            .order('id', { ascending: true })
            .limit(limit),
        keyed('id'),
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
      readAllByKey<ReactionRow>(
        (cursor, limit) => {
          const request = supabase
            .from('reactions')
            .select(
              `feed_event_id, user_id, feed_events!inner(actor_id, media_item_id, media_items(${MEDIA}))`,
            )
            .eq('feed_events.actor_id', userId)
            .neq('user_id', userId);

          /**
           * The one composite cursor on this screen, because there is nothing to split on.
           *
           * `reactions` is keyed by `(feed_event_id, user_id)` and this read pins
           * neither, so a cursor on either column alone would skip every other reaction
           * on the boundary event. The predicate below is the ordinary tuple comparison
           * written the way PostgREST spells it, and it is one `or=` combined by AND with
           * the two filters above — not a second one stacked on an existing `or=`, which
           * is precisely why `follows` is read as two requests instead.
           */
          const keyset =
            cursor === null
              ? request
              : request.or(
                  `feed_event_id.gt.${cursor[0]},` +
                    `and(feed_event_id.eq.${cursor[0]},user_id.gt.${cursor[1]})`,
                );

          return keyset
            .order('feed_event_id', { ascending: true })
            .order('user_id', { ascending: true })
            .limit(limit);
        },
        (row) => [row.feed_event_id, row.user_id],
      ),

      /**
       * Every approved edge the reader is an end of, in **one** request per page.
       *
       * This was briefly two requests, one per direction, because pinning half of the
       * `(follower_id, followee_id)` key makes the other half unique and the cursor a
       * single column. Independent review 21c killed that, and the sequence is the reason:
       * read the outgoing direction, then `me → A` is deleted, then `A → me` is approved,
       * then read the incoming direction. Both edges are in hand and **they never existed
       * at the same instant** — a mutual fabricated out of two snapshots, which is worse
       * than the off-by-one I had accounted for and which no amount of "the window is
       * small" makes acceptable on a number the app states as an award.
       *
       * So the direction filter and the keyset cursor share one `or=`, and the nesting is
       * what makes that possible: PostgREST allows `or(and(…,or(…)),and(…,or(…)))`, so the
       * whole predicate is a single query parameter and every page is a single request —
       * which means an account under a thousand edges, i.e. every real account, is read in
       * exactly one request and therefore one snapshot, exactly as before.
       *
       * The `!inner` markers in `FOLLOWS_SELECT` are untouched and are still the privacy
       * control; `supabase/tests/award-privacy.mjs` probes this predicate against the
       * deployed database rather than trusting that it parses.
       */
      readAllByKey<FollowRow>((cursor, limit) => {
        const mine = `follower_id.eq.${userId},followee_id.eq.${userId}`;
        const request = supabase.from('follows').select(FOLLOWS_SELECT).eq('state', 'approved');

        return (
          cursor === null
            ? request.or(mine)
            : request.or(
                `and(follower_id.gt.${cursor[0]},or(${mine})),` +
                  `and(follower_id.eq.${cursor[0]},followee_id.gt.${cursor[1]},or(${mine}))`,
              )
        )
          .order('follower_id', { ascending: true })
          .order('followee_id', { ascending: true })
          .limit(limit);
      }, (row) => [row.follower_id, row.followee_id]),
    ]);

  /**
   * Which fields could not be read, so a failure is never dressed up as a zero.
   *
   * Independent review 20's finding and the founder's Phase 7 instruction are the same
   * instruction: an award that cannot be calculated reliably says so. A failed read
   * rendered as 0 is the app making a statement about the reader — you have sent no
   * recommendations — on the strength of a request that never came back.
   *
   * **Per-field with no exception, which is the change of this pass.** `watched` used to
   * throw and take the whole sheet with it, on the reasoning that thirteen tracks are
   * meaningless without it. Thirteen are; seven are not, and rejecting those seven is the
   * same mistake in the other direction — Mutual Mania has nothing to do with the
   * collection and refusing to show it because the collection was too large to read is a
   * wrong answer dressed as caution. Review 21b's nit, and the model already supported
   * this: every track in `tracks.ts` declares exactly one `needs` field, so "which awards
   * does this failure cost" has an answer that needs no guessing.
   *
   * The one thing that has to be said out loud is what *else* a failed collection read
   * costs. Public notes are rows on `user_media`, so `written` is derived from the same
   * read as `watched`, and letting Comment Gremlin fall back to comments-only would be a
   * silent undercount — the exact failure this whole set exists to prevent. So the two go
   * together, below.
   */
  const unavailable = new Set<keyof AwardFacts>();
  // Not read because the viewer is not a party to them — a different fact from a read
  // that failed, and worded differently on the row (`progress.ts`).
  const withheld = new Set<keyof AwardFacts>(
    own ? [] : ['invitedSignups', 'recommendationsSent'],
  );
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

  const titles: WatchedTitle[] = [];
  const notes: WrittenContribution[] = [];

  const watchedRows = rowsOf<WatchedRow | VisitorWatchedRow>(watched, 'watched');
  // Notes live on these rows, so a collection that could not be read takes the written
  // count with it rather than quietly reporting the comments alone.
  if (watched.error) unavailable.add('written');

  for (const row of watchedRows) {
    const title = titleFrom(row.media_item_id, one(row.media_items));
    if (!title) continue;
    // A visitor's row has no date at all — the projection carries none (PRD §22) — so
    // their drill-down shows the title without a "Watched …" line, not a wrong date.
    titles.push({ ...title, watchedOn: 'watched_on' in row ? row.watched_on : null });

    // A note is one row on `user_media` and appears on two surfaces — the activity row
    // and Bingd Reviews. Counted once, here, and only when it is public: a private note
    // is not social content, and Comment Gremlin is an award for talking to people.
    // Deriving it from the collection read is what makes "counted once" structural.
    // The visitor's view answers the same question as one precomputed boolean, so the
    // two modes count the same rows. The view's predicate is `note is not null` and
    // this one additionally trims, which looks like a gap and is not one: every note
    // writer normalises through `nullif(btrim(coalesce(p_note, '')), '')`, so the
    // column cannot hold a blank string for the two to disagree about. That invariant
    // is the load-bearing one, so it is pinned in `logged-collection.test.mjs` rather
    // than left to be re-derived here — a writer that stopped normalising fails a test
    // instead of showing a visitor a Comment Gremlin the owner does not have.
    const hasPublicNote =
      'has_public_note' in row
        ? row.has_public_note
        : Boolean(row.note && row.note.trim() !== '' && row.note_visibility === 'public');
    if (hasPublicNote) {
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

  // Newest first, which is what the server used to be asked for. The read pages on the
  // key instead — `created_at` is not unique and a `.gt()` cursor on a shared value skips
  // rows — so the order the reader sees is applied here, once, over every row.
  const watchlistTitles = newestFirst(
    rowsOf<SimpleRow>(watchlist, 'watchlist'),
    (row) => row.created_at,
    (row) => row.media_item_id,
  ).flatMap((row) => {
    const title = titleFrom(row.media_item_id, one(row.media_items));
    return title ? [title] : [];
  });

  const invitedSignups = rowsOf<InviteRow>(invites, 'invitedSignups').map((row) => ({
    person: personFrom(row.invitee_id, one(row.invitee)),
    activatedAt: row.activated_at,
  }));

  const commentRows = newestFirst(
    rowsOf<CommentRow>(comments, 'written'),
    (row) => row.created_at,
    (row) => row.id,
  ).map((row) => {
    const event = one(row.feed_events);
    const title = event?.media_item_id ? titleFrom(event.media_item_id, one(event.media_items)) : null;
    return {
      key: `comment:${row.id}`,
      kind: 'comment' as ContributionKind,
      title,
      writtenAt: row.created_at,
    } satisfies WrittenContribution;
  });

  const recommendationsSent: RecommendationSent[] = newestFirst(
    rowsOf<RecommendationRow>(recommendations, 'recommendationsSent'),
    (row) => row.recommended_at,
    (row) => row.id,
  ).map((row) => ({
    key: row.id,
    // A recommendation names a title the sender chose, so a missing media row is a
    // broken join rather than a hidden one — but the recommendation still happened and
    // still counts, so it keeps its row.
    title: titleFrom('', one(row.media_items)),
    recipient: personFrom(row.recipient_id, one(row.recipient)),
    sentAt: row.recommended_at,
  }));

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

  /**
   * **An intersection may only be taken from one snapshot**, and this is where that is
   * enforced rather than argued.
   *
   * One request is one `READ COMMITTED` transaction. Two are not: page one can hold
   * `me → A`, that edge can be deleted, `A → me` can be approved, and page two holds the
   * reverse — so the assembled arrays name a mutual that existed at no instant. A count
   * survives being read across pages; an intersection *invents a member*.
   *
   * Every real account is one request — a thousand approved edges is a lot of people —
   * but "every real account" is not an invariant anything enforces, and this traversal
   * supports twelve thousand rows. So past one page Mutual Mania becomes `unavailable`
   * rather than a number nobody can stand behind: a dash and "Could not load this one",
   * which is the same answer this file gives every other read it cannot vouch for.
   * Independent review 21d, after 21c rejected the two-request version for the same
   * reason and I fixed only the version I had written.
   *
   * The honest way out of the dash is a server-side intersection in one transaction,
   * which is a migration and belongs to Beta Hardening rather than here.
   */
  if (!follows.error && follows.pages > 1) unavailable.add('mutualFollows');

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
    withheld,
  };
}

/**
 * The eight metrics, so "did anything at all arrive" has an answer.
 *
 * Listed rather than derived from the returned object, because a metric that is an empty
 * array on a good day — Invite Instigator is empty for everybody today — cannot be told
 * apart from a missing one by looking at the value.
 */
const METRICS: (keyof AwardFacts)[] = [
  'watched',
  'rankings',
  'watchlist',
  'invitedSignups',
  'written',
  'recommendationsSent',
  'reactionsReceived',
  'mutualFollows',
];

type FollowEdge = {
  follower_id: string;
  followee_id: string;
  follower?: ProfileRow | ProfileRow[] | null;
  followee?: ProfileRow | ProfileRow[] | null;
};

/**
 * The people who follow the reader back.
 *
 * The rows are every approved edge the reader is an end of, in both directions, and a
 * mutual is an id that appears on both sides. This takes them as one array and does not
 * care how many requests assembled it — which is the honest shape, because it has never
 * been one: the caller reads the two directions separately so each can be paged on a
 * unique key, and past a thousand edges the single `.or()` it replaced was several
 * requests anyway.
 *
 * What that costs is one follow-back landing between the two reads, counted or missed by
 * one and corrected on the next read. What it does not cost is a phantom: an id only
 * enters the intersection by appearing on a row that genuinely existed when it was read.
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
export function useAwards(viewerId: string, userId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    /**
     * Keyed by the viewer *and* the target, like every viewer-relative read
     * (`useRankedTitles` states the convention). What this query returns genuinely
     * differs per viewer — RLS trims reactions, follows and the collection view to what
     * the caller may see — and a cache entry reachable from a second signed-in account
     * on the same device is the recurring defect the convention exists to stop.
     * `invalidateAwards` matches on the `['awards', viewerId]` prefix, which now means
     * "everything this viewer computed" — their own sheet and any they were looking at.
     */
    queryKey: ['awards', viewerId, userId],
    enabled: (options.enabled ?? true) && Boolean(userId) && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<AwardsQuery> => {
      const facts = await readFacts(userId, viewerId === userId);

      /**
       * Nothing arrived at all, which is a different fact from a metric being unavailable.
       *
       * Per-field degradation is right when one read fails — the collection being too
       * large to count is no reason to withhold Mutual Mania. It is the wrong answer for
       * a device that is offline, where every field is unavailable and twenty rows of
       * dashes is a worse sentence than one that says so and offers Try again.
       *
       * This is deliberately "all eight", not "the important one". The founder's phone
       * loses signal in a lift; a single ceiling error does not.
       */
      if (METRICS.every((metric) => facts.unavailable?.has(metric))) {
        throw new Error('Could not read anything about this account’s awards.');
      }

      return { facts, awards: awardsFor(facts) };
    },
  });
}
