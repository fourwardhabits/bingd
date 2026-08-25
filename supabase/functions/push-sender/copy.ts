/**
 * What a push says, and the only thing it carries back into the app.
 *
 * Pure, and separated from `index.ts` for the reason `normalize.ts` is separated from the
 * adapter: this is the part with a right answer, and a right answer is worth asserting.
 * Nothing here reads a database, a secret, or the network.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY RULE, WHICH IS THE WHOLE REASON THIS FILE IS SMALL
 *
 * A push is rendered by the operating system on a **locked screen**, to whoever is
 * holding the phone. It is the least private surface this product has, and it is the one
 * surface the recipient cannot re-read the privacy settings of.
 *
 * So a push carries three things and no others: **who** did it, **what kind of thing**
 * they did, and **which title** it was about. It never carries what anybody wrote.
 *
 * That is not a filter applied here — it is a property of the query that produces the
 * input. `claim_push_batch` selects a username, a display name and a media title, and
 * there is no column in its output for a note, a comment body, a review or a bio. A note
 * cannot leak through this file because a note never reaches it. If somebody widens that
 * query, this comment is the thing they have to argue with.
 *
 * The actor is already known to be nameable to the recipient: `claim_push_batch` applies
 * `can_discover_profile`, the same predicate `my_notifications` applies, so a blocked or
 * suspended actor produced no job at all.
 */

/** One job as `claim_push_batch` returns it. */
export type PushJob = {
  notification_id: string;
  /**
   * The claim generation, echoed back to `settle_push_batch` and used for nothing else.
   *
   * `push_outbox.attempts` is incremented on every claim, so it identifies **this** claim.
   * A sender that stalls past its five-minute lease has already had the row taken by the
   * next drain; without this its late reply would land on the replacement's in-flight row —
   * back to `pending`, a failure charged to a delivery still running, and a third drain
   * sending the same notification alongside the sender that never lost it.
   */
  attempt: number;
  type: string;
  actor_username: string | null;
  actor_name: string | null;
  media_item_id: string | null;
  /**
   * The activity, when the notification points at one.
   *
   * `claim_push_batch` reads it from `notifications.subject_id` directly rather than
   * through the `feed_events` join beside it, because that join is narrowed to the
   * recipient's *own* activity — and a reply notification's recipient is another
   * commenter, for whom it yields null.
   */
  feed_event_id: string | null;
  media_kind: 'movie' | 'series' | 'season' | null;
  media_title: string | null;
  series_title: string | null;
  tokens: { token: string; platform: 'ios' | 'android' }[] | null;
};

/** What the app is handed when somebody taps. Deliberately five fields. */
export type PushData = {
  /** So the client can settle its own inbox without guessing which row this was. */
  notificationId: string;
  kind: string;
  /** The three fields `features/notifications/routing.ts` resolves a destination from. */
  actorUsername: string | null;
  mediaItemId: string | null;
  /**
   * The activity the notification is about, so a tapped comment or reply opens the
   * conversation rather than the title page.
   *
   * **It is still not what anybody wrote.** An id is not content: it names a row whose
   * every read goes through `activity_comments`, which asks `can_view_profile` about the
   * event before returning anything. The privacy rule at the top of this file is that a
   * push carries who, what kind, and which title — this adds *which conversation*, which
   * is the same class of fact as the title and is rendered by the operating system as
   * nothing at all.
   */
  feedEventId: string | null;
};

export type PushContent = {
  title: string;
  body: string;
  data: PushData;
};

/**
 * The subject's name, joined the way the app joins it.
 *
 * A deliberate, reduced copy of `compactName` in `src/lib/titles.ts`, and the duplication
 * is not laziness: this file is Deno and that one is React Native, and neither toolchain
 * can load the other's module. What is copied is the rule that matters here — a season's
 * own title is "Season 2" and names nothing on its own, so the show's name has to carry
 * it — and the parts that do not apply to a one-line push (the year, the visible-parent
 * option) are left out rather than reproduced.
 */
export function subjectName(job: PushJob): string | null {
  const own = job.media_title?.trim() || null;
  if (!own) return null;
  if (job.media_kind !== 'season') return own;

  const series = job.series_title?.trim() || null;
  if (!series) return own;

  // "Chernobyl, Chernobyl" — TMDB names a limited series' single season after the show.
  if (own.toLowerCase().includes(series.toLowerCase())) return own;

  const ordinal = own.match(/^season\s+(\d+)$/i)?.[1];
  return ordinal ? `${series}, S${ordinal}` : `${series}, ${own}`;
}

/**
 * The sentence, in the same words the inbox row uses.
 *
 * Kept deliberately parallel to `verbFor` in `src/features/notifications/use-notifications.ts`
 * — somebody who reads a push and then opens the app should find the same event described
 * the same way, and two vocabularies for one event is how a product starts sounding like
 * two products. It is a copy for the same toolchain reason as above, and it is the *only*
 * copy: there is no third place.
 */
function sentence(job: PushJob, name: string, subject: string | null): { title: string; body: string } {
  switch (job.type) {
    case 'follow':
      return { title: name, body: 'started following you' };
    case 'follow_request':
      return { title: name, body: 'wants to follow you' };
    case 'comment':
      return {
        title: name,
        body: subject ? `commented on your activity — ${subject}` : 'commented on your activity',
      };
    case 'reaction':
      return {
        title: name,
        body: subject ? `reacted to your activity — ${subject}` : 'reacted to your activity',
      };
    case 'watch_tag':
      return {
        title: name,
        body: subject ? `watched ${subject} with you` : 'watched something with you',
      };
    case 'recommendation':
      return {
        title: name,
        body: subject ? `recommended ${subject}` : 'recommended something to watch',
      };
    case 'invite_activated':
      return { title: name, body: 'joined bingd. from your invite' };
    /**
     * The one push whose title is not a person, because it is the first thing anybody
     * ever sees from Bingd and the greeting is the point. The inbox row does the same —
     * "Welcome to bingd." before the inviter's name — and the emoji it draws is dropped
     * here: a notification centre is not the place, and the celebration survives without
     * it.
     */
    case 'invite_welcome':
      return { title: 'Welcome to bingd.', body: `${name} invited you` };
    default:
      // Unreachable: `_push_eligible` is the list, and it is shorter than this switch.
      // Returned rather than thrown so one unexpected type cannot fail a whole batch.
      return { title: name, body: 'did something on bingd.' };
  }
}

/**
 * One job's push, or null if it cannot be said.
 *
 * Null for a job with no nameable actor. Every eligible type is somebody doing something,
 * and a notification that cannot say who is not worth waking a phone for — the same rule
 * the inbox applies when it drops a row whose actor it cannot name.
 */
export function contentFor(job: PushJob): PushContent | null {
  const name = job.actor_name?.trim() || job.actor_username?.trim() || null;
  if (!name && job.type !== 'invite_welcome') return null;
  if (!name) return null;

  const subject = subjectName(job);
  const { title, body } = sentence(job, name, subject);

  return {
    title,
    body,
    data: {
      notificationId: job.notification_id,
      kind: job.type,
      actorUsername: job.actor_username,
      mediaItemId: job.media_item_id,
      // `?? null` rather than passing it through, because a job produced by a database
      // that has not yet applied 20260826000600 has no such key — and `undefined` in a
      // JSON payload is a field that silently disappears rather than one the client can
      // read as absent.
      feedEventId: job.feed_event_id ?? null,
    },
  };
}
