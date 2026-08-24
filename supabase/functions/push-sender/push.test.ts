/**
 * The two pure halves of the sender: what a push says, and how a provider answer is read.
 *
 * Both are worth asserting for the same reason `normalize.test.ts` gives — they do
 * something a reader cannot verify by eye. `contentFor` decides what appears on a locked
 * screen, and `isDeadToken` decides whether somebody's phone stops receiving
 * notifications for ever.
 *
 * Run with:
 *   npx deno test --config supabase/functions/push-sender/deno.json --allow-net \
 *     supabase/functions/push-sender
 */

import { assert, assertEquals } from '@std/assert';

import { contentFor, subjectName, type PushJob } from './copy.ts';
import {
  chunk,
  isDeadToken,
  isRetryable,
  redactTokens,
  sendChunk,
  type ExpoTicket,
} from './expo.ts';
import { summarise, type Addressed } from './batch.ts';

const job = (overrides: Partial<PushJob> = {}): PushJob => ({
  notification_id: '11111111-1111-1111-1111-111111111111',
  type: 'follow',
  actor_username: 'ada',
  actor_name: 'Ada Lovelace',
  media_item_id: null,
  media_kind: null,
  media_title: null,
  series_title: null,
  tokens: [{ token: 'ExponentPushToken[aaa]', platform: 'ios' }],
  ...overrides,
});

// ---------------------------------------------------------------------------
// What a push says
// ---------------------------------------------------------------------------

Deno.test('every eligible type says something in the second person', () => {
  const expected: Record<string, [string, string]> = {
    follow: ['Ada Lovelace', 'started following you'],
    follow_request: ['Ada Lovelace', 'wants to follow you'],
    comment: ['Ada Lovelace', 'commented on your activity'],
    reaction: ['Ada Lovelace', 'reacted to your activity'],
    watch_tag: ['Ada Lovelace', 'watched something with you'],
    recommendation: ['Ada Lovelace', 'recommended something to watch'],
    invite_activated: ['Ada Lovelace', 'joined bingd. from your invite'],
    invite_welcome: ['Welcome to bingd.', 'Ada Lovelace invited you'],
  };

  for (const [type, [title, body]] of Object.entries(expected)) {
    const content = contentFor(job({ type }));
    assert(content, `${type} produced no push`);
    assertEquals(content.title, title, type);
    assertEquals(content.body, body, type);
  }
});

Deno.test('names the title where there is one', () => {
  const content = contentFor(
    job({ type: 'recommendation', media_kind: 'movie', media_title: 'Stalker' }),
  );
  assertEquals(content?.body, 'recommended Stalker');
});

Deno.test("a season carries its show's name, because its own is Season 2", () => {
  assertEquals(
    subjectName(job({ media_kind: 'season', media_title: 'Season 2', series_title: 'Severance' })),
    'Severance, S2',
  );
  // TMDB names a limited series' single season after the show, and "Chernobyl,
  // Chernobyl" is what naive joining produces.
  assertEquals(
    subjectName(job({ media_kind: 'season', media_title: 'Chernobyl', series_title: 'Chernobyl' })),
    'Chernobyl',
  );
  // A movie is never joined to anything.
  assertEquals(subjectName(job({ media_kind: 'movie', media_title: 'Stalker' })), 'Stalker');
});

Deno.test('falls back to the handle when there is no display name', () => {
  assertEquals(contentFor(job({ actor_name: null }))?.title, 'ada');
});

Deno.test('says nothing at all when it cannot name the actor', () => {
  assertEquals(contentFor(job({ actor_name: null, actor_username: null })), null);
});

/**
 * The privacy assertion, written as a whitelist rather than a blacklist.
 *
 * A blacklist ("does not contain the note") passes the day somebody adds a field the
 * blacklist has not heard of. This fails the moment the payload grows a fifth key, which
 * is the point: a push is read on a locked screen and its contents are a decision, not a
 * default.
 */
Deno.test('the tap payload carries four fields and no more', () => {
  const content = contentFor(job({ media_item_id: '22222222-2222-2222-2222-222222222222' }));
  assertEquals(Object.keys(content!.data).sort(), [
    'actorUsername',
    'kind',
    'mediaItemId',
    'notificationId',
  ]);
});

