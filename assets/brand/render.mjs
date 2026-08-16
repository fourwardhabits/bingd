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
  await writeFile(join(here, file), out);
  return { file, bytes: out.length };
}

for (const target of targets) {
  const { file, bytes } = await render(target);
  console.log(`${file}  ${(bytes / 1024).toFixed(1)} KB`);
}
