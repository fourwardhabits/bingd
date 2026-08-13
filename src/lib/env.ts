import Constants from 'expo-constants';
import { z } from 'zod';

/**
 * Fails loudly at startup rather than producing a confusing network error on the
 * first query. A missing Supabase URL is a misconfigured build, not a runtime
 * condition worth handling gracefully.
 */
const schema = z.object({
  variant: z.enum(['development', 'preview', 'production']),
  supabaseUrl: z.string().url(),
  supabaseAnonKey: z.string().min(1),
});

const parsed = schema.safeParse(Constants.expoConfig?.extra ?? {});

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(
    `Invalid app configuration: ${missing}. Check .env against .env.example and restart the bundler.`,
  );
}

export const env = parsed.data;

export const isProduction = env.variant === 'production';

/** Non-production builds show a persistent environment badge (client.md §8). */
export const showEnvironmentBadge = !isProduction;
