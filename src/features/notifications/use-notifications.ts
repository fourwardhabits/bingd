import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { GOAL_LABEL } from '@/features/goals/goals';
import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { classifyWrite, mustReconcile } from '@/lib/write-outcome';

/**
 * The kinds of notification this app writes, and the only ones it renders.
 *
 * A closed union rather than a string, because the founder's rule for this surface was
 * to render an event only where its meaning is unambiguous. Anything the database
 * grows later appears here as `null` from `verbFor` and is dropped, which is a
 * deliberate silence rather than a row that says "something happened".
 */
export type NotificationKind =
  | 'follow'
  | 'follow_request'
  | 'follow_approved'
  | 'reaction'
  | 'comment'
  /**
   * Somebody named this reader in a comment or a reply (`20260830000100`).
   *
   * A separate kind rather than a flavour of `comment`, because it is a different
   * statement — "there is a new remark on your post" versus "this remark is addressed
   * to you" — and because a mention arrives on activity that is very often not the
   * reader's at all. It shares the **Comments** preference category deliberately: the
   * settings screen already has that row, and a second control beside it would ask a
   * reader to hold a distinction the product does not otherwise make.
   *
   * At most one per (comment, person), for good, enforced by the `comment_mentions`
   * ledger rather than by anything here — so editing a comment, removing a mention and
   * putting it back cannot ring twice.
   */
  | 'mention'
  | 'watch_tag'
  | 'recommendation'
  /**
   * A recommendation this reader sent was ranked (`20260827000600`).
   *
   * Written by `_rank_finalize` — the one place a ranking is created — when the
   * recipient first reaches a completed ranking for the title, in the same
   * transaction, so a lost reply or a replay cannot double it and a Rank Again or
   * a bucket change cannot re-fire it. Actor is the person who ranked; recipient
   * is the recommender; `subject_id` is the exact `title_ranked` feed event, so
   * the row opens the recipient's actual post the way a comment row opens its
   * conversation.
   */
  | 'recommendation_ranked'
  /**
   * Somebody this reader invited reached activation — ten ranked titles (PRD §28).
   *
   * **The writer arrived on 2026-08-19** (`20260819000500`), and the order it arrived
   * in is the point. The type, its preference category and its route were all built
   * first, deliberately, while `invite_attributions.activated_at` still had no writer:
   * so when `_maybe_activate_invite` filed its first row, that row was already
   * rendered, already silenceable through the `invites` category, and already routed
   * to the person who joined. Nothing here had to change.
   *
   * Written server-side at the activation transition, once — never from a client
   * observing the column, which could not tell a crossing from a state. That is the
   * same distinction `award_earned` below is still waiting on.
   */
  | 'invite_activated'
  /**
   * The inviter's own half of an acceptance, filed by `redeem_invite` at the moment an
   * invitation is redeemed (`20260831000100`).
   *
   * **It replaces the `follow` row that acceptance used to file, rather than joining
   * it.** The follow is still created; what changed is the sentence. "Ada Lovelace
   * joined bingd. from your invite" is the fact worth telling, and "started following
   * you" was the incidental half of it — two rows for one act is the redundancy PRD §15
   * refuses.
   *
   * **Not to be confused with `invite_activated` above.** That is the analytics
   * milestone at the tenth ranking and is unchanged; this is the social event at
   * acceptance. Two moments, two rows, and neither stands in for the other.
   *
   * Filed only when the invitee's follow was auto-approved. A **private** inviter still
   * gets `follow_request`, because that row carries Approve and Decline and is the only
   * place in the app they exist.
   */
  | 'invite_joined'
  /**
   * The invitee's own welcome, filed by `redeem_invite` at the moment an invitation
   * is accepted (`20260823000100`).
   *
   * The only kind in this list whose recipient is the *new* account. Everything else
   * is news about somebody acting on an established reader; this is the first thing
   * a person ever sees in Bingd, and it exists because the invitee was the one party
   * to the exchange being told nothing — the inviter already gets a `follow`, and the
   * follow itself already happens without either of them watching it.
   *
   * Written server-side inside the redemption, so a lost reply or a remount cannot
   * produce a second one, and cannot lose the first.
   */
  | 'invite_welcome'
  /**
   * The accepter's own record of approving a follow request (`20260827000200`).
   *
   * The founder's correction: accepting a request made the notification vanish, so
   * the Bell kept every social fact except the one where two people connected. The
   * actionable `follow_request` row is still cleared on approval — an Accept that can
   * be drawn twice is a bug — and this row is what replaces the silence. Actor is the
   * requester; recipient is the accepter; born **pre-read**, because it reports the
   * reader's own tap. `mutual` freezes whether the connection was two-way at that
   * moment, which is what decides between "You and Abisola are now friends" and
   * "Abisola now follows you".
   *
   * Never pushed (`_push_eligible` does not list it) and always delivered — a record
   * of your own action is not a preference axis.
   */
  | 'friendship'
  /**
   * An award tier was crossed — written by `_maybe_award_unlocks` off the durable
   * unlock ledger since 20260828000100, which is exactly the server-side record
   * this comment used to say the type was waiting for. The crossing is detected
   * where the facts change (triggers on the source tables), recorded at most once
   * (the ledger's primary key), and this row is the earner's own congratulations:
   * actorless, because nobody did it to them, with the award named in `payload`.
   */
  | 'award_earned'
  /**
   * An annual watch goal was finished — written by `_maybe_goal_completion` off the
   * durable `goal_completions` ledger since 20260829000200.
   *
   * The same shape as `award_earned` and for the same reasons: the crossing is detected
   * where the facts change (a statement-level trigger on `user_media`), recorded at most
   * once per account, year and medium (the ledger's primary key), and this row is the
   * earner's own congratulations — actorless, because nobody did it to them.
   *
   * What makes it a *crossing* rather than a state is the arithmetic in the trigger:
   * the count before this write was below the target and the count after it is not. So
   * editing a goal downward under an existing count, a recalculation, a relaunch and the
   * migration's own rollout all produce nothing.
   */
  | 'goal_completed';

