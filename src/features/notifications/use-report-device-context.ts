import { useEffect, useRef } from 'react';

import { useAuth } from '@/features/auth';
import { deviceContext } from '@/lib/device-context';
import { supabase } from '@/lib/supabase';

/**
 * Tells the server this device's timezone and region, once per signed-in account per app
 * run (`report_device_context`, migration 20260930000100).
 *
 * **Why.** Release awareness decides *when* a notification may interrupt somebody —
 * 10:00 to 20:00 in their own time — and whether a US theatrical date is their date. The
 * server has neither fact and, by the founder's rule, must never guess one. Until an
 * account has reported, its release events are recorded as in-app only.
 *
 * **What it is not.** No UI, no permission, no prompt, no analytics event, and nothing it
 * does can fail visibly: the call is fired and forgotten, and an error (including a server
 * that predates the function, which answers 404) is dropped. Nothing is written when the
 * device reports neither value.
 *
 * Latched per account, like `usePush`'s registration: the auth object's identity changes
 * on every profile refetch, and a second account signing in on the same device reports for
 * itself.
 */
export function useReportDeviceContext() {
  const auth = useAuth();
  const userId = auth.status === 'ready' ? auth.userId : null;
  const reportedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) {
      reportedFor.current = null;
      return;
    }
    if (reportedFor.current === userId) return;
    reportedFor.current = userId;
    void reportDeviceContext();
  }, [userId]);
}

export async function reportDeviceContext(): Promise<void> {
  const { timezone, region } = deviceContext();
  if (!timezone && !region) return;
  try {
    // `rpc` resolves with `{ error }` rather than throwing; there is nothing to do with
    // one. The try is for a transport that throws anyway.
    await supabase.rpc('report_device_context', { p_timezone: timezone, p_region: region });
  } catch {
    // Deliberately silent. See the header.
  }
}
