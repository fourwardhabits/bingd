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

  /**
   * Everything else keeps the caller's own wording.
   *
   * The first version passed every message through outside production, and
   * independent review was right to object: Postgres echoes rejected input in a
   * constraint or type error, so a build handed to a tester could put another
   * person's value on screen. The three codes above name a missing column, function
   * or table — schema shape, never row content — which is the whole diagnostic need
   * here. A timeout or a 500 tells a developer nothing the caller's sentence does
   * not, and is not worth the exposure.
   */
  return null;
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

/**
 * The same three codes as a set, so a body that has just been parsed can be asked the
 * question `isSchemaDrift` asks of a thrown error.
 *
 * `isSchemaDrift` takes an error object because that is what a screen holds. The fetch
 * chokepoint in `lib/supabase.ts` holds a *response*, one layer below any of that, and
 * it reaches the same three codes by the same reasoning: a missing column, function or
 * table is the client and the database disagreeing about the schema, and nothing else
 * here is.
 */
export const SCHEMA_DRIFT_CODES: ReadonlySet<string> = new Set([
  '42703',
  'PGRST202',
  'PGRST205',
]);

/** A backend-contract failure, reduced to the two things that are safe to carry. */
export type ContractBreach = {
  /** One of `SCHEMA_DRIFT_CODES`. */
  code: string;
  /**
   * The schema object the backend does not have — `public.rank_again`, `media_items.foo`.
   * Null when the message did not name one in a shape this is willing to read.
   */
  symbol: string | null;
};

/**
 * The one identifier a drift message names, and nothing else from the message.
 *
 * **The message is never forwarded whole**, and that is the whole point of this
 * function. `diagnose` above already refuses to put arbitrary PostgREST messages on
 * screen because Postgres echoes rejected input in constraint and cast errors, and
 * `lib/monitoring.ts`'s header records the same exposure for anything that reaches
 * Sentry. These three codes name schema *shape* — that is why they are the three
 * `diagnose` is willing to print — but the safe reading of that is to extract the
 * identifier and drop the prose, rather than to trust every future wording of it.
 *
 * So: a strict identifier, optionally schema-qualified, and a length cap. Anything the
 * pattern does not match becomes `symbol: null`, which still reports *that* a contract
 * broke and under which code.
 */
const SYMBOL = /\b(?:function|table|relation|column)\s+['"]?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/i;

export function readContractBreach(body: unknown): ContractBreach | null {
  if (!body || typeof body !== 'object') return null;

  const { code, message } = body as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !SCHEMA_DRIFT_CODES.has(code)) return null;

  const named = typeof message === 'string' ? SYMBOL.exec(message)?.[1] : undefined;
  return { code, symbol: named && named.length <= 120 ? named : null };
}
