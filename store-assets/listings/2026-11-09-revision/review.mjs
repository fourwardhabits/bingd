/** Review sheets for the founder. None of these are store assets. */
import { H, MAROON, W, line, sharp, svg } from './lib.mjs';

const INK = '#242326';
const MUTED = '#6B6670';
const SHEET_BG = '#EEEAE5';
const MARK = '#00B3D6';

const label = (text, px = 26, color = INK, face = 'sansMedium') =>
  line({ text, face, px, color });
const at = (l, left, baseline) => ({
  input: l.input,
  left: Math.round(left - l.ink.x0),
  top: Math.round(baseline - l.baseline),
});

async function scaled(png, width, radius = 0) {
  const height = Math.round((H * width) / W);
  const img = await sharp(png).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer();
  if (!radius) return { input: img, width, height };
  const mask = svg(
    width,
    height,
    `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/>`,
  );
  return {
    input: await sharp(img)
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer(),
    width,
    height,
  };
}

async function canvas(width, height, layers, bg = SHEET_BG) {
  return sharp({ create: { width, height, channels: 3, background: bg } })
    .composite(layers)
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Cards in a row at 1/3 scale, each with its label underneath. */
export async function contactSheet(items, title) {
  const tw = 402,
    pad = 40,
    gap = 28,
    top = 110;
  const th = Math.round((H * tw) / W);
  const heading = await label(title, 34, INK, 'sansSemi');
  const layers = [at(heading, pad, 64)];
  for (const [i, it] of items.entries()) {
    const left = pad + i * (tw + gap);
    layers.push({ input: (await scaled(it.png, tw)).input, left, top });
    layers.push(at(await label(it.label, 24, it.flag ? MAROON : INK), left, top + th + 40));
    if (it.note) layers.push(at(await label(it.note, 20, MUTED, 'sans'), left, top + th + 72));
  }
  const width = Math.max(
    pad * 2 + items.length * tw + (items.length - 1) * gap,
    pad * 2 + Math.ceil(heading.ink.x1 - heading.ink.x0),
  );
  return canvas(width, top + th + 100, layers);
}

/**
 * App Store search-result scale: three screenshots side by side at `tw` px wide,
 * rounded like the store's thumbnails, on white.
 */
export async function browseSheet(rows, tw = 250) {
  const pad = 32,
    gap = 12,
    head = 56;
  const th = Math.round((H * tw) / W);
  const cols = Math.max(...rows.map((r) => r.items.length));
  const rowH = head + th + 36;
  const layers = [];
  for (const [r, row] of rows.entries()) {
    const y = pad + r * rowH;
    layers.push(
      at(await label(row.title, 24, row.flag ? MAROON : INK, 'sansSemi'), pad, y + 34),
    );
    for (const [i, png] of row.items.entries()) {
      layers.push({
        input: (await scaled(png, tw, Math.round(tw * 0.055))).input,
        left: pad + i * (tw + gap),
        top: y + head,
      });
    }
  }
  return canvas(
    pad * 2 + cols * tw + (cols - 1) * gap,
    pad * 2 + rows.length * rowH - 36,
    layers,
    '#FFFFFF',
  );
}

/** Approved vs proposed at half size, with the measured subtitle-to-phone gap marked on both. */
export async function beforeAfter({ id, before, after, mBefore, mAfter, note }) {
  const s = 0.5,
    tw = Math.round(W * s),
    th = Math.round(H * s);
  const side = 190,
    gap = 48,
    top = 150;
  const width = side * 2 + tw * 2 + gap;
  const xB = side,
    xA = side + tw + gap;
  const pct = Math.round((100 * (mBefore.gap - mAfter.gap)) / mBefore.gap);
  const layers = [
    at(
      await label(
        `${id}: gap ${mBefore.gap} px → ${mAfter.gap} px (−${pct}%)`,
        34,
        INK,
        'sansSemi',
      ),
      40,
      62,
    ),
    at(await label(note, 22, MUTED, 'sans'), 40, 104),
    at(await label('APPROVED (PR #240)', 22, MUTED, 'sansSemi'), xB, top - 14),
    at(await label('PROPOSED', 22, MAROON, 'sansSemi'), xA, top - 14),
    { input: (await scaled(before, tw)).input, left: xB, top },
    { input: (await scaled(after, tw)).input, left: xA, top },
  ];
  const marks = [];
  for (const [m, x0, labelX, align] of [
    [mBefore, xB, xB - 16, 'end'],
    [mAfter, xA, xA + tw + 16, 'start'],
  ]) {
    const y0 = top + (m.subtitleBottom + 1) * s,
      y1 = top + m.phoneTop * s;
    marks.push(
      `<line x1="${x0}" y1="${y0}" x2="${x0 + tw}" y2="${y0}" stroke="${MARK}" stroke-width="2"/>`,
      `<line x1="${x0}" y1="${y1}" x2="${x0 + tw}" y2="${y1}" stroke="${MARK}" stroke-width="2"/>`,
      `<rect x="${x0 + 6}" y="${y0}" width="10" height="${y1 - y0}" fill="${MARK}" fill-opacity="0.55"/>`,
    );
    const l = await label(`${m.gap} px`, 30, MARK, 'sansSemi');
    const left = align === 'end' ? labelX - (l.ink.x1 - l.ink.x0 + 1) : labelX;
    layers.push(at(l, left, (y0 + y1) / 2 + 11));
  }
  layers.push({ input: svg(width, top + th + 40, marks.join('')), left: 0, top: 0 });
  return canvas(width, top + th + 40, layers);
}

/** The revised card 02 at half size next to a 1:1 crop of its comparison sheet. */
export async function card02Large(png) {
  const s = 0.5,
    tw = Math.round(W * s),
    th = Math.round(H * s);
  const crop = { left: 98, top: 1150, width: 1015, height: 1472 };
  const pad = 40,
    top = 120,
    gap = 48;
  const layers = [
    at(
      await label(
        'Card 02, revised: full card at 50% (left) and the comparison at 100% (right)',
        30,
        INK,
        'sansSemi',
      ),
      pad,
      66,
    ),
    { input: (await scaled(png, tw)).input, left: pad, top },
    { input: await sharp(png).extract(crop).png().toBuffer(), left: pad + tw + gap, top },
  ];
  return canvas(pad * 2 + tw + gap + crop.width, top + Math.max(th, crop.height) + pad, layers);
}

/** The bottom 360 px of each card at 50%, to check what each phone shows at the edge. */
export async function bottomEdges(items) {
  const s = 0.5,
    strip = 360,
    tw = Math.round(W * s),
    th = Math.round(strip * s);
  const pad = 40,
    gap = 32,
    head = 44,
    cols = 2,
    top = 100;
  const rows = Math.ceil(items.length / cols);
  const layers = [
    at(
      await label('Bottom edge of every card (bottom 360 px, 50%)', 30, INK, 'sansSemi'),
      pad,
      60,
    ),
  ];
  for (const [i, it] of items.entries()) {
    const left = pad + (i % cols) * (tw + gap);
    const y = top + Math.floor(i / cols) * (head + th + gap);
    layers.push(at(await label(it.label, 22, INK), left, y + 30));
    const img = await sharp(it.png)
      .extract({ left: 0, top: H - strip, width: W, height: strip })
      .resize(tw, th)
      .png()
      .toBuffer();
    layers.push({ input: img, left, top: y + head });
  }
  return canvas(
    pad * 2 + cols * tw + (cols - 1) * gap,
    top + rows * (head + th + gap) + pad,
    layers,
  );
}
