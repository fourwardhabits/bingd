/**
 * The titles behind a finished import's *Unmatched* row: `useUnresolvedRows`, one of the
 * two sources `outcomes.ts` describes. `CompletionSummary` joins it to this session's parse
 * with `buildImdbOutcomes` (IMP1113-UI; the per-heading hook it replaced listed shows,
 * episodes and other kinds too, which the results now give as notes).
 *
 * The titles a finished IMDb import could not match are read from the owner's own rows.
 *
 * `_import_settle` keeps exactly these rows (ambiguous, unmatched, not reached by the
 * provider, and any straggler), reduced to `{name, year}`, for this screen. `import_rows_own`
 * lets the owner read them, so this is a plain select with no RPC and no migration.
 *
 * Read once per job while the summary is on screen, and kept in component state only.
 * Paged by `id`, a page at a time, because PostgREST caps a response; bounded so that a
 * very large unmatched set costs at most `MAX_PAGES` requests, beyond which the summary
 * keeps its count rather than a partial list that would not add up.
 */

import { useEffect, useState } from 'react';

import { withGrace } from '@/lib/grace';
import { supabase } from '@/lib/supabase';

import type { UnresolvedRow, UnresolvedRows } from './outcomes';

/** PostgREST's default `max_rows`. */
export const UNRESOLVED_PAGE = 1_000;
/** Ten pages: ten thousand unmatched titles listed by name, after which only the count. */
export const MAX_PAGES = 10;
/** Per page, the same budget `use-import` gives one importer request. */
const PAGE_DEADLINE_MS = 20_000;
const STALLED = Symbol('stalled');
/** One object each, so a memo over the answer holds across renders. */
const LOADING: UnresolvedRows = { state: 'loading' };
const UNAVAILABLE: UnresolvedRows = { state: 'unavailable' };

type RawRow = { id?: unknown; raw?: { name?: unknown; year?: unknown } | null };

const asRow = (row: RawRow): UnresolvedRow | null => {
  const name = row.raw?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const year = row.raw?.year;
  return { name, year: typeof year === 'number' && Number.isInteger(year) ? year : null };
};

/**
 * Every unresolved row of `jobId`, or `unavailable`. Total: never throws.
 *
 * A row that does not have a name is a row this screen cannot show, and showing the rest
 * would make the list shorter than its count, so it makes the whole read unavailable.
 */
export async function readUnresolvedRows(
  jobId: string,
  expected: number,
): Promise<UnresolvedRows> {
  if (expected > UNRESOLVED_PAGE * MAX_PAGES) return UNAVAILABLE;
  try {
    const rows: UnresolvedRow[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * UNRESOLVED_PAGE;
      const answer = await withGrace(
        Promise.resolve(
          supabase
            .from('import_rows')
            .select('id, raw')
            .eq('job_id', jobId)
            .order('id', { ascending: true })
            .range(from, from + UNRESOLVED_PAGE - 1),
        ),
        PAGE_DEADLINE_MS,
        STALLED,
      );
      if (answer === STALLED) return UNAVAILABLE;
      const { data, error } = answer as { data?: unknown; error?: unknown };
      if (error || !Array.isArray(data)) return UNAVAILABLE;
      for (const raw of data as RawRow[]) {
        const row = asRow(raw);
        if (row === null) return UNAVAILABLE;
        rows.push(row);
      }
      if (data.length < UNRESOLVED_PAGE) return { state: 'ready', rows };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * The hook over `readUnresolvedRows`. Nothing is read when there is nothing to list
 * (`expected` is 0) or no job to read it for.
 */
export function useUnresolvedRows(
  jobId: string | null | undefined,
  expected: number,
): UnresolvedRows {
  const [result, setResult] = useState<{ key: string; rows: UnresolvedRows } | null>(null);
  const key = jobId && expected > 0 ? `${jobId}:${expected}` : null;

  useEffect(() => {
    if (key === null || !jobId) return;
    let alive = true;
    void readUnresolvedRows(jobId, expected).then((rows) => {
      if (alive) setResult({ key, rows });
    });
    return () => {
      alive = false;
    };
  }, [key, jobId, expected]);

  if (key === null) return UNAVAILABLE;
  return result?.key === key ? result.rows : LOADING;
}