export type Notification = {
  id: string;
  kind: NotificationKind;
  createdAt: string;
  readAt: string | null;
  actorId: string | null;
  actorUsername: string | null;
  actorName: string | null;
  actorAvatarUri: string | null;
  /** The title the event was about, where there is one. */
  mediaItemId: string | null;
  mediaTitle: string | null;
  /** A film or a season, which is what the sentence says out loud. */
  mediaKind: 'movie' | 'series' | 'season' | null;
  /** The show a season belongs to. A season's own title is "Season 2". */
  seriesTitle: string | null;
  /**
   * What the row points at, as the database recorded it.
   *
   * Carried so that routing can tell two silences apart. A `comment` row always has
   * a `feed_event` subject; `mediaItemId` going null therefore means the event was
   * deleted rather than that there was never one — the join in `my_notifications`
   * that resolves the title requires the event to still exist *and* still belong to
   * this reader. `routing.ts` reads exactly that difference.
   */
  subjectType: string | null;
  subjectId: string | null;
  /**
   * `friendship` only: whether the connection was mutual when it was made. Frozen at
   * acceptance by the server rather than re-derived here, so an unfollow later does
   * not rewrite what the row said. Null on every other kind.
   */
  mutual: boolean | null;
  /**
   * `award_earned` only (20260828000100): which award, for the row's sentence and
   * badge. The names are the server's snapshot; the keys resolve artwork through
   * `badgeFor`, which falls back to 🏅 for a track this bundle predates. Null on
   * every other kind.
   */
  award: { key: string; tierKey: string; name: string; tierLabel: string | null } | null;
  /**
   * `goal_completed` only (20260829000200): which annual goal was finished, for the row's
   * sentence. Null on every other kind.
   */
  goal: { year: number; category: 'movies' | 'tv_seasons'; target: number } | null;
  /**
   * One line of what was written, on a `comment` or `mention` row. Null everywhere else,
   * and null on those two when the comment has been retracted, is spoiler-marked, or
   * belongs to somebody this reader may not see.
   *
   * **Withheld by the server, not by this file**, and that is the deliberate exception
   * to how spoilers work everywhere else in this app: `shouldMask` is viewer-relative
   * and lives on the client because a masked body is readable by exactly the accounts an
   * unmasked one is. The inbox is different — the row appears without being opened and
   * the same string goes to a lock screen — so `my_notifications` never sends it and
   * there is nothing here that could leak it.
   */
  /**
   * `mention` only: whether the comment that named this reader was a reply rather than a
   * top-level remark. Recorded by the server when the mention was filed, so the sentence
   * cannot be re-derived wrongly from a thread that has moved on.
   */
  mentionInReply: boolean;
  preview: string | null;
  /**
   * Why there is no preview, when the reason is a spoiler claim. The row says "Contains
   * spoilers" rather than leaving a blank second line, which reads as a rendering bug.
   */
  previewHidden: boolean;
  /**
   * `watch_tag` only: whether this reader has already ranked the title.
   *
   * Decides whether the row offers Rank. Resolved in the read that draws the row rather
   * than held anywhere, so the control disappears on the next refetch after they rank
   * it, with no write and no invalidation to remember.
   */
  viewerRanked: boolean;
};

