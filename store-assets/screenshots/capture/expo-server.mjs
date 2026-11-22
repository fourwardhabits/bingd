import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';

/** Backend and telemetry settings that must never reach a render from the operator's shell. */
const SCRUBBED_ENV = /^(EXPO_PUBLIC_|SUPABASE|SENTRY|POSTHOG|EAS_|EXPO_TOKEN)/;

export const pidFile = (workdir) => join(workdir, 'expo-server.pid');

export function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use, and this run did not start it. Nothing was stopped.`));
    });
    socket.once('error', () => resolve());
  });
}

/**
 * `fetch` gives up on response headers after five minutes, and Metro sends none until the
 * first build finishes, so this reads with no socket timeout under its own deadline.
 */
function get(url, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(Math.max(remaining, 1000), () => req.destroy(new Error(`Timed out on ${url}`)));
    req.on('error', reject);
  });
}

/** Asks for the page and then its bundle, so Chrome never sits through the first build. */
export async function waitForBundle(port, { timeoutMs = 25 * 60 * 1000, isAlive = () => true } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('Metro exited before serving the bundle. See expo.log in the workdir.');
    try {
      const page = await get(`${base}/`, deadline);
      if (page.status === 200) {
        const html = page.body.toString('utf8');
        const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
        if (!src) throw new Error('The page has no bundle script');
        const started = Date.now();
        const bundle = await get(new URL(src, base).href, deadline);
        if (bundle.status !== 200) {
          throw new Error(`Bundle answered ${bundle.status}: ${bundle.body.toString('utf8').slice(0, 400)}`);
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(`bundle ready: ${(bundle.body.length / 1e6).toFixed(1)} MB in ${seconds}s`);
        return;
      }
      lastError = `page answered ${page.status}`;
    } catch (error) {
      lastError = error.message;
      if (/Bundle answered|no bundle script/.test(lastError)) throw error;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Metro never served the bundle: ${lastError}`);
}

/**
 * Starts Expo in the render folder. Three deliberate settings:
 *
 * - TEMP points at a private folder. Metro's cache lives in the system temp folder and
 *   `--clear` deletes it, so a shared temp would wipe any other render running on the machine.
 * - `node <cli>` rather than `npx`, so the recorded PID is the server and stopping it can
 *   never reach a process this run did not start.
 * - `CI=1` keeps Metro from watching files, which is the load and the staleness both.
 */
export async function startExpo({ workdir, port }) {
  await assertPortFree(port);

  const privateTemp = join(workdir, '.tmp');
  mkdirSync(privateTemp, { recursive: true });

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED_ENV.test(k)));
  Object.assign(env, {
    CI: '1',
    BROWSER: 'none',
    EXPO_NO_TELEMETRY: '1',
    EXPO_OFFLINE: '1',
    EXPO_NO_DEPENDENCY_VALIDATION: '1',
    TEMP: privateTemp,
    TMP: privateTemp,
    TMPDIR: privateTemp,
  });

  const log = createWriteStream(join(workdir, 'expo.log'));
  const child = spawn(
    process.execPath,
    [
      join(workdir, 'node_modules', 'expo', 'bin', 'cli'),
      'start',
      '--web',
      '--port',
      String(port),
      '--offline',
      '--no-dev',
      '--minify',
      '--clear',
    ],
    { cwd: workdir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  writeFileSync(pidFile(workdir), String(child.pid));

  let alive = true;
  child.once('exit', () => {
    alive = false;
  });

  return {
    pid: child.pid,
    isAlive: () => alive,
    stop: () => stopExpo(workdir),
  };
}

/** Stops only the process tree recorded by this pipeline's own pid file. */
export function stopExpo(workdir) {
  const file = pidFile(workdir);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8'));
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Already gone, which is the state this function exists to reach.
  }
  rmSync(file, { force: true });
  return true;
}
