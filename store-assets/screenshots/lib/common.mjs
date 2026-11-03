import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pipeline package folder. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repository this copy of the pipeline lives in. */
export const REPO = resolve(ROOT, '..', '..');
/** Gitignored. Every stage reads from and writes to a folder under here by default. */
export const OUT = join(ROOT, 'out');

/** `--name value` and bare `--flag`. Anything else is a usage error, not a silent no-op. */
export function parseArgs(argv, known) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!(name in known)) {
      throw new Error(`Unknown flag --${name}. Known: ${Object.keys(known).map((k) => `--${k}`).join(' ')}`);
    }
    if (known[name] === 'flag') {
      args[name] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      args[name] = value;
      i += 1;
    }
  }
  return args;
}

export const csv = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null);

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

/**
 * System Chrome, never a downloaded browser: `playwright-core` ships none, and the
 * pipeline must not fetch one. CHROME_PATH overrides the search.
 */
export function findChrome() {
  const candidates = [process.env.CHROME_PATH, ...CHROME_PATHS].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`Chrome not found. Install it or set CHROME_PATH. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  return found;
}

/**
 * What it takes for two runs to paint the same pixels.
 *
 * Text must be greyscale and unhinted. `--disable-gpu` is the one that is easy to lose: with
 * GPU raster, identical poster bytes came out differently resampled from run to run, across
 * up to 45% of a frame. Measured 2026-11-02 with the poster bytes hashed. Chromium's
 * deterministic-mode compositor flags made no difference, so they are not here.
 */
export const CHROME_ARGS = ['--disable-lcd-text', '--font-render-hinting=none', '--disable-gpu'];
