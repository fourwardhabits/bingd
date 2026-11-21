/**
 * Applies the 2026-11-19 store refresh to an EAS metadata config pulled from the LIVE
 * App Store listing, so nothing the founder typed into App Store Connect is overwritten
 * by a stale draft from this repository.
 *
 *   eas metadata:pull --profile production            # writes store.config.json from App Store Connect
 *   node store-assets/listings/2026-11-19-refresh/metadata/apply-refresh.mjs store.config.json --version 1.2.0
 *   git diff --no-index <copy> store.config.json      # read every change
 *   eas metadata:push --profile production            # only after reading the diff
 *
 * What it changes, and nothing else:
 *   - en-US title -> "bingd" (no period). The graphic wordmark inside the screenshots keeps its period.
 *   - "bingd." used as the plain-text name in subtitle / description / promoText / releaseNotes -> "bingd".
 *     Only where the period cannot be a sentence end: followed by a space and a lowercase
 *     letter ("bingd. is a home ..."), or the whole field. Domains (bingd.app) never match.
 *     Every other "bingd." is printed for a human decision and left alone.
 *   - apple.version -> --version, and releaseNotes from --release-notes (or WHATS_NEW below)
 *     when the pulled config has none for the new version.
 *   - en-US screenshots: the six cards, in upload order, for both iPhone slots.
 *
 * Read-only on everything else. Writes the result back to the same file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const listing = join(here, '..');
const args = process.argv.slice(2);
const file = args[0];
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const version = opt('--version');
if (!file || !version) {
  console.error(
    'usage: apply-refresh.mjs <store.config.json> --version <x.y.z> [--release-notes "..."]',
  );
  process.exit(2);
}

/** Draft "What's New" for the new version. FOUNDER CONFIRM before pushing. */
const WHATS_NEW =
  'Everything from recent updates is now built into the app: a tidier feed that groups a ranking session into one post, clearer likes and comments on every post, and smoother sharing of reviews. Plus fixes and polish.';

/**
 * Screenshot display types. 1206 x 2622 is "iPhone with Dynamic Island (medium display)",
 * the size Apple lists as required; 1320 x 2868 is the large display (6.9"). Confirm both
 * keys against the pulled config: if App Store Connect already holds sets, `eas
 * metadata:pull` names them, and those names win over these.
 */
const SLOTS = { APP_IPHONE_61: 'apple-1206x2622', APP_IPHONE_67: 'apple-1320x2868' };

const cfgPath = resolve(file);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const projectDir = dirname(cfgPath);
const manifest = JSON.parse(readFileSync(join(listing, 'manifest.json'), 'utf8'));
const apple = (cfg.apple ??= {});
const info = (apple.info ??= {});
const en = (info['en-US'] ??= {});
const changes = [];
const review = [];

const set = (obj, key, value, label) => {
  if (obj[key] !== value) {
    changes.push(`${label}: ${JSON.stringify(obj[key] ?? null)} -> ${JSON.stringify(value)}`);
    obj[key] = value;
  }
};

set(en, 'title', 'bingd', 'en-US title');

const SAFE = /\bbingd\.(?= [a-z])/g;
for (const key of ['subtitle', 'description', 'promoText', 'releaseNotes']) {
  const v = en[key];
  if (typeof v !== 'string') continue;
  if (v.trim() === 'bingd.') {
    set(en, key, 'bingd', `en-US ${key}`);
    continue;
  }
  const next = v.replace(SAFE, 'bingd');
  if (next !== v) set(en, key, next, `en-US ${key}`);
  for (const m of next.matchAll(/\bbingd\.(?![a-z0-9])/gi))
    review.push(
      `en-US ${key} @${m.index}: "...${next.slice(Math.max(0, m.index - 30), m.index + 36)}..."`,
    );
}
for (const locale of Object.keys(info))
  if (locale !== 'en-US')
    review.push(`locale ${locale} exists: apply the same name change there by hand`);

set(apple, 'version', version, 'apple.version');
if (!en.releaseNotes)
  set(en, 'releaseNotes', opt('--release-notes') ?? WHATS_NEW, 'en-US releaseNotes');

const screenshots = { ...(en.screenshots ?? {}) };
for (const [slot, target] of Object.entries(SLOTS)) {
  const files = manifest.targets[target].cards
    .sort((a, b) => a.position - b.position)
    .map((c) => relative(projectDir, join(listing, '..', '..', '..', c.file)));
  changes.push(
    `en-US screenshots.${slot}: ${(screenshots[slot] ?? []).length} -> ${files.length} files (${target})`,
  );
  screenshots[slot] = files;
}
for (const slot of Object.keys(screenshots))
  if (!SLOTS[slot])
    review.push(
      `screenshots.${slot} still holds ${screenshots[slot].length} older images: delete that set in App Store Connect or list the new ones here`,
    );
en.screenshots = screenshots;

writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log('Changed:');
for (const c of changes) console.log(`  ${c}`);
console.log(
  review.length ? '\nNeeds a human decision (left as is):' : '\nNothing left for review.',
);
for (const r of review) console.log(`  ${r}`);
console.log(
  `\nCard 03: ${manifest.card03.status}${manifest.card03.missing ? ` (waiting for ${manifest.card03.missing})` : ''}`,
);
if (manifest.card03.status !== 'swapped')
  console.log(
    'Do not push the screenshots until card 03 is swapped: one submission carries both the name and the final set.',
  );
