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

describe('scrubBreadcrumb', () => {
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
