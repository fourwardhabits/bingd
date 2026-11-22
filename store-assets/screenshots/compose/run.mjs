#!/usr/bin/env node
/**
 * Stage 2: raw captures into marketing frames, one master per frame and canvas.
 *
 *   node compose/run.mjs [--raw out/raw] [--out out/composed] [--frames a,b] [--canvases c,d]
 *
 * Reads no network and starts no server. `--status-bar <px>` sets how much of the top of a
 * raw image to remove when the folder has no capture.json, which is how native captures
 * come in: see NATIVE-CAPTURE.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import sharp from 'sharp';

import { csv, launchChrome, OUT, parseArgs } from '../lib/common.mjs';
import { copy as allCopy } from '../manifest/copy.mjs';
import { frames as allFrames } from '../manifest/frames.mjs';
import { canvases, targets } from '../manifest/targets.mjs';
import { loadFonts } from './fonts.mjs';
import { deviceMetrics, TEMPLATES } from './templates.mjs';

const args = parseArgs(process.argv.slice(2), {
  raw: 'value',
  out: 'value',
  fonts: 'value',
  frames: 'value',
  canvases: 'value',
  'status-bar': 'value',
});

const rawDir = resolve(args.raw ?? join(OUT, 'raw'));
const outDir = resolve(args.out ?? join(OUT, 'composed'));
const onlyFrames = csv(args.frames);
const onlyCanvases = csv(args.canvases);

/** How far into the safe area a frame keeps, so the app's header clears the rounded corner. */
const STATUS_BAR_KEEP = 10;

const recordFile = join(rawDir, 'capture.json');
const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : null;

function statusBarPixels() {
  if (args['status-bar']) return Number(args['status-bar']);
  if (!record) return 0;
  return (record.device.safeArea.top - STATUS_BAR_KEEP) * record.device.deviceScaleFactor;
}

/** Where a framed screen starts, in raw pixels: see `focus` in manifest/frames.mjs. */
function focusPixels(frame, rawHeight) {
  if (!frame.focus) return 0;
  const measured = record?.scenes?.[frame.scene]?.focusTop;
  if (measured !== undefined) {
    return Math.round((measured - frame.focus.margin) * record.device.deviceScaleFactor);
  }
  return Math.round(rawHeight * frame.focus.fallback);
}

/**
 * The app has no status bar in Chrome, and the live frames show none: the blank goes. A
 * frame's `focus` starts lower still, clamped so the image always fills what the device shows.
 */