const KINDS = new Set<string>([
  'follow',
  'follow_request',
  'follow_approved',
  'reaction',
  'comment',
  'mention',
  'watch_tag',
  'recommendation',
  'recommendation_ranked',
  'invite_activated',
  'invite_joined',
  'invite_welcome',
  'friendship',
  'award_earned',
  'goal_completed',
]);

/**
 * The kinds that are somebody doing something, rather than something happening.
 *
 * Everything here is drawn with a name and a face, so a row that cannot name its
 * actor is dropped rather than rendered anonymously. `award_earned` is the first
 * kind that is genuinely nobody's action — it has a null `actor_id` by construction —
 * and it is not held to that rule. Before it existed the rule was simply "always",
 * which would have silently swallowed the first actorless notice ever written.
 */
const ACTORLESS_KINDS = new Set<string>(['award_earned', 'goal_completed']);

/**
 * The caller's own inbox.
 *
 * `my_notifications` is definer and the reason is the whole design of this surface: a
 * private account requesting to follow another private account fails
 * `can_view_profile`, so an invoker query would return the request with no name
 * attached and the one control that resolves it could not be drawn. The request would
 * be permanently unanswerable, which turns the private setting into a trap. It takes
 * no recipient and cannot be asked about anybody else — the same shape as `my_blocks`.
 *
 * Rows whose actor cannot be named are dropped rather than rendered anonymously —
 * unless the kind is genuinely actorless (`ACTORLESS_KINDS`): the award
 * congratulations has a null actor by construction and survives the filter, with
 * its own render branch on the Bell rather than a blank avatar.
 */
