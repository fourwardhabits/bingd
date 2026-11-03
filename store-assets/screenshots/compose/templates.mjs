import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO } from '../lib/common.mjs';
import { fontFaceCss } from './fonts.mjs';

/** docs/design/design-system.md §2, via src/ui/tokens/color.ts. */
export const COLOR = {
  maroon: '#773744',
  maroonDeep: '#481D26',
  amber: '#D4A64C',
  parchment: '#F5EBDD',
  ink: '#242326',
};

/**
 * The live frames' field runs from Maroon into a deep Maroon. The top third stays exact
 * `#773744` because the 3.88:1 and 7.4:1 contrast figures are measured against it.
 */
const FIELD = `linear-gradient(180deg, ${COLOR.maroon} 0%, ${COLOR.maroon} 34%, ${COLOR.maroonDeep} 100%)`;

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The mark from its one source, recoloured the way the kit's reversed logo is. */
export function reversedMark() {
  const svg = readFileSync(join(REPO, 'assets', 'brand', 'bingd-icon.svg'), 'utf8');
  if (!svg.includes(`stroke="${COLOR.maroon}"`)) {
    throw new Error('assets/brand/bingd-icon.svg no longer strokes in Maroon; update reversedMark');
  }
  return svg.replace(`stroke="${COLOR.maroon}"`, `stroke="${COLOR.parchment}"`);
}

const baseCss = (canvas, faces) => `
${fontFaceCss(faces)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${canvas.width}px;height:${canvas.height}px;overflow:hidden}
body{font-kerning:normal;text-rendering:geometricPrecision;-webkit-font-smoothing:antialiased}
.field{position:relative;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden;background:${FIELD}}
.eyebrow{font-family:'bingd-sans';font-weight:700;color:${COLOR.amber};letter-spacing:.14em;white-space:nowrap}
.headline{font-family:'bingd-serif';font-weight:400;color:${COLOR.parchment};line-height:1.09}
.headline span{display:block;white-space:nowrap}
.sub{font-family:'bingd-sans';font-weight:400;color:${COLOR.parchment};white-space:nowrap;margin-top:.3em}
.device{position:absolute;background:${COLOR.ink}}
.device .screen{width:100%;height:100%;overflow:hidden}
.device img{display:block}
`;

const textBlock = (copy, type) => `
  ${copy.eyebrow && type.eyebrow ? `<div class="eyebrow" data-text style="font-size:${type.eyebrow}px">${escapeHtml(copy.eyebrow)}</div>` : ''}
  <h1 class="headline" data-text style="font-size:${type.headline}px">${copy.headline.map((l) => `<span>${escapeHtml(l)}</span>`).join('')}</h1>
  <div class="sub" data-text style="font-size:${type.sub}px">${escapeHtml(copy.sub)}</div>`;

/**
 * Sizes a device so its screen is an exact pixel width, which lets compose resample the
 * capture once with sharp instead of leaving it to Chrome's image scaler.
 */
export function deviceMetrics(outerWidth) {
  const bezel = Math.round(outerWidth * 0.024);
  return {
    bezel,
    radius: Math.round(outerWidth * 0.112),
    screenRadius: Math.round(outerWidth * 0.112) - bezel,
    screenWidth: outerWidth - bezel * 2,
  };
}

/**
 * Rounded top, and rounded bottom only when the phone is fully on canvas. The screen's own
 * corners come baked into the image: see screenImage in compose/run.mjs.
 */
function deviceHtml({ src, outerWidth, style, shadow, bleed }) {
  const m = deviceMetrics(outerWidth);
  const r = `${m.radius}px ${m.radius}px ${bleed ? '0 0' : `${m.radius}px ${m.radius}px`}`;
  return `<div class="device" data-device style="${style};width:${outerWidth}px;border-radius:${r};padding:${m.bezel}px ${m.bezel}px ${bleed ? 0 : m.bezel}px;box-shadow:${shadow}">
    <div class="screen"><img src="${src}" width="${m.screenWidth}" alt=""></div>
  </div>`;
}

const SHADOW = (y, blur) => `0 ${y}px ${blur}px rgba(36,35,38,.5)`;

/** Eyebrow, headline and sub, centred, over a device that runs off the bottom edge. */
function portrait({ canvas, copy, images, faces }) {
  const { width: W, height: H, type, text, device } = canvas;
  const left = Math.round((W - device.width) / 2);
  const main = deviceHtml({
    src: images.main.src,
    outerWidth: device.width,
    style: `left:${left}px;top:${device.top}px;height:${H - device.top}px`,
    shadow: SHADOW(24, 90),
    bleed: true,
  });
  let inset = '';
  if (images.inset) {
    const iw = device.inset.width;
    const m = deviceMetrics(iw);
    const height = images.inset.height + m.bezel * 2;
    const top = H - device.inset.bottom - height;
    if (top < device.top) throw new Error(`The inset phone does not fit on ${W}x${H}`);
    inset = deviceHtml({
      src: images.inset.src,
      outerWidth: iw,
      style: `right:${device.inset.right}px;top:${top}px;height:${height}px`,
      shadow: SHADOW(18, 70),
      bleed: false,
    });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(canvas, faces)}
.text{position:absolute;left:0;right:0;top:${text.top}px;display:flex;flex-direction:column;align-items:center;gap:${text.gap}px;text-align:center}
</style></head><body><div class="field"><div class="text">${textBlock(copy, type)}</div>${main}${inset}</div></body></html>`;
}

/** Text on the left, a phone cropped by the bottom edge on the right. */
function landscape({ canvas, copy, images, faces }) {
  const { height: H, type, text, device } = canvas;
  const main = deviceHtml({
    src: images.main.src,
    outerWidth: device.width,
    style: `right:${device.right}px;top:${device.top}px;height:${H - device.top}px`,
    shadow: SHADOW(16, 60),
    bleed: true,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(canvas, faces)}
.text{position:absolute;left:${text.left}px;top:0;bottom:0;width:${text.width}px;display:flex;flex-direction:column;justify-content:center;gap:${text.gap}px}
</style></head><body><div class="field"><div class="text">${textBlock(copy, type)}</div>${main}</div></body></html>`;
}

/**
 * No device and no artwork: the lockup and the promise. This is the one composed format
 * with the logo on the field, so `bingd.` appears here as the drawn logo and nowhere as text.
 */
function brand({ canvas, copy, faces }) {
  const { type, text, logo } = canvas;
  const markSvg = reversedMark()
    .replace('width="100%"', `width="${logo.markWidth}"`)
    .replace('height="100%"', `height="${Math.round(logo.markWidth * 0.6)}"`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(canvas, faces)}
.field{background:${COLOR.maroon};display:flex;align-items:center;justify-content:center;gap:60px}
.lockup{display:flex;flex-direction:column;align-items:center;gap:4px}
.wordmark{font-family:'bingd-serif';color:${COLOR.parchment};font-size:${logo.wordmark}px;line-height:1}
.text{display:flex;flex-direction:column;gap:${text.gap}px}
</style></head><body><div class="field">
  <div class="lockup" data-logo>${markSvg}<div class="wordmark">bingd.</div></div>
  <div class="text">${textBlock(copy, type)}</div>
</div></body></html>`;
}

export const TEMPLATES = { portrait, landscape, brand };
