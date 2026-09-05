import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

/**
 * Renders the social profile/post/story/banner kit from the canonical brand
 * sources. Run with `node store-assets/social/render.mjs`; the outputs are
 * committed so nobody has to reproduce a design decision from a PNG.
 *
 * Sources of truth, and nothing else is one:
 *   mark   assets/brand/bingd-icon.svg
 *   colour src/ui/tokens/color.ts  (docs/design/design-system.md §2)
 *   type   docs/design/design-system.md §4 — DM Serif Display, Inter
 *
 * The mark is rasterised from the SVG at the size it is used, never scaled up
 * from a smaller bitmap. Text is drawn by Pango against the font files that
 * ship in the app, so these files are set in the same faces the product is,
 * not in whatever serif the host machine happens to have installed.
 *
 * No third-party artwork appears here by design — every graphic in this kit is
 * brand-owned.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const MARK = join(repo, 'assets', 'brand', 'bingd-icon.svg');

/** docs/design/design-system.md §2. */
const PAPER = '#FBF8F4';
const PARCHMENT = '#F5EBDD';
const MAROON = '#773744';
const INK = '#242326';
const AMBER = '#D4A64C';
/** border.hairline — Ink at 12%. */
const HAIRLINE = 'rgba(36,35,38,0.12)';