export function useNotifications(viewerId: string) {
  const query = useQuery({
    queryKey: ['notifications', viewerId],
    // Short, because the useful thing about an inbox is that it is current, and this
    // is one round trip against an index on (recipient_id, created_at desc).
    staleTime: 30_000,
    /**
     * The one query in the app that opts out of the global `refetchOnWindowFocus:
     * false`, because it is the one whose whole job is to be current about something
     * somebody else did.
     *
     * It does nothing without `startQueryFocusTracking` (`lib/query.ts`), which is
     * what makes "focus" mean "the app came back to the foreground" rather than a
     * browser event that never fires here.
     */
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase.rpc('my_notifications', { p_limit: 100 });
      if (error) throw error;

      return (
        (data ?? []) as {
          id: string;
          kind: string;
          created_at: string;
          read_at: string | null;
          actor_id: string | null;
          actor_username: string | null;
          actor_display_name: string | null;
          actor_avatar_path: string | null;
          media_item_id: string | null;
          media_title: string | null;
          media_kind: 'movie' | 'series' | 'season' | null;
          series_title: string | null;
          subject_type: string | null;
          subject_id: string | null;
          payload: {
            mutual?: boolean;
            award?: string;
            tier?: string;
            award_name?: string;
            tier_label?: string;
            // `goal_completed` (20260829000200).
            year?: number;
            category?: 'movies' | 'tv_seasons';
            target?: number;
            // `mention` (20260830000100).
            reply?: boolean;
          } | null;
          // 20260830000100. Optional in the type for the same reason `mentions` is in
          // `use-comments`: a bundle can be newer than the database it is pointed at
          // during a rollout, and the absence must read as "no preview" rather than
          // throw.
          comment_excerpt?: string | null;
          comment_spoilers?: boolean | null;
          viewer_ranked?: boolean | null;
        }[]
      )
        .filter(
          (row) =>
            KINDS.has(row.kind) &&
            (Boolean(row.actor_username) || ACTORLESS_KINDS.has(row.kind)),
        )
        .map((row) => ({
          id: row.id,
          kind: row.kind as NotificationKind,
          createdAt: row.created_at,
          readAt: row.read_at,
          actorId: row.actor_id,
          actorUsername: row.actor_username,
          actorName: row.actor_display_name || row.actor_username,
          actorAvatarUri: avatarUri(row.actor_avatar_path),
          mediaItemId: row.media_item_id,
          mediaTitle: row.media_title,
          mediaKind: row.media_kind,
          seriesTitle: row.series_title,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          mutual: row.kind === 'friendship' ? row.payload?.mutual === true : null,
          award:
            row.kind === 'award_earned' && row.payload?.award && row.payload?.tier
              ? {
                  key: row.payload.award,
                  tierKey: row.payload.tier,
                  name: row.payload.award_name ?? 'a new Award',
                  tierLabel: row.payload.tier_label ?? null,
                }
              : null,
          goal:
            row.kind === 'goal_completed' && row.payload?.year && row.payload?.category
              ? {
                  year: Number(row.payload.year),
                  category: row.payload.category,
                  target: Number(row.payload.target ?? 0),
                }
              : null,
          // Trimmed here rather than in the row, because the whitespace is an artefact of
          // how somebody typed and a preview is one line: a comment beginning with a
          // newline would otherwise draw an empty second line under the sentence.
          mentionInReply: row.kind === 'mention' && row.payload?.reply === true,
          preview: row.comment_excerpt?.replace(/\s+/g, ' ').trim() || null,
          previewHidden: row.comment_spoilers === true,
          viewerRanked: row.viewer_ranked === true,
        }));
    },
  });

  /**
   * The other half of "current": moving between tabs.
   *
   * Foreground is covered above, but the tab navigator keeps every visited tab
   * mounted, so walking from Collection back to Feed creates no new observer and
   * asks the server nothing. This is the boundary that closes it.
   *
   * **Gated on staleness rather than firing every time.** An ungated `refetch()`
   * ignores `staleTime` by design, which would turn a reader flicking between two
   * tabs into a request per tap. Read through a ref so the callback identity does
   * not change with the flag and re-run the effect on its own.
   */
  const { refetch, isStale } = query;
  const stale = useRef(isStale);
  // Mirrored in an effect rather than assigned during render: a ref written while
  // rendering is torn between two passes under concurrent rendering, and the lint rule
  // that says so is right even where this one would have got away with it.
  useEffect(() => {
    stale.current = isStale;
  }, [isStale]);

  useFocusEffect(
    useCallback(() => {
      if (stale.current) void refetch();
    }, [refetch]),
  );

  return query;
}

