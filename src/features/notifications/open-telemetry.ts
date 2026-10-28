import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

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

/** The kinds that are the app speaking rather than a person (20261028000100). */
export const PROACTIVE_KINDS: ReadonlySet<string> = new Set([
  'watchlist_social',
  'theatrical_release',
  'watchlist_resurface',
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
  destination: unknown;
}): void {
  const id = readString(notificationId);
  const k = readString(kind);
  if (!id || !k) return;

  track({ name: 'notification_opened', props: { kind: k, channel, proactive: PROACTIVE_KINDS.has(k) } });

  try {
    void Promise.resolve(
      supabase.rpc('record_notification_open', {
        p_notification_id: id,
        p_channel: channel,
        p_destination: typeof destination === 'string' ? destination.slice(0, 200) : null,
      }),
    ).catch(() => undefined);
  } catch {
    // Deliberately silent. See the header.
  }
}
