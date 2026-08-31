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
export type Addressed = {
  notificationId: string;
  /** Carried through so `summarise` can hand it back. See `PushJob.attempt`. */
  attempt: number;
  token: string;
  message: ExpoMessage;
};

/**
 * The messages whose queue row still exists, at the last moment before dispatch.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND CHECK, AFTER THE CLAIM ALREADY SUCCEEDED
 *
 * `claim_push_batch` leases a row for five minutes and hands over its payload. In that
 * window the notification behind a job can be deleted, and since `20260904000100` that is
 * not hypothetical: revoking a collection-derived award tier deletes the congratulations,
 * and `push_outbox` cascades from it. The queue row is gone; the sender is holding a copy
 * of what used to be in it.
 *
 * Independent review 78 found this and was right to call it MAJOR: the migration's own
 * header claimed an already-*delivered* push was the only thing that could not be stopped,
 * and it was wrong by one step.
 *
 * So the ids go back to the database — `live_push_jobs` — and anything without a row is
 * dropped rather than sent. **It is not award-specific**: any notification deleted inside
 * the lease is caught by the same filter.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CHECK SITS, AND WHAT IS HONESTLY LEFT
 *
 * It filters `Addressed` and not `PushJob`, which is the whole reason it is worth
 * having: review 78b pointed out that a check run *before* the messages are built leaves
 * the entire message-building phase inside the window, and that calling the remainder
 * "already in flight" was too generous. So the caller builds every message first and
 * narrows the list immediately before the first `sendChunk`.
 *
 * **The residual window is between this call returning and the HTTP request leaving**, and
 * it cannot be closed: there is no way to make a database read and a network send one
 * atomic act, and neither Apple nor Google offers a recall afterwards. What this buys is
 * that the window is a few milliseconds of dispatch rather than the whole of the sender's
 * work, which is the difference between a race somebody could actually hit and one that
 * needs the send itself to be interrupted.
 *
 * **Nothing is settled for a dropped message.** Its `push_outbox` row is already gone, so
 * there is nothing to mark delivered or failed — settling it would be an update against no
 * row, and reporting it as sent would be a lie in the summary.
 */
export function stillQueued(addressed: Addressed[], live: readonly string[]): Addressed[] {
  const alive = new Set(live);
  return addressed.filter((entry) => alive.has(entry.notificationId));
}

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
        attempt: job.attempt,
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
    { attempt: number; accepted: boolean; retryable: boolean; error: string | null }
  >();
  const deadTokens = new Set<string>();

  addressed.forEach((entry, index) => {
    const outcome = ticketFor(index);
    if (outcome.dead) deadTokens.add(entry.token);

    const accepted = !outcome.retryable && !outcome.dead;
    const current = byNotification.get(entry.notificationId) ?? {
      attempt: entry.attempt,
      accepted: false,
      retryable: false,
      error: null,
    };

    byNotification.set(entry.notificationId, {
      attempt: current.attempt,
      accepted: current.accepted || accepted,
      retryable: current.retryable || outcome.retryable,
      error: current.error ?? (outcome.retryable ? outcome.message : null),
    });
  });

  const results = [...byNotification].map(([notification_id, outcome]) => ({
    notification_id,
    attempt: outcome.attempt,
    delivered: outcome.accepted || !outcome.retryable,
    // Kept even on a delivered-because-partial row: it is why one device did not get it,
    // and `settle_push_batch` ignores the field for a row it is deleting.
    error: outcome.error,
  }));

  return { results, deadTokens: [...deadTokens] };
}
