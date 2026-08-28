/**
 * PostgREST, small enough to reason about and real enough to catch a paging bug.
 *
 * The mocks this replaces ignored their filters and returned whichever array the test
 * had seeded, which makes an unscoped read look identical to a scoped one and makes a
 * pagination loop look like it works while testing nothing at all. Two rounds of
 * independent review found defects that only exist *between* requests — a cap that
 * arrives as a plausible number, an offset that shifts under a concurrent write — and
 * neither is reachable by a stub that answers everything in one call.
 *
 * So this honours what the reads actually say: `eq`, `neq`, `not(is null)`, `gt`, a
 * top-level `or` including the nested `and(...)` form a keyset cursor needs, `order` and
 * `limit`. It counts requests per table, and it will run a callback between them, which
 * is how a test writes to the table mid-read the way another device would.
 *
 * What it is not is a database. There are no joins to resolve — embedded rows are
 * whatever the test seeded on the row — and no RLS. Anything depending on either belongs
 * in `supabase/tests`, against a real Postgres.
 */

export type Rows = Record<string, unknown[]>;

/** What one request asked for, so a missing filter can be asserted rather than assumed. */
export type Read = {
  table: string;
  columns: string;
  filters: Record<string, unknown>;
  order: { column: string; ascending: boolean }[];
  limit: number | null;
  or: string | null;
  /** The keyset cursors this request carried, which is what makes paging assertable. */
  gt: [string, string][];
};

export type Postgrest = {
  from: (table: string) => unknown;
  /**
   * `supabase.rpc`, answered from `rpcAnswers` by function name and recorded in
   * `rpcCalls`. Deliberately not a database either: a function's real behaviour —
   * its gates, its predicate — is `supabase/tests`' job; what a client test needs
   * is "was it called, with what, and what does the screen do with the reply".
   * A name in `broken` fails the same way a broken table read does.
   */
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** Seeded rpc replies by function name. Absent means `data: null`. */
  rpcAnswers: Record<string, unknown>;
  /** Every rpc call issued, in order. */
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  /** Rows per table. Owned here rather than passed in, because a `jest.mock` factory
   * runs before the test file's own `const` initialisers and would capture `undefined`. */
  tables: Rows;
  /** Every request issued, in order. */
  reads: Read[];
  /** How many requests each table was asked for. */
  requests: Record<string, number>;
  /** Tables whose reads fail. */
  broken: Set<string>;
  /** Runs after each request is served — where a concurrent write goes. */
  between: (table: string, requestsSoFar: number, rows: Rows) => void;
};

/** `feed_events.actor_id` through a to-one embed PostgREST types as an array. */
const valueAt = (row: unknown, path: string): unknown => {
  let current: unknown = row;
  for (const part of path.split('.')) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return Array.isArray(current) ? current[0] : current;
};

const compare = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
};

/**
 * One term of a PostgREST logical expression: `column.op.value`, or a nested
 * `and(...)` / `or(...)`.
 *
 * Split on top-level commas only, because the whole point of the nested form is that it
 * contains commas of its own.
 */
const split = (expression: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const character = expression[i];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
};

const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
type Operator = (typeof OPERATORS)[number];

export const apply = (row: unknown, path: string, operator: Operator, value: string): boolean => {
  const actual = valueAt(row, path);
  switch (operator) {
    case 'eq':
      return String(actual) === value;
    case 'neq':
      return String(actual) !== value;
    case 'gt':
      return compare(actual, value) > 0;
    case 'gte':
      return compare(actual, value) >= 0;
    case 'lt':
      return compare(actual, value) < 0;
    case 'lte':
      return compare(actual, value) <= 0;
  }
};

/**
 * One term of an `or=` expression.
 *
 * The column may itself be dotted — `feed_events.actor_id` is how a filter reaches an
 * embedded row — so the operator is found by name rather than by counting dots, which is
 * what PostgREST itself has to do.
 */
