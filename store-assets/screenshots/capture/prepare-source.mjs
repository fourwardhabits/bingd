import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { REPO, ROOT } from '../lib/common.mjs';

/**
 * Everything the web bundle needs, and nothing else. Never a live worktree: Expo can
 * rewrite config files, and a render must not be able to touch a checkout.
 */
const EXPORT_PATHS = [
  'app',
  'src',
  'assets',
  'config',
  'app.config.ts',
  'babel.config.js',
  'tsconfig.json',
  'package.json',
];

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

/** A folder holding an app checkout, or anything `git rev-parse` can resolve. */
export function resolveSource(input) {
  if (existsSync(join(input, 'app.config.ts'))) {
    const path = resolve(input);
    let sha = null;
    try {
      sha = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // A plain folder with no history is a legitimate source.
    }
    return { kind: 'folder', input, path, sha };
  }
  let sha;
  try {
    sha = git('rev-parse', '--verify', `${input}^{commit}`);
  } catch {
    throw new Error(`--source "${input}" is neither an app folder nor a git ref in ${REPO}`);
  }
  return { kind: 'ref', input, sha };
}

/**
 * Removes a junction without following it. A recursive delete through a junction would
 * empty the node_modules it points at, so this refuses anything that is not a link.
 */
export function removeJunction(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`Refusing to remove ${path}: it is a real folder, not a junction`);
  }
  unlinkSync(path);
}

function clearWorkdir(workdir) {
  // A render folder never holds these. Finding one means --workdir points at a real checkout.
  for (const marker of ['.git', 'package-lock.json']) {
    if (existsSync(join(workdir, marker))) {
      throw new Error(`Refusing to clear ${workdir}: it contains ${marker}`);
    }
  }
  // The junction first and on its own. Only then is a recursive delete safe.
  removeJunction(join(workdir, 'node_modules'));
  if (existsSync(join(workdir, 'node_modules'))) {
    throw new Error(`Junction still present in ${workdir}; not clearing it`);
  }
  rmSync(workdir, { recursive: true, force: true });
}

function exportFromRef(sha, workdir) {
  const tar = join(workdir, 'source.tar');
  git('archive', '--format=tar', `--output=${tar}`, sha, '--', ...EXPORT_PATHS);
  // Run inside the folder: a Windows drive colon in a -f path reads as a remote host to tar.
  execFileSync('tar', ['-xf', 'source.tar'], { cwd: workdir });
  rmSync(tar);
}

function exportFromFolder(path, workdir) {
  for (const entry of EXPORT_PATHS) {
    cpSync(join(path, entry), join(workdir, entry), { recursive: true });
  }
}

/**
 * Patches applied to the export only. `required` patches stop the run if the source has
 * moved on, because a build without them is not comparable. The tab bar patch is optional
 * so a redesign that rewrites that file warns rather than blocks.
 */
function applyPatches(workdir) {
  const log = {};
  const patch = (file, { pattern, replacement, already, required }) => {
    const full = join(workdir, file);
    const text = readFileSync(full, 'utf8');
    const hits = text.match(pattern)?.length ?? 0;
    if (hits === 0 && !(already && already.test(text))) {
      if (required) throw new Error(`Render patch no longer applies to ${file}: ${pattern}`);
      console.warn(`warning: render patch did not apply to ${file}: ${pattern}`);
    }
    writeFileSync(full, text.replace(pattern, replacement));
    log[file] = hits;
  };

  patch('app.config.ts', {
    pattern: /output:\s*'server'/g,
    replacement: "output: 'single'",
    already: /output:\s*'single'/,
    required: true,
  });
  // The Android tab bar is the phone layout; the web branch is a desktop one.
  patch('app/(tabs)/_layout.tsx', {
    pattern: /Platform\.OS === 'android'/g,
    replacement: "(Platform.OS === 'android' || Platform.OS === 'web')",
    required: false,
  });

  const pkgPath = join(workdir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.main = 'shims/entry.js';
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return log;
}

function warnOnLockfileDrift(nodeModules, source) {
  const lockBeside = join(dirname(nodeModules), 'package-lock.json');
  if (!existsSync(lockBeside)) return;
  const hash = (text) =>
    createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
  const wanted =
    source.kind === 'ref'
      ? git('show', `${source.sha}:package-lock.json`)
      : readFileSync(join(source.path, 'package-lock.json'), 'utf8');
  if (hash(readFileSync(lockBeside, 'utf8')) !== hash(wanted)) {
    console.warn(
      `warning: ${nodeModules} was installed from a different lockfile than the source,\n` +
        '         so the render may not match that build.',
    );
  }
}

/** Builds the render folder from scratch. Returns what to record in capture.json. */
export function prepareSource({ source, workdir, nodeModules, mockPort }) {
  if (!existsSync(join(nodeModules, 'expo', 'package.json'))) {
    throw new Error(`--node-modules ${nodeModules} has no expo package in it`);
  }
  if (!statSync(nodeModules).isDirectory()) throw new Error(`${nodeModules} is not a folder`);

  clearWorkdir(workdir);
  mkdirSync(workdir, { recursive: true });

  if (source.kind === 'ref') exportFromRef(source.sha, workdir);
  else exportFromFolder(source.path, workdir);

  const patches = applyPatches(workdir);

  mkdirSync(join(workdir, 'shims'), { recursive: true });
  cpSync(join(ROOT, 'capture', 'shims', 'entry.js'), join(workdir, 'shims', 'entry.js'));
  cpSync(
    join(ROOT, 'capture', 'shims', 'expo-notifications.js'),
    join(workdir, 'shims', 'expo-notifications.js'),
  );
  if (existsSync(join(workdir, 'metro.config.js'))) {
    console.warn('warning: the source ships a metro.config.js; the render config replaces it');
  }
  cpSync(join(ROOT, 'capture', 'shims', 'metro.config.js'), join(workdir, 'metro.config.js'));

  // A fake key and a loopback URL. No real credential is read from anywhere.
  writeFileSync(
    join(workdir, '.env'),
    [
      `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:${mockPort}`,
      'EXPO_PUBLIC_SUPABASE_ANON_KEY=mock-anon-key',
      'APP_VARIANT=development',
      `EXPO_PUBLIC_POSTHOG_HOST=http://127.0.0.1:${mockPort}`,
      '',
    ].join('\n'),
  );

  warnOnLockfileDrift(nodeModules, source);
  symlinkSync(nodeModules, join(workdir, 'node_modules'), 'junction');
  return { patches };
}