async function screenImage(
  scene,
  screenWidth,
  cropTop,
  { frame = null, visibleHeight = 0, radius, roundBottom = false },
) {
  const file = join(rawDir, `${scene}.png`);
  if (!existsSync(file)) throw new Error(`No raw capture for scene "${scene}" in ${rawDir}`);
  const { width, height } = await sharp(file).metadata();
  const needed = Math.ceil((visibleHeight * width) / screenWidth);
  const wanted = frame ? focusPixels(frame, height) : 0;
  const top = Math.max(cropTop, Math.min(wanted, height - needed));
  if (height - top < needed) {
    throw new Error(`${scene} is too short to fill the device: ${height - top} < ${needed}`);
  }
  const resized = await sharp(file)
    .extract({ left: 0, top, width, height: height - top })
    .resize({ width: screenWidth, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  // The corners are baked in rather than clipped by the page: Chrome's anti-aliased clip
  // differed by a few hundred pixels from one run to the next, on no pattern, and no flag
  // settled it. Past the foot of the image a bleeding screen has no bottom corners to round.
  const maskHeight = roundBottom ? meta.height : meta.height + radius;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">` +
      `<rect width="${meta.width}" height="${maskHeight}" rx="${radius}" ry="${radius}"/></svg>`,
  );
  const buffer = await sharp(resized)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return {
    src: `data:image/png;base64,${buffer.toString('base64')}`,
    width: meta.width,
    height: meta.height,
  };
}

/** Fails a frame rather than exporting one where the copy ran off the field or into the phone. */
function layoutProblems({ width, height }) {
  const problems = [];
  const margin = Math.round(width * 0.04);
  const device = document.querySelector('[data-device]')?.getBoundingClientRect();
  const logo = document.querySelector('[data-logo]')?.getBoundingClientRect();
  for (const el of document.querySelectorAll('[data-text]')) {
    // The line boxes, not the block: a nowrap span can overrun a block that looks fine.
    const lines = [...el.querySelectorAll('span')].map((s) => s.getBoundingClientRect());
    const left = Math.min(el.getBoundingClientRect().left, ...lines.map((b) => b.left));
    const right = Math.max(el.getBoundingClientRect().right, ...lines.map((b) => b.right));
    const box = el.getBoundingClientRect();
    const name = el.className;
    if (left < margin || right > width - margin || box.top < margin || box.bottom > height - margin) {
      problems.push(`${name} is inside the ${margin}px margin`);
    }
    if (device && box.bottom > device.top && left < device.right && right > device.left) {
      problems.push(`${name} runs into the device`);
    }
    if (logo && left < logo.right && right > logo.left) {
      problems.push(`${name} runs into the logo`);
    }
  }
  return problems;
}

/** Each (frame, canvas) pair some export target asks for, minus the filters. */
function wantedRenders() {
  const seen = new Set();
  const renders = [];
  for (const target of targets) {
    if (!target.canvas) continue;
    for (const frame of target.frames) {
      const key = `${frame}|${target.canvas}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (onlyFrames && !onlyFrames.includes(frame)) continue;
      if (onlyCanvases && !onlyCanvases.includes(target.canvas)) continue;
      renders.push({ frameId: frame, canvasId: target.canvas });
    }
  }
  return renders;
}

async function main() {
  const faces = loadFonts(args.fonts);
  const renders = wantedRenders();
  if (renders.length === 0) throw new Error('Those filters match nothing in manifest/targets.mjs');

  mkdirSync(outDir, { recursive: true });
  const cropTop = statusBarPixels();

  const browser = await launchChrome();

  try {
    for (const { frameId, canvasId } of renders) {
      const frame = allFrames[frameId];
      const canvas = canvases[canvasId];
      const images = {};
      if (frame.scene) {
        const { bezel, screenRadius, screenWidth } = deviceMetrics(canvas.device.width);
        images.main = await screenImage(frame.scene, screenWidth, cropTop, {
          frame,
          visibleHeight: canvas.height - canvas.device.top - bezel,
          radius: screenRadius,
        });
        if (frame.inset && canvas.device.inset) {
          const inset = deviceMetrics(canvas.device.inset.width);
          images.inset = await screenImage(frame.inset, inset.screenWidth, cropTop, {
            radius: inset.screenRadius,
            roundBottom: true,
          });
        }
      }

      const html = TEMPLATES[canvas.template]({
        canvas,
        copy: allCopy[frame.copy],
        images,
        faces,
      });

      const page = await browser.newPage({
        viewport: { width: canvas.width, height: canvas.height },
        deviceScaleFactor: 1,
      });
      // Generous, like capture: a frame carries megabytes of inline image, and with GPU raster
      // off a 1320x2868 screenshot on a shared machine can take longer than the 30s default.
      page.setDefaultTimeout(180000);
      await page.setContent(html, { waitUntil: 'load' });

      // A failed face would be swapped silently by the browser. This is the stop for that.
      const fontState = await page.evaluate(async () => {
        await document.fonts.ready;
        const loads = [...document.fonts].map((f) =>
          f.load().then(
            () => null,
            () => `${f.family} ${f.weight}`,
          ),
        );
        return (await Promise.all(loads)).filter(Boolean);
      });
      if (fontState.length) throw new Error(`Font failed in Chrome: ${fontState.join(', ')}`);

      const problems = await page.evaluate(layoutProblems, {
        width: canvas.width,
        height: canvas.height,
      });
      if (problems.length) throw new Error(`${frameId} on ${canvasId}: ${problems.join('; ')}`);

      // `load` means fetched, not decoded. A frame shot before decode rasters its corners twice.
      await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
      const buffer = await page.screenshot({ type: 'png', fullPage: false });
      await page.close();

      const name = `${frameId}--${canvasId}.png`;
      writeFileSync(join(outDir, name), buffer);
      console.log(`${name}  ${canvas.width}x${canvas.height}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\ncompose failed: ${error.message}`);
  process.exitCode = 1;
});
