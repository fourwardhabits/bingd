/**
 * Split one migration file into statements the way the Supabase CLI does.
 *
 * Not a general SQL parser and not trying to be. It answers exactly one question — where
 * are the top-level semicolons — by skipping everything a semicolon can hide inside:
 * line comments, block comments (which nest in PostgreSQL), single-quoted strings with
 * their doubled-quote escapes, and dollar-quoted bodies with arbitrary tags.
 *
 * Each statement is stored trimmed and WITHOUT its terminating semicolon, and the
 * comments preceding a statement belong to it. That is not a choice made here: it is the
 * shape of the 53 rows already in `supabase_migrations.schema_migrations`, and
 * `verify-splitter.mjs` proves this function reproduces all 53 byte for byte before the
 * runner is allowed to write a fifty-fourth.
 */
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Line comment: to end of line.
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // Block comment, and PostgreSQL nests them.
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }

    // Single-quoted string. '' is an escaped quote, not a close-then-open.
    if (ch === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Dollar-quoted body. The tag may be empty ($$) or named ($fn$); a leading digit is
    // not a tag, which is what keeps $1 from opening one.
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }

    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) out.push(statement);
      start = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}
