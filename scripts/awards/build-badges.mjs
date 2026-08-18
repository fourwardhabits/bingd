/**
 * Builds `assets/awards/*.png` from the generated contact sheet.
 *
 *     node scripts/awards/build-badges.mjs            # writes the badges
 *     node scripts/awards/build-badges.mjs --tiles    # also writes every raw tile
 *
 * The source, `00 Brand SVGs/badges.jpg`, is founder-supplied, never modified, and not
 * a sprite sheet. It is a generated image: the cells are not equal, some art overflows
 * its cell, one tile has a sparkle detached from it, and every tile carries a rendered
 * caption underneath. Several captions are wrong — two tiles read "Movie Muncher" over
 * artwork for different tiers, one reads Gold "Smal" — so the captions are cropped away
 * and none of them is read. Which tile is which award is the human reading in `TILES`
 * below, and `src/features/awards/badges.ts` is what the app uses.
 *
 * How the cutting works:
 *
 *   1. Columns come from a vertical ink profile over the whole sheet. A run narrower
 *      than `COLUMN_MIN_WIDTH` is not a column — it is a detached sparkle — so it joins
 *      whichever neighbour is nearer. A gap threshold was the first attempt and cannot
 *      work: the sparkle's gap is 2px and genuine column gaps run 23px to 35px, but no
 *      single number between them separates the two cases on this sheet.
 *   2. Inside each column, a horizontal ink profile gives alternating bands. A band
 *      taller than `ART_MIN_HEIGHT` is artwork; anything shorter is a caption line.
 *   3. Each art band is tightened to its own ink on both axes, then padded — but the
 *      padding is clamped so it cannot reach into the band above or below. Two tiles
 *      sit six pixels above their caption, and without the clamp the top line of the
 *      caption came away inside the crop: invisible at badge size, and still text.
 *   4. The background is cleared by a flood fill inwards from the crop border, never by
 *      a colour threshold over the tile. The popcorn is a pale cream within fourteen
 *      levels of the sheet's background, and a threshold eats the middle of it. A fill
 *      from outside cannot cross the dark outline every one of these illustrations has.
 *   5. Each badge is centred on a square canvas at its native scale. Nothing is
 *      resampled, so nothing is softened or stretched; the art keeps the relative size
 *      the illustrator drew it at, and every file has the same aspect so a list of them
 *      does not jitter.
 *
 * **What the checks can and cannot establish.** They prove a crop exists, is not empty,
 * fits the canvas, and has clear space on all four sides — which is what catches a
 * caption pulled in by padding, and is exactly what caught the gold popcorn and the
 * couch before the band clamp existed. They cannot prove that every retained pixel
 * belongs to the illustration somebody meant: a caption fragment fully enclosed inside
 * an art band would pass all four. Independent review 20 named that gap and it is real.
 * What closes it is looking: `scripts/awards/contact-sheet.mjs` lays all thirty out in
 * a grid, and every one of them was read that way before they were committed.
 * `assets/awards/BADGES.json` records the source rectangle each came from, so a rerun
 * that moves one is visible in a diff rather than only on a device.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

const SOURCE = '00 Brand SVGs/badges.jpg';
const OUT_DIR = 'assets/awards';
const TILE_DIR = 'assets/awards/tiles';

/** Sampled from the sheet's four corners, which agree to within three levels. */
const BACKGROUND = [245, 237, 216];
/** How far off the background a pixel has to be to count as ink. */
const INK = 26;
/** Narrower than this and it is a fragment of the column beside it, not a column. */
const COLUMN_MIN_WIDTH = 30;
/** A band this tall is artwork. Caption lines run to about thirty. */
const ART_MIN_HEIGHT = 45;
/** Breathing room around the tightened art, in source pixels. */
const PAD = 6;
/** The square every badge is centred on. Comfortably larger than the widest tile. */
const CANVAS = 152;

/**
 * Which tile carries which badge, read off the pictures rather than off the captions.
 *
 * `r-c` is one-based from the top left of the sheet. Where the sheet drew a family
 * twice — and it drew five of them twice — the set kept is the one whose three tiers
 * read as three different things at a glance, because only one tier of a track is ever
 * on screen and the badge is how somebody sees that they moved.
 */
