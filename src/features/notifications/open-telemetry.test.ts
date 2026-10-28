import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

import { recordNotificationOpen } from './open-telemetry';

jest.mock('@/lib/analytics', () => ({ track: jest.fn() }));
jest.mock('@/lib/supabase', () => ({
  supabase: { rpc: jest.fn(() => Promise.resolve({ data: { ok: true }, error: null })) },
}));

beforeEach(() => jest.clearAllMocks());

describe('recordNotificationOpen', () => {
  it('writes the server row and a coarse event, with nothing about who or which title', () => {
    recordNotificationOpen({
      notificationId: 'n1',
      kind: 'watchlist_social',
      channel: 'push',
      destination: 'title',
    });
    expect(supabase.rpc).toHaveBeenCalledWith('record_notification_open', {
      p_notification_id: 'n1',
      p_channel: 'push',
      p_destination: 'title',
    });
    expect(track).toHaveBeenCalledWith({
      name: 'notification_opened',
      props: { kind: 'watchlist_social', channel: 'push', proactive: true },
    });
  });

  it('marks a reactive kind as not proactive', () => {
    recordNotificationOpen({
      notificationId: 'n2',
      kind: 'comment',
      channel: 'inbox',
      destination: 'activity',
    });
    expect(track).toHaveBeenCalledWith({
      name: 'notification_opened',
      props: { kind: 'comment', channel: 'inbox', proactive: false },
    });
  });

  it('records nothing for a payload that does not name a notification', () => {
    recordNotificationOpen({ notificationId: undefined, kind: 'follow', channel: 'push', destination: 'inbox' });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  /**
   * Codex review: an unknown or hostile kind from a push payload must never reach the
   * vendor. The server record still happens, because the server reads the kind from the
   * notification row and ignores this value.
   */
  it('never sends an unknown or hostile kind to analytics', () => {
    for (const kind of [7, null, '', 'not_a_kind', 'Ravi watched Dune', 'follow; drop', 'FOLLOW']) {
      recordNotificationOpen({ notificationId: 'n3', kind, channel: 'push', destination: 'inbox' });
    }
    expect(track).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledTimes(7);
    for (const call of (supabase.rpc as jest.Mock).mock.calls) {
      expect(Object.keys(call[1] as object).sort()).toEqual([
        'p_channel',
        'p_destination',
        'p_notification_id',
      ]);
    }
  });

  it('never throws, even when the transport does', () => {
    (supabase.rpc as jest.Mock).mockImplementationOnce(() => {
      throw new Error('offline');
    });
    expect(() =>
      recordNotificationOpen({ notificationId: 'n4', kind: 'follow', channel: 'push', destination: 'inbox' }),
    ).not.toThrow();
  });
});
