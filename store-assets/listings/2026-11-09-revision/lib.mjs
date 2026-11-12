/**
 * Drawing primitives for the 2026-11-09 revision cards: type, phone frame,
 * shadow, background. Geometry and treatment are carried over unchanged from
 * the founder's legacy renderer (handoff `legacy-renderer/build.mjs` + `lib.mjs`);
 * only the file paths were made portable.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..', '..', '..');
const FONT_PKGS = join(REPO, 'node_modules', '@expo-google-fonts');

// Pango resolves `fontfile` by family name through fontconfig, so a system-wide
// "Inter" (a different version) can silently win. Fontconfig is limited to the
// app's own font packages; this must happen before sharp is loaded.
const fcDir = join(tmpdir(), 'bingd-store-fontconfig');
mkdirSync(join(fcDir, 'cache'), { recursive: true });
writeFileSync(
  join(fcDir, 'fonts.conf'),
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<dir>${join(FONT_PKGS, 'inter')}</dir><dir>${join(FONT_PKGS, 'dm-serif-display')}</dir><cachedir>${join(fcDir, 'cache')}</cachedir></fontconfig>`,
);
process.env.FONTCONFIG_FILE = join(fcDir, 'fonts.conf');
const { default: sharp } = await import('sharp');

export { sharp };

const font = (pkg, weight, file) => join(FONT_PKGS, pkg, weight, file);
/** The same OFL files the app ships (package.json → @expo-google-fonts/*). */
export const FONTS = {
  serif: [
    'DM Serif Display',
    font('dm-serif-display', '400Regular', 'DMSerifDisplay_400Regular.ttf'),
  ],
  sans: ['Inter', font('inter', '400Regular', 'Inter_400Regular.ttf')],
  sansMedium: ['Inter Medium', font('inter', '500Medium', 'Inter_500Medium.ttf')],
  sansSemi: ['Inter SemiBold', font('inter', '600SemiBold', 'Inter_600SemiBold.ttf')],
};

export const W = 1206;
export const H = 2622;
export const FRAME = '#1A191C';
export const PAPER = '#FBF8F4';
export const MAROON = '#773744';
export const AMBER = '#D4A64C';

/** [y, r, g, b] down the card edge, measured from the live listing by the legacy renderer. */
const BG_STOPS = [
  [0, 125, 58, 75],
  [346, 120, 56, 72],
  [864, 109, 50, 63],
  [1210, 102, 48, 59],
  [1555, 97, 47, 55],
  [1900, 90, 42, 51],
  [2246, 77, 32, 44],
  [2622, 68, 27, 36],
];

