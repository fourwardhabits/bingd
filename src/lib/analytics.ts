import PostHog from 'posthog-react-native';
import { Platform } from 'react-native';

import { env } from './env';
import { releaseContext } from './release';

/**
 * Product analytics, against a first-party event schema (decision log §24).
 *
 * The schema is the point of this file. Autocapture is off, deliberately: in a
 * mobile app it records the text of whatever was tapped, which here means film
 * titles out of somebody's private collection. PRD §22 does not permit that to
 * leave the device, and "we only look at aggregates" is not a control.
 *
 * So every event is declared below, and **the type is the enforcement**. There
 * is no `track(name: string, props: object)` overload to reach for in a hurry.
 * Properties are counts, closed sets of values and booleans; there is no declared
 * event that accepts a title, a username, a note, a bio or a search query, so one
 * cannot be sent by accident or in a rush before a demo.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS SET IS SIZED TO ANSWER
 *
 * One question, for the friend beta and nothing beyond it: **do people activate,
 * run the core loop, use the social side — and which build were they on when they
 * did it.** Eleven events. Not a funnel platform, not retention infrastructure,
 * not an attribution model; those are in `docs/product/deferred-roadmap.md` with
 * the reasons they are not here.
 *
 * The vocabulary and the exact once-per semantics of every event are written down
 * in `docs/product/analytics.md`, which is the founder-readable half of this file.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN EVENT IS ALLOWED TO MEAN
 *
 * Review 21 spent seven rounds on one sentence: **a client's observation is not
 * proof of a server outcome.** That rule has a weaker but real analytics form.
 *
 * Analytics does not need ledger semantics — nobody is paid out of this data — but
 * an event must not be *obviously* wrong in the direction that flatters. So every
 * emission here sits behind an outcome the server actually confirmed, and none of
 * them sits on a reconciliation path. The consequence is stated rather than
 * hidden: a write that commits and loses its reply is **under-counted**, because
 * the client that could not hear the answer does not claim one. Undercounting a
 * lost reply is a small bias in a known direction; double-counting a retry is a
 * number that looks like growth and is not.
 */

// ---------------------------------------------------------------------------
// Common property vocabularies
// ---------------------------------------------------------------------------

/** A film or one season of a show. A series is neither — it is not loggable (AD-1). */
export type MediaKind = 'movie' | 'tv_season';

/**
 * Where in the app the action was taken.
 *
 * Named for the surface a person would recognise rather than for the component or the
 * route, because a component gets renamed in a redesign and the historical data then
 * refers to something that no longer exists.
 */
export type Surface =
  | 'search'
  | 'collection'
  | 'feed'
  | 'for_you'
  | 'sent_to_you'
  | 'profile'
  | 'title'
  | 'onboarding'
  | 'awards'
  /**
   * The notification inbox, which is a real origin rather than a category padded out
   * for symmetry: following back from a "started following you" row is how a beta
   * network actually closes into mutuals, and it is the only follow entry point that
   * is not somebody's profile.
   */
  | 'notifications';

export type SignInMethod = 'email_code' | 'password' | 'apple' | 'google';

/**
 * Which monthly leaderboard is being looked at.
 *
 * The server's own metric names, so the event, the chip and the RPC argument are one
 * string. A separate analytics vocabulary here would be a fourth spelling of the same
 * four things and the first one to drift.
 */
export type LeaderboardMetricName = 'titles' | 'movies' | 'tv' | 'reviews';

/** The three bands. `not_for_me` is the database's spelling and the one used here. */
export type Bucket = 'loved' | 'fine' | 'not_for_me';

/**
 * Where a person came from, when that is ever known.
 *
 * **One value has a writer, and only one.** `invite` is set by `redeem_invite`
 * succeeding (`features/invite/redeem.ts`), which is the single mechanism that
 * establishes how somebody arrived without inferring it. Every other value is still
 * unset and must stay that way until something can state it: deriving a source from
 * behaviour ("they followed three people quickly, so it must be a friend referral") is
 * the thing this type exists to make somebody argue for out loud rather than do
 * quietly.
 */
