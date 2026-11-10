#!/usr/bin/env node
/**
 * Renders `web/src/social-card.png`, the image every shared bingd link unfurls to.
 *
 * **Run by hand, not by the site build**, for the reason `shots.mjs` is: the site must build
 * from `web/` alone, with nothing to install, and `sharp` is an authoring-time dependency.
 * The output is committed.
 *
 *     node web/social-card.mjs
 *
 * Sources of truth, the same ones `store-assets/social/render.mjs` uses and no others:
 *   mark   assets/brand/bingd-icon.svg
 *   colour src/ui/tokens/color.ts
 *   type   the font files the app ships, drawn by Pango, so this cannot fall back to
 *          whatever serif the machine has. The card this replaced did exactly that, on an
 *          older mark with perforations on one frame only.
 *
 * It is the first bingd an invited friend sees, so it shows what happens in the product
 * rather than only the name: the reveal, in its own colours, and the sentence the reveal
 * says out loud. Text only. No poster artwork leaves an app screenshot.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const WIDTH = 1200;
const HEIGHT = 630;
const LEFT = 84;

const PARCHMENT = '#F5EBDD';
const MAROON = '#773744';
const INK = '#242326';
const SECONDARY = '#5F5A56';

const FONTS = {
  serif: join(repo, 'node_modules/@expo-google-fonts/dm-serif-display/400Regular/DMSerifDisplay_400Regular.ttf'),
  sans: join(repo, 'node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  sansMedium: join(repo, 'node_modules/@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
};
const FAMILY = { serif: 'DM Serif Display', sans: 'Inter', sansMedium: 'Inter Medium' };

/**
 * `sharp` does not reject a missing font file. It draws in a fallback and reports success,
 * which is how the card this replaced came to be set in the wrong type. So a missing font
 * stops the run before anything is written.
 */
for (const file of Object.values(FONTS)) {
  await access(file).catch(() => {
    throw new Error(`Missing font ${file}. Run npm ci, then render again.`);
  });
}

/** A line of type at an exact pixel size, trimmed to its own ink. */
async function line({ text, face, px, color }) {
  const dpi = Math.round((72 * px) / 10);
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}">${text.replace(/&/g, '&amp;')}</span>`,
      font: `${FAMILY[face]} 10`,
      fontfile: FONTS[face],
      dpi,
      rgba: true,
    },
  })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

const atLeft = (layer, left, centreY) => ({
  input: layer.input,
  left: Math.round(left),
  top: Math.round(centreY - layer.height / 2),
});
const atCentre = (layer, centreX, centreY) => atLeft(layer, centreX - layer.width / 2, centreY);

async function mark(width) {
  const svg = await readFile(join(repo, 'assets', 'brand', 'bingd-icon.svg'));
  const input = await sharp(svg, { density: Math.ceil((72 * width * 2) / 200) })
    .resize({ width, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer();
  const { width: w, height } = await sharp(input).metadata();
  return { input, width: w, height };
}

const PANEL = { left: 868, top: 136, size: 248 };

const panel = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL.size}" height="${PANEL.size}">
    <rect width="${PANEL.size}" height="${PANEL.size}" rx="24" fill="${MAROON}"/>
  </svg>`,
);

const brandMark = await mark(92);
const wordmark = await line({ text: 'bingd.', face: 'serif', px: 58, color: MAROON });
const brandY = 112;

const layers = [
  atLeft(brandMark, LEFT, brandY),
  atLeft(wordmark, LEFT + brandMark.width + 18, brandY + 2),
  atLeft(await line({ text: 'Rank what you watch.', face: 'serif', px: 62, color: INK }), LEFT, 256),
  atLeft(await line({ text: 'See where it really lands.', face: 'serif', px: 62, color: INK }), LEFT, 334),
  atLeft(await line({ text: 'Stop guessing between 3.5 and 4 stars.', face: 'sans', px: 31, color: SECONDARY }), LEFT, 424),
  atLeft(await line({ text: 'Free on iPhone and Android', face: 'sansMedium', px: 26, color: MAROON }), LEFT, 504),
  { input: panel, left: PANEL.left, top: PANEL.top },
];

const centreX = PANEL.left + PANEL.size / 2;
layers.push(
  atCentre(await line({ text: '8.9', face: 'serif', px: 118, color: PARCHMENT }), centreX, PANEL.top + PANEL.size / 2),
  atCentre(await line({ text: 'Below Parasite', face: 'sans', px: 26, color: SECONDARY }), centreX, 436),
  atCentre(await line({ text: 'Above Inception', face: 'sans', px: 26, color: SECONDARY }), centreX, 476),
);

const png = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: PARCHMENT } })
  .composite(layers)
  .png({ compressionLevel: 9 })
  .toBuffer();

await writeFile(join(here, 'src', 'social-card.png'), png);
console.log(`social-card.png ${WIDTH}x${HEIGHT} ${(png.length / 1024).toFixed(1)} KB`);