/**
 * How many are unanswered.
 *
 * Only follow requests count. A reaction is not a task and a comment is not a task;
 * a request is somebody waiting on the reader, and it is the one thing in this inbox
 * that stays true until they act — which is why Settings' row says "3 waiting" rather
 * than repeating the bell's number.
 */
export function pendingRequestCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => row.kind === 'follow_request').length;
}

/**
 * How much has not been read, which is what the bell carries.
 *
 * It only became a usable number when read state became the reader's to change: while
 * the inbox marked itself read on open, this was zero every time anybody could have
 * looked at it.
 */
export function unreadCount(notifications: Notification[] | undefined) {
  return (notifications ?? []).filter((row) => !row.readAt).length;
}

/** The inbox's three ages. See `sectionFor`. */
export type InboxSection = 'today' | 'week' | 'earlier';

/**
 * Which shelf of the inbox a row belongs on.
 *
 * Three, and vague on purpose — Today, This week, Earlier — because the section is
 * scaffolding for scanning, not a second timestamp: the row already says "2d ago".
 * The boundaries use the same rounding `relativeTime` uses, so a row can never sit
 * under a heading its own label contradicts: "1d ago" (which begins at 23.5 hours)
 * is the first row of This week, and "7d ago" (6.5 days) the first of Earlier.
 *
 * `now` is injectable for the same reason `relativeTime`'s is: a test that reads
 * the clock is a test that rots.
 */
export function sectionFor(createdAt: string, now: number = Date.now()): InboxSection {
  const then = new Date(createdAt).getTime();
  if (!Number.isFinite(then)) return 'earlier';

  const hours = Math.round(Math.max(0, now - then) / 3_600_000);
  if (hours < 24) return 'today';

  const days = Math.round(hours / 24);
  if (days < 7) return 'week';

  return 'earlier';
}

/**
 * What the row says happened, in the second person.
 *
 * One place, because the wording is the only thing distinguishing three follow states
 * that are otherwise the same row — and `follow_request` versus `follow_approved` is
 * exactly the pair that reads backwards if it is written twice.
 *
 * A recommendation says which kind of thing it is — "recommended a movie", "recommended
 * a season" — because the title on the next line is often "Season 2", and the kind is
 * what makes that sentence mean anything before the show's name is read.
 */
