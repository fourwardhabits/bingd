// Extracts the latest definition of a function (with its leading comments kept out) from a
// migration file, and applies single-occurrence replacements that throw if they miss.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIG = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

export function fn(file, name) {
  const text = readFileSync(join(MIG, file), 'utf8');
  const start = text.lastIndexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${name} not in ${file}`);
  const end = text.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`no end for ${name}`);
  return text.slice(start, end + 4);
}

export function edit(source, pairs, label) {
  let out = source;
  for (const [from, to] of pairs) {
    const hits = out.split(from).length - 1;
    if (hits !== 1) throw new Error(`${label}: expected 1 hit, got ${hits} for:\n${from}`);
    out = out.replace(from, () => to);
  }
  return out;
}
