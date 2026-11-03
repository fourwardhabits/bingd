#!/usr/bin/env node
/**
 * Stage 3: every target size from manifest/targets.mjs, into a gitignored folder.
 *
 *   node export/run.mjs [--composed out/composed] [--raw out/raw] [--out out/export]
 *                       [--targets a,b] [--frames c,d] [--partial]
 *
 * Reads each file back and refuses anything with the wrong size, format or an alpha channel,
 * because the stores reject those only after an upload. There is deliberately no stage after
 * this one: nothing in this package can reach a store, a host or an account.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import sharp from 'sharp';

import { csv, OUT, parseArgs } from '../lib/common.mjs';
import { COLOR } from '../compose/templates.mjs';
import { SURFACE_RULES, targets } from '../manifest/targets.mjs';

const args = parseArgs(process.argv.slice(2), {
  composed: 'value',
  raw: 'value',
  out: 'value',
  targets: 'value',
  frames: 'value',
  partial: 'flag',
});

const composedDir = resolve(args.composed ?? join(OUT, 'composed'));
const rawDir = resolve(args.raw ?? join(OUT, 'raw'));
const outDir = resolve(args.out ?? join(OUT, 'export'));
const onlyTargets = csv(args.targets);
const onlyFrames = csv(args.frames);

const EXTENSIONS = { png: 'png', jpeg: 'jpg', webp: 'webp' };

function encode(image, target) {
  if (target.format === 'webp') {
    return image.webp({ quality: target.quality, effort: target.effort });
  }
  if (target.format === 'jpeg') return image.jpeg({ quality: target.quality ?? 92, mozjpeg: true });
  return image.png({ compressionLevel: 9 });
}

/**
 * The site shows the bare screen with no status bar, like the shots web/shots.mjs writes.
 * The blank safe area goes from the top, and the rest of the height from below the tab bar.
 */
function websiteCrop(metadata, target, record) {
  const scale = metadata.width / target.width;
  const height = Math.round(target.height * scale);
  const top = record ? record.device.safeArea.top * record.device.deviceScaleFactor : 0;
  if (top + height > metadata.height) {
    throw new Error(`Raw image too short for ${target.id}: ${metadata.height} < ${top + height}`);
  }
  return { left: 0, top, width: metadata.width, height };
}

async function render(input, target, record) {
  let image = sharp(input);
  if (target.surface === 'website') {
    const metadata = await image.metadata();
    image = image.extract(websiteCrop(metadata, target, record));
  }
  // `top` keeps the headline: anything lost to rounding comes off the phone's cropped foot.
  image = image
    .resize(target.width, target.height, { fit: 'cover', position: 'top', kernel: 'lanczos3' })
    .flatten({ background: COLOR.maroon })
    .removeAlpha()
    .toColourspace('srgb');
  return encode(image, target).toBuffer();
}

async function verify(buffer, target, name) {
  const meta = await sharp(buffer).metadata();
  const rules = SURFACE_RULES[target.surface];
  const problems = [];
  if (meta.width !== target.width || meta.height !== target.height) {
    problems.push(`is ${meta.width}x${meta.height}, wanted ${target.width}x${target.height}`);
  }
  if (meta.format !== target.format) problems.push(`is ${meta.format}, wanted ${target.format}`);
  if (rules.noAlpha && meta.hasAlpha) problems.push('has an alpha channel');
  if (meta.space !== 'srgb') problems.push(`is in ${meta.space}, wanted srgb`);
  if (problems.length) throw new Error(`${name} ${problems.join(', ')}`);
}

function jobsFor(target) {
  if (target.shots) {
    return Object.entries(target.shots).map(([name, scene]) => ({
      name,
      key: scene,
      input: join(rawDir, `${scene}.png`),
    }));
  }
  return target.frames.map((frame) => ({
    name: frame,
    key: frame,
    input: join(composedDir, `${frame}--${target.canvas}.png`),
  }));
}

async function main() {
  const recordFile = join(rawDir, 'capture.json');
  const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) : null;
  const selected = targets.filter((t) => !onlyTargets || onlyTargets.includes(t.id));
  if (selected.length === 0) throw new Error('--targets matches nothing in manifest/targets.mjs');

  const index = { source: record?.source ?? null, files: [] };
  let skipped = 0;

  for (const target of selected) {
    const dir = join(outDir, target.id);
    mkdirSync(dir, { recursive: true });
    for (const job of jobsFor(target)) {
      if (onlyFrames && !onlyFrames.includes(job.key) && !onlyFrames.includes(job.name)) continue;
      if (!existsSync(job.input)) {
        if (args.partial) {
          skipped += 1;
          continue;
        }
        throw new Error(`Missing input for ${target.id}/${job.name}: ${job.input}`);
      }
      const buffer = await render(job.input, target, record);
      const file = `${job.name}.${EXTENSIONS[target.format]}`;
      await verify(buffer, target, `${target.id}/${file}`);
      writeFileSync(join(dir, file), buffer);
      index.files.push({
        target: target.id,
        surface: target.surface,
        file: `${target.id}/${file}`,
        width: target.width,
        height: target.height,
        format: target.format,
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      });
      console.log(
        `${`${target.id}/${file}`.padEnd(64)} ${target.width}x${target.height}  ${(buffer.length / 1024).toFixed(0)}KB`,
      );
    }
  }

  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\n${index.files.length} file(s) in ${outDir}${skipped ? `, ${skipped} skipped` : ''}`);
}

main().catch((error) => {
  console.error(`\nexport failed: ${error.message}`);
  process.exitCode = 1;
});