export function verbFor(
  kind: NotificationKind,
  mediaKind?: Notification['mediaKind'],
  /**
   * `goal_completed` only. Optional for the same reason `mediaKind` is: most kinds have a
   * sentence that is a constant, and the two that do not take exactly what they need
   * rather than the whole row.
   */
  goal?: Notification['goal'],
  /**
   * `mention` only, and optional for the same reason the two above it are: one kind
   * needs it and thirteen do not. Absent reads as "in a comment", which is the more
   * common of the two and the safer thing to say about a row from a database that
   * predates the flag.
   */
  reply?: boolean,
): string {
  switch (kind) {
    case 'follow':
      return 'started following you';
    case 'follow_request':
      return 'wants to follow you';
    case 'follow_approved':
      return 'approved your follow request';
    case 'reaction':
      return 'reacted to your activity';
    case 'comment':
      return 'commented on your activity';
    /**
     * "in a comment" and "in a reply" are one sentence apart, and the founder asked for
     * the distinction where the copy already makes it. The `reply` flag is the server's
     * (`comment_mentions`' writer records it), so the two surfaces cannot disagree about
     * which a given row was.
     */
    case 'mention':
      return reply ? 'mentioned you in a reply' : 'mentioned you in a comment';
    /**
     * The tail of "Suraj watched 100 Meters with you", which is what the row draws when
     * it has the title. This is the fallback for a title that has left the catalogue —
     * and, unlike the row, it cannot put the name in the middle of the sentence, so it
     * says "something" where the row says the film.
     */
    case 'watch_tag':
      return 'watched something with you';
    case 'recommendation':
      if (mediaKind === 'season') return 'recommended a season';
      if (mediaKind === 'movie') return 'recommended a movie';
      return 'recommended something';
    /**
     * The spoken shape and the fallback shape. The row itself says "ranked
     * The Martian from your recommendation" with the title inline — the
     * founder's copy — and falls back to this when the event (and with it the
     * title) is gone. Here the title rides after the sentence, as every other
     * label appends its subject.
     */
    case 'recommendation_ranked':
      return 'ranked your recommendation';
    case 'invite_activated':
      return 'joined bingd. from your invite';
    /**
     * The same sentence as `invite_activated`, deliberately, because it is the same
     * fact — and this is the row that says it at the moment it becomes true.
     *
     * The two are not duplicates in an inbox: acceptance files this one and only this
     * one; activation files the other, later, and only if the invitee ranks ten titles.
     * An inviter can see both over a fortnight, describing two different milestones of
     * the same person, which is what the invite funnel actually has to say.
     */
    case 'invite_joined':
      return 'joined bingd. from your invite';
    /**
     * No emoji here, on purpose. The row draws one; a screen reader would say "party
     * popper" in the middle of the only sentence that tells a new reader who brought
     * them, and the celebration is the part that survives being dropped.
     */
    case 'invite_welcome':
      return 'invited you';
    /**
     * The non-mutual reading, which is the one this shape can say. The mutual case —
     * "You and Abisola are now friends" — does not begin with the actor, so the Bell
     * special-cases it beside the welcome; this is the spoken fallback and the row
     * for an approval that was one-way.
     */
    case 'friendship':
      return 'now follows you';
    /**
     * Second person, and no actor. Every other verb completes a sentence that began
     * with somebody's name; this one is the whole sentence, which is why the row
     * that draws it must not expect a face.
     */
    case 'award_earned':
      return 'You earned a new Award';
    /**
     * Second person and actorless, like the award above it — nobody did this to them.
     *
     * The year and the medium come from the row, because a congratulation that does not
     * say *which* goal is one the reader has to go and look up. The emoji is the founder's
     * copy and is the only one in this file: a goal is the single most deliberate thing
     * anybody does in this app, and it is the one place a 🎉 is not decoration.
     */
    case 'goal_completed':
      return goal
        ? `You hit your ${goal.year} ${GOAL_LABEL[goal.category]} goal 🎉`
        : 'You hit your goal 🎉';
  }
}

/** What the row's relationship control says, and whether pressing it does anything. */
export type RelationshipAction = {
  label: 'Follow' | 'Follow back' | 'Requested' | 'Following';
  /** `Requested` and `Following` are statements of fact, not offers. */
  actionable: boolean;
};

/** The reader's own outgoing edge to a row's actor, as `follow_state_with` reports it. */
export type OutgoingEdge = {
  following?: 'approved' | 'pending' | null;
  blocked?: boolean;
};

/**
 * The two rows that are *about* a relationship, and therefore always state one.
 *
 * Everywhere else in this inbox a follow control is an offer that disappears once it
 * has been taken. On these two it is the point of the row, so it reports the state
 * instead of vanishing — see `relationshipActionFor`.
 */
const INVITE_ROWS = new Set<string>(['invite_welcome', 'invite_joined']);