const TILES = {
  'movie-muncher-bronze': '1-1', //     plain popcorn bucket
  'movie-muncher-silver': '1-2', //     a bucket holding a cinema ticket
  'movie-muncher-gold': '1-3', //       gold bucket, crowned
  'season-snacker-bronze': '1-4', //    a small retro television
  'season-snacker-silver': '1-5', //    a flat screen with a remote
  'season-snacker-gold': '2-3', //      the couch, lit up
  'invite-instigator-bronze': '3-1', // one paper plane
  'invite-instigator-silver': '3-2', // a flight of them
  'invite-instigator-gold': '3-3', //   the confetti cannon
  'queue-dragon-seedling': '4-1', //    a dragon asleep on the pile
  'queue-dragon-hoarder': '4-2', //     awake, and holding it
  'queue-dragon-queue-dragon': '4-3', //the scroll it will never finish
  'rating-rascal-scribbler': '5-1', //  the pencil
  'rating-rascal-score-goblin': '5-2', //the goblin and its dial
  'rating-rascal-rank-beast': '1-9', // the beast with the same dial
  'comment-gremlin-whisper': '2-7', //  one bubble
  'comment-gremlin-chatterbox': '2-8', //three
  'comment-gremlin-megaphone': '2-9', //no bubble at all
  'hype-courier-nudge': '4-4', //       a plane
  'hype-courier-messenger': '4-5', //   a courier
  'hype-courier-hype-train': '4-6', //  the train
  'scream-snack-spooky-sip': '3-7', //  the cup
  'scream-snack-slash-snack': '3-8', // the bucket, alarmed
  'scream-snack-nightmare-fuel': '3-9', //the ghost, lit
  'lol-mode-giggle': '5-4',
  'lol-mode-cackle': '5-5',
  'lol-mode-wheeze': '5-6',
  'softie-hours-sniffle': '5-7',
  'softie-hours-tearjerker': '5-8',
  'softie-hours-sob-lord': '5-9',
};

const { data, info } = await sharp(SOURCE).raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

const isInk = (x, y) => {
  const i = (y * W + x) * C;
  return (
    Math.max(
      Math.abs(data[i] - BACKGROUND[0]),
      Math.abs(data[i + 1] - BACKGROUND[1]),
      Math.abs(data[i + 2] - BACKGROUND[2]),
    ) > INK
  );
};

/** Contiguous true runs of at least `minRun`. */
function runs(flags, minRun) {
  const out = [];
  let start = null;
  for (let i = 0; i <= flags.length; i += 1) {
    const on = i < flags.length && flags[i];
    if (on && start === null) start = i;
    if (!on && start !== null) {
      if (i - start >= minRun) out.push([start, i - 1]);
      start = null;
    }
  }
  return out;
}

/** Absorbs every run narrower than `minWidth` into the nearer of its neighbours. */
function absorbFragments(list, minWidth) {
  const wide = list.filter(([a, b]) => b - a + 1 >= minWidth).map((run) => [...run]);
  if (!wide.length) return list.map((run) => [...run]);
  for (const [a, b] of list) {
    if (b - a + 1 >= minWidth) continue;
    let best = 0;
    let bestGap = Infinity;
    for (const [i, [wa, wb]] of wide.entries()) {
      const gap = a > wb ? a - wb : wa - b;
      if (gap >= 0 && gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    wide[best][0] = Math.min(wide[best][0], a);
    wide[best][1] = Math.max(wide[best][1], b);
  }
  return wide;
}

/**
 * Clears everything the outside of the crop can reach, and reports what it kept.
 *
 * Four-way flood fill from the border over near-background pixels. These are outlined
 * illustrations, so the fill stops at the outline and every enclosed pale area keeps
 * its pixels.
 */
function cutOut(rgb, w, h) {
  const outside = new Uint8Array(w * h);
  const near = (p) =>
    Math.max(
      Math.abs(rgb[p * 3] - BACKGROUND[0]),
      Math.abs(rgb[p * 3 + 1] - BACKGROUND[1]),
      Math.abs(rgb[p * 3 + 2] - BACKGROUND[2]),
    ) <= INK;

  const queue = [];
  for (let x = 0; x < w; x += 1) queue.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 1) queue.push(y * w, y * w + w - 1);
  while (queue.length) {
    const p = queue.pop();
    if (outside[p] || !near(p)) continue;
    outside[p] = 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) queue.push(p - 1);
    if (x < w - 1) queue.push(p + 1);
    if (y > 0) queue.push(p - w);
    if (y < h - 1) queue.push(p + w);
  }

  const rgba = Buffer.alloc(w * h * 4);
  let opaque = 0;
  for (let p = 0; p < w * h; p += 1) {
    rgba[p * 4] = rgb[p * 3];
    rgba[p * 4 + 1] = rgb[p * 3 + 1];
    rgba[p * 4 + 2] = rgb[p * 3 + 2];
    rgba[p * 4 + 3] = outside[p] ? 0 : 255;
    if (!outside[p]) opaque += 1;
  }
  return { rgba, opaque };
}

// ---------------------------------------------------------------------------
// Cut every tile out of the sheet.
// ---------------------------------------------------------------------------

const columnInk = new Array(W).fill(false);
for (let x = 0; x < W; x += 1) {
  for (let y = 0; y < H; y += 1) {
    if (isInk(x, y)) {
      columnInk[x] = true;
      break;
    }
  }
}
const columns = absorbFragments(runs(columnInk, 4), COLUMN_MIN_WIDTH);

