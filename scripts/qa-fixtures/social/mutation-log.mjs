/**
 * The mutation log: one JSON line per write the fixture makes (or, under --dry-run, would
 * make), plus the skips, conflicts and refusals a coordinator needs to read a run back.
 *
 * Fields: time, command, target, actor, operation, entity, result, and an optional detail.
 * Never a token, a key or a password: the logger is handed every secret value the run
 * holds and refuses to write a line containing one (it redacts and says so), so a careless
 * `detail` cannot leak.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'logs');

export function defaultLogPath(command, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(DEFAULT_LOG_DIR, `${stamp}-${command}.jsonl`);
}

/**
 * @param {{ command: string, target: string, path?: string|null, sink?: (line: string) => void,
 *           secrets?: () => string[], clock?: () => Date }} options
 *   `sink` replaces the file (tests); `path: null` with no sink writes nowhere.
 */
export function createMutationLog({
  command,
  target,
  path,
  sink,
  secrets = () => [],
  clock = () => new Date(),
}) {
  let ready = false;
  const lines = [];

  const write = (line) => {
    lines.push(line);
    if (sink) return sink(line);
    if (!path) return undefined;
    if (!ready) {
      mkdirSync(dirname(path), { recursive: true });
      ready = true;
    }
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
    return undefined;
  };

  return {
    path: sink ? null : (path ?? null),
    lines,
    record({ actor, operation, entity, result, detail }) {
      const entry = {
        time: clock().toISOString(),
        command,
        target,
        actor,
        operation,
        entity,
        result,
      };
      if (detail !== undefined) entry.detail = detail;
      let line = JSON.stringify(entry);
      for (const secret of secrets()) {
        if (typeof secret === 'string' && secret.length >= 6 && line.includes(secret)) {
          line = line.split(secret).join('[redacted]');
        }
      }
      write(line);
      return entry;
    },
  };
}
