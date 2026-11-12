import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

import { ROUTED_KINDS, type NotificationDestination } from './routing';
import type { NotificationKind } from './use-notifications';

/**
 * A notification was opened (2026-10-28, proactive notifications).
 *
 * Two records for two readers. `record_notification_open` writes the server's, which is
 * the one that matters: it names the notification and the proactive candidate behind it,
 * so a push can be followed through to whether the title was then ranked or watched
 * (`proactive_attribution`), and none of that ever reaches a vendor. The PostHog event is
 * the coarse count beside it — kind, channel, proactive or not.
 *
 * Fire-and-forget, and it never throws. This runs on the tap that opens a screen, and a
 * metric that could delay or fail that tap would be measuring itself.
 */

export type OpenChannel = 'push' | 'inbox';

/** The kinds that are the app speaking rather than a person (20261028000100, 20261031000100). */
export const PROACTIVE_KINDS: ReadonlySet<string> = new Set([
  'watchlist_social',
  'theatrical_release',
  'watchlist_resurface',
  'season_premiere',
]);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export function recordNotificationOpen({
  notificationId,
  kind,
  channel,
  destination,
}: {
  notificationId: unknown;
  kind: unknown;
  channel: OpenChannel;
  /**
   * The kind of screen it led to, from the routing resolver — never a path. The server
   * accepts only this closed vocabulary, so no id, username or free text is ever stored.
   */
  destination: NotificationDestination;
}): void {
  const id = readString(notificationId);
  if (!id) return;

  /**
   * The kind is validated against the closed vocabulary before it goes anywhere (Codex
   * review). A push payload arrives from outside the app, and an unknown or hostile
   * string must not become a PostHog property. The server's own record does not use this
   * value at all: `record_notification_open` reads the kind from the notification row.
   */
  const raw = readString(kind);
  const k = raw && ROUTED_KINDS.includes(raw as NotificationKind) ? (raw as NotificationKind) : null;
  if (k) {
    track({ name: 'notification_opened', props: { kind: k, channel, proactive: PROACTIVE_KINDS.has(k) } });
  }

  try {
    void Promise.resolve(
      supabase.rpc('record_notification_open', {
        p_notification_id: id,
        p_channel: channel,
        p_destination: destination,
      }),
    ).catch(() => undefined);
  } catch {
    // Deliberately silent. See the header.
  }
}
