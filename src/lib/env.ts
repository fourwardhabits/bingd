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

  // Optional so the project runs with no Sentry or PostHog account at all.
  // Both integrations become no-ops when absent, which keeps a contributor from
  // needing credentials to a service they have no reason to touch. An empty
  // string is normalised to undefined, because a .env with a blank value is the
  // ordinary way to say "not configured".
  sentryDsn: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().url().optional()),
  posthogKey: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  posthogHost: z.string().url().default('https://us.i.posthog.com'),
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
