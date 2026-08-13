import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { env } from './env';
import { sessionStorage } from './session-storage';

/**
 * Every write goes through an RPC so RLS and the ranking invariants are enforced
 * in one place — see docs/architecture/api.md. Direct table writes from the
 * client are a bug even where RLS would permit them.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    // Keychain and Keystore, chunked. auth.md §5 forbids AsyncStorage.
    storage: sessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar to read a callback from; deep links are
    // handled explicitly by the router instead (client.md §7).
    detectSessionInUrl: false,
    // The OAuth code is exchanged by the app rather than arriving as a token in a
    // redirect URL, so the token never passes through a URL that a browser, a log,
    // or another app registered for the scheme could observe.
    flowType: 'pkce',
  },
});

/**
 * Supabase refreshes on a timer, and a timer does not run while the app is
 * suspended. Without this, a session that expired in the background stays expired
 * until something happens to trigger a refresh — so the first query after
 * reopening fails, and the retry succeeds, which reads as a flaky network.
 */
export function startSessionRefresh() {
  const apply = (state: string) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  };

  apply(AppState.currentState);
  const subscription = AppState.addEventListener('change', apply);
  return () => subscription.remove();
}