const matches = (row: unknown, expression: string): boolean => {
  const nested = /^(and|or)\((.*)\)$/s.exec(expression);
  if (nested) {
    const terms = split(nested[2]!);
    return nested[1] === 'and'
      ? terms.every((term) => matches(row, term))
      : terms.some((term) => matches(row, term));
  }

  const tokens = expression.split('.');
  const at = tokens.findIndex((token) => (OPERATORS as readonly string[]).includes(token));
  if (at <= 0) throw new Error(`the PostgREST stand-in cannot parse "${expression}"`);
  return apply(row, tokens.slice(0, at).join('.'), tokens[at] as Operator, tokens.slice(at + 1).join('.'));
};

export function createPostgrest(): Postgrest {
  const tables: Rows = {};
  const client: Postgrest = {
    tables,
    reads: [],
    requests: {},
    broken: new Set(),
    between: () => {},
    rpcAnswers: {},
    rpcCalls: [],
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      client.rpcCalls.push({ name, args });
      if (client.broken.has(name)) {
        return Promise.resolve({ data: null, error: { message: 'nope' } });
      }
      return Promise.resolve({ data: client.rpcAnswers[name] ?? null, error: null });
    },
    from: (table: string) => {
      const read: Read = {
        table,
        columns: '',
        filters: {},
        order: [],
        limit: null,
        or: null,
        gt: [],
      };
      /** Every predicate this request carries. They are combined with AND, as PostgREST does. */
      const where: ((row: unknown) => boolean)[] = [];

      const chain: Record<string, unknown> = {
        select: (columns: string) => {
          read.columns = columns;
          client.reads.push(read);
          return chain;
        },
        eq: (column: string, value: unknown) => {
          read.filters[column] = value;
          where.push((row) => apply(row, column, 'eq', String(value)));
          return chain;
        },
        neq: (column: string, value: unknown) => {
          where.push((row) => apply(row, column, 'neq', String(value)));
          return chain;
        },
        gt: (column: string, value: unknown) => {
          read.gt.push([column, String(value)]);
          where.push((row) => apply(row, column, 'gt', String(value)));
          return chain;
        },
        not: (column: string, operator: string, value: unknown) => {
          if (operator !== 'is' || value !== null) {
            throw new Error('the PostgREST stand-in only implements not(is, null)');
          }
          where.push((row) => {
            const actual = valueAt(row, column);
            return actual !== null && actual !== undefined;
          });
          return chain;
        },
        or: (expression: string) => {
          // Recorded as well as applied, because "is there an `or` on this request at
          // all" is its own assertion — a keyset cursor that silently stopped being
          // added would otherwise look like a first page that never ends.
          read.or = read.or === null ? expression : `${read.or} && ${expression}`;
          where.push((row) => matches(row, `or(${expression})`));
          return chain;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          read.order.push({ column, ascending: options?.ascending !== false });
          return chain;
        },
        limit: (count: number) => {
          read.limit = count;
          return chain;
        },
        range: (from: number, to: number) => {
          read.limit = to - from + 1;
          (read as Read & { range?: [number, number] }).range = [from, to];
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => {
          client.requests[table] = (client.requests[table] ?? 0) + 1;
          if (client.broken.has(table)) {
            const failed = Promise.resolve({ data: null, error: { message: 'nope' } }).then(
              resolve,
            );
            client.between(table, client.requests[table]!, tables);
            return failed;
          }

          let rows = (tables[table] ?? []).filter((row) => where.every((term) => term(row)));

          for (const { column, ascending } of [...read.order].reverse()) {
            rows = [...rows].sort((a, b) => {
              const result = compare(valueAt(a, column), valueAt(b, column));
              return ascending ? result : -result;
            });
          }

          const range = (read as Read & { range?: [number, number] }).range;
          if (range) rows = rows.slice(range[0], range[1] + 1);
          else if (read.limit !== null) rows = rows.slice(0, read.limit);

          const served = Promise.resolve({ data: rows, error: null }).then(resolve);
          client.between(table, client.requests[table]!, tables);
          return served;
        },
      };

      return chain;
    },
  };

  return client;
}