/** `"3-7"` to the cut tile, as RGBA plus its dimensions. */
const tiles = new Map();

for (const [colIndex, [cx0, cx1]] of columns.entries()) {
  const rowInk = new Array(H).fill(false);
  for (let y = 0; y < H; y += 1) {
    for (let x = cx0; x <= cx1; x += 1) {
      if (isInk(x, y)) {
        rowInk[y] = true;
        break;
      }
    }
  }
  // Every band, captions included. The art bands are what gets cut; the caption
  // bands are what the padding is not allowed to reach into.
  const allBands = runs(rowInk, 4);
  const art = allBands.filter(([a, b]) => b - a + 1 >= ART_MIN_HEIGHT);

  for (const [rowIndex, [ry0, ry1]] of art.entries()) {
    const bandIndex = allBands.findIndex(([a]) => a === ry0);
    const above = allBands[bandIndex - 1];
    const below = allBands[bandIndex + 1];
    // Tighten to the art's own ink: several illustrations are narrower than the
    // caption underneath them, and the caption is what set the column's width.
    let x0 = cx1;
    let x1 = cx0;
    for (let y = ry0; y <= ry1; y += 1) {
      for (let x = cx0; x <= cx1; x += 1) {
        if (isInk(x, y)) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
    }
    x0 = Math.max(0, x0 - PAD);
    x1 = Math.min(W - 1, x1 + PAD);
    const y0 = Math.max(0, above ? Math.max(ry0 - PAD, above[1] + 1) : ry0 - PAD);
    const y1 = Math.min(H - 1, below ? Math.min(ry1 + PAD, below[0] - 1) : ry1 + PAD);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    const rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const s = ((y0 + y) * W + (x0 + x)) * C;
        const d = (y * w + x) * 3;
        rgb[d] = data[s];
        rgb[d + 1] = data[s + 1];
        rgb[d + 2] = data[s + 2];
      }
    }
    const { rgba, opaque } = cutOut(rgb, w, h);
    tiles.set(`${rowIndex + 1}-${colIndex + 1}`, { rgba, w, h, opaque, x: x0, y: y0 });
  }
}

// ---------------------------------------------------------------------------
// Write the badges the app names, checking each one before it is written.
// ---------------------------------------------------------------------------

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const problems = [];
const written = [];

for (const [name, cell] of Object.entries(TILES)) {
  const tile = tiles.get(cell);
  if (!tile) {
    problems.push(`${name}: no tile at ${cell}`);
    continue;
  }
  const { rgba, w, h, opaque, x, y } = tile;

  // A crop that ran into the edge of the sheet, or into the caption below it, shows up
  // as ink hard against a boundary. PAD is 6, so ink in the outer two pixels means the
  // tightening did not have the room it asked for and the art may be clipped.
  const EDGE = 2;
  let touches = false;
  for (let py = 0; py < h && !touches; py += 1) {
    for (let px = 0; px < w; px += 1) {
      if (rgba[(py * w + px) * 4 + 3] === 0) continue;
      if (px < EDGE || px >= w - EDGE || py < EDGE || py >= h - EDGE) {
        touches = true;
        break;
      }
    }
  }
  if (touches) problems.push(`${name} (${cell}): art touches the crop edge, may be clipped`);
  if (w > CANVAS || h > CANVAS) problems.push(`${name} (${cell}): ${w}x${h} exceeds the canvas`);
  // A tile that is almost all background is a caption band that slipped the filter.
  const filled = opaque / (w * h);
  if (filled < 0.1) problems.push(`${name} (${cell}): only ${Math.round(filled * 100)}% ink`);

  await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: rgba,
        raw: { width: w, height: h, channels: 4 },
        left: Math.round((CANVAS - w) / 2),
        top: Math.round((CANVAS - h) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toFile(`${OUT_DIR}/${name}.png`);

  written.push({ name, cell, source: `${x},${y} ${w}x${h}`, inkPercent: Math.round(filled * 100) });
}

if (process.argv.includes('--tiles')) {
  await mkdir(TILE_DIR, { recursive: true });
  for (const [cell, { rgba, w, h }] of tiles) {
    await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toFile(`${TILE_DIR}/tile-${cell}.png`);
  }
}

await writeFile(
  `${OUT_DIR}/BADGES.json`,
  `${JSON.stringify({ source: SOURCE, canvas: CANVAS, badges: written }, null, 2)}\n`,
);

const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.png'));
console.log(`${files.length} badges from ${tiles.size} tiles in ${columns.length} columns`);
if (problems.length) {
  console.error('\nPROBLEMS');
  for (const line of problems) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('no clipping, no oversize, no empty crops');
}
