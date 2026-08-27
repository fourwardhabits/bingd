import { QueryClient } from '@tanstack/react-query';

import { watchQueries } from './flight-queries';
import { recordRequest, resetFlightRecorder, snapshot } from './flight-recorder';

/**
 * The fix for independent review 51's blocker, and for the same defect found independently
 * while writing it.
 *
 * The recorder's network log opens its record inside `requestWithDeadline`, which is the
 * app's `global.fetch` — and `@supabase/supabase-js` awaits the session *before* it calls
 * that. So a request stalled on `getSession()` never reaches the recorder and leaves nothing
 * behind at all, which is indistinguishable from a query that was never made. That is the
 * exact confusion this whole surface exists to end, so the start has to be recorded a layer
 * up, where React Query announces it.
 *
 * These tests pin the three readings the report is built to support.
 */

beforeEach(resetFlightRecorder);

const clientWith = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const queryEvents = () => snapshot().events.filter((event) => event.channel === 'query');

describe('where a query began', () => {
  it('records the start under the key name, and nothing from the key after it', async () => {
    const client = clientWith();
    const stop = watchQueries(client);

    await client.fetchQuery({
      queryKey: ['collection', '13b51cfb-bc61-4b8b-a3e1-4e3c544e3cbf'],
      queryFn: () => Promise.resolve([]),
    });

    const [begin] = queryEvents();
    expect(begin).toMatchObject({ channel: 'query', label: 'collection', detail: 'begin' });
    expect(JSON.stringify(queryEvents())).not.toContain('13b51cfb');
    stop();
  });

  it('records how a query ended', async () => {
    const client = clientWith();
    const stop = watchQueries(client);

    await client.fetchQuery({ queryKey: ['collection'], queryFn: () => Promise.resolve([]) });
    await client
      .fetchQuery({ queryKey: ['feed'], queryFn: () => Promise.reject(new Error('no')) })
      .catch(() => {});

    const details = queryEvents().map((event) => `${event.label}:${event.detail}`);
    expect(details).toContain('collection:success');
    expect(details).toContain('feed:error');
    stop();
  });

  /**
   * **The reading that matters.** A begin with no matching network record is a request that
   * never got past the session wait — mode 2, which the network log alone cannot show
   * because the record is never opened.
   */
  it('leaves a begin with no network record when the request never leaves', async () => {
    const client = clientWith();
    const stop = watchQueries(client);

    // A query function that hangs before any request is made, which is what awaiting a
    // session that never answers looks like from here.
    void client.fetchQuery({
      queryKey: ['collection'],
      queryFn: () => new Promise<never>(() => {}),
    });
    await Promise.resolve();

    expect(queryEvents().map((event) => event.label)).toContain('collection');
    expect(snapshot().network).toHaveLength(0);
    stop();
  });

  /** And the ordinary case, so the absence above means something. */
  it('pairs a begin with a network record when the request does leave', async () => {
    const client = clientWith();
    const stop = watchQueries(client);

    await client.fetchQuery({
      queryKey: ['collection'],
      queryFn: async () => {
        const handle = recordRequest('https://x.supabase.co/rest/v1/user_media');
        handle.sent();
        handle.settled({ status: 200 });
        return [];
      },
    });

    expect(queryEvents().map((event) => event.label)).toContain('collection');
    expect(snapshot().network.map((record) => record.name)).toContain('rest:user_media');
    stop();
  });

  it('stops when told to, so nothing outlives the process it was watching', async () => {
    const client = clientWith();
    watchQueries(client)();

    await client.fetchQuery({ queryKey: ['collection'], queryFn: () => Promise.resolve([]) });

    expect(queryEvents()).toHaveLength(0);
  });
});