export type AcquisitionSource =
  | 'friend_direct'
  | 'launch_party'
  | 'beli'
  | 'letterboxd'
  | 'amc_alist'
  | 'reddit'
  | 'instagram'
  | 'organic_store'
  | 'invite'
  | 'other';

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/**
 * Every event the app may emit.
 *
 * Adding one is a deliberate act: name it for the user's outcome rather than for the
 * component that fired it, and be able to say what it does **not** mean. Both halves
 * are written down per event in `docs/product/analytics.md`.
 */
export type AnalyticsEvent =
  // --- Activation ---------------------------------------------------------
  /**
   * A Supabase session exists. **Not** an account: `profiles.id` references
   * `auth.users(id)` and the profile is created afterwards, so there is a real and
   * persistent state in between (auth.md §4). Kept separate from `signup_completed`
   * because the gap between the two *is* a metric — people who authenticated and then
   * abandoned the profile form.
   */
  | { name: 'sign_in_completed'; props: { method: SignInMethod } }
  /**
   * `create_profile` answered `created`. The account now exists.
   *
   * Not an install, not a sign-in, and **not** `already_exists` — that answer means the
   * profile was already there, which is a replay rather than a signup.
   */
  | { name: 'signup_completed'; props?: undefined }
  /**
   * The first-run taste flow ended, by either exit.
   *
   * `skipped` is what distinguishes them, and it is one event rather than two so the
   * denominator cannot drift: everybody who reaches the end of the flow is in here.
   */
  | { name: 'onboarding_completed'; props: { skipped: boolean; titles_ranked: number } }

  // --- Core loop ----------------------------------------------------------
  /**
   * A title was given a bucket, which is what puts it in the collection.
   *
   * **Not** a ranking — a bucket is a band, not a position (PRD §11) — and not the log
   * sheet opening.
   */
  | {
      name: 'title_logged';
      props: { media_kind: MediaKind; surface: Surface; bucket: Bucket };
    }
  /**
   * One canonical exact ranking completed: the server answered `placed`, and the title
   * has a position.
   *
   * **Not** the ranking sheet opening, not a comparison answered, and not a session
   * that was abandoned or cancelled. `rebucket` says whether this was a first placement
   * or a title moving band, which are different actions with the same completion.
   */
  | {
      name: 'ranking_completed';
      props: {
        media_kind: MediaKind;
        surface: Surface;
        comparisons: number;
        rebucket: boolean;
      };
    }
  /**
   * Added to the watchlist. Removal is not an event — nothing in the beta asks.
   *
   * **No `media_kind`, deliberately.** The watchlist accepts a series as well as a film
   * or a season ("want to watch this show" is coherent even though logging is
   * season-level), so the kind here would need a third value that no other event has —
   * and two of the four surfaces that offer the bookmark hold only a media id anyway.
   * A property that is right on two screens and guessed on the other two is worse than
   * an absent one.
   */
  | { name: 'watchlist_added'; props: { surface: Surface } }

  // --- Social and discovery -----------------------------------------------
  /**
   * A `follow` committed.
   *
   * `state` is the honest half: following a private account creates a **request**, not
   * a follow, and counting the two together would report a network that does not exist
   * yet.
   */
  | { name: 'follow_created'; props: { surface: Surface; state: 'approved' | 'pending' } }
  /**
   * `recommend_title` stored a recommendation. **Not** the share sheet opening, and not
   * a refusal — `recommend_title` returns `not_mutual` inside a 200, so a 200 is not a
   * send (`use-recommend.ts`).
   */
  | { name: 'recommendation_sent'; props: { media_kind: MediaKind; surface: Surface } }
  /**
   * The **recipient** tapped through to a recommendation they had not opened before.
   * Owned by the recipient, not by the sender. Not a delivery and not an impression.
   */
  | { name: 'recommendation_opened'; props: { media_kind: MediaKind; surface: Surface } }
  /**
   * A member search result was opened.
   *
   * Here because member search shipped in this tranche and "did anybody use it" is a
   * question the beta actually has to answer. `position` and nothing else: **the query
   * text is never sent** — see `FORBIDDEN_PROPERTY_KEYS`.
   */
  | { name: 'member_search_result_opened'; props: { surface: Surface; position: number } }

  // --- Growth -------------------------------------------------------------
  /**
   * `create_invite_link` minted or returned the caller's link **and recorded the
   * creation**. It is the strongest growth-intent signal that exists without a web
   * property, and it is deliberately not called a send: opening a share sheet is not an
   * invitation delivered (`growth-instrumentation.md`).
   *
   * A replayed operation id answers `already_applied` and writes no creation row, so it
   * emits nothing — the event follows the row, not the tap.
   */
  | { name: 'invite_link_created'; props: { surface: Surface; has_title: boolean } }
  /**
   * A real account claimed a valid invitation and `invite_attributions` gained a row.
   *
   * The redemption, not the open and not the install. `redeem_invite` answers `ok`
   * exactly for the call whose insert landed, so a replay, a second device and a lost
   * reply all emit nothing — the event follows the row, as `invite_link_created` does.
   *
   * **No properties at all.** The inviter is another person, and the token is in
   * `FORBIDDEN_PROPERTY_KEYS`. What the founder needs from this event is that it
   * happened and who it is attributed to, and the second half is a database join rather
   * than a property on a vendor's timeline.
   */
  | { name: 'invite_redeemed'; props?: undefined }
  /**
   * An attributed invitee reached activation: ten ranked titles (PRD §28).
   *
   * Emitted by the **invitee's** session, because they are the one who ranked. The
   * server decides: `_rank_finalize` returns `activated: true` only for the transaction
   * whose guarded UPDATE flipped `activated_at`, so two devices finishing the tenth
   * ranking at the same moment produce one event and a retry produces none.
   *
   * Nothing is inferred here. An app that counted rankings client-side would emit this
   * for accounts with no attribution at all, and would emit it again after a reinstall.
   */
  | { name: 'invite_activated'; props?: undefined }

  // --- Experiments ----------------------------------------------------------
  /**
   * The Leaderboard was opened from the Feed's toggle.
   *
   * One of this tranche's two explicit experiments (founder §27), and the only one that
   * needs an event at all: the board is behind a control nothing else leads to, so
   * "did anybody find it" has no other answer. Carries the metric it opened on — which
   * is always the default today, and will not be if the surface ever remembers a choice.
   *
   * Emitted on entering the mode, not per render and not on every chip. Leaving and
   * returning is a second view, because it is a second decision to look.
   */
  | { name: 'leaderboard_viewed'; props: { metric: LeaderboardMetricName } }
  /**
   * A different metric chip was chosen.
   *
   * The question is which of the four people actually care about, which is what decides
   * whether the set stays at four. Only a *change* — re-tapping the chip you are on
   * emits nothing, or the count would measure fidgeting.
   */
  | { name: 'leaderboard_metric_selected'; props: { metric: LeaderboardMetricName } };

