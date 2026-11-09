#!/usr/bin/env node
/**
 * Checks the final Apple screenshots against `apple-1206x2622/checksums.json` and the
 * App Store Connect rules that apply to them: 1206x2622, PNG, no alpha channel.
 *
 * Read-only. It never re-encodes a file; these PNGs are the founder's approved exports
 * and must reach App Store Connect byte for byte.
 *
 *   node store-assets/listings/2026-11-09/validate.mjs
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const { files } = JSON.parse(
  await readFile(join(here, 'apple-1206x2622', 'checksums.json'), 'utf8'),
);

let failed = 0;
for (const [name, expected] of Object.entries(files)) {
  const bytes = await readFile(join(here, name));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const meta = await sharp(bytes).metadata();
  const problems = [
    meta.format !== 'png' && `format ${meta.format}`,
    (meta.width !== 1206 || meta.height !== 2622) && `size ${meta.width}x${meta.height}`,
    meta.hasAlpha && 'has alpha',
    meta.channels !== 3 && `${meta.channels} channels`,
    bytes.length !== expected.bytes && `bytes ${bytes.length} != ${expected.bytes}`,
    sha256 !== expected.sha256 && 'sha256 mismatch',
  ].filter(Boolean);
  failed += problems.length ? 1 : 0;
  console.log(
    `${problems.length ? 'FAIL' : 'PASS'}  ${name}  ${meta.width}x${meta.height}  ${problems.join(', ')}`,
  );
}

process.exit(failed ? 1 : 0);
