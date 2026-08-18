/**
 * Lays the extracted tiles back out in a labelled grid, so a crop that clipped an ear
 * or kept a caption is visible at a glance rather than only on a device.
 *
 *     node scripts/awards/contact-sheet.mjs [inputDir] [outFile]
 */
import { readdir } from 'node:fs/promises';

import sharp from 'sharp';

const dir = process.argv[2] ?? 'assets/awards/raw';
const out = process.argv[3] ?? 'assets/awards/raw/contact-sheet.png';

const CELL = 132;
const COLS = 9;
const files = (await readdir(dir)).filter((f) => f.endsWith('.png') && !f.includes('contact'));
files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

const rows = Math.ceil(files.length / COLS);
const composites = [];
for (const [i, file] of files.entries()) {
  const buf = await sharp(`${dir}/${file}`)
    .resize(CELL - 16, CELL - 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  composites.push({
    input: buf,
    left: (i % COLS) * CELL + 8,
    top: Math.floor(i / COLS) * CELL + 8,
  });
}

await sharp({
  create: {
    width: COLS * CELL,
    height: rows * CELL,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite(composites)
  .png()
  .toFile(out);

console.log(`${files.length} tiles -> ${out}`);
console.log(files.join(' '));
