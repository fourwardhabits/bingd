#!/usr/bin/env node
/**
 * Turns the founder's raw device captures into the web's shipped product shots.
 *
 * **Run by hand, not by the site build.** The outputs are committed into `web/src/`
 * beside `shot-collection.jpg` and `shot-ranking.jpg`, and for the same reason those
 * two are: the whole site must build from `web/` alone, with no dependency reaching
 * up into the repo and nothing for Cloudflare Pages to install. `sharp` is a repo
 * dependency used at authoring time and never at deploy time.
 *
 * Sources are `02 Screenshots/App Store/`, which is untracked and founder-local. That
 * is deliberate — a 600KB PNG per frame is not a thing to keep in git history — and it
 * is why this script names each one explicitly and fails loudly when one is missing,
 * rather than globbing a directory that may not exist on another machine.
 *
 * ---------------------------------------------------------------------------
 * THE BLUR IS NOT A STYLE CHOICE
 * ---------------------------------------------------------------------------
 *
 * The Feed is the best advertisement bingd. has and every capture of it contains other
 * people's display names and faces. `docs/architecture/web-deployment.md` records the
 * rule the existing two shots were picked under — no accounts, no handles, no faces —
 * which is why the site has never shown a feed at all.
 *
 * The founder resolved the same tension himself on the App Store: the live listing's
 * `04-social` frame shows the Feed with **every display name and avatar blurred**. This
 * applies that published decision to the web, at the same strength, so the site can
 * finally show the social layer without publishing a member list. The regions are
 * stated in source pixels and checked by eye against the output; a region that drifts
 * shows up immediately as a legible name, which is the failure worth catching.
 */

import { mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/**
 * `--raw` and `--out` exist because two of the three things this script needs live
 * outside the tree it sits in: the captures are untracked and therefore absent from a
 * git worktree, and `node_modules` belongs to the primary checkout. The defaults are
 * the ordinary single-checkout case; the flags are what let one run from anywhere.
 */
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const raw = flag('--raw', join(repo, '02 Screenshots', 'App Store'));
const out = flag('--out', join(here, 'src'));

/**
 * Android system chrome, cropped off every frame.
 *
 * The clock, the battery and the three-button navigation bar are the host phone's, not
 * bingd.'s, and a landing page that shows them is showing somebody's device rather than
 * a product. The app's own bottom tab bar is kept: it is the product.
 *
 * Stated as a fraction of height rather than in pixels because the captures are not all
 * 1080x2340 — four were already cropped by whatever produced them.
 */
const TOP = 0.030;
const BOTTOM = 0.043;

/**
 * There used to be a detail crop here, for the score reveal, whose 2026-08-31 capture
 * carries a placement line the shipped app can no longer draw. The reveal left the page
 * on 2026-09-12, when the ranking section started being illustrated by the two ranked
 * collections instead, so the crop and its class went with it. If a detail shot comes
 * back, the capture's stale line is the reason it has to be cropped rather than shown.
 */

/**
 * `[x, y, width, height]` in source pixels, blurred before the crop.
 *
 * Only the Feed needs any. Sigma 14 at 1080px wide is past the point where letterforms
 * survive, which is the bar: a name that can be squinted at is not blurred.
 */
const FEED_MASKS = [
  [175, 1010, 360, 56], // row 1 display name
  [96, 1115, 60, 60], // row 1 actor avatar, overlapping the poster
  [175, 1382, 360, 56], // row 2 display name
  [96, 1487, 60, 60], // row 2 actor avatar
  [175, 1758, 190, 52], // row 3 handle
  [90, 1846, 56, 56], // row 3 actor avatar
];

const SHOTS = [
  {
    source: 'Screenshot_20260831_094018_bingd.jpg',
    name: 'shot-compare',
    width: 760,
    alt: 'The bingd. ranking sheet asking which did you like more, with two film posters side by side',
  },
  {
    source: 'Screenshot_20260831_093909_bingd.jpg',
    name: 'shot-movies',
    width: 640,
    alt: 'A ranked bingd. movie collection as a poster grid, each poster carrying its own score',
  },
  {
    source: 'Screenshot_20260831_093915_bingd.jpg',
    name: 'shot-tv',
    width: 640,
    alt: 'A ranked bingd. TV collection as a poster grid, each season carrying its own score',
  },
  {
    source: 'Screenshot_20260831_093902_bingd.jpg',
    name: 'shot-feed',
    width: 640,
    masks: FEED_MASKS,
    alt: 'The bingd. feed showing trending titles and friends’ activity, with names and faces blurred',
  },
  {
    source: 'Screenshot_20260831_094137_bingd.jpg',
    name: 'shot-foryou',
    width: 640,
    alt: 'The bingd. For you wall, a grid of suggested films each with a save and a dismiss control',
  },
  {
    source: 'Screenshot_20260831_093932_bingd.jpg',
    name: 'shot-watchlist',
    width: 640,
    alt: 'A bingd. watchlist of nine films shown as a poster grid',
  },
];

await mkdir(out, { recursive: true });

const manifest = [];

for (const shot of SHOTS) {
  const file = join(raw, shot.source);
  try {
    await access(file);
  } catch {
    console.error(`missing source: ${file}`);
    process.exit(1);
  }

  let image = sharp(file);
  const { width: w, height: h } = await image.metadata();

  if (shot.masks) {
    // Blur each region on its own and composite it back, which is the only way to blur
    // part of an image in sharp: `blur()` is whole-image.
    const patches = await Promise.all(
      shot.masks.map(async ([left, top, width, height]) => ({
        input: await sharp(file)
          .extract({ left, top, width, height })
          .blur(14)
          .toBuffer(),
        left,
        top,
      })),
    );
    image = sharp(await sharp(file).composite(patches).toBuffer());
  }

  // The whole frame minus the host phone's status and navigation bars.
  const box = {
    left: 0,
    top: Math.round(h * TOP),
    width: w,
    height: h - Math.round(h * TOP) - Math.round(h * BOTTOM),
  };

  const buffer = await image
    .extract(box)
    .resize({ width: shot.width })
    .webp({ quality: 80, effort: 6 })
    .toBuffer();

  const meta = await sharp(buffer).metadata();
  await sharp(buffer).toFile(join(out, `${shot.name}.webp`));

  manifest.push({ name: shot.name, width: meta.width, height: meta.height, alt: shot.alt });
  console.log(
    `${shot.name}.webp  ${meta.width}x${meta.height}  ${(buffer.length / 1024).toFixed(0)}KB`,
  );
}

console.log('\n--- paste into build.mjs ---');
console.log(JSON.stringify(manifest, null, 2));