/**
 * The relationship control for a row, or nothing.
 *
 * **This replaced `canFollowBack`, which could only answer yes or no.** That was right
 * for `follow` and wrong for the two invite rows, and the reason is what those rows
 * are for. `redeem_invite` creates the invitee's follow as part of acceptance, so by
 * the time the welcome is ever drawn the edge already exists — and a boolean gate meant
 * the control was hidden on essentially every welcome ever rendered. The row that
 * exists to introduce two accounts said nothing about whether they were connected.
 *
 * So on `invite_welcome` and `invite_joined` the control always appears and names the
 * truth: **Following**, **Requested**, or an offer to start. The first two are inert —
 * they are statements, and the place to undo a follow is the profile the row already
 * opens, where `FollowControl` has always drawn that state and its confirmation.
 *
 * **`Follow` on a welcome, `Follow back` on a join.** The inviter never followed the
 * invitee, so there is nothing for the invitee to return; the inviter, receiving a join,
 * is being followed and can return it.
 *
 * Everything else keeps the old rule exactly. `follow` and `friendship` offer Follow
 * back only where no edge goes the other way; `follow_request` is excluded because it
 * has Approve and Decline, and a third control that quietly starts a relationship in the
 * opposite direction beside them is one mis-tap from a follow nobody meant.
 * `follow_approved` is excluded because the reader followed *them*.
 *
 * `resolved` is not the same question as "is there an edge". Until `follow_state_with`
 * has answered, an absent entry means nobody has looked — and drawing `Follow` on that
 * would flash the wrong word on the row most likely to already be Following.
 */
export function relationshipActionFor(
  row: Notification,
  edge: OutgoingEdge | undefined,
  resolved: boolean,
): RelationshipAction | null {
  if (!row.actorId) return null;
  // A block in either direction removes the rows themselves server-side; this is the
  // window before the next refetch, and an offer to follow somebody the reader has
  // blocked is not one of the states this control is allowed to draw.
  if (edge?.blocked) return null;

  if (INVITE_ROWS.has(row.kind)) {
    if (!resolved) return null;
    if (edge?.following === 'approved') return { label: 'Following', actionable: false };
    if (edge?.following === 'pending') return { label: 'Requested', actionable: false };
    return { label: row.kind === 'invite_welcome' ? 'Follow' : 'Follow back', actionable: true };
  }

  // `friendship` joins the pair (20260827000200): a one-way acceptance is exactly
  // "somebody now follows you", and the edge check hides the control by itself
  // whenever the friendship was mutual.
  if (row.kind === 'follow' || row.kind === 'friendship') {
    return edge?.following ? null : { label: 'Follow back', actionable: true };
  }

  return null;
}

/**
 * Whether this row should offer Rank.
 *
 * Only on `watch_tag`, only where the title still resolves, and only where the reader
 * has not ranked it. Somebody has just said they watched this with you; the useful next
 * act is to place it, and before this the row was a sentence with nothing to do about it.
 *
 * **It leads to the title page, not to the ranking sheet**, and that is the founder's
 * instruction rather than a shortcut. A notification is a claim about something that
 * happened, possibly days ago; dropping the reader straight into a comparison session
 * from a Bell tap is a modal state entered by accident. The title page already has a
 * Rank button, it is where every other ranking in the app begins, and it gives them the
 * poster and the score before they commit to anything.
 *
 * `viewerRanked` is resolved server-side in the read that draws the row, so the control
 * disappears on the next refetch after they rank it. There is nothing to invalidate and
 * no local state that could disagree.
 */
export function canRankFromRow(row: Notification): boolean {
  return row.kind === 'watch_tag' && Boolean(row.mediaItemId) && !row.viewerRanked;
}

/**
 * Marks the whole inbox read.
 *
 * All at once, from one control the reader presses. There is no per-row marking and no
 * mark-on-open: the first would be six taps to clear six rows, and the second is what
 * this replaced — it made `read_at` a column whose value nobody could ever observe as
 * anything but "read".
 */
export function useMarkNotificationsRead(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_notifications_read');
      if (error) throw error;
    },
    // `onSettled` rather than `onSuccess`: a mark-read that commits and loses its reply
    // leaves the badge showing a count the server no longer agrees with, and the reader
    // has no control that would ask again (`lib/write-outcome.ts`). A refusal this app
    // raises on purpose is the one case with nothing to refetch.
    onSettled: (_data, error) => {
      if (!mustReconcile(classifyWrite(error as { code?: string } | null))) return;
      return queryClient.invalidateQueries({ queryKey: ['notifications', viewerId] });
    },
  });
}
