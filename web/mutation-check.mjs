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
 * Thirteen mutants. The last four arrived with the public-launch tranche, and are the
 * only ones whose defect is a *claim* rather than a broken link — a site that says the
 * apps have launched, a search engine invited in while the test is still closed, and a
 * Terms of Use naming a company that does not exist. None of the three breaks anything
 * a user would notice, which is exactly why they need a test:
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
 *  10. The release mode flipped to `public`, with store URLs invented to get past the
 *      build's own guard. The site then claims both apps are downloadable and asks to be
 *      indexed while neither is true.
 *  11. The noindex header dropped while the mode still says beta. The pages' meta tag
 *      still says the right thing, so the mistake is invisible from the HTML alone.
 *  12. The Terms' unconfirmed-entity placeholder replaced with a plausible company name,
 *      which is what tidying it away rather than filling it in correctly looks like.
 *  13. The Terms-status gate deleted from the public block, so filling in the entity
 *      alone would open the launch — and publish a Terms still calling itself an
 *      unreviewed draft, exactly the hole an independent review found before the gate
 *      existed.
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
// `_headers` stopped being a committed file in the public-launch tranche: its robots
// directive has to follow the release mode, so it is generated. The mutants that used to
// edit it edit the template it is generated from.
const BUILD = join(here, 'build.mjs');

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
    file: BUILD,
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
    /**
     * The launch switch, thrown early.
     *
     * This is the defect with the longest tail in the whole repository: a site that
     * says the apps are on the stores when they are not sends people to a 404, and an
     * indexed `/u/<handle>` cannot be withdrawn by any privacy setting in the app.
     * The build's own guard catches it while the store URLs are null — so this mutant
     * supplies them too, which is exactly the shape a careless launch commit would
     * have, and checks that the suite still notices.
     */
    name: 'the release mode flipped to public before the apps are actually on the stores',
    file: join(here, 'distribution.config.json'),
    apply: (s) =>
      s
        .replace('"mode": "beta"', '"mode": "public"')
        .replace('"storeUrl": null', '"storeUrl": "https://apps.apple.com/app/id6803954532"')
        .replace('"storeUrl": null', '"storeUrl": "https://play.google.com/store/apps/details?id=app.bingd"'),
  },
  {
    /**
     * noindex removed from the header while the mode still says beta.
     *
     * The two halves — the header and the pages' meta tag — are generated from one
     * `isPublic`, and this checks that the suite reads the header rather than trusting
     * the flag. Deleting one of two agreeing sources is the edit that would otherwise
     * pass, because the other one still says the right thing.
     */
    name: 'the noindex header dropped while the beta is still closed',
    file: BUILD,
    // Matched without the trailing escape, which is two source characters rather than a
    // newline and is the reason the first version of this mutant silently did not apply.
    apply: (s) => s.replace("  X-Robots-Tag: noindex, nofollow", '  X-Indexed-Anyway: yes'),
  },
  {
    /**
     * The Terms' unconfirmed-entity placeholder filled in with a plausible company.
     *
     * The failure it models is not malice, it is tidying: a placeholder in capitals
     * looks unfinished, and the obvious way to "finish" it is to write something that
     * reads like a company name. That produces a contract naming a party that does not
     * exist, which is worse than the obviously unfinished version it replaced.
     */
    name: 'the Terms placeholder replaced with an invented legal entity',
    file: BUILD,
    apply: (s) =>
      s.replace(
        "'[LEGAL ENTITY / DEVELOPER NAME &mdash; FOUNDER TO CONFIRM]'",
        "'Bingd Ltd'",
      ),
  },
  {
    /**
     * The Terms-status gate deleted from the public block.
     *
     * The gate exists because the entity check alone had a hole: entity filled, store
     * URLs set, mode flipped — and the site would publish a Terms whose own first
     * paragraph still said "Draft for review". This checks the sandbox suite would
     * notice the gate going: with it inert, the launch-commit rehearsal in
     * router.test.mjs builds where a refusal is asserted.
     */
    name: 'the Terms-status gate deleted, so a public build could ship a draft Terms',
    file: BUILD,
    apply: (s) => s.replace("if (TERMS_STATUS !== 'final')", 'if (false)'),
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
