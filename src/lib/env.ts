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

/**
 * The Supabase project a URL names, or null if it names none.
 *
 * Restated from `config/backends.cjs` rather than imported, deliberately, in the same way
 * `declaresPushNatively` is restated inside `app.config.ts`: that module is loaded by
 * Expo’s config resolver at **build** time, and pulling it into the app bundle to answer
 * a runtime question trades a real dependency for a comment. `env.test.ts` asserts the two
 * agree, which is the seam this arrangement creates.
 *
 * Parsed, never pattern-matched. A regex over a URL string is the shape of check that says
 * yes to `https://evil.example/?x=abheeqyjzekiowkztfxv.supabase.co`.
 */
const projectRef = (url: string): string | null => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') return null;
  if (target.username || target.password) return null;
  const suffix = '.supabase.co';
  const host = target.hostname.toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const ref = host.slice(0, -suffix.length);
  return ref.length === 0 || ref.includes('.') ? null : ref;
};

/** bingd-production. Public: it is half of the URL in every request this app makes. */
const PRODUCTION_PROJECT_REF = 'abheeqyjzekiowkztfxv';

/**
 * A staging build pointed at production does not start.
 *
 * `config/backends.cjs` already refuses this where the config resolves, which covers
 * `eas build` and `eas update` alike. This is the same rule stated where the consequence
 * lands, and it earns its lines because the two failures look nothing alike. A build-time
 * refusal is a red log nobody ships past. The runtime version of the same mistake is a
 * Beta-badged app on a phone quietly reading and writing the real database, and nothing
 * about it looks wrong: it signs in, it shows real data, and the damage is only visible
 * later, in production rows nobody meant to create.
 *
 * **Keyed on the variant, not the lane.** `beta` carries the production variant and uses
 * production on purpose (see `config/backends.cjs`), so what this asks is whether a build
 * wearing the preview identity — `app.bingd.preview`, `bingd-preview://`, the plum icon —
 * has been pointed at production, whatever some dashboard variable says.
 */
if (env.variant !== 'production' && projectRef(env.supabaseUrl) === PRODUCTION_PROJECT_REF) {
  throw new Error(
    `This is a ${env.variant} build and it is configured against bingd-production ` +
      `(${PRODUCTION_PROJECT_REF}). A staging build must never talk to the production ` +
      `database. Fix EXPO_PUBLIC_SUPABASE_URL in the EAS environment this lane names ` +
      `(eas env:list ${env.lane ?? env.variant}); config/backends.cjs is the allowlist.`,
  );
}

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
