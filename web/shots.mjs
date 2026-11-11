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
const layers = flag('--layers', null);

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
const TOP = 0.03;
const BOTTOM = 0.043;

/**
 * There used to be a detail crop here, for the score reveal, whose 2026-08-31 capture
 * carries a placement line the shipped app can no longer draw. The reveal left the page
 * on 2026-09-12, when the ranking section started being illustrated by the two ranked
 * collections instead, so the crop and its class went with it. If a detail shot comes
 * back, the capture's stale line is the reason it has to be cropped rather than shown.
 */

/**
 * Masks are `[x, y, width, height]` in source pixels, blurred before the crop. Sigma 14
 * at 1080px wide is past the point where letterforms survive, which is the bar: a name
 * that can be squinted at is not blurred.
 *
 * The Witcher comments thread. Every display name and avatar is blurred, the founder's
 * included, for the same reason as the Feed: a comment is somebody's words, and the page
 * shows the conversation, not who had it.
 */
const COMMENT_MASKS = [
  [175, 372, 168, 58], // "Abisola" in the ranked row
  [80, 464, 62, 68], // actor avatar over the poster
  [38, 677, 92, 92], // first commenter's photo
  [155, 684, 318, 50], // first commenter's name
  [100, 1011, 94, 94], // reply avatar
  [218, 1016, 150, 56], // reply name
];

/**
 * The Group Picks sheet (Galaxy S25, 2026-09-14). It lists the people the account follows,
 * so each friend row is blurred across its avatar, display name and handle: the site
 * shows no accounts, handles or faces (docs/architecture/web-deployment.md). "You", the
 * checkboxes and every other part of the sheet stay legible.
 */
const GROUP_PICKS_MASKS = [
  [36, 1188, 524, 106], // Abisola
  [36, 1334, 524, 108], // adirajan
  [36, 1481, 524, 106], // Ashvin
  [36, 1629, 524, 106], // bingd. founder
  [36, 1776, 524, 106], // Eric Eichstadt
  [36, 1923, 524, 106], // Ganga
];

/**
 * The 2026-11-09 refresh, from the founder's prepared screen layers rather than raw
 * captures: `node web/shots.mjs --layers <prepared-screen-layers>`.
 *
 * These are the same screens as the approved App Store set, before they went into a
 * phone frame. They arrive already redacted (localized blur on every member's name and
 * photo) with the Android bars already cropped, so this mode applies no masks and no
 * TOP/BOTTOM trim. It only scales them, and crops the router's ranking detail.
 *
 * The capture-based entries for these eight names were removed from `SHOTS`, so a plain
 * run cannot put the August captures back.
 */
const LAYER_SHOTS = [
  {
    source: '01-movies-tv__main-screen.png',
    name: 'shot-movies',
    width: 640,
    alt: 'A ranked bingd movie collection as a grid of posters, each one carrying its own score out of ten',
  },
  {
    source: '01-movies-tv__secondary-screen.png',
    name: 'shot-tv',
    width: 640,
    alt: 'A ranked bingd TV collection as a grid of posters, each season carrying its own score out of ten',
  },
  {
    source: '02-head-to-head__secondary-screen.png',
    name: 'shot-compare',
    width: 640,
    alt: 'The bingd ranking sheet asking which did you like more, You Can See Everything or Inception',
  },
  {
    // The same ranking as shot-compare, finished: the result sheet over the title page.
    source: '02-head-to-head__main-screen.png',
    name: 'shot-score',
    width: 640,
    alt: 'The score a bingd ranking lands on, 9.8 for You Can See Everything, sixth in Movies and just below Inglourious Basterds',
  },
  {
    source: '03-friends__main-screen.png',
    name: 'shot-feed',
    width: 640,
    alt: 'The bingd feed, showing trending titles above friends’ recent activity, with names and faces blurred',
  },
  {
    source: '06-for-you__main-screen.png',
    name: 'shot-recommended',
    width: 640,
    alt: 'The bingd For you tab: a wall of recommended movies, each with a save and a dismiss control, under Sent to You, Find for a Group and Filters',
  },
  {
    source: '01-movies-tv__secondary-screen.png',
    name: 'shot-collection',
    format: 'jpeg',
    width: 720,
    alt: 'A bingd collection of ranked series, each with a score out of ten.',
  },
  {
    // The comparison sheet alone, from just above its rounded top edge to under Undo and
    // Can't decide.
    source: '02-head-to-head__secondary-screen.png',
    name: 'shot-ranking',
    format: 'jpeg',
    width: 720,
    crop: [0, 388, 709, 974],
    alt: 'Two films side by side in bingd, under the question which did you like more.',
  },
];

