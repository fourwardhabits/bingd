import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../lib/common.mjs';

/**
 * The faces a frame is set in, from the same `@expo-google-fonts` packages the app ships.
 * `--fonts <dir>` reads flat TTFs instead, which is what the brand kit's 06-fonts folder is.
 *
 * Each CSS family name below is private to this pipeline, so a font installed on the host
 * machine can never stand in, and no stack names a fallback: a face that does not load is
 * an error here, and compose/run.mjs asserts the same thing again inside Chrome.
 */
export const FACES = [
  {
    family: 'bingd-serif',
    weight: 400,
    file: 'DMSerifDisplay_400Regular.ttf',
    packagePath: '@expo-google-fonts/dm-serif-display/400Regular',
  },
  {
    family: 'bingd-sans',
    weight: 400,
    file: 'Inter_400Regular.ttf',
    packagePath: '@expo-google-fonts/inter/400Regular',
  },
  {
    family: 'bingd-sans',
    weight: 700,
    file: 'Inter_700Bold.ttf',
    packagePath: '@expo-google-fonts/inter/700Bold',
  },
];

export function loadFonts(fontsDir) {
  const missing = [];
  const faces = FACES.map((face) => {
    const path = fontsDir
      ? join(fontsDir, face.file)
      : join(ROOT, 'node_modules', face.packagePath, face.file);
    if (!existsSync(path)) {
      missing.push(path);
      return null;
    }
    return { ...face, data: readFileSync(path).toString('base64') };
  });
  if (missing.length) {
    throw new Error(
      `Missing font file(s), and frames are never set in a fallback:\n  ${missing.join('\n  ')}\n` +
        'Run npm install in store-assets/screenshots, or pass --fonts <dir> with these files.',
    );
  }
  return faces;
}

export const fontFaceCss = (faces) =>
  faces
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-weight:${f.weight};font-style:normal;` +
        `src:url(data:font/ttf;base64,${f.data}) format('truetype');}`,
    )
    .join('\n');