export const svg = (w, h, body) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`,
  );
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line of type at an exact px size. Returns RGBA PNG plus its ink box and baseline (from a reference 'H'). */
export async function line({ text, face, px, color, tracking = 0 }) {
  const dpi = Math.round((72 * px) / 10);
  const attrs = [`foreground="${color}"`];
  // With this libvips/Pango build letter_spacing is in 1/1024 px regardless of dpi.
  if (tracking) attrs.push(`letter_spacing="${Math.round(tracking * 1024)}"`);
  const render = (t) =>
    sharp({
      text: {
        text: `<span ${attrs.join(' ')}>${esc(t)}</span>`,
        font: `${FONTS[face][0]} 10`,
        fontfile: FONTS[face][1],
        dpi,
        rgba: true,
      },
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
  const ink = ({ data, info }) => {
    let x0 = 1e9,
      x1 = -1,
      y0 = 1e9,
      y1 = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++)
        if (data[(y * info.width + x) * 4 + 3] > 24) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    return { x0, x1, y0, y1 };
  };
  const img = await render(text);
  const ref = ink(await render('H'));
  const png = await sharp(img.data, { raw: img.info }).png().toBuffer();
  return {
    input: png,
    width: img.info.width,
    height: img.info.height,
    ink: ink(img),
    baseline: ref.y1 + 1,
    capTop: ref.y0,
  };
}

/** Composite descriptor that centres a line on `cx` by its ink, baseline at `baseline`. */
export const placeLine = (l, cx, baseline) => ({
  input: l.input,
  left: Math.round(cx - (l.ink.x0 + l.ink.x1 + 1) / 2),
  top: Math.round(baseline - l.baseline),
});

/**
 * A screen image as { buffer, width, height }. Layers are used as-is (already
 * cropped and redacted). Raw captures get the legacy Android chrome crop.
 */
const CROP_TOP = 0.0381;
const CROP_BOTTOM = 0.9541;
export async function loadScreen(file, { rawCapture = false } = {}) {
  if (!rawCapture) {
    const buffer = await sharp(file).png().toBuffer();
    const m = await sharp(buffer).metadata();
    return { buffer, width: m.width, height: m.height };
  }
  const { width, height } = await sharp(file).metadata();
  const top = Math.round(height * CROP_TOP);
  const bottom = Math.round(height * CROP_BOTTOM);
  const buffer = await sharp(file)
    .extract({ left: 0, top, width, height: bottom - top })
    .png()
    .toBuffer();
  return { buffer, width, height: bottom - top, crop: { top, bottom, sourceHeight: height } };
}

/** Scales a screen to the inner width (never stretched) and crops it to innerH. */
async function fitScreen(scr, innerW, innerH) {
  const scaledH = Math.round((scr.height * innerW) / scr.width);
  let img = sharp(scr.buffer).resize({ width: innerW, height: scaledH, kernel: 'lanczos3' });
  if (innerW > scr.width) img = img.sharpen({ sigma: 0.6, m1: 0.5, m2: 1.5 });
  const buf = await img.png().toBuffer();
  const h = Math.min(innerH, scaledH);
  return {
    buffer: await sharp(buf)
      .extract({ left: 0, top: 0, width: innerW, height: h })
      .png()
      .toBuffer(),
    height: h,
    scaledH,
  };
}

export async function phone({ scr, outerW, outerH, bezel, radius }) {
  const innerW = outerW - 2 * bezel;
  const innerH = outerH - 2 * bezel;
  const fit = await fitScreen(scr, innerW, innerH);
  const ir = radius - bezel;
  const clip = svg(
    innerW,
    innerH,
    `<rect width="${innerW}" height="${innerH}" rx="${ir}" ry="${ir}" fill="#fff"/>`,
  );
  const screenImg = await sharp({
    create: { width: innerW, height: innerH, channels: 4, background: PAPER },
  })
    .composite([
      { input: fit.buffer, left: 0, top: 0 },
      { input: clip, blend: 'dest-in' },
    ])
    .png()
    .toBuffer();
  const body = svg(
    outerW,
    outerH,
    `<rect width="${outerW}" height="${outerH}" rx="${radius}" ry="${radius}" fill="${FRAME}"/>
    <rect x="1" y="1" width="${outerW - 2}" height="${outerH - 2}" rx="${radius - 1}" ry="${radius - 1}" fill="none" stroke="#3A383D" stroke-width="2"/>`,
  );
  return {
    buffer: await sharp(body)
      .composite([{ input: screenImg, left: bezel, top: bezel }])
      .png()
      .toBuffer(),
    screenH: fit.height,
    scaledH: fit.scaledH,
  };
}

export async function shadowOf(phoneBuf, { sigma, opacity, dy }) {
  const { width, height } = await sharp(phoneBuf).metadata();
  const pad = Math.ceil(sigma * 3);
  const alpha = await sharp(phoneBuf).extractChannel(3).toBuffer();
  const shadow = await sharp({ create: { width, height, channels: 3, background: '#000' } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  const padded = await sharp(shadow)
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .blur(sigma)
    .png()
    .toBuffer();
  const { data, info } = await sharp(padded).raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * opacity);
  return { input: await sharp(data, { raw: info }).png().toBuffer(), pad, dy };
}

/** Crops a layer to the card so sharp.composite accepts it. */
export async function visible(buf, left, top) {
  const m = await sharp(buf).metadata();
  const t0 = Math.max(0, -top),
    l0 = Math.max(0, -left);
  const w = Math.min(m.width - l0, W - Math.max(0, left)),
    h = Math.min(m.height - t0, H - Math.max(0, top));
  return {
    input: await sharp(buf)
      .extract({ left: l0, top: t0, width: w, height: h })
      .png()
      .toBuffer(),
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

let bgCache;
export async function background() {
  if (bgCache) return bgCache;
  const stops = BG_STOPS.map(
    ([y, r, g, b]) => `<stop offset="${(y / H).toFixed(4)}" stop-color="rgb(${r},${g},${b})"/>`,
  ).join('');
  bgCache = await sharp(
    svg(
      W,
      H,
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>
    <radialGradient id="lift" cx="0.5" cy="0.22" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.035"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#lift)"/>`,
    ),
  )
    .png()
    .toBuffer();
  return bgCache;
}

/** Final encode: flattened 8-bit sRGB RGB PNG, no alpha, 72 dpi (same as the approved exports). */
export const encodeCard = (img) =>
  img
    .flatten({ background: '#000' })
    .removeAlpha()
    .toColourspace('srgb')
    .withMetadata({ density: 72 })
    .png({ compressionLevel: 9 })
    .toBuffer();

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
