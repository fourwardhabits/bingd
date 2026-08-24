/**
 * Turning a claimed batch into messages, and a provider's answer back into outcomes.
 *
 * Separate from `index.ts` for the reason `normalize.ts` is separate from the adapter, and
 * for one more that an independent review made concrete: `index.ts` calls `Deno.serve` at
 * module scope, so importing it to test a pure function **starts an HTTP server**. The
 * subtle part of this function is the summary below, and it should be assertable without
 * booting anything.
 *
 * Nothing here reads a database, a secret, or the network.
 */

import { contentFor, type PushJob } from './copy.ts';
import type { ExpoMessage } from './expo.ts';

/** One message, and the notification and token it belongs to, so tickets can be mapped back. */
export type Addressed = { notificationId: string; token: string; message: ExpoMessage };

export function messagesFor(jobs: PushJob[]): Addressed[] {
  const out: Addressed[] = [];

  for (const job of jobs) {
    const content = contentFor(job);
    // A job whose actor cannot be named. `claim_push_batch` already refuses these, so
    // this is the second of two — and the cheaper one to be wrong about.
    if (!content) continue;

    for (const device of job.tokens ?? []) {
      out.push({
        notificationId: job.notification_id,
        token: device.token,
        message: {
          to: device.token,
          title: content.title,
          body: content.body,
          data: content.data as unknown as Record<string, unknown>,
          sound: 'default',
          // Android delivers to a channel or not at all. `default` is the one
          // `expo-notifications` creates for us, and the client sets its name.
          channelId: 'default',
          priority: 'high',
        },
      });
    }
  }

  return out;
}

/**
 * What happened to each notification, from the tickets its messages came back with.
 *
 * `delivered` means **there is nothing worth retrying**, which is not the same as "every
 * device got it". Three cases collapse into it, and the third is the interesting one:
 *
 *   · every ticket was accepted;
 *   · nothing was accepted and nothing is retryable — every token was dead, and they are
 *     revoked in this same settlement, so sending again would produce the same answer for
 *     ever;
 *   · **something was accepted and something else failed retryably.**
 *
 * ---------------------------------------------------------------------------
 * WHY A PARTIAL SUCCESS IS NOT RETRIED
 *
 * The queue is keyed on the notification, not on the (notification, token) pair — a row is
 * one thing that happened, and a retry re-sends to **every** live token the recipient has.
 * So retrying a partial failure buzzes the phone that already received it, again, on every
 * attempt. Independent review found exactly that: two devices, one `ok` and one
 * rate-limited, and device one gets the same notification up to three times.
 *
 * Given a choice between one person's second phone missing a buzz and their first phone
 * buzzing three times for one event, the missed buzz is the better failure — and it is the
 * one the product can absorb, because **the in-app row is the notification** and it is
 * already there, on every device, unaffected. Push is transport.
 *
 * The complete fix is per-token attempt tracking, which is a column and a key change in
 * `push_outbox`. It is not worth that here: it buys a second delivery to a second device
 * of a message the account has already received.
 *
 * The error is still recorded when nothing succeeded, so a wholly failed send is
 * diagnosable rather than silent.
 */
export function summarise(
  addressed: Addressed[],
  ticketFor: (index: number) => { retryable: boolean; dead: boolean; message: string | null },
) {
  const byNotification = new Map<
    string,
    { accepted: boolean; retryable: boolean; error: string | null }
  >();
  const deadTokens = new Set<string>();

  addressed.forEach((entry, index) => {
    const outcome = ticketFor(index);
    if (outcome.dead) deadTokens.add(entry.token);

    const accepted = !outcome.retryable && !outcome.dead;
    const current = byNotification.get(entry.notificationId) ?? {
      accepted: false,
      retryable: false,
      error: null,
    };

    byNotification.set(entry.notificationId, {
      accepted: current.accepted || accepted,
      retryable: current.retryable || outcome.retryable,
      error: current.error ?? (outcome.retryable ? outcome.message : null),
    });
  });

  const results = [...byNotification].map(([notification_id, outcome]) => ({
    notification_id,
    delivered: outcome.accepted || !outcome.retryable,
    // Kept even on a delivered-because-partial row: it is why one device did not get it,
    // and `settle_push_batch` ignores the field for a row it is deleting.
    error: outcome.error,
  }));

  return { results, deadTokens: [...deadTokens] };
}
