import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

/**
 * Renders the app's raster brand assets from `bingd-icon.svg`.
 *
 * Run with `npm run brand:render`, and only when the mark changes. The outputs
 * are committed, because a build that has to rasterise an SVG is a build that
 * can fail at rasterising an SVG, and EAS would be the place it happened.
 *
 * The SVG is the source of truth and the only place the mark is drawn. Anything
 * here that looks like design — the padding, the two canvas sizes — exists
 * because a store icon and a splash have hard platform requirements that a
 * 200x120 artboard does not satisfy.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'bingd-icon.svg');

/** Paper. Mirrors surface.base in src/ui/tokens/color.ts. */
const PAPER = '#FBF8F4';

const targets = [
  {
    file: 'icon.png',
    // 1024 square is what both stores want, and what Expo downsamples every
    // other size from.
    canvas: 1024,
    // The mark is 5:3, so width is the binding constraint and the icon will
    // always carry more padding above and below than at the sides. iOS masks a
    // superellipse out of this, which is why it stops short of the edge.
    inset: 0.78,
    background: PAPER,
  },
  {
    // Android adaptive icons are masked to whatever shape the launcher likes —
    // circle, squircle, teardrop — and only the centre 66% of the canvas is
    // guaranteed to survive. A 5:3 mark inscribed in a circle of that diameter
    // can be 0.56 of the canvas wide; this stays under it.
    file: 'icon-adaptive.png',
    canvas: 1024,
    inset: 0.52,
    background: PAPER,
  },
  {
    // The splash image, not the splash screen. Expo centres this on the
    // background colour, so the file is just the mark with room around it.
    file: 'splash.png',
    canvas: 1024,
    inset: 0.55,
    background: null,
  },
];

/**
 * The preview lane gets its own icon, and the reason is a failure rather than polish.
 *
 * A staging build exists to be installed **beside** the production app on one phone, and
 * until now the two were the same picture. A founder holding a device cannot report "the
 * app is broken" usefully if they cannot tell which app they opened, and an hour spent
 * testing the wrong one is the cheapest version of that going wrong.
 *
 * Same mark, on the brand plum, with a Paper band across the foot. **No text**: sharp
 * rasterises SVG through whatever font stack the machine happens to have, and an icon
 * that renders a missing glyph somewhere else is worse than one carrying no word at all.
 * The name under the icon already reads "bingd preview".
 *
 * These files are referenced only by the non-production variants, so they are never
 * `expoConfigExternalFile` sources for production or beta and cannot move either
 * fingerprint. Proven by recomputing both afterwards, not assumed.
 */
const PLUM = '#773744';

const previewTargets = [
  { file: 'icon-preview.png', canvas: 1024, inset: 0.78 },
  { file: 'icon-adaptive-preview.png', canvas: 1024, inset: 0.52 },
];

const svg = await readFile(source);

/**
 * Rendered at the target width rather than scaled up from the artboard: sharp
 * rasterises the SVG at whatever density it is asked for, so the strokes stay
 * crisp instead of being resampled from a 200pt bitmap.
 */
async function render({ file, canvas, inset, background }) {
  const markWidth = Math.round(canvas * inset);

  const mark = await sharp(svg, { density: 384 })
    .resize({ width: markWidth, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const out = await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();

  await mkdir(here, { recursive: true });
  // Returned rather than written: whether these bytes may replace what is committed is a
  // release question, decided at the bottom of this file.
  return { file, out };
}

/**
 * The preview mark: plum field, Paper mark, Paper band at the foot.
 *
 * The mark is tinted rather than redrawn. sharp cannot recolour an arbitrary SVG, so it
 * is rasterised, its alpha kept, and Paper poured through it — which leaves
 * `bingd-icon.svg` the only place the shape is defined, the rule this file exists to hold.
 */
async function renderPreview({ file, canvas, inset }) {
  const markWidth = Math.round(canvas * inset);

  const shape = await sharp(svg, { density: 384 })
    .resize({ width: markWidth, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const { width, height } = await sharp(shape).metadata();
  const mark = await sharp({ create: { width, height, channels: 4, background: PAPER } })
    .composite([{ input: shape, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Clear of the centre 66% an Android launcher is guaranteed to keep.
  const band = await sharp({
    create: { width: canvas, height: Math.round(canvas * 0.085), channels: 4, background: PAPER },
  })
    .png()
    .toBuffer();

  const out = await sharp({
    create: { width: canvas, height: canvas, channels: 4, background: PLUM },
  })
    .composite([
      { input: mark, gravity: 'centre' },
      { input: band, top: canvas - Math.round(canvas * 0.16), left: 0 },
    ])
    .png()
    .toBuffer();

  await writeFile(join(here, file), out);
  return { file, bytes: out.length };
}

/**
 * **The committed production assets are not overwritten by accident.**
 *
 * `icon.png`, `icon-adaptive.png` and `splash.png` are `expoConfigExternalFile` fingerprint
 * sources: their *contents* are hashed into every lane's runtime version. A different
 * `sharp` or `libvips` build rasterises the same SVG to different bytes, so running this
 * script on another machine — to add a preview icon, say — could move the runtime version
 * of a binary that is already in App Review, and the diff would look like three pictures
 * nobody changed.
 *
 * So the rule is: identical bytes are a silent no-op, and **differing bytes stop the
 * script** unless `--force` says the mark genuinely changed. `npm run brand:render` passes
 * no arguments and cannot be made to pass one — `package.json`'s `scripts` block is itself
 * a fingerprint source (`config/push.cjs`), so editing that line has the same cost as the
 * accident it would be preventing.
 *
 * `--preview-only` skips them entirely, which is what the staging separation used.
 */
const previewOnly = process.argv.includes('--preview-only');
const force = process.argv.includes('--force');

if (!previewOnly) {
  const moved = [];

  for (const target of targets) {
    const { file, out } = await render(target);
    const path = join(here, file);
    const existing = await readFile(path).catch(() => null);

    if (existing && existing.equals(out)) {
      console.log(`${file}  unchanged`);
      continue;
    }
    if (existing && !force) {
      moved.push(file);
      continue;
    }

    await writeFile(path, out);
    console.log(`${file}  ${(out.length / 1024).toFixed(1)} KB${existing ? '  REWRITTEN' : ''}`);
  }

  if (moved.length > 0) {
    console.error(
      `\nRefusing to rewrite ${moved.join(', ')}.\n\n` +
        'These bytes are hashed into every lane\'s runtime version, and they differ from\n' +
        'what is committed. If the mark really changed, re-run with --force and expect every\n' +
        'published binary to stop receiving over-the-air updates until it is rebuilt. If you\n' +
        'only wanted the preview icons, use --preview-only.\n',
    );
    process.exitCode = 1;
  }
}

for (const target of previewTargets) {
  const { file, bytes } = await renderPreview(target);
  console.log(`${file}  ${(bytes / 1024).toFixed(1)} KB`);
}