const SHOTS = [
  {
    source: 'Screenshot_20260914_110947_bingd.jpg',
    name: 'shot-grouppicks',
    width: 640,
    masks: GROUP_PICKS_MASKS,
    alt: 'The bingd Group Picks sheet: choose who is watching from the people you follow and bingd finds movies you can all agree on, with names blurred',
  },
  {
    // Your First Five on an iPhone (2026-09-12), the whole screen (founder, 2026-09-14:
    // the earlier crop to four rows hid too much). Only the iPhone status bar goes, the
    // way every other shot loses its host phone's chrome; the onboarding progress bar
    // under it is the app's and stays.
    //
    // One sentence is painted out, not cropped: "Already on Letterboxd? You can bring
    // your whole history across whenever you like, from Settings." This preview-build
    // capture predates the importer reaching the shipped app, and a landing page must not
    // advertise a feature the App Store build does not have. Painted with the screen's
    // own ground, so the gap reads as spacing. Remove the `paint` when the importer ships.
    source: 'IMG_0756.PNG',
    name: 'shot-ranked',
    width: 640,
    crop: [0, 80, 828, 1712],
    paint: [{ box: [20, 562, 790, 92], rgb: [251, 248, 244] }],
    alt: 'The bingd. Your First Five screen: four movies ranked in order, each with its score out of ten',
  },
  {
    source: 'Screenshot_20260831_094209_bingd.jpg',
    name: 'shot-comments',
    width: 640,
    masks: COMMENT_MASKS,
    alt: 'A bingd comment thread under a ranking of The Witcher, season one, with names and faces blurred',
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

/** `--only shot-a,shot-b` regenerates just those, leaving every committed shot untouched. */
const only = flag('--only', null)?.split(',');

for (const shot of (layers ? LAYER_SHOTS : SHOTS).filter(
  (s) => !only || only.includes(s.name),
)) {
  const file = join(layers ?? raw, shot.source);
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
        input: await sharp(file).extract({ left, top, width, height }).blur(14).toBuffer(),
        left,
        top,
      })),
    );
    image = sharp(await sharp(file).composite(patches).toBuffer());
  }

  if (shot.paint) {
    // Solid rectangles in the screen's own ground colour, over something that must not be
    // shown at all (not merely made illegible, which is what `masks` is for).
    const fills = await Promise.all(
      shot.paint.map(async ({ box: [left, top, width, height], rgb: [r, g, b] }) => ({
        input: await sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
          .png()
          .toBuffer(),
        left,
        top,
      })),
    );
    image = sharp(await image.composite(fills).toBuffer());
  }

  // The whole frame minus the host phone's status and navigation bars, unless the shot
  // names its own crop. A prepared layer has no bars left to trim.
  const box = shot.crop
    ? { left: shot.crop[0], top: shot.crop[1], width: shot.crop[2], height: shot.crop[3] }
    : layers
      ? { left: 0, top: 0, width: w, height: h }
      : {
          left: 0,
          top: Math.round(h * TOP),
          width: w,
          height: h - Math.round(h * TOP) - Math.round(h * BOTTOM),
        };

  const ext = shot.format === 'jpeg' ? 'jpg' : 'webp';
  const resized = image
    .extract(box)
    .flatten({ background: '#fbf8f4' })
    .resize({ width: shot.width });
  const buffer = await (
    ext === 'jpg'
      ? resized.jpeg({ quality: 82, mozjpeg: true })
      : resized.webp({ quality: 80, effort: 6 })
  ).toBuffer();

  const meta = await sharp(buffer).metadata();
  await sharp(buffer).toFile(join(out, `${shot.name}.${ext}`));

  manifest.push({ name: shot.name, width: meta.width, height: meta.height, alt: shot.alt });
  console.log(
    `${shot.name}.${ext}  ${meta.width}x${meta.height}  ${(buffer.length / 1024).toFixed(0)}KB`,
  );
}

console.log('\n--- paste into build.mjs ---');
console.log(JSON.stringify(manifest, null, 2));
