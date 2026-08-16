import { isProduction } from './env';

/**
 * Turns a Supabase/PostgREST failure into a sentence that names the dependency.
 *
 * "Check your connection and try again" was the only thing several screens could
 * say, and it is wrong in the one case that keeps happening during development: a
 * backend a migration behind the client, on a connection that is working perfectly.
 * A device test then reports "could not load" and the actual cause — one absent
 * column — takes a schema dump to find.
 *
 * So outside production the message says which thing is missing. In production it
 * returns null and the caller keeps its ordinary copy: a user can act on "check
 * your connection" and can do nothing whatever with `42703`.
 *
 * The two codes worth naming are the two that mean *drift* rather than trouble:
 *
 *   42703  undefined_column — the client selected a column the database does not
 *          have. Always an unapplied migration.
 *   PGRST202  PostgREST could not find a function with that name and argument set.
 *          Either the function is absent or its signature moved.
 *
 * Everything else falls through to the caller's own wording, because a timeout, a
 * 500 or a dropped socket really is "try again".
 */
export function diagnose(error: unknown): string | null {
  if (isProduction || !error) return null;

  const { code, message } = error as { code?: string; message?: string };
  if (!code && !message) return null;

  if (code === '42703') {
    return `Backend is out of date: ${message ?? 'a column this build needs does not exist'}. Apply the pending migrations.`;
  }
  if (code === 'PGRST202') {
    return `Backend is out of date: ${message ?? 'a function this build needs does not exist'}. Apply the pending migrations.`;
  }
  if (code === 'PGRST205') {
    return `Schema cache is stale: ${message ?? 'the table is not in the cache'}. Reload the PostgREST schema.`;
  }

  return message ? `${message}${code ? ` (${code})` : ''}` : null;
}

/**
 * Whether a failure is the client and the database disagreeing about the schema.
 *
 * Used to decide what a screen *does* rather than what it says: drift is not
 * retryable by the person holding the phone, so a control that offers "try again"
 * against it is offering something that cannot work.
 */
export const isSchemaDrift = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST202' || code === 'PGRST205';
};
