/**
 * The Expo Push Service, and the only place this project talks to it.
 *
 * ---------------------------------------------------------------------------
 * WHY EXPO PUSH AND NOT APNs AND FCM DIRECTLY
 *
 * Sending to APNs means holding a `.p8`, signing a JWT, keeping an HTTP/2 connection and
 * re-signing every hour. Sending to FCM v1 means a service-account key and an OAuth token
 * exchange. Both mean this function holds two more long-lived private credentials, and
 * both mean the client has to hand up a **native** device token — which is the one shape
 * of token that is different on every platform and every build variant.
 *
 * Expo's service takes one opaque `ExponentPushToken[...]`, works out which transport it
 * belongs to, and is already the thing `expo-notifications` mints tokens for. The
 * credentials live in EAS rather than here, which is why this file holds no secret at all
 * — the only thing it needs is the token the device already gave us. That is the same
 * argument AD-8 makes for keeping the TMDB key in one Edge Function, applied to two
 * credentials instead of one.
 *
 * The cost is a dependency on a third party for delivery. It is a real one, it is stated,
 * and the mitigation is that nothing about the schema assumes it: `device_tokens` holds a
 * token and a platform, and swapping transports is a change to this file.
 *
 * ---------------------------------------------------------------------------
 * NO VENDOR SDK
 *
 * `expo-server-sdk` exists and is not used. It is a Node package with a retry policy, a
 * rate limiter and a receipts poller of its own, and this function needs about forty
 * lines of it. Two HTTP shapes, written out, are easier to reason about than a dependency
 * whose behaviour under failure has to be read anyway.
 */

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/**
 * Everything below returns a `failure` string that `index.ts` writes to the function log,
 * and two of those strings are built from **the provider's own words**: the body of a
 * non-2xx response, and `errors[0].message`. Expo names the token it is complaining about
 * — `"ExponentPushToken[...]" is not a registered push notification recipient` is one of
 * its ordinary replies — so those two paths copy an operational secret into a log that
 * outlives the request.
 *
 * This is the same two-pass redaction `src/features/notifications/push.ts` applies on the
 * client, and it is here for the same reason it is there: a token is a device address, a
 * log is not the place for one, and nothing on screen or in a diff would have shown it.
 * The first pass takes an Expo token by its literal shape; the second takes any long
 * opaque run, which is what a raw APNs token, an FCM token and a JWT all look like.
 */
export function redactTokens(message: string): string {
  return message
    .replace(/Expo(nent)?PushToken\[[^\]]*\]/g, '[token]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

/**
 * Expo's documented ceiling for one request. Exceeding it is rejected outright rather
 * than truncated, so this is a hard chunk size rather than a tuning knob.
 */
export const MAX_MESSAGES_PER_REQUEST = 100;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound?: 'default';
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
};

/** One ticket, as Expo returns it. `id` is a receipt id, which v1 does not poll. */
export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type SendOutcome = {
  /** Indexed in step with the messages that were sent. */
  tickets: ExpoTicket[];
  /** Set when the whole request failed and there are no tickets to read. */
  failure: string | null;
};

/** Splits into requests Expo will accept. Exported so the size is testable. */
export function chunk<T>(items: T[], size = MAX_MESSAGES_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Whether Expo is telling us this device is gone for good.
 *
 * `DeviceNotRegistered` is the one error that is about the *token* rather than about the
 * attempt: the app was uninstalled, or the token was rolled. Everything else —
 * `MessageTooBig`, `MessageRateExceeded`, a 5xx — is about this send and says nothing
 * about whether the device still exists.
 *
 * Getting this wrong in the permissive direction is expensive and silent: revoking a live
 * token stops that phone receiving anything, for ever, with no error anywhere. So this
 * matches one string and nothing else.
 */
export function isDeadToken(ticket: ExpoTicket): boolean {
  return ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered';
}

/**
 * Whether a ticket leaves anything worth retrying.
 *
 * A dead token is *settled*, not failed: sending to it again would produce the same
 * answer for ever, and the token is revoked in the same breath so the next claim will not
 * find it. Only a genuine error is worth another attempt.
 */
export function isRetryable(ticket: ExpoTicket): boolean {
  return ticket.status === 'error' && !isDeadToken(ticket);
}

/**
 * One request's worth of messages.
 *
 * Errors are returned rather than thrown. A batch is many people's notifications and one
 * unreachable host must not lose the settlement for the rest — the caller records the
 * failure, the rows go back to pending, and the next drain tries again.
 */
export async function sendChunk(
  messages: ExpoMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  if (messages.length === 0) return { tickets: [], failure: null };

  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Expo's own guidance. The payload is mostly repeated field names, so this is a
        // large saving on a hundred-message request.
        'Accept-Encoding': 'gzip, deflate',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    return { tickets: [], failure: redactTokens(`push transport: ${(e as Error).message}`) };
  }

  if (!response.ok) {
    // The body can carry a structured reason, and it can also carry an HTML error page
    // from something in front of Expo. Bounded, so neither ends up in a log entry
    // measured in kilobytes.
    const text = await response.text().catch(() => '');
    return {
      tickets: [],
      failure: redactTokens(`push ${response.status}: ${text.slice(0, 200)}`),
    };
  }

  let payload: { data?: ExpoTicket[]; errors?: { message?: string }[] };
  try {
    payload = await response.json();
  } catch (e) {
    return {
      tickets: [],
      failure: redactTokens(`push response was not json: ${(e as Error).message}`),
    };
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    return {
      tickets: [],
      failure: redactTokens(`push rejected: ${payload.errors[0]?.message ?? 'unknown'}`),
    };
  }

  const tickets = payload?.data;
  if (!Array.isArray(tickets)) {
    return { tickets: [], failure: 'push response had no tickets' };
  }

  /**
   * Expo returns one ticket per message, in order, and the caller maps them back by
   * index. A short array would silently attribute one message's outcome to another — so
   * it is refused rather than zipped against.
   */
  if (tickets.length !== messages.length) {
    return {
      tickets: [],
      failure: `push returned ${tickets.length} tickets for ${messages.length} messages`,
    };
  }

  return { tickets, failure: null };
}
