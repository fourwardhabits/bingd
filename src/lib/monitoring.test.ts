import type { Breadcrumb, ErrorEvent, Event } from '@sentry/react-native';

import { scrub, scrubBreadcrumb, scrubTransaction } from './monitoring';

/**
 * What a crash report is allowed to carry.
 *
 * The interesting assertions are about the **transaction** path, which independent review
 * 24 found unguarded: `beforeSend` does not run for performance transactions, and
 * `tracesSampleRate` is 1.0 outside production, so every trace was leaving with whatever
 * `request` it happened to carry while the error path beside it was carefully filtered.
 *
 * These test the pure shaping functions rather than the SDK. Standing up Sentry to observe
 * what it sends would be testing Sentry; what is worth pinning is the transformation.
 */

const event = (over: Partial<ErrorEvent> = {}): ErrorEvent => ({ ...over }) as ErrorEvent;

describe('scrub', () => {
  it('reduces the user to an id', () => {
    // A crash needs an account to be correlated to. It does not need a name, and a name is
    // a second copy of the social graph inside a vendor nobody agreed to when signing up.
    const scrubbed = scrub(
      event({ user: { id: 'user-1', username: 'ada', email: 'ada@example.com' } }),
    );

    expect(scrubbed.user).toEqual({ id: 'user-1' });
  });

  it('strips the query string from a request url, and the body with it', () => {
    // A route path names an identifier. A query string is where the search screen puts
    // whatever the person typed.
    const scrubbed = scrub(
      event({
        request: {
          url: 'https://project.supabase.co/rest/v1/media?q=something%20embarrassing',
          query_string: 'q=something embarrassing',
          data: { note: 'a private note' },
          cookies: { session: 'abc' },
        },
      }),
    );

    expect(scrubbed.request?.url).toBe('https://project.supabase.co/rest/v1/media');
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
  });

  it('keeps only scalars in extra', () => {
    // `extra` is the one bag a caller fills by hand, so it is the one that can be handed a
    // whole row without anybody noticing.
    const scrubbed = scrub(
      event({
        extra: {
          attempt: 2,
          screen: 'title',
          profile: { bio: 'a private bio', username: 'ada' },
          titles: ['Heat', 'Inception'],
        },
      }),
    );

    expect(scrubbed.extra).toEqual({ attempt: 2, screen: 'title' });
  });
});

describe('scrubTransaction', () => {
  it('strips a transaction request the same way, because beforeSend never sees one', () => {
    const transaction = scrubTransaction({
      type: 'transaction',
      transaction: 'title/[id]',
      request: {
        url: 'https://project.supabase.co/rest/v1/media?q=private',
        data: { rows: 12 },
        cookies: { session: 'abc' },
      },
    } as Event);

    expect(transaction.request?.url).toBe('https://project.supabase.co/rest/v1/media');
    expect(transaction.request?.data).toBeUndefined();
    expect(transaction.request?.cookies).toBeUndefined();
  });

  it('applies the same scalar rule to a transaction extra', () => {
    const transaction = scrubTransaction({
      type: 'transaction',
      extra: { ms: 120, payload: { note: 'private' } },
    } as Event);

    expect(transaction.extra).toEqual({ ms: 120 });
  });
});

describe('scrubTransaction spans', () => {
  // The attributes `@sentry/browser` 10.37 puts on an XHR span, which is the path the React
  // Native SDK takes by default. Handles and ids here are invented.
  const SECRET = '?username=eq.private_handle&select=id,display_name&media_item_id=eq.abc';
  const URL = 'https://project.supabase.co/rest/v1/profiles';
  const httpSpan = () => ({
    op: 'http.client',
    description: `GET ${URL}`,
    span_id: 'a'.repeat(16),
    trace_id: 'b'.repeat(32),
    start_timestamp: 1,
    data: {
      type: 'xhr',
      url: `${URL}${SECRET}`,
      'http.method': 'GET',
      'http.url': `${URL}${SECRET}`,
      'http.query': SECRET,
      'http.fragment': '#from-a-share',
      'server.address': 'project.supabase.co',
      'http.response.status_code': 200,
      'sentry.op': 'http.client',
      'sentry.origin': 'auto.http.browser',
    },
  });
  const transaction = (over: Partial<Event> = {}): Event =>
    ({ type: 'transaction', transaction: '/title/[id]', spans: [httpSpan()], ...over }) as Event;

  it('takes the query string out of every field an http span carries it in', () => {
    const [span] = scrubTransaction(transaction()).spans ?? [];

    expect(JSON.stringify(span)).not.toContain('private_handle');
    expect(JSON.stringify(span)).not.toContain('from-a-share');
    expect(span?.data?.url).toBe(URL);
    expect(span?.data?.['http.url']).toBe(URL);
    expect(span?.data).not.toHaveProperty('http.query');
    expect(span?.data).not.toHaveProperty('http.fragment');
  });

  it('keeps what makes a trace useful', () => {
    const [span] = scrubTransaction(transaction()).spans ?? [];

    expect(span?.op).toBe('http.client');
    expect(span?.description).toBe(`GET ${URL}`);
    expect(span?.data).toMatchObject({
      'http.method': 'GET',
      'http.response.status_code': 200,
      'server.address': 'project.supabase.co',
      'sentry.origin': 'auto.http.browser',
    });
  });

  it('cuts a query out of a description and out of a field this file has never named', () => {
    // An SDK upgrade is free to rename these, as it already has once (`url.full`).
    const span = httpSpan();
    span.description = `GET ${URL}${SECRET}`;
    Object.assign(span.data, { 'url.full': `${URL}${SECRET}`, 'url.query': SECRET });

    const [scrubbed] = scrubTransaction(transaction({ spans: [span] })).spans ?? [];

    expect(JSON.stringify(scrubbed)).not.toContain('private_handle');
    expect(scrubbed?.description).toBe(`GET ${URL}`);
    expect(scrubbed?.data?.['url.full']).toBe(URL);
  });

  it('scrubs the root span too, which travels in the trace context', () => {
    const event = transaction({
      contexts: {
        trace: {
          span_id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          data: { 'http.query': SECRET, url: `${URL}${SECRET}` },
        },
      },
    });

    expect(JSON.stringify(scrubTransaction(event))).not.toContain('private_handle');
  });

  it('leaves a transaction with no spans alone', () => {
    expect(() => scrubTransaction(transaction({ spans: undefined }))).not.toThrow();
  });
});

describe('scrubBreadcrumb', () => {
  it('drops the query and fragment keys an http breadcrumb can carry', () => {
    const scrubbed = scrubBreadcrumb({
      category: 'xhr',
      type: 'http',
      data: {
        url: 'https://project.supabase.co/rest/v1/rankings?user_id=eq.1',
        'http.query': '?user_id=eq.1',
        method: 'GET',
        status_code: 200,
      },
    });

    expect(scrubbed?.data).toEqual({
      url: 'https://project.supabase.co/rest/v1/rankings',
      method: 'GET',
      status_code: 200,
    });
  });

  it('drops console breadcrumbs entirely', () => {
    // Console output is the least controlled surface in the app, and a breadcrumb replays
    // whatever was logged during development.
    expect(scrubBreadcrumb({ category: 'console', message: 'user object: {...}' })).toBeNull();
  });

  it('strips the query string from a breadcrumb url', () => {
    const crumb = scrubBreadcrumb({
      category: 'fetch',
      data: { url: 'https://api.example.com/search?q=private', status_code: 200 },
    }) as Breadcrumb;

    expect(crumb.data?.url).toBe('https://api.example.com/search');
    expect(crumb.data?.status_code).toBe(200);
  });
});
