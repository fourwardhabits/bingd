#!/usr/bin/env node
/**
 * Builds the static site for bingd.app, whose only job in v1 is to serve the two
 * files that let a tapped link open the app instead of the browser.
 *
 * Why this is generated rather than committed by hand: both files repeat the same
 * identifiers in different shapes, Apple's needs a team prefix that Android's does
 * not, and a mistake in either is invisible. There is no error message when an
 * Apple App Site Association file is malformed — iOS fetches it, fails to parse
 * it, and links quietly keep opening Safari. So the identifiers live in one JSON
 * file and this script refuses to produce output while any of them is missing.
 */

import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const config = JSON.parse(await readFile(join(here, 'deep-links.config.json'), 'utf8'));

const problems = [];

if (!config.appleTeamId) {
  problems.push(
    'appleTeamId is not set. App Store Connect > Membership Details > Team ID (10 characters).',
  );
} else if (!/^[A-Z0-9]{10}$/.test(config.appleTeamId)) {
  problems.push(`appleTeamId "${config.appleTeamId}" is not 10 uppercase alphanumerics.`);
}

const withFingerprints = config.variants.filter((v) => v.androidSha256.length > 0);

if (withFingerprints.length === 0) {
  problems.push(
    'No variant has an androidSha256 fingerprint. Run `eas credentials`, or read it ' +
      'from Play Console > Setup > App integrity if Play re-signs the app.',
  );
}

for (const variant of config.variants) {
  for (const fingerprint of variant.androidSha256) {
    if (!/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)) {
      problems.push(
        `${variant.name}: "${fingerprint}" is not a SHA-256 fingerprint. Expected 32 ` +
          'colon-separated uppercase hex pairs.',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\nCannot build the deep-link files:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nDeploying with these missing would not break the site. It would make every\n' +
      'invitation and share link open the browser instead of the app, with no error\n' +
      'anywhere to explain why. Refusing instead.\n',
  );
  process.exit(1);
}

await mkdir(join(dist, '.well-known'), { recursive: true });
await cp(join(here, 'public'), dist, { recursive: true });

/**
 * Apple. `applinks` claims the paths; `webcredentials` is what lets the keychain
 * offer a saved password and is required for Sign in with Apple's associated
 * domain to behave. Every variant is listed, because a development build has its
 * own bundle identifier and would otherwise be the one place links do not work —
 * which is exactly where they get tested.
 */
const appleAppIds = config.variants.map((v) => `${config.appleTeamId}.${v.bundleId}`);

const aasa = {
  applinks: {
    details: [
      {
        appIDs: appleAppIds,
        components: config.appPaths.map((path) => ({
          '/': path,
          comment: 'Opens in the app when installed',
        })),
      },
    ],
  },
  webcredentials: { apps: appleAppIds },
};

// No file extension, by Apple's requirement. The content type is set in _headers.
await writeFile(
  join(dist, '.well-known', 'apple-app-site-association'),
  `${JSON.stringify(aasa, null, 2)}\n`,
);

/**
 * Android. One statement per package, and a package may list several fingerprints,
 * which is the normal case: the upload key and the Play app-signing key differ
 * whenever Play re-signs.
 */
const assetlinks = withFingerprints.map((variant) => ({
  relation: ['delegate_permission/common.handle_all_urls'],
  target: {
    namespace: 'android_app',
    package_name: variant.bundleId,
    sha256_cert_fingerprints: variant.androidSha256,
  },
}));

await writeFile(
  join(dist, '.well-known', 'assetlinks.json'),
  `${JSON.stringify(assetlinks, null, 2)}\n`,
);

console.log(`Built ${dist}`);
console.log(`  apple-app-site-association  ${appleAppIds.length} app IDs, ${config.appPaths.length} paths`);
console.log(`  assetlinks.json             ${assetlinks.length} package(s)`);