// ---------------------------------------------------------------------------
// Reading a provider answer
// ---------------------------------------------------------------------------

const ok: ExpoTicket = { status: 'ok', id: 'r1' };
const gone: ExpoTicket = {
  status: 'error',
  message: 'not registered',
  details: { error: 'DeviceNotRegistered' },
};
const rateLimited: ExpoTicket = {
  status: 'error',
  message: 'slow down',
  details: { error: 'MessageRateExceeded' },
};
const shapeless: ExpoTicket = { status: 'error', message: 'something' };

Deno.test('only DeviceNotRegistered kills a token', () => {
  assert(isDeadToken(gone));
  for (const ticket of [ok, rateLimited, shapeless]) {
    assert(!isDeadToken(ticket), JSON.stringify(ticket));
  }
});

Deno.test('a dead token is settled rather than retried', () => {
  assert(!isRetryable(gone), 'retrying a dead token would repeat for ever');
  assert(isRetryable(rateLimited));
  assert(isRetryable(shapeless));
  assert(!isRetryable(ok));
});

Deno.test('chunks at the size Expo accepts', () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  assertEquals(
    chunk(items).map((c) => c.length),
    [100, 100, 50],
  );
  assertEquals(chunk([]).length, 0);
});

// ---------------------------------------------------------------------------
// The transport, against a stub
// ---------------------------------------------------------------------------

const stub = (handler: () => Response | Promise<Response>) => (() => handler()) as typeof fetch;

Deno.test('returns tickets in order for a good response', async () => {
  const outcome = await sendChunk(
    [
      { to: 'a', title: 't', body: 'b', data: {} },
      { to: 'b', title: 't', body: 'b', data: {} },
    ],
    stub(() => Response.json({ data: [ok, gone] })),
  );

  assertEquals(outcome.failure, null);
  assertEquals(outcome.tickets, [ok, gone]);
});

/**
 * The mapping back to notifications and tokens is by index, so a short array would
 * attribute one person's failure to another person's push — and would do it silently.
 */
Deno.test('refuses a response with the wrong number of tickets', async () => {
  const outcome = await sendChunk(
    [
      { to: 'a', title: 't', body: 'b', data: {} },
      { to: 'b', title: 't', body: 'b', data: {} },
    ],
    stub(() => Response.json({ data: [ok] })),
  );

  assertEquals(outcome.tickets, []);
  assert(outcome.failure?.includes('1 tickets for 2 messages'));
});

Deno.test('reports a transport failure rather than throwing', async () => {
  const outcome = await sendChunk(
    [{ to: 'a', title: 't', body: 'b', data: {} }],
    stub(() => {
      throw new Error('econnreset');
    }),
  );

  assertEquals(outcome.tickets, []);
  assert(outcome.failure?.includes('econnreset'));
});

Deno.test('bounds what it repeats from an error body', async () => {
  const outcome = await sendChunk(
    [{ to: 'a', title: 't', body: 'b', data: {} }],
    stub(() => new Response('x'.repeat(5000), { status: 502 })),
  );

  assert(outcome.failure);
  assert(outcome.failure.length < 300, `failure was ${outcome.failure.length} characters`);
});

/**
 * Review 40 found these: every `failure` string is built from the provider's own words and
 * is then written to a function log, and Expo names the token it is rejecting. A log
 * outlives the request, so an unredacted failure puts a device address somewhere nobody
 * would look for one. The client has had a redactor since a test caught the same leak
 * there; these are the sender's half.
 */
Deno.test('redaction takes an Expo token out of a message, whichever spelling', () => {
  assertEquals(
    redactTokens('"ExponentPushToken[abc-123]" is not a registered recipient'),
    '"[token]" is not a registered recipient',
  );
  assertEquals(redactTokens('bad ExpoPushToken[xyz]'), 'bad [token]');
});

Deno.test('redaction also takes a long opaque run, which is what a raw APNs token is', () => {
  const apns = 'a'.repeat(64);
  assert(!redactTokens(`rejected ${apns}`).includes(apns));
});

