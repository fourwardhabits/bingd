import Constants from 'expo-constants';
import { z } from 'zod';

/**
 * Fails loudly at startup rather than producing a confusing network error on the
 * first query. A missing Supabase URL is a misconfigured build, not a runtime
 * condition worth handling gracefully.
 */
const schema = z.object({
  variant: z.enum(['development', 'preview', 'production']),

  /**
   * The release lane, which the variant cannot express.
   *
   * `beta` builds the **production** variant, because a bundle identifier cannot change
   * between a TestFlight build and the App Store release that replaces it. So
   * `variant === 'production'` is true of a friend beta and of a public release alike,
   * and anything asking "is somebody testing this?" has to ask the lane instead.
   *
   * Optional, and absent outside an EAS build — a local `expo start` has no lane. The
   * fallbacks below are what make that absence mean something rather than nothing.
   */
  lane: z.enum(['development', 'preview', 'beta', 'production']).optional(),

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

/**
 * The lane, with the variant as a fallback.
 *
 * A build with no `BINGD_LANE` is not on EAS, so it is somebody's own machine, and the
 * variant is the closest true answer. Written as a fallback rather than a default in the
 * schema so that the absence is visible here, where the consequence is.
 */
export const lane: 'development' | 'preview' | 'beta' | 'production' = env.lane ?? env.variant;

/**
 * Is somebody testing this build?
 *
 * **Not `!isProduction`.** A Beta build carries the production variant — same bundle
 * identifier, same scheme, because neither can change between a TestFlight build and the
 * App Store release that replaces it — while running against the nonproduction backend.
 * Gating on the variant hid the build diagnostics from exactly the people who needed them
 * most, which is what independent review 28 objected to: a production-variant binary
 * pointed at a test database, with nothing on screen saying so.
 *
 * Only a real `production` lane is a release.
 */
export const isRelease = lane === 'production';

/** Non-production builds show a persistent environment badge (client.md §8). */
export const showEnvironmentBadge = !isProduction;