/** The emittable names, for tests and for the spec to be checked against. */
export const ANALYTICS_EVENTS = [
  'sign_in_completed',
  'signup_completed',
  'onboarding_completed',
  'title_logged',
  'ranking_completed',
  'watchlist_added',
  'follow_created',
  'recommendation_sent',
  'recommendation_opened',
  'member_search_result_opened',
  'invite_link_created',
  'invite_redeemed',
  'invite_activated',
] as const satisfies readonly AnalyticsEvent['name'][];

/**
 * Named, specified, and **not emittable** — deliberately absent from the union above.
 *
 * Each one describes a state this app cannot currently observe. Declaring the name
 * without the ability to send it is the point: it records the taxonomy on the day the
 * state exists, and it makes emitting one a compile error until then rather than a
 * judgement somebody makes at 2am before a demo.
 *
 * **`invite_redeemed` and `invite_activated` left this list on 2026-08-19**, which is
 * the mechanism working as designed: `20260819000500` gave both of them a writer, so
 * both moved into the union above and became emittable in the same change that made
 * them true. One entry remains.
 */
export const DEFERRED_EVENTS = {
  /**
   * An award tier was crossed. The durable ledger exists now (20260828000100) and
   * the crossing happens SERVER-side, inside whichever write moved the metric —
   * three of the twenty tracks cross on somebody else's action, with the earner's
   * app not even running. Client analytics can only observe the aftermath (a
   * notification arriving), and an event emitted from an observation is the
   * observed-state bug this file's history is about. Deferred until there is a
   * client-side moment that IS the crossing, or a server-side analytics path.
   */
  award_earned: 'crossed server-side (20260828000100); no honest client emission point',
} as const;

