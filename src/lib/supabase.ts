import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import { env } from './env';

/**
 * Every write goes through an RPC so RLS and the ranking invariants are enforced
 * in one place — see docs/architecture/api.md. Direct table writes from the
 * client are a bug even where RLS would permit them.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // React Native has no URL bar to read a callback from; deep links are
    // handled explicitly by the router instead (client.md §7).
    detectSessionInUrl: false,
  },
});
