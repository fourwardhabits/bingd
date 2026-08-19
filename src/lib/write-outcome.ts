/**
 * What a write's answer actually proves — which is not always what happened.
 *
 * Five review rounds of Beta Hardening §1 found the same defect in five different
 * writers, and this module exists because it is one defect rather than five. **A
 * response is evidence about what this client observed. It is not always evidence about
 * whether the server's transaction committed.** Independent review 21e named the case
 * that breaks the old rule: PostgreSQL defines `08007 transaction_resolution_unknown`
 * for exactly the moment a connection dies mid-`COMMIT`, and PostgREST passes the whole
 * `08` class through with its codes attached. So "the error carries a SQLSTATE" — which
 * is what `collection/writes.ts` used to test — reports a committed row as a refusal.
 *
 * Three answers, and only three:
 *
 * - **committed** — the server answered, and it answered yes.
 * - **refused** — the server answered no, by raising a SQLSTATE this application's own
 *   functions raise on purpose. A PL/pgSQL `raise exception` aborts its transaction, so
 *   this one is proof.
 * - **unknown** — everything else. No code at all (a dropped socket, a timeout, a
 *   gateway's HTML error page — `postgrest-js` gives all three `code: ''`), the `08`
 *   connection class, or a SQLSTATE nobody here has reasoned about.
 *
 * **Unrecognised means unknown, deliberately.** The alternative is an encyclopedia of
 * every SQLSTATE Postgres defines, maintained by people guessing at the ones they have
 * never seen — and getting one wrong in the "refused" direction is a silent stale
 * screen, while getting one wrong in the "unknown" direction is one redundant refetch.
 * The trade is not close.
 */

export type WriteOutcome = 'committed' | 'refused' | 'unknown';

/** The shape both `postgrest-js` and `supabase-js` hand back for a failed call. */
export type ServerError = { code?: string | null; message?: string } | null | undefined;

/**
 * The SQLSTATEs this application's server functions raise on purpose, plus the ones
 * Postgres and PostgREST raise before any statement of ours runs at all.
 *
 * Every entry is a refusal that could not have committed, and every entry is here
 * because something in `supabase/migrations` or this client names it. Grepping
 * `errcode =` across the migrations is what produced the first group; adding a code
 * without a caller that means it is how this list would become the encyclopedia it is
 * written to avoid.
 */
export const REFUSAL_CODES: ReadonlySet<string> = new Set([
  // Raised by the writers' own validation and asserts (`errcode =` in the migrations).
  '22023', // invalid_parameter_value — a series, a future date, an over-long note
  '23505', // unique_violation — a handle, an invite token
  '28000', // invalid_authorization_specification — no session
  '42501', // insufficient_privilege — assert_can_write, RLS, a lapsed follow
  '42704', // undefined_object — no such bucket, no such enum member
  '42710', // duplicate_object
  '53400', // configuration_limit_exceeded — the rate limiters
  '55000', // object_not_in_prerequisite_state — _assert_unranked, a stale note version
  'P0001', // raise_exception — the generic refusal
  'P0002', // no_data_found — no such title, nothing to change

  // Rejected before the function body: a declared constraint, a bad cast, a column or
  // routine this build asked for and the database does not have. None of them commit.
  '22P02', // invalid_text_representation — an enum value the client mistyped
  '23514', // check_violation — a declared CHECK, which is where goal targets are bounded
  '42703', // undefined_column — the backend is behind this build (`lib/diagnose.ts`)
  'PGRST202', // no such function in the schema cache
  'PGRST205', // no such table in the schema cache
]);

/**
 * Classifies a PostgREST or `supabase-js` error.
 *
 * `refusals` is overridable so a caller with a narrower contract can say so, but every
 * caller in this app passes the default: the question "did this commit" has one answer
 * per SQLSTATE, and it does not depend on which feature asked.
 */
export function classifyWrite(
  error: ServerError,
  refusals: ReadonlySet<string> = REFUSAL_CODES,
): WriteOutcome {
  if (!error) return 'committed';
  const code = error.code;
  return code && refusals.has(code) ? 'refused' : 'unknown';
}

/**
 * The same question for Storage, which answers with HTTP rather than a SQLSTATE.
 *
 * A 4xx is the API declining a request it understood, and nothing was written. A 5xx, a
 * timeout, or no status at all (`StorageUnknownError`, which is what a dead socket
 * becomes) leaves the outcome open — the DELETE may well have been executed and the
 * reply lost on the way back.
 *
 * `408 Request Timeout` sits on the ambiguous side on purpose: it says the server gave
 * up waiting, not that it did nothing.
 */
export function classifyStorageWrite(
  error: { status?: number; statusCode?: string | number } | null | undefined,
): WriteOutcome {
  if (!error) return 'committed';

  const status = error.status ?? Number(error.statusCode);
  if (!Number.isFinite(status)) return 'unknown';

  return status >= 400 && status < 500 && status !== 408 ? 'refused' : 'unknown';
}

/**
 * Whether the caller has to reconcile whatever canonical state this write touches.
 *
 * True for **committed** as well as **unknown**, and that is the whole point of putting
 * it behind a name: the bug review 21e found four times was a caller that reconciled on
 * success and returned early on failure, so the one case that most needs a refetch —
 * the write that landed and could not say so — was the one case that never got one.
 */
export const mustReconcile = (outcome: WriteOutcome) => outcome !== 'refused';
