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
  attempt: 1,
  type: 'follow',
  actor_username: 'ada',
  actor_name: 'Ada Lovelace',
  media_item_id: null,
  media_kind: null,
  media_title: null,
  series_title: null,
  // Null by default, because most eligible types are not about a conversation. The two
  // that are carry it, and the tests below assert both directions.
  feed_event_id: null,
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
    recommendation_ranked: ['Ada Lovelace', 'ranked your recommendation'],
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

// ---------------------------------------------------------------------------
// An award that says so (20260828000100)
// ---------------------------------------------------------------------------

Deno.test('the congratulations is the one actorless push, and names the award', () => {
  // No actor at all — the row is the earner's own — and still a push. The name gate
  // exists to refuse a sentence about nobody; this sentence is about the reader.
  const content = contentFor(
    job({
      type: 'award_earned',
      actor_username: null,
      actor_name: null,
      award_name: 'Movie Muncher',
    }),
  );
  assert(content, 'award_earned produced no push');
  assertEquals(content.title, 'bingd. Awards');
  assertEquals(content.body, 'You earned Movie Muncher');
  // The tap payload keeps the five-field whitelist, honestly null where an award
  // has no person and no title; `kind` alone routes to the reader's own Awards.
  assertEquals(content.data.kind, 'award_earned');
  assertEquals(content.data.actorUsername, null);
  assertEquals(content.data.mediaItemId, null);
  assertEquals(content.data.feedEventId, null);
});

Deno.test('an award job from a database mid-deploy still says something honest', () => {
  const content = contentFor(
    job({ type: 'award_earned', actor_username: null, actor_name: null }),
  );
  assertEquals(content?.body, 'You earned a new Award');
});

Deno.test('names the title where there is one', () => {
  const content = contentFor(
    job({ type: 'recommendation', media_kind: 'movie', media_title: 'Stalker' }),
  );
  assertEquals(content?.body, 'recommended Stalker');
});

// ---------------------------------------------------------------------------
// A recommendation that hears back (20260827000600)
// ---------------------------------------------------------------------------

Deno.test('a fulfilment says the founder’s sentence, title inline', () => {
  const content = contentFor(
    job({ type: 'recommendation_ranked', media_kind: 'movie', media_title: 'The Martian' }),
  );
  assertEquals(content?.title, 'Ada Lovelace');
  assertEquals(content?.body, 'ranked The Martian from your recommendation');
});

Deno.test('a fulfilment names a season through its show, like every other push', () => {
  const content = contentFor(
    job({
      type: 'recommendation_ranked',
      media_kind: 'season',
      media_title: 'Season 1',
      series_title: 'The Legend of Vox Machina',
      feed_event_id: 'event-1',
    }),
  );
  assertEquals(content?.body, 'ranked The Legend of Vox Machina, S1 from your recommendation');
  // The tap payload carries the exact ranking post, and nothing written.
  assertEquals(content?.data.feedEventId, 'event-1');
});

// ---------------------------------------------------------------------------
// The comment is the message (20260827000300)
// ---------------------------------------------------------------------------

Deno.test('a comment push leads with what was written', () => {
  const content = contentFor(
    job({
      type: 'comment',
      media_kind: 'movie',
      media_title: 'Spider-Man: Far From Home',
      comment_excerpt: 'This ending broke me',
    }),
  );

  assertEquals(content?.title, 'Ada Lovelace commented');
  assertEquals(content?.body, '“This ending broke me” · Spider-Man: Far From Home');
});

Deno.test('a comment with no resolvable title still quotes the comment', () => {
  const content = contentFor(job({ type: 'comment', comment_excerpt: 'so good' }));
  assertEquals(content?.body, '“so good”');
});

Deno.test('a long comment is elided by this file, not chopped by the OS', () => {
  const content = contentFor(job({ type: 'comment', comment_excerpt: 'a'.repeat(180) }));
  assert(content);
  assert(content.body.length < 180);
  assert(content.body.includes('…'), 'an elided quote says so');
});

Deno.test('newlines in a comment become one lock-screen line', () => {
  const content = contentFor(job({ type: 'comment', comment_excerpt: 'line one\n\nline two' }));
  assertEquals(content?.body, '“line one line two”');
});

Deno.test('no excerpt falls back to the metadata sentence, never an empty quote', () => {
  // Deleted, spoiler-marked, or a database that predates the migration: the server
  // sends null (or no key at all) and the old sentence stands.
  for (const excerpt of [null, undefined, '', '   ']) {
    const content = contentFor(
      job({
        type: 'comment',
        media_kind: 'movie',
        media_title: 'Stalker',
        comment_excerpt: excerpt as string | null,
      }),
    );
    assertEquals(content?.title, 'Ada Lovelace');
    assertEquals(content?.body, 'commented on your activity — Stalker');
  }
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
Deno.test('the tap payload carries five fields and no more', () => {
  const content = contentFor(job({ media_item_id: '22222222-2222-2222-2222-222222222222' }));
  assertEquals(Object.keys(content!.data).sort(), [
    'actorUsername',
    'feedEventId',
    'kind',
    'mediaItemId',
    'notificationId',
  ]);
});

/**
 * The field the thread page needs, and the reason it is a field rather than a lookup.
 *
 * A tapped push must land where a tapped inbox row lands. Before this the payload carried
 * the title and not the event, so a comment push opened the title page while the same
 * notification in the inbox opened the conversation — two destinations for one event, and
 * the invisible half of the pair, because the inbox is what anybody testing looks at.
 *
 * It is still not content. An id names a row whose every read goes through
 * `activity_comments`, which asks `can_view_profile` about the event before returning
 * anything; the operating system renders it as nothing at all.
 */
Deno.test('a comment push carries the conversation it is about', () => {
  const content = contentFor(
    job({ type: 'comment', feed_event_id: '33333333-3333-3333-3333-333333333333' }),
  );
  assertEquals(content!.data.feedEventId, '33333333-3333-3333-3333-333333333333');
});

/**
 * A job from a database that has not applied `20260826000600` has no such key at all, and
 * `undefined` in a JSON payload is a field that silently disappears rather than one the
 * client can read as absent. `hrefForPush` then falls back to the title, which is the
 * behaviour that shipped before this field existed.
 */
Deno.test('an older job without the field sends an explicit null', () => {
  const older = job();
  delete (older as { feed_event_id?: unknown }).feed_event_id;
  const content = contentFor(older);
  assertEquals(content!.data.feedEventId, null);
  assertEquals('feedEventId' in content!.data, true);
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

// `attempt` defaults to 1 because these fixtures are all a first claim. It is the claim
// generation `settle_push_batch` matches on, and `summarise` has to carry it through
// untouched — a batch whose two devices came from one job must report one attempt, not two.
const addressed = (notificationId: string, token: string, attempt = 1): Addressed => ({
  notificationId,
  attempt,
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

  assertEquals(results, [{ notification_id: 'n1', attempt: 1, delivered: true, error: null }]);
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
