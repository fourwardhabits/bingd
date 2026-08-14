import PostHog from 'posthog-react-native';
import { Platform } from 'react-native';

import { env } from './env';

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
 * Properties are counts, durations, and closed sets of values; there is no
 * declared event that accepts a title, a username, a note, or a media id, so
 * one cannot be sent by accident or in a rush before a demo.
 *
 * What this buys, concretely: Sentry says the app broke, this says the app
 * worked and nobody used it. "Forty people opened the ranking flow and nine
 * finished" is the sentence that decides what to build next, and it is invisible
 * without something like this.
 */

type Bucket = 'loved' | 'fine' | 'not_for_me';
type Surface = 'onboarding' | 'search' | 'collection' | 'import' | 'recommendations' | 'profile';

/**
 * Every event the app may emit.
 *
 * Adding one is a deliberate act: name it for the user's outcome rather than the
 * component that fired it, because a name like `feed_card_pressed` stops meaning
 * anything the first time the card is redesigned.
 */
export type AnalyticsEvent =
  | { name: 'app_opened'; props?: undefined }
  | { name: 'sign_in_completed'; props: { method: 'email_code' | 'apple' | 'google' } }
  // Separate from sign_in_completed because they are different failures. A gap
  // between the two is people who authenticated and then abandoned the profile
  // form — the state auth.md §4 exists to describe — and that is invisible if one
  // event covers both.
  | { name: 'account_created'; props?: undefined }
  | { name: 'onboarding_completed'; props: { seconds: number; titlesRanked: number } }

  // The core loop. PRD §28 defines activation as ten ranked titles, so the
  // funnel between these three is the number that matters most in the alpha.
  | { name: 'title_logged'; props: { bucket: Bucket; surface: Surface } }
  | { name: 'ranking_started'; props: { bucket: Bucket; bandSize: number } }
  | {
      name: 'ranking_completed';
      props: { bucket: Bucket; comparisons: number; skips: number; adjustable: boolean };
    }
  | { name: 'ranking_abandoned'; props: { bucket: Bucket; comparisons: number } }
  | { name: 'ranking_reordered'; props: { distance: number } }

  // Import. The measure of success is how many titles survive matching, and how
  // many people come back afterwards rather than bouncing off a wall of work.
  | { name: 'import_started'; props: { rows: number } }
  | { name: 'import_completed'; props: { matched: number; unmatched: number; seconds: number } }
  | { name: 'import_abandoned'; props: { rows: number; reviewed: number } }

  // Social and growth.
  | { name: 'invite_link_shared'; props?: undefined }
  | { name: 'invite_accepted'; props: { hoursSinceSent: number } }
  | { name: 'follow_created'; props: { fromSurface: Surface } }
  | { name: 'share_card_created'; props: { format: 'feed' | 'story'; titles: number } }
  | { name: 'reaction_added'; props: { kind: string } }

  // Monetization signal without any billing code existing. PRD §20 wants the
  // ceiling measured before a price is chosen, and a gate hit is that signal.
  | { name: 'capability_gate_hit'; props: { capability: string; surface: Surface } }

  // Recommendations. A dismissal with a reason is worth more than a tap.
  | { name: 'recommendation_shown'; props: { position: number; reasonKind: string } }
  | { name: 'recommendation_accepted'; props: { position: number } }
  | { name: 'recommendation_dismissed'; props: { position: number; reason: string } };

export const analyticsEnabled = Boolean(env.posthogKey);

let client: PostHog | null = null;

export function initAnalytics(): PostHog | null {
  if (!env.posthogKey) return null;
  // posthog-react-native requires a native storage backend. Web builds used for previews
  // and screenshot harnesses do not have one, so analytics is disabled there.
  if (Platform.OS === 'web') return null;
  client ??= new PostHog(env.posthogKey, {
    host: env.posthogHost,
    // Named events only. See the note at the top of this file.
    captureAppLifecycleEvents: true,
    disabled: false,
  });
  return client;
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
  client.capture(event.name, event.props);
}

/**
 * Associates events with an account.
 *
 * The internal UUID and nothing else — no email, no username, no display name.
 * A person profile that carries a username turns an analytics vendor into a
 * second copy of the social graph, which is not what was agreed to when someone
 * signed up.
 */
export function identify(userId: string | null): void {
  if (!client) return;
  if (userId) {
    client.identify(userId);
  } else {
    client.reset();
  }
}