Deno.test('an error body that names a token does not reach the failure string', async () => {
  const outcome = await sendChunk(
    [{ to: 'a', title: 't', body: 'b', data: {} }],
    stub(
      () =>
        new Response('unregistered: "ExponentPushToken[secret-device-address]"', {
          status: 400,
        }),
    ),
  );

  assert(outcome.failure);
  assert(
    !outcome.failure.includes('ExponentPushToken['),
    `failure carried a token: ${outcome.failure}`,
  );
  assert(!outcome.failure.includes('secret-device-address'));
});

Deno.test("a provider's own error message is redacted too", async () => {
  const outcome = await sendChunk(
    [{ to: 'a', title: 't', body: 'b', data: {} }],
    stub(
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: 'ExponentPushToken[nope] is invalid' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );

  assert(outcome.failure);
  assert(!outcome.failure.includes('ExponentPushToken['), outcome.failure);
});

Deno.test('sends nothing for an empty chunk', async () => {
  const outcome = await sendChunk(
    [],
    stub(() => {
      throw new Error('should not have been called');
    }),
  );
  assertEquals(outcome, { tickets: [], failure: null });
});

// ---------------------------------------------------------------------------
// Deciding what a batch's outcome was
// ---------------------------------------------------------------------------

const addressed = (notificationId: string, token: string): Addressed => ({
  notificationId,
  token,
  message: { to: token, title: 't', body: 'b', data: {} },
});

/** Reads outcomes out of a list, in the shape `summarise` asks for. */
const from = (outcomes: ExpoTicket[]) => (index: number) => ({
  retryable: isRetryable(outcomes[index]),
  dead: isDeadToken(outcomes[index]),
  message: outcomes[index].status === 'error' ? outcomes[index].message : null,
});

Deno.test('a clean send is delivered and revokes nothing', () => {
  const { results, deadTokens } = summarise([addressed('n1', 'a')], from([ok]));

  assertEquals(results, [{ notification_id: 'n1', delivered: true, error: null }]);
  assertEquals(deadTokens, []);
});

Deno.test('a wholly failed send is retried, carrying why', () => {
  const { results } = summarise([addressed('n1', 'a')], from([rateLimited]));

  assertEquals(results[0].delivered, false);
  assertEquals(results[0].error, 'slow down');
});

Deno.test('every token dead is settled rather than retried, and all are revoked', () => {
  const { results, deadTokens } = summarise(
    [addressed('n1', 'a'), addressed('n1', 'b')],
    from([gone, gone]),
  );

  assertEquals(results[0].delivered, true, 'retrying dead tokens would repeat for ever');
  assertEquals(deadTokens.sort(), ['a', 'b']);
});

/**
 * The case an independent review found. The queue is keyed on the notification, so a retry
 * re-sends to **every** live token — and the phone that already received it buzzes again,
 * on every attempt, up to three times for one event.
 *
 * The in-app row is the notification and it is already on both devices. A missed buzz on a
 * second phone is the better failure.
 */
Deno.test('a partial success is not retried, so the device that got it is not buzzed twice', () => {
  const { results } = summarise(
    [addressed('n1', 'a'), addressed('n1', 'b')],
    from([ok, rateLimited]),
  );

  assertEquals(results.length, 1);
  assertEquals(results[0].delivered, true);
  // Still recorded, so a half-failing send is diagnosable rather than silent.
  assertEquals(results[0].error, 'slow down');
});

Deno.test('one device dead beside one that worked is delivered, and the dead one revoked', () => {
  const { results, deadTokens } = summarise(
    [addressed('n1', 'a'), addressed('n1', 'b')],
    from([ok, gone]),
  );

  assertEquals(results[0].delivered, true);
  assertEquals(deadTokens, ['b']);
});

Deno.test('two notifications in one batch are settled independently', () => {
  const { results } = summarise(
    [addressed('n1', 'a'), addressed('n2', 'b')],
    from([ok, rateLimited]),
  );

  assertEquals(results.length, 2);
  assertEquals(results.find((r) => r.notification_id === 'n1')?.delivered, true);
  assertEquals(results.find((r) => r.notification_id === 'n2')?.delivered, false);
});