// ---------------------------------------------------------------------------
// The privacy boundary, enforced at runtime as well as in the type
// ---------------------------------------------------------------------------

/**
 * Every property key any declared event may carry, plus the release context.
 *
 * `track` filters against this, which is belt and braces over the union above — and the
 * braces are the part that survives somebody adding a property in a hurry. The type
 * stops a bad *event*; this stops a bad *key* reaching the wire even if the type were
 * widened by accident.
 */
export const ALLOWED_PROPERTY_KEYS: readonly string[] = [
  // Event properties.
  'method',
  'skipped',
  'titles_ranked',
  'media_kind',
  'surface',
  'bucket',
  'comparisons',
  'rebucket',
  'state',
  'position',
  'has_title',
  // Release identity (`lib/release.ts`).
  'environment',
  'platform',
  'app_version',
  'build_number',
  'runtime_version',
  'eas_channel',
  'eas_update_id',
  'build_kind',
  // Future, nullable, set by nobody today.
  'acquisition_source',
  'beta_cohort',
];

/**
 * Keys that must never appear, asserted by test against the list above.
 *
 * This is not a second filter — the allowlist already is one. It is a **statement of
 * what the exclusion is for**, so that widening the allowlist to include one of these
 * has to break a test whose name says why.
 */
export const FORBIDDEN_PROPERTY_KEYS: readonly string[] = [
  'email',
  'username',
  'display_name',
  'name',
  'title',
  'query',
  'search',
  'note',
  'review',
  'comment',
  'bio',
  'dob',
  'date_of_birth',
  'avatar',
  'avatar_path',
  'token',
  'invite_token',
  'password',
  'access_token',
  'phone',
  'media_item_id',
  'recipient_id',
  'actor_id',
];

const allowed = new Set(ALLOWED_PROPERTY_KEYS);

/**
 * The only shapes a property may have.
 *
 * Scalars, and nothing else. An object or an array is how a whole row reaches a vendor
 * by accident — somebody spreads `...profile` into a property bag and the bio travels
 * with it — so the shape is refused outright rather than walked and pruned.
 */
export type PropertyValue = string | number | boolean;

/**
 * Drops anything not declared, and anything that is not a scalar.
 *
 * Null and undefined go too: an absent property is cleaner than a null one, because a
 * null groups in a chart and reads as a value somebody chose.
 */
export function sanitize(
  props: Record<string, unknown> | undefined,
): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** The release fields as a plain bag, so `sanitize` can be the only thing that shapes them. */
const releaseProperties = (): Record<string, unknown> => ({ ...releaseContext() });

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const analyticsEnabled = Boolean(env.posthogKey);

let client: PostHog | null = null;

/**
 * The account currently associated with events, as far as this process knows.
 *
 * Held so that `identify(null)` on a cold start — which `session.tsx` issues before the
 * stored session has resolved — does **not** call `reset()`. Resetting there throws away
 * the anonymous distinct id and the registered super properties on every single launch,
 * which breaks the one thing an anonymous id is for: joining somebody's pre-signup
 * events to their account when they finally create one.
 */
let identified: string | null = null;

export function initAnalytics(): PostHog | null {
  if (!env.posthogKey) return null;
  // posthog-react-native requires a native storage backend. Web builds used for previews
  // and screenshot harnesses do not have one, so analytics is disabled there.
  if (Platform.OS === 'web') return null;
  client ??= new PostHog(env.posthogKey, {
    host: env.posthogHost,
    // Named events only. See the note at the top of this file.
    //
    // Lifecycle events are the one exception and they are kept: Application Installed
    // and Application Opened are generated by the library from state this app does not
    // have, they carry no user content, and "how many launches" is not worth a
    // hand-written event. The custom `app_opened` that used to sit beside them has been
    // removed — two events for one launch is the duplicate-capture problem in miniature,
    // and the library's version is the one that gets background and foreground right.
    captureAppLifecycleEvents: true,
    disabled: false,
  });
  registerRelease();
  return client;
}

