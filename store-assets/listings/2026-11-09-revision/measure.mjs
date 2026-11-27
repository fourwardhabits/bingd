/**
 * Measures a rendered card from its pixels, not from layout constants:
 *   subtitleBottom  last row of subtitle ink (light pixels on the maroon ground)
 *   phoneTop        first row of the main phone's frame (#1A191C) at the card's centre
 *   gap             clear rows between them
 *   topMargin       rows above the first ink of any type
 */
import { sharp } from './lib.mjs';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export async function measureCard(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = (x, y) => {
    const i = (y * w + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const lightRow = (y) => {
    const bg = lum(...px(12, y));
    for (let x = 24; x < w - 24; x++) if (lum(...px(x, y)) > bg + 45) return true;
    return false;
  };
  let phoneTop = -1;
  for (let y = 300; y < h; y++) {
    let dark = 0;
    for (let x = 300; x < w - 300; x++) if (lum(...px(x, y)) < 34) dark++;
    if (dark > (w - 600) * 0.9) {
      phoneTop = y;
      break;
    }
  }
  let subtitleBottom = -1;
  for (let y = phoneTop - 1; y > 0; y--)
    if (lightRow(y)) {
      subtitleBottom = y;
      break;
    }
  let topInk = -1;
  for (let y = 0; y < subtitleBottom; y++)
    if (lightRow(y)) {
      topInk = y;
      break;
    }
  return {
    width: w,
    height: h,
    topInk,
    subtitleBottom,
    phoneTop,
    gap: phoneTop - subtitleBottom - 1,
    topMargin: topInk,
  };
}

/**
 * Lines of type above the main phone, from pixels: runs of rows with light ink,
 * merged across gaps of up to `join` rows (dots and accents). Each line reports its
 * ink box, so the count proves the line breaks and x0/x1 prove nothing is clipped.
 */
export async function measureTextLines(file, { join = 10 } = {}) {
  const { phoneTop } = await measureCard(file);
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const l = (x, y) => {
    const i = (y * w + x) * 3;
    return lum(data[i], data[i + 1], data[i + 2]);
  };
  const lines = [];
  let open = null;
  for (let y = 0; y < phoneTop - 30; y++) {
    const bg = l(12, y);
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++)
      if (l(x, y) > bg + 45) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    if (x0 < 0) continue;
    if (open && y - open.y1 <= join + 1) {
      open.y1 = y;
      open.x0 = Math.min(open.x0, x0);
      open.x1 = Math.max(open.x1, x1);
    } else {
      open = { y0: y, y1: y, x0, x1 };
      lines.push(open);
    }
  }
  return lines.map((b) => ({
    ...b,
    width: b.x1 - b.x0 + 1,
    height: b.y1 - b.y0 + 1,
    centre: (b.x0 + b.x1 + 1) / 2,
    marginLeft: b.x0,
    marginRight: w - 1 - b.x1,
  }));
}

/**
 * Bezel-to-bezel width of a phone frame, from pixels: the leftmost and rightmost
 * columns in [xFrom, xTo) that are frame-dark on every row in [y0, y1). Screen
 * content is never that dark for hundreds of rows, so only bezels match. The 1 px
 * lighter edge stroke on each side is not counted.
 */
export async function measureFrameWidth(file, [y0, y1], [xFrom, xTo]) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const dark = (x, y) => {
    const i = (y * w + x) * 3;
    return lum(data[i], data[i + 1], data[i + 2]) < 34;
  };
  const bezel = (x) => {
    for (let y = y0; y < y1; y++) if (!dark(x, y)) return false;
    return true;
  };
  let left = -1;
  let right = -1;
  for (let x = xFrom; x < xTo; x++)
    if (bezel(x)) {
      left = x;
      break;
    }
  for (let x = xTo - 1; x >= xFrom; x--)
    if (bezel(x)) {
      right = x;
      break;
    }
  return { left, right, width: right - left + 1 };
}
