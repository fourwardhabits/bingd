import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * Every embed the client asks PostgREST for has a foreign key to embed along.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (#196 founder QA, 2026-09-21)
 *
 * The T4 goal read was `watch_events?select=…,media_items!inner(…)`, and `watch_events` had
 * no foreign key to `media_items`. PostgREST answered every such request with PGRST200 and
 * the Goals screen said "Could not load your goals" — on staging, on a device, for everyone
 * on the new client. Every unit test passed, because every unit test mocks Supabase, and a
 * mock cannot know which relationships the real schema has.
 *
 * This reads the client source the way PostgREST reads a request — `from(table)` then the
 * `select` string's embeds — and asks the migrated schema whether each one has a key in
 * either direction. It is conservative: a view, an aliased-column embed it cannot resolve,
 * or a select it cannot parse is reported as skipped, never silently passed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}


/**
 * Every embed in one file, each checked against the relation that ENCLOSES it.
 *
 * `feed_events!inner(media_items(…))` embeds `media_items` in `feed_events`, not in the table
 * the chain started from, and `parent:parent_id(…)` inside `media_items(…)` follows
 * `media_items.parent_id`. The first version of this file read every embed as relative to
 * the top table and reported four false PGRST200s; nesting is the grammar, so the scanner
 * keeps a stack of resolved relations and checks each embed against the top of it.
 */
function checkFile(text, where, { tables, keys, related }, out) {
  const chain = /\.from\(\s*'([a-z_]+)'\s*\)([\s\S]{0,400}?)\.select\(\s*(['`])([\s\S]*?)\3/g;
  for (const m of text.matchAll(chain)) {
    const [, table, between, , select] = m;
    // Another `.from(` in between means the select belongs to a different chain.
    if (between.includes('.from(')) continue;

    // Each stack entry is the table that relation resolves to, or null when it cannot be
    // resolved (a view, an aggregate) — and then nothing nested under it is judged.
    const stack = [tables.has(table) ? table : null];
    if (!tables.has(table)) out.skipped.push(`${where}: ${table} is a view`);

    const token = /([a-z_]+)(?::([a-z_]+))?(?:!([a-z_]+))?\(|\)/g;
    for (const e of select.matchAll(token)) {
      if (e[0] === ')') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const [, first, aliasColumn] = e;
      const parent = stack[stack.length - 1];

      if (['count', 'sum', 'avg', 'min', 'max'].includes(first) || parent === null) {
        stack.push(null);
        continue;
      }

      if (aliasColumn) {
        // `alias:column(…)` follows the key on that column of the enclosing relation.
        const key = keys.find((k) => k.child === parent && k.column === aliasColumn);
        if (key) {
          out.checked += 1;
          stack.push(key.parent);
        } else {
          out.missing.push(`${where}: ${parent}.${aliasColumn} has no foreign key`);
          stack.push(null);
        }
        continue;
      }

      if (!tables.has(first)) {
        out.skipped.push(`${where}: ${parent} → ${first} (not a table)`);
        stack.push(null);
        continue;
      }
      if (related(parent, first)) {
        out.checked += 1;
      } else {
        out.missing.push(`${where}: ${parent} → ${first} has no foreign key (PGRST200)`);
      }
      stack.push(first);
    }
  }
}

let t;

before(async () => {
  t = await createTestDb();
});

after(async () => {
  await t?.close();
});

describe('the embeds the client asks for', () => {
  it('each has a foreign key to embed along', async () => {
    const tables = new Set(
      (
        await t.sql(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE'`,
        )
      ).rows.map((r) => r.table_name),
    );
    const keys = (
      await t.sql(
        `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
                a.attname as column
           from pg_constraint c
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
      )
    ).rows;
    const related = (x, y) =>
      keys.some((k) => (k.child === x && k.parent === y) || (k.child === y && k.parent === x));

    const out = { missing: [], skipped: [], checked: 0 };
    for (const file of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'app'))]) {
      checkFile(readFileSync(file, 'utf8'), relative(root, file), { tables, keys, related }, out);
    }

    assert.deepEqual(out.missing, [], 'an embed the client makes has no relationship to embed along');
    // A parser that finds nothing proves nothing.
    assert.ok(out.checked >= 5, `only ${out.checked} embeds were checked; the parser has stopped finding them`);
  });

  it('would have caught the goal read that shipped without its key', async () => {
    // The control: the exact select that failed on staging, against a schema with no
    // watch_events → media_items key, must be reported. Without this, a scanner that had
    // quietly stopped matching would pass the test above forever.
    const out = { missing: [], skipped: [], checked: 0 };
    const tables = new Set(['watch_events', 'media_items', 'user_media']);
    const keys = [
      { child: 'watch_events', parent: 'user_media', column: 'user_id' },
      { child: 'user_media', parent: 'media_items', column: 'media_item_id' },
    ];
    const related = (x, y) =>
      keys.some((k) => (k.child === x && k.parent === y) || (k.child === y && k.parent === x));
    checkFile(
      "supabase.from('watch_events').select('id, media_item_id, watched_on, media_items!inner(kind, title, poster_path)')",
      'use-goals.ts',
      { tables, keys, related },
      out,
    );
    assert.deepEqual(out.missing, [
      'use-goals.ts: watch_events → media_items has no foreign key (PGRST200)',
    ]);
  });
});
