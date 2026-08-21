/**
 * The mutation check for the deep-link identity tests — `npm run test:web:mutants`.
 * Deliberately not part of `test:web`, and deliberately not a `.test.mjs`, matching
 * `supabase/tests/concurrency/mutation-check.mjs`.
 *
 * `test:web` passing proves the site is internally consistent. It does not prove the
 * suite would notice if the site stopped describing *this app* — and that is the failure
 * this project has already shipped once. `/list/*` was claimed against a route called
 * `app/lists/[id].tsx` for weeks with every test green, because the two halves were only
 * ever checked against each other. It is still live on Apple's CDN today.
 *
 * So each way the four uncompiled halves of a deep link can drift apart is reintroduced
 * here, and `web/router.test.mjs` is required to go red. Every one of these mutants
 * ships silently in production: there is no error message when an Apple App Site
 * Association file names the wrong app, no warning when an intent filter loses
 * autoVerify, and no log line when a claimed path has no screen. The link simply opens
 * the browser, or opens the app onto `+not-found`, and the reasonable conclusion for
 * whoever tapped it is that Bingd does not work.
 *
 * Nine mutants:
 *
 *   1. `/lists/*` reverted to `/list/*`. The exact defect that shipped.
 *   2. A variant renamed in `app.config.ts` and not in `deep-links.config.json`, so the
 *      file claims an appID no build produces.
 *   3. `associatedDomains` pointed at another host, so the binary is entitled for a
 *      domain that publishes nothing and bingd.app's file is read by nobody.
 *   4. `autoVerify` dropped. Android still matches the filter but shows a chooser
 *      instead of opening — which reads as the link being broken.
 *   5. The Android host changed without the site moving.
 *   6. `apple-app-site-association` typed `text/plain`. iOS fetches it, declines to
 *      parse it, and every Universal Link keeps opening Safari.
 *   7. A path claimed against a folder with no `[param].tsx` to receive the identifier.
 *   8. One Android `pathPrefix` dropped, so a route opens the app on iOS and opens Chrome
 *      on Android — the `/list/*` failure again, on one platform only.
 *   9. The Android filter widened back to the whole host, which is what it said before
 *      2026-08-20. It claims /privacy, /support and /account-deletion, and Android hands
 *      the store's own compliance links to the app to render as `+not-found`.
 *
 * **The Apple team id is not here, and cannot be.** It has exactly one source in this
 * repository and nothing to cross-check it against, so a wrong value is consistent
 * everywhere and no offline test can see it. It is verified by a link opening on a
 * physical device, and by nothing else.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const LINKS = join(here, 'deep-links.config.json');
const APP_CONFIG = join(root, 'app.config.ts');
const HEADERS = join(here, 'public', '_headers');

const MUTANTS = [
  {
    name: 'the /list/* typo, reintroduced',
    file: LINKS,
    apply: (s) => s.replace('"/lists/*"', '"/list/*"'),
  },
  {
    name: 'a variant renamed in app.config.ts and not in deep-links.config.json',
    file: APP_CONFIG,
    apply: (s) => s.replace("bundleId: 'app.bingd.preview'", "bundleId: 'app.bingd.beta'"),
  },
  {
    name: 'associatedDomains pointed at a host that publishes nothing',
    file: APP_CONFIG,
    apply: (s) => s.replace("'applinks:bingd.app'", "'applinks:bingd.example'"),
  },
  {
    name: 'autoVerify dropped from the Android intent filter',
    file: APP_CONFIG,
    apply: (s) => s.replace('autoVerify: true,', 'autoVerify: false,'),
  },
  {
    name: 'the Android host changed without the site moving',
    file: APP_CONFIG,
    apply: (s) => s.replace("host: 'bingd.app'", "host: 'www.bingd.app'"),
  },
  {
    name: 'apple-app-site-association no longer typed as JSON',
    file: HEADERS,
    apply: (s) =>
      s.replace(
        /(\/\.well-known\/apple-app-site-association\r?\n\s+Content-Type: )application\/json/,
        '$1text/plain',
      ),
  },
  {
    name: 'a path claimed against a folder with no [param].tsx to receive the identifier',
    file: LINKS,
    apply: (s) => s.replace('"/i/*"', '"/settings/*"'),
  },
  {
    name: 'an Android path prefix dropped, so one route opens the app on iOS and Chrome on Android',
    file: APP_CONFIG,
    apply: (s) =>
      s.replace(/\r?\n\s+\{ scheme: 'https', host: 'bingd\.app', pathPrefix: '\/i\/' \},/, ''),
  },
  {
    name: 'the Android filter widened back to the whole host, so /privacy opens the app',
    file: APP_CONFIG,
    apply: (s) =>
      s.replace(
        /data: \[(\r?\n\s+\{ scheme: 'https', host: 'bingd\.app', pathPrefix: '[^']+' \},)+\r?\n\s+\],/,
        "data: [{ scheme: 'https', host: 'bingd.app' }],",
      ),
  },
];

const results = [];

for (const mutant of MUTANTS) {
  const original = readFileSync(mutant.file, 'utf8');
  const mutated = mutant.apply(original);

  // A mutant that did not apply is a silently passing check, which is the one outcome
  // this file exists to prevent. Reported as a failure rather than skipped.
  if (mutated === original) {
    results.push([`${mutant.name} — MUTANT DID NOT APPLY`, false]);
    continue;
  }

  try {
    writeFileSync(mutant.file, mutated);
    let red = false;
    try {
      execFileSync(process.execPath, ['--test', join(here, 'router.test.mjs')], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch {
      red = true;
    }
    results.push([mutant.name, red]);
  } finally {
    writeFileSync(mutant.file, original);
  }
}

// The suite rebuilds dist/ as it runs. Left as an ordinary `npm run build:web` would.
execFileSync(process.execPath, [join(here, 'build.mjs')], { cwd: root, stdio: 'pipe' });

let ok = true;
for (const [name, detected] of results) {
  console.log(`${detected ? 'DETECTED ' : 'MISSED   '} ${name}`);
  if (!detected) ok = false;
}
console.log(`\n${results.filter(([, d]) => d).length} / ${results.length} defects detected`);
process.exit(ok ? 0 : 1);