const FONTS = {
  serif: join(repo, 'node_modules/@expo-google-fonts/dm-serif-display/400Regular/DMSerifDisplay_400Regular.ttf'),
  sans: join(repo, 'node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  sansMedium: join(repo, 'node_modules/@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
};
const FAMILY = { serif: 'DM Serif Display', sans: 'Inter', sansMedium: 'Inter Medium' };

/** The mark's artboard, from the SVG's viewBox. */
const MARK_RATIO = 120 / 200;

const svgSource = await readFile(MARK);

/**
 * The mark at an exact pixel width. Rasterised at 2x and resampled down: the
 * strokes are 8 units on a 200-unit artboard and alias badly if drawn once at
 * final size.
 */
async function mark(width) {
  const density = Math.ceil((72 * width * 2) / 200);
  return sharp(svgSource, { density })
    .resize({ width: Math.round(width), fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function escapeMarkup(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A line (or block, honouring `\n`) of type at an exact pixel size, trimmed to
 * its own ink. Pango sizes in points, so the point size is pinned at 10 and the
 * DPI carries the scale — that keeps hinting consistent across sizes.
 */
async function type({ text, face, px, color, tracking = 0, leading }) {
  const dpi = Math.round((72 * px) / 10);
  const attributes = [`foreground="${color}"`];
  if (tracking) {
    // Pango letter_spacing is in 1024ths of a point at the described size.
    attributes.push(`letter_spacing="${Math.round(((tracking * 72) / dpi) * 1024)}"`);
  }
  const markup = `<span ${attributes.join(' ')}>${escapeMarkup(text)}</span>`;
  const image = sharp({
    text: {
      text: markup,
      font: `${FAMILY[face]} 10`,
      fontfile: FONTS[face],
      dpi,
      rgba: true,
      align: 'centre',
      ...(leading === undefined ? {} : { spacing: Math.round((leading * 72) / dpi) }),
    },
  });
  const { data, info } = await image
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

/** Places a layer by its own centre, which is what every layout below thinks in. */
function at(layer, cx, cy) {
  return {
    input: layer.input,
    left: Math.round(cx - layer.width / 2),
    top: Math.round(cy - layer.height / 2),
  };
}

async function compose({ width, height, background, layers }) {
  return sharp({ create: { width, height, channels: 4, background } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const out = async (file, buffer) => {
  await writeFile(join(here, file), buffer);
  const { width, height } = await sharp(buffer).metadata();
  console.log(`${file.padEnd(30)} ${width}x${height}  ${(buffer.length / 1024).toFixed(1)} KB`);
  return { file, width, height };
};

// ---------------------------------------------------------------------------
// Copy — approved 2026-09-04
// ---------------------------------------------------------------------------

const COPY = {
  wordmark: 'bingd.',
  line: 'Rank what you watch, find your next binge.',
  chip: 'Movies + TV',
  bio: 'Rank what you watch, find your next binge. Movies + TV.',
  description: 'Build your ranked list, compare taste with friends, find your next binge together.',
};

// ---------------------------------------------------------------------------
// The mark, as vector, at any size
// ---------------------------------------------------------------------------

/** The canonical mark's geometry, verbatim from assets/brand/bingd-icon.svg. */
const MARK_PATHS = `<g stroke="${MAROON}" stroke-width="8" stroke-linecap="butt" stroke-linejoin="round" fill="none">
      <rect x="80" y="40" width="40" height="40" fill="${AMBER}" stroke="none" />
      <rect x="20" y="10" width="100" height="70" rx="8" />
      <line x1="45" y1="10" x2="45" y2="80" />
      <line x1="20" y1="27" x2="45" y2="27" />
      <line x1="20" y1="45" x2="45" y2="45" />
      <line x1="20" y1="63" x2="45" y2="63" />
      <rect x="80" y="40" width="100" height="70" rx="8" />
      <line x1="155" y1="40" x2="155" y2="110" />
      <line x1="155" y1="57" x2="180" y2="57" />
      <line x1="155" y1="75" x2="180" y2="75" />
      <line x1="155" y1="93" x2="180" y2="93" />
    </g>`;

/** The mark at a given width, centred on (cx, cy), in SVG user units. */
function markGroup(width, cx, cy) {
  const height = width * MARK_RATIO;
  return `<g transform="translate(${cx - width / 2} ${cy - height / 2}) scale(${width / 200})">${MARK_PATHS}</g>`;
}

// ---------------------------------------------------------------------------
// Profile — mark only. The recommended avatar.
// ---------------------------------------------------------------------------

/**
 * The app icon is this drawing at inset 0.78, which suits the superellipse iOS
 * masks and not the circle every social platform crops to: at that width the
 * corners of a 5:3 mark fall outside the inscribed disc. 0.58 clears it by a
 * wide margin (half-diagonal 346 against a 512 radius) and still fills the
 * square enough to look composed where a platform shows the source uncropped.
 *
 * No ring, no outline, no handle. Paper runs to all four edges.
 */
const AVATAR_INSET = 0.58;

function profileMarkSvg(size, markWidth = size * AVATAR_INSET, cy = size / 2) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPER}"/>
  ${markGroup(markWidth, size / 2, cy)}
</svg>`;
}

async function profileMark() {
  const size = 1024;
  const svg = profileMarkSvg(size);
  await writeFile(join(here, 'profile-mark.svg'), svg, 'utf8');
  const png = await sharp(Buffer.from(svg), { density: 288 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  return out('profile-mark-1024.png', png);
}

// ---------------------------------------------------------------------------
// Profile — mark over wordmark. The alternate.
// ---------------------------------------------------------------------------

/**
 * The block is 440 wide and about 420 tall, a half-diagonal near 300 against a
 * 512 radius, so it survives a circular crop. It is the alternate rather than
 * the recommended avatar because `bingd.` set to fit a 32pt avatar is not
 * legible, and the mark on its own already is.
 */
async function profileLockup() {
  const size = 1024;
  const markWidth = 440;
  const markHeight = markWidth * MARK_RATIO;
  const gap = 52;

  const wordmark = await type({ text: COPY.wordmark, face: 'serif', px: 132, color: MAROON });
  const blockHeight = markHeight + gap + wordmark.height;
  // Nudged up: the wordmark's descender makes the block bottom-heavy, so
  // geometric centring reads as sitting low.
  const top = (size - blockHeight) / 2 - 12;

  const wordmarkCentre = top + markHeight + gap + wordmark.height / 2;
  const markCentre = top + markHeight / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPER}"/>
  ${markGroup(markWidth, size / 2, markCentre)}
  <!-- Live type: this file renders correctly only where DM Serif Display is
       installed. profile-lockup-1024.png is the master. -->
  <text x="${size / 2}" y="${top + markHeight + gap + wordmark.height}" fill="${MAROON}"
        font-family="DM Serif Display" font-size="132" text-anchor="middle">bingd.</text>
</svg>`;
  await writeFile(join(here, 'profile-lockup.svg'), svg, 'utf8');

  const base = await sharp(Buffer.from(profileMarkSvg(size, markWidth, markCentre)), { density: 288 })
    .resize(size, size)
    .png()
    .toBuffer();

  const png = await sharp(base)
    .composite([at(wordmark, size / 2, wordmarkCentre)])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return out('profile-lockup-1024.png', png);
}

// ---------------------------------------------------------------------------
// Archive — the earlier ringed avatar, kept for reference and not recommended
// ---------------------------------------------------------------------------

async function archivedRing() {
  const size = 1024;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${PAPER}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - size * 0.004}" fill="none" stroke="${HAIRLINE}" stroke-width="${size * 0.008}"/>
  ${markGroup(size * AVATAR_INSET, size / 2, size / 2)}
</svg>`;
  await mkdir(join(here, 'archive'), { recursive: true });
  const png = await sharp(Buffer.from(svg), { density: 288 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(here, 'archive', 'profile-ring-1024.png'), png);
  console.log(`${'archive/profile-ring-1024.png'.padEnd(30)} ${size}x${size}  (superseded)`);
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The positioning line at the largest size that still sets on ONE line inside
 * `maxWidth`, or `null` if that would mean dropping below `floor`. A line that
 * has to break to fit is a line this kit leaves out.
 */
async function oneLine({ maxWidth, sizes, floor = 30 }) {
  for (const px of sizes) {
    if (px < floor) break;
    const layer = await type({ text: COPY.line, face: 'sans', px, color: INK });
    if (layer.width <= maxWidth) return layer;
  }
  return null;
}

/** The Parchment chip, with the Ink hairline §1 asks any fill to carry. */
function chipSvg(w, h, r) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r}" fill="${PARCHMENT}" stroke="${HAIRLINE}" stroke-width="2"/></svg>`,
  );
}

async function chip({ px, padX, padY }) {
  const label = await type({ text: COPY.chip, face: 'sansMedium', px, color: INK, tracking: px * 0.017 });
  const w = label.width + padX * 2;
  const h = label.height + padY * 2;
  const plate = await sharp(chipSvg(w, h, h / 2)).png().toBuffer();
  const merged = await sharp(plate)
    .composite([{ input: label.input, left: Math.round((w - label.width) / 2), top: Math.round((h - label.height) / 2) }])
    .png()
    .toBuffer();
  return { input: merged, width: w, height: h };
}

// ---------------------------------------------------------------------------
// Launch post — 4:5
// ---------------------------------------------------------------------------

async function launchPost() {
  const W = 1080;
  const H = 1350;
  const markWidth = 300;
  const markLayer = { input: await mark(markWidth), width: markWidth, height: markWidth * MARK_RATIO };
  const wordmark = await type({ text: COPY.wordmark, face: 'serif', px: 168, color: MAROON });
  const line = await oneLine({ maxWidth: W - 150, sizes: [46, 44, 42, 40, 38, 36, 34, 32, 30] });
  const badge = await chip({ px: 30, padX: 40, padY: 24 });

  const layers = [at(markLayer, W / 2, 400), at(wordmark, W / 2, 665)];
  if (line) layers.push(at(line, W / 2, 855));
  layers.push(at(badge, W / 2, 1050));

  return out('launch-post-1080x1350.png', await compose({ width: W, height: H, background: PAPER, layers }));
}

// ---------------------------------------------------------------------------
// Story — 9:16, content inside the middle 80% (docs/design/screens.md)
// ---------------------------------------------------------------------------

async function story() {
  const W = 1080;
  const H = 1920;
  const markWidth = 320;
  const markLayer = { input: await mark(markWidth), width: markWidth, height: markWidth * MARK_RATIO };
  const wordmark = await type({ text: COPY.wordmark, face: 'serif', px: 176, color: MAROON });
  const line = await oneLine({ maxWidth: W - 150, sizes: [46, 44, 42, 40, 38, 36, 34, 32, 30] });
  const badge = await chip({ px: 30, padX: 40, padY: 24 });

  const layers = [at(markLayer, W / 2, 700), at(wordmark, W / 2, 980)];
  if (line) layers.push(at(line, W / 2, 1175));
  layers.push(at(badge, W / 2, 1380));

  return out('story-master-1080x1920.png', await compose({ width: W, height: H, background: PAPER, layers }));
}

// ---------------------------------------------------------------------------
// Banner — 1500x500, the X/Twitter header size, croppable to the narrower ones
// ---------------------------------------------------------------------------

/**
 * Everything sits in the middle third horizontally and above the lower quarter,
 * because a header is cropped differently on every platform and overlapped by
 * the avatar on one of them.
 */
async function banner() {
  const W = 1500;
  const H = 500;
  const markWidth = 132;
  const markLayer = { input: await mark(markWidth), width: markWidth, height: markWidth * MARK_RATIO };
  const wordmark = await type({ text: COPY.wordmark, face: 'serif', px: 92, color: MAROON });
  const line = await oneLine({ maxWidth: 780, sizes: [32, 30] });

  const gap = 34;
  const lockupWidth = markLayer.width + gap + wordmark.width;
  const lockupLeft = (W - lockupWidth) / 2;
  const baseline = 208;

  const layers = [
    at(markLayer, lockupLeft + markLayer.width / 2, baseline),
    at(wordmark, lockupLeft + markLayer.width + gap + wordmark.width / 2, baseline + 4),
  ];
  if (line) layers.push(at(line, W / 2, 316));

  return out('social-banner-master.png', await compose({ width: W, height: H, background: PAPER, layers }));
}

// ---------------------------------------------------------------------------
// Contact sheet
// ---------------------------------------------------------------------------

/** A circular crop, which is the only way to check an avatar. */
async function circleCrop(file, size) {
  const source = await sharp(join(here, file)).resize(size, size).png().toBuffer();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(source).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function contactSheet(rendered) {
  const W = 2000;
  const H = 1460;
  const layers = [];

  const caption = async (text, cx, cy, color = INK) =>
    at(await type({ text, face: 'sansMedium', px: 22, color, tracking: 0.4 }), cx, cy);

  layers.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <rect width="${W}" height="${H}" fill="#FFFFFF"/>
        <rect x="0" y="0" width="${W}" height="120" fill="${PARCHMENT}"/>
        <rect x="550" y="170" width="400" height="360" rx="16" fill="${INK}"/>
        <rect x="1410" y="170" width="400" height="360" rx="16" fill="${INK}"/>
      </svg>`,
    ),
    left: 0,
    top: 0,
  });

  const sheetTitle = await type({ text: 'bingd. social kit', face: 'serif', px: 46, color: MAROON });
  const sheetNote = await type({
    text: 'generated by store-assets/social/render.mjs',
    face: 'sans',
    px: 22,
    color: INK,
  });
  layers.push(at(sheetTitle, 60 + sheetTitle.width / 2, 58));
  layers.push(at(sheetNote, 60 + sheetTitle.width + 32 + sheetNote.width / 2, 64));

  // Row 1 — both profile masters, square and circle-cropped on dark.
  layers.push({ input: await sharp(join(here, 'profile-mark-1024.png')).resize(300, 300).toBuffer(), left: 180, top: 200 });
  layers.push(await caption('profile-mark, square', 330, 550));
  layers.push(await caption('RECOMMENDED AVATAR', 330, 586, MAROON));

  layers.push({ input: await circleCrop('profile-mark-1024.png', 300), left: 600, top: 200 });
  layers.push(await caption('profile-mark, cropped', 750, 550));

  layers.push({ input: await sharp(join(here, 'profile-lockup-1024.png')).resize(300, 300).toBuffer(), left: 1040, top: 200 });
  layers.push(await caption('profile-lockup, square', 1190, 550));

  layers.push({ input: await circleCrop('profile-lockup-1024.png', 300), left: 1460, top: 200 });
  layers.push(await caption('profile-lockup, cropped', 1610, 550));

  // Row 2 — the three graphics.
  layers.push({ input: await sharp(join(here, 'launch-post-1080x1350.png')).resize({ height: 430 }).toBuffer(), left: 180, top: 690 });
  layers.push(await caption('launch-post 1080x1350', 180 + 172, 1160));

  layers.push({ input: await sharp(join(here, 'story-master-1080x1920.png')).resize({ height: 430 }).toBuffer(), left: 580, top: 690 });
  layers.push(await caption('story 1080x1920', 580 + 121, 1160));

  layers.push({ input: await sharp(join(here, 'social-banner-master.png')).resize({ width: 900 }).toBuffer(), left: 900, top: 690 });
  layers.push(await caption('social-banner 1500x500', 900 + 450, 1040));

  const inventory = rendered.map((r) => `${r.file}  ${r.width}x${r.height}`).join('\n');
  layers.push(at(await type({ text: inventory, face: 'sans', px: 20, color: INK, leading: 12 }), 1350, 1170));

  const identity = await type({
    text: `bingd.    @bingdwatch\n${COPY.bio}`,
    face: 'sans',
    px: 26,
    color: INK,
    leading: 18,
  });
  layers.push(at(identity, W / 2, 1350));

  return out('contact-sheet.png', await compose({ width: W, height: H, background: '#FFFFFF', layers }));
}

const rendered = [];
rendered.push(await profileMark());
rendered.push(await profileLockup());
rendered.push(await launchPost());
rendered.push(await story());
rendered.push(await banner());
await archivedRing();
await contactSheet(rendered);