/**
 * Release identity as super properties, so that the library-generated lifecycle events
 * carry it too.
 *
 * `track` **also** merges it into each event explicitly, and that is not redundancy for
 * its own sake: `register` is asynchronous and persists, so a first launch can capture a
 * lifecycle event before it lands. Merging per event means a canonical event is never
 * missing its build, whatever the ordering did.
 */
function registerRelease() {
  void client?.register(sanitize(releaseProperties()));
}

export function getAnalytics(): PostHog | null {
  return client;
}

/**
 * The only way to emit an event. Overloaded on the event union so that omitting
 * required properties, or inventing an event, is a compile error.
 */
export function track(event: AnalyticsEvent): void {
  if (!client) return;
  client.capture(event.name, {
    ...sanitize(event.props as Record<string, unknown> | undefined),
    ...sanitize(releaseProperties()),
  });
}

/**
 * Associates events with an account.
 *
 * The internal UUID and nothing else — no email, no username, no display name. A person
 * profile carrying a username turns an analytics vendor into a second copy of the social
 * graph, which is not what was agreed to when somebody signed up.
 *
 * Three transitions, and each one is a decision:
 *
 * - **none → somebody.** `identify`. The anonymous events from before signup join the
 *   account, which is the whole signup funnel.
 * - **somebody → none** (sign-out, and account deletion, which signs out). `reset`, so a
 *   second account on the same device is a separate person to the vendor.
 * - **somebody → somebody else** with no sign-out in between. `reset` *first*. Without
 *   it PostHog aliases the second account onto the first one's anonymous id and the two
 *   people become one for ever — the identity mistake that cannot be undone afterwards.
 *
 * Super properties do not survive `reset`, so the release context is registered again
 * after every one.
 */
export function identify(userId: string | null): void {
  if (!client) {
    identified = userId;
    return;
  }
  if (userId === identified) return;

  if (!userId) {
    client.reset();
    identified = null;
    registerRelease();
    return;
  }

  if (identified) {
    client.reset();
    registerRelease();
  }
  client.identify(userId);
  identified = userId;
}

/**
 * The residual this design does not close, written down rather than assumed away.
 *
 * `identified` is **process-local**, and PostHog's distinct id is **persisted**. The two
 * agree in every sequence a person can actually produce, because a sign-out resets both
 * and a relaunch restores the same account it was killed with — which is why
 * `session.tsx` is careful to call `identify(null)` only once the session is *known* to
 * be absent, rather than while it is still loading. A launch that resolves to signed-out
 * therefore clears any identity a previous process left behind.
 *
 * The sliver that remains is a process killed in the window between a session changing
 * and the effect that reports it: the new account's session persists, the old account's
 * distinct id persists, and the next launch identifies the new account without a reset.
 * Closing it means persisting the identified id to storage and reading it back
 * asynchronously before the first `identify` — real complexity, on a path measured in
 * milliseconds, for a friend beta. Recorded as debt instead.
 */


/** Exported for tests, which must not inherit the previous one's client or identity. */
export function resetAnalyticsForTests() {
  client = null;
  identified = null;
}

/**
 * Where this person came from, and which beta group they belong to.
 *
 * **It has exactly one caller, and it is the one this function was written for.** A
 * successful `redeem_invite` calls it with `'invite'`, and every event this install
 * sends from that point carries the source. Both fields stay nullable by design and
 * neither may be inferred from behaviour; `beta_cohort` and every other source still
 * have no writer, and each needs a founder decision about where the value came from
 * rather than a client-side guess.
 *
 * **Registered rather than sent, so it is not retroactive.** PostHog super-properties
 * attach to events from here on; the `signup_completed` that happened two screens ago
 * does not gain a source. That is the honest shape — the app did not know then — and it
 * means the invite funnel is joined in the database on `invite_attributions`, with this
 * as the cheap cross-check rather than the record.
 */
export function setAcquisition(input: {
  source?: AcquisitionSource | null;
  cohort?: string | null;
}): void {
  if (!client) return;
  void client.register(sanitize({ acquisition_source: input.source, beta_cohort: input.cohort }));
}
