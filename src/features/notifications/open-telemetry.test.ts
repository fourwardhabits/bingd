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
      destination: '/title/x',
    });
    expect(supabase.rpc).toHaveBeenCalledWith('record_notification_open', {
      p_notification_id: 'n1',
      p_channel: 'push',
      p_destination: '/title/x',
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
      destination: '/activity/e',
    });
    expect(track).toHaveBeenCalledWith({
      name: 'notification_opened',
      props: { kind: 'comment', channel: 'inbox', proactive: false },
    });
  });

  it('records nothing for a payload that does not name a notification', () => {
    recordNotificationOpen({ notificationId: undefined, kind: 'follow', channel: 'push', destination: '/' });
    recordNotificationOpen({ notificationId: 'n3', kind: 7, channel: 'push', destination: '/' });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('never throws, even when the transport does', () => {
    (supabase.rpc as jest.Mock).mockImplementationOnce(() => {
      throw new Error('offline');
    });
    expect(() =>
      recordNotificationOpen({ notificationId: 'n4', kind: 'follow', channel: 'push', destination: '/' }),
    ).not.toThrow();
  });
});
