import { FunctionsHttpError } from '@supabase/supabase-js';

import { resetFlightRecorder, snapshot } from './flight-recorder';

/**
 * **The wider search, and the one thing a report could not say about it.**
 *
 * The founder searched "lizzie" and "McGuire" on a physical iPhone and got:
 *
 *     Could not search wider
 *     Your catalogue has nothing, and the wider search did not answer.
 *
 * Run against the same deployed function, as a real signed-in user, those queries return
 * *Lizzie McGuire*, *The Lizzie McGuire Movie* and *Lizzie McGuire - Fashionably Lizzie* in
 * 380–850ms. So the failure is on the device — and every one of the five ways it can fail
 * arrived at that screen as the same sentence, with nothing anywhere to tell them apart.
 *
 * `BG401` is an auth problem. `BG429` is a spent allowance. `BG502` is TMDB being down.
 * `BG500` is the function itself. A `FunctionsFetchError` is a request that never got an
 * answer at all — the same shape as the build-4 stall, and the one that belongs beside the
 * network log rather than in a search discussion. These tests pin that each of them reaches
 * the flight recorder as its own code, and that nothing carrying a query string does.
 */

const mockInvoke = jest.fn();

jest.mock('./supabase', () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => mockInvoke(...args) } },
}));

import { AdapterError, searchProvider } from './tmdb-adapter';

/** A non-2xx as supabase-js reports it: an error whose body it has not read. */
const httpError = (status: number, body: unknown) =>
  new FunctionsHttpError({
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);

const adapterEvents = () =>
  snapshot().events.filter((event) => event.label.startsWith('adapter:'));

beforeEach(() => {
  resetFlightRecorder();
  mockInvoke.mockReset();
});

describe('a wider search that works', () => {
  it('returns the rows and records the action as ok', async () => {
    mockInvoke.mockResolvedValue({
      data: { results: [{ id: 'm1', title: 'The Lizzie McGuire Movie' }] },
      error: null,
    });

    const results = await searchProvider('lizzie mcguire', 20);

    expect(results).toHaveLength(1);
    expect(adapterEvents()).toMatchObject([{ label: 'adapter:search', detail: 'ok' }]);
  });

  it('times it, so a slow isolate is distinguishable from a broken one', async () => {
    mockInvoke.mockResolvedValue({ data: { results: [] }, error: null });

    await searchProvider('lizzie', 20);

    expect(adapterEvents()[0]?.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('a wider search that does not answer', () => {
  it('records a spent allowance as BG429, and says it is a rate limit', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(429, { error: { code: 'BG429', message: 'Too many searches.' } }),
    });

    await expect(searchProvider('lizzie', 20)).rejects.toMatchObject({
      code: 'BG429',
      isRateLimit: true,
    });
    expect(adapterEvents()).toMatchObject([{ label: 'adapter:search', detail: 'BG429' }]);
  });

  it('records an unrecognised caller as BG401', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(401, { error: { code: 'BG401', message: 'Sign in to search titles' } }),
    });

    // The surprising one, and the reason it is worth naming: the local catalogue pass uses
    // the same session and the same token. A BG401 beside a successful `rpc:search_titles`
    // would be a finding about the functions lane specifically, not about the account.
    await expect(searchProvider('lizzie', 20)).rejects.toMatchObject({ code: 'BG401' });
    expect(adapterEvents()).toMatchObject([{ detail: 'BG401' }]);
  });

  it('records a provider outage as BG502', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(502, { error: { code: 'BG502', message: 'unavailable' } }),
    });

    await expect(searchProvider('lizzie', 20)).rejects.toMatchObject({ code: 'BG502' });
    expect(adapterEvents()).toMatchObject([{ detail: 'BG502' }]);
  });

  it('records a request that never reached an answer by its class, not a BG code', async () => {
    const fetchFailure = new Error('Network request failed');
    fetchFailure.name = 'FunctionsFetchError';
    mockInvoke.mockResolvedValue({ data: null, error: fetchFailure });

    await expect(searchProvider('lizzie', 20)).rejects.toBeInstanceOf(AdapterError);
    // Not a BG code, deliberately: the function never spoke, so attributing one would be
    // inventing an answer it did not give.
    expect(adapterEvents()).toMatchObject([{ detail: 'FunctionsFetchError' }]);
  });

  it('records a rejection out of invoke itself', async () => {
    const deadline = new Error('The request did not answer within 10000ms.');
    deadline.name = 'RequestDeadlineError';
    mockInvoke.mockRejectedValue(deadline);

    await expect(searchProvider('lizzie', 20)).rejects.toThrow();
    expect(adapterEvents()).toMatchObject([{ detail: 'RequestDeadlineError' }]);
  });
});

describe('what the recording may never contain', () => {
  it('names the action and never what was searched for', async () => {
    mockInvoke.mockResolvedValue({
      data: null,
      error: httpError(500, { error: { code: 'BG500', message: 'no results for lizzie' } }),
    });

    await expect(searchProvider('lizzie mcguire', 20)).rejects.toThrow();

    const recorded = JSON.stringify(adapterEvents());
    // The query string is the one thing on this path that is somebody's data, and the
    // server's message can echo it — so neither the term nor the message is recorded.
    expect(recorded).not.toContain('lizzie');
    expect(recorded).not.toContain('mcguire');
    expect(recorded).not.toContain('no results');
  });
});
