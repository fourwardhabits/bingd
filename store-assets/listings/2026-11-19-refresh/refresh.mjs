/**
 * Store refresh 2026-11-19: the approved six-card set (PR #245 v3 copy and order, with the
 * founder's Nov 11 picks) rendered for every store slot, plus the card 03 feed swap.
 *
 *   node store-assets/listings/2026-11-19-refresh/refresh.mjs
 *   node store-assets/listings/2026-11-19-refresh/refresh.mjs --card03 /path/Screenshot_20261119_160109_bingd.jpg
 *
 * Nothing is redesigned. `lib.mjs`, `cards.mjs` and `sources/` are byte copies from PR #245
 * (head a2500485). The renderer below is #245's card renderer generalised to any canvas
 * (the same generalisation as the Nov 11 `play-render.mjs`): the 1206 x 2622 card is scaled
 * uniformly by h / 2622 and centred, and the background gradient is extended to the width.
 *
 * Steps, stopping on the first failure:
 *   1. Verify `sources/` against `sources/SOURCES.json`.
 *   2. Render the approved lineup at 1206 x 2622 and 1080 x 1920 and require it to match the
 *      Nov 11 final candidate byte for byte (sha256 below, from the Drive README).
 *   3. If `inputs/card03.json` names a reviewed, redacted feed capture, render card 03 from it
 *      and require everything outside the main phone's screen to be unchanged.
 *   4. Write every target (Apple 6.3", Apple 6.9", Google Play), the manifest, checksums,
 *      contact sheets and QA report.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  H,
  W,
  encodeCard,
  line,
  loadScreen,
  phone,
  placeLine,
  shadowOf,
  sharp,
  svg,
} from './lib.mjs';
import { BALANCED, REVISION, TYPE, cardSpecs } from './cards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const rel = (p) => relative(REPO, p);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const R = Math.round;

// ---------------------------------------------------------------------------------------
// What is being reproduced
// ---------------------------------------------------------------------------------------

/** Upload position → file stem, as in #245 `store-order/` and the Nov 11 Drive candidate. */
const STEMS = [
  '01-collection__01-movies-tv',
  '02-head-to-head__02-head-to-head',
  '03-friends__03-friends',
  '04-for-you__06-for-you',
  '05-watchlist__04-watchlist',
  '06-goals-awards__05-your-year_balanced',
];

/**
 * sha256 of "bingd store screenshots — final candidate 2026-11-11" (Drive folder
 * 1NID4eD9XJKABNio8r9MTHqQ0HaaMs96s, README.md). ios/ is #245 store-order 01–05 plus
 * alternatives/05-your-year_ALT-balanced.png; play/ is play-render.mjs `pad`.
 */
const NOV11 = {
  'apple-1206x2622': [
    'dd356e82187b4226c430b7213bebc2b2ced8bc27f224f000dd8b491e182c2b1a',
    '78e9098b848a7bddf81c4b0eb87f0b5c49fca43379a6e3ce13368f92ac1a7084',
    '54b1cf6bb4a5654fe01e715817ddf0eacef5535b481fb9c3112dd4ca63babc73',
    'bf9a8dd62d43692a590dd8479157522ec21a93312f559c878fed1ef0b5a23238',
    '1b087156477b162abdb3442d8cc0aa15a03127911650d742700741d3e164cec7',
    '51e6da3532f0e7441f4f5730ba667cf52d98574fc21aa053886893a4739a4e35',
  ],
  'play-1080x1920': [
    '6bd80f42274e1d2dad79bcb9e3011cbce661354ddd70c1132e3e0485a7e94092',
    '24d078244e8d42fb33bd9b94852aaf7fde5999ed18421d7d3f120c6665c85ea0',
    '69688443d068ee2cfabd477dd65d6736efedd27a1d6b06c921da958cb0381b2f',
    '526d2ad930a8e84d1b3aa6753cebdfb3b1deaf1f29a388dbdf9ffdef420cf9c7',
    'b72428a77e315ac651b71948989ef226848453fd5d5d1c80237ee79cc1f3ef3b',
    '81307ab0a58cd9db491c5cc555e153cdd51cd80b57c6a59c71f31929d4f440a3',
  ],
};

/**
 * Every slot this set is uploaded to. Apple's current specification (fetched 2026-11-19)
 * requires "iPhone with Dynamic Island (medium display)", which 1206 x 2622 is; the large
 * display (6.9") slot falls back to the 6.5" slot when empty, so it gets its own native
 * render rather than whatever an older version left there. The app is iPhone-only
 * (`supportsTablet: false`), so there is no iPad set.
 */
const TARGETS = [
  {
    id: 'apple-1206x2622',
    store: 'apple',
    w: 1206,
    h: 2622,
    slot: 'iPhone with Dynamic Island, medium display (6.3")',
  },
  {
    id: 'apple-1320x2868',
    store: 'apple',
    w: 1320,
    h: 2868,
    slot: 'iPhone with Dynamic Island, large display (6.9")',
  },
  {
    id: 'play-1080x1920',
    store: 'play',
    w: 1080,
    h: 1920,
    slot: 'Google Play phone screenshots',
  },
];

// ---------------------------------------------------------------------------------------
// The renderer: #245 renderCard / Nov 11 play-render, for any canvas
// ---------------------------------------------------------------------------------------

const TAB_BAR = 145 / 945;
const TAB_BAR_MARGIN = 12;
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

const bgCache = new Map();
async function background(PW, PH) {
  const key = `${PW}x${PH}`;
  if (!bgCache.has(key)) {
    const stops = BG_STOPS.map(
      ([y, r, g, b]) =>
        `<stop offset="${(y / H).toFixed(4)}" stop-color="rgb(${r},${g},${b})"/>`,
    ).join('');
    bgCache.set(
      key,
      await sharp(
        svg(
          PW,
          PH,
          `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient><radialGradient id="lift" cx="0.5" cy="0.22" r="0.55"><stop offset="0" stop-color="#fff" stop-opacity="0.035"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="${PW}" height="${PH}" fill="url(#g)"/><rect width="${PW}" height="${PH}" fill="url(#lift)"/>`,
        ),
      )
        .png()
        .toBuffer(),
    );
  }
  return bgCache.get(key);
}

async function vis(buf, left, top, PW, PH) {
  const m = await sharp(buf).metadata();
  const t0 = Math.max(0, -top);
  const l0 = Math.max(0, -left);
  const w = Math.min(m.width - l0, PW - Math.max(0, left));
  const h = Math.min(m.height - t0, PH - Math.max(0, top));
  return {
    input: await sharp(buf)
      .extract({ left: l0, top: t0, width: w, height: h })
      .png()
      .toBuffer(),
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

/** One card on a PW x PH canvas. Returns the PNG and the main screen's top edge (QA). */
async function render(spec, layout, { w: PW, h: PH }) {
  const s = PH / H;
  const ox = (PW - W * s) / 2;
  const X = (x) => R(ox + s * x);
  const Y = (y) => R(s * y);
  const L = [];
  for (let i = 0; i < 2; i++) {
    const hl = await line({
      text: spec.headline[i],
      ...TYPE.headline,
      px: TYPE.headline.px * s,
    });
    L.push(placeLine(hl, PW / 2, Y(layout.headline[i])));
  }
  const st = await line({ text: spec.subtitle, ...TYPE.subtitle, px: TYPE.subtitle.px * s });
  L.push(placeLine(st, PW / 2, Y(layout.subtitle)));

  const M = layout.main;
  const mw = R(M.w * s);
  const mb = R(M.bezel * s);
  const mr = R(M.radius * s);
  const my = Y(M.y);
  const main = await phone({
    scr: await loadScreen(spec.main.file, spec.main),
    outerW: mw,
    outerH: PH - my + mr + R(40 * s),
    bezel: mb,
    radius: mr,
  });
  const ms = await shadowOf(main.buffer, { sigma: 18 * s, opacity: 0.28, dy: R(10 * s) });
  L.push(await vis(ms.input, X(M.x) - ms.pad, my - ms.pad + ms.dy, PW, PH));
  L.push(await vis(main.buffer, X(M.x), my, PW, PH));

  if (spec.sec) {
    const S = layout.sec;
    const sw = R(S.w * s);
    const sb = Math.max(1, R(S.bezel * s));
    const sr = R(S.radius * s);
    const scr = await loadScreen(spec.sec.file, spec.sec);
    const innerW = sw - 2 * sb;
    const ih = Math.min(R((scr.height * innerW) / scr.width), R((1876 / 945) * innerW));
    const outerH = ih + 2 * sb;
    const top = PH + sb + Math.ceil(TAB_BAR * innerW) + R(TAB_BAR_MARGIN * s) - outerH;
    const sec = await phone({ scr, outerW: sw, outerH, bezel: sb, radius: sr });
    const ss = await shadowOf(sec.buffer, { sigma: 22 * s, opacity: 0.5, dy: R(16 * s) });
    L.push(await vis(ss.input, X(S.x) - ss.pad, top - ss.pad + ss.dy, PW, PH));
    L.push(await vis(sec.buffer, X(S.x), top, PW, PH));
  }
  const png = await encodeCard(sharp(await background(PW, PH)).composite(L));
  // Above this row nothing depends on the main screen (type, background, phone shadow halo).
  const screenIndependentRows = my - Math.ceil(3 * 18 * s) + R(10 * s);
  return { png, screenIndependentRows };
}

// ---------------------------------------------------------------------------------------
// Card 03: the feed capture swap
// ---------------------------------------------------------------------------------------

const CARD03 = join(here, 'inputs', 'card03.json');

/**
 * The legacy Android chrome crop (`lib.mjs` loadScreen rawCapture): 3.81 % off the top
 * (status bar) and everything below 95.41 % (navigation bar). On the founder's 1080 x 2340
 * captures that is rows 89..2233, a 1080 x 2144 screen, the same 1.985 aspect as the
 * approved 945 x 1876 card 03 layer, so the phone frames it identically.
 */
async function cropCapture(file, crop) {
  const { width, height } = await sharp(file).metadata();
  const top = R(height * crop.top);
  const bottom = R(height * crop.bottom);
  return {
    buffer: await sharp(file)
      .rotate()
      .extract({ left: 0, top, width, height: bottom - top })
      .png()
      .toBuffer(),
    width,
    height: bottom - top,
    sourceSize: [width, height],
  };
}

const boxOf = (r) =>
  r.kind === 'circle'
    ? { x: r.cx - r.r, y: r.cy - r.r, w: 2 * r.r, h: 2 * r.r }
    : { x: r.x, y: r.y, w: r.w, h: r.h };

/** The approved cards' redaction: a heavy Gaussian blur, hard-edged boxes on names, soft discs on avatars. */
async function redact(buf, regions) {
  const { width, height } = await sharp(buf).metadata();
  const layers = [];
  for (const r of regions) {
    const sigma = r.sigma ?? (r.kind === 'circle' ? 10 : 12);
    const b = boxOf(r);
    const x0 = Math.max(0, R(b.x));
    const y0 = Math.max(0, R(b.y));
    const x1 = Math.min(width, R(b.x + b.w));
    const y1 = Math.min(height, R(b.y + b.h));
    if (x1 <= x0 || y1 <= y0) throw new Error(`redaction "${r.what}" lies outside the screen`);
    const pad = Math.ceil(3 * sigma);
    const ex = Math.max(0, x0 - pad);
    const ey = Math.max(0, y0 - pad);
    const ew = Math.min(width, x1 + pad) - ex;
    const eh = Math.min(height, y1 + pad) - ey;
    const blurred = await sharp(buf)
      .extract({ left: ex, top: ey, width: ew, height: eh })
      .blur(sigma)
      .png()
      .toBuffer();
    let inner = await sharp(blurred)
      .extract({ left: x0 - ex, top: y0 - ey, width: x1 - x0, height: y1 - y0 })
      .ensureAlpha()
      .png()
      .toBuffer();
    if (r.kind === 'circle') {
      const mask = await sharp(
        svg(
          x1 - x0,
          y1 - y0,
          `<circle cx="${r.cx - x0}" cy="${r.cy - y0}" r="${r.r - 2}" fill="#fff"/>`,
        ),
      )
        .blur(2)
        .png()
        .toBuffer();
      inner = await sharp(inner)
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    }
    layers.push({ input: inner, left: x0, top: y0 });
  }
  return sharp(buf).composite(layers).png().toBuffer();
}

/** Outlines and numbers each redaction over a screen, with a 100 px grid for placing them. */
async function annotate(buf, regions) {
  const { width, height } = await sharp(buf).metadata();
  const grid = [];
  for (let x = 100; x < width; x += 100)
    grid.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#00A0FF" stroke-opacity="0.35"/><text x="${x + 4}" y="22" font-family="Inter" font-size="18" fill="#0070C0">${x}</text>`,
    );
  for (let y = 100; y < height; y += 100)
    grid.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#00A0FF" stroke-opacity="0.35"/><text x="4" y="${y - 4}" font-family="Inter" font-size="18" fill="#0070C0">${y}</text>`,
    );
  const marks = regions.map((r, i) => {
    const shape =
      r.kind === 'circle'
        ? `<circle cx="${r.cx}" cy="${r.cy}" r="${r.r}" fill="none" stroke="#E00000" stroke-width="3"/>`
        : `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#E00000" stroke-width="3"/>`;
    const b = boxOf(r);
    return `${shape}<text x="${b.x + b.w + 6}" y="${b.y + 22}" font-family="Inter" font-size="22" font-weight="bold" fill="#E00000">${i + 1}</text>`;
  });
  return sharp(buf)
    .composite([{ input: svg(width, height, grid.join('') + marks.join('')) }])
    .png()
    .toBuffer();
}

/**
 * Resolves card 03's main screen. Returns the approved layer unless `inputs/card03.json`
 * holds a reviewed redaction of a capture whose redacted layer is committed.
 *
 * The raw capture is never written into the repository: it shows other people's names and
 * avatars. Only its sha256 and the redacted layer are kept.
 */
async function resolveCard03(capturePath) {
  const cfg = JSON.parse(readFileSync(CARD03, 'utf8'));
  const layerPath = join(here, cfg.layer);
  const report = { status: 'approved-layer', config: rel(CARD03) };

  if (capturePath) {
    const bytes = readFileSync(capturePath);
    const digest = sha(bytes);
    if (basename(capturePath) !== cfg.expectedFileName)
      console.log(
        `NOTE  capture is named ${basename(capturePath)}, expected ${cfg.expectedFileName}`,
      );
    if (cfg.captureSha256 && cfg.captureSha256 !== digest) {
      console.log('NOTE  a different capture than the one reviewed: redaction sign-off reset');
      cfg.reviewed = false;
      cfg.reviewedBy = null;
    }
    cfg.captureFileName = basename(capturePath);
    cfg.captureSha256 = digest;

    const scr = await cropCapture(capturePath, cfg.crop);
    cfg.captureSize = scr.sourceSize;
    if (Math.abs(scr.height / scr.width - 1876 / 945) > 0.01)
      console.log(
        `WARN  cropped screen is ${scr.width}x${scr.height} (aspect ${(scr.height / scr.width).toFixed(3)}), the approved layer is 1.985: check the crop`,
      );
    // Unredacted preview: outside the repository, for placing the boxes only.
    const privatePreview = join(tmpdir(), 'bingd-card03-UNREDACTED-preview.png');
    writeFileSync(privatePreview, await annotate(scr.buffer, cfg.redactions));
    const redacted = await redact(scr.buffer, cfg.redactions);
    mkdirSync(join(here, 'review'), { recursive: true });
    writeFileSync(
      join(here, 'review', 'card03-redaction-check.png'),
      await annotate(redacted, cfg.redactions),
    );
    if (!cfg.reviewed) {
      writeFileSync(CARD03, JSON.stringify(cfg, null, 2) + '\n');
      console.log(
        `\nSTOP  card 03 needs a redaction sign-off before it can be rendered.\n` +
          `      1. Open ${privatePreview} (unredacted, outside the repo; do not commit it).\n` +
          `      2. In ${rel(CARD03)}, make "redactions" cover every person's name and avatar on\n` +
          `         the visible screen (rows 0-${cfg.visibleRows}), using the grid. Titles, posters and scores stay.\n` +
          `      3. Re-run with --card03 and check ${rel(join(here, 'review', 'card03-redaction-check.png'))}.\n` +
          `      4. When nothing identifying is readable, set "reviewed": true and "reviewedBy", and re-run.\n`,
      );
      process.exit(3);
    }
    writeFileSync(layerPath, redacted);
    cfg.layerSha256 = sha(redacted);
    writeFileSync(CARD03, JSON.stringify(cfg, null, 2) + '\n');
  }

  if (cfg.reviewed && existsSync(layerPath)) {
    const digest = sha(readFileSync(layerPath));
    if (digest !== cfg.layerSha256)
      throw new Error(`${rel(layerPath)} does not match layerSha256 in ${rel(CARD03)}`);
    return { file: layerPath, report: { ...report, status: 'swapped', ...pick(cfg) } };
  }
  return { file: null, report: { ...report, missing: cfg.expectedFileName } };
}

const pick = (cfg) => ({
  capture: cfg.captureFileName,
  captureSha256: cfg.captureSha256,
  layer: cfg.layer,
  layerSha256: cfg.layerSha256,
  redactions: cfg.redactions.length,
  reviewedBy: cfg.reviewedBy,
});

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------

const results = [];
function check(ok, label) {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.error('\nStopping on the first failure.');
    process.exit(1);
  }
}

async function validateImage(buf, target) {
  const m = await sharp(buf).metadata();
  const problems = [];
  if (m.format !== 'png') problems.push(`format ${m.format}`);
  if (m.width !== target.w || m.height !== target.h) problems.push(`${m.width}x${m.height}`);
  if (m.channels !== 3 || m.hasAlpha)
    problems.push(`channels ${m.channels} alpha ${m.hasAlpha}`);
  if (m.depth !== 'uchar') problems.push(`depth ${m.depth}`);
  if (m.space !== 'srgb') problems.push(`space ${m.space}`);
  if (target.store === 'play') {
    const ratio = Math.max(m.width, m.height) / Math.min(m.width, m.height);
    if (ratio > 2) problems.push(`aspect ${ratio.toFixed(3)} > 2`);
    if (Math.min(m.width, m.height) < 320 || Math.max(m.width, m.height) > 3840)
      problems.push('side outside 320..3840');
    if (buf.length > 8 * 1024 * 1024) problems.push('over 8 MB');
  }
  if (target.store === 'apple' && buf.length > 10 * 1024 * 1024) problems.push('over 10 MB');
  return {
    problems,
    meta: { width: m.width, height: m.height, channels: m.channels, bytes: buf.length },
  };
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const card03Arg = argv.includes('--card03') ? argv[argv.indexOf('--card03') + 1] : null;
if (argv.includes('--card03') && !card03Arg) {
  console.error('usage: refresh.mjs [--card03 <path to Screenshot_20261119_160109_bingd.jpg>]');
  process.exit(2);
}

console.log('== 1. Sources');
const SOURCES = JSON.parse(readFileSync(join(here, 'sources', 'SOURCES.json'), 'utf8'));
const { lineup } = cardSpecs(join(here, 'sources'));
const used = new Set(
  lineup.flatMap((c) => [c.main.file, c.sec?.file].filter(Boolean).map((f) => rel(f))),
);
for (const f of used) {
  const key = relative(join(here, 'sources'), join(REPO, f));
  const expected = SOURCES.files[key]?.sha256;
  check(
    expected && sha(readFileSync(join(REPO, f))) === expected,
    `${key} matches SOURCES.json`,
  );
}

console.log('\n== 2. Approved lineup reproduces the Nov 11 final candidate');
const layoutFor = (spec) => (spec.position === 6 ? BALANCED : REVISION);
const baseline = {};
for (const target of TARGETS) {
  baseline[target.id] = [];
  for (const [i, spec] of lineup.entries()) {
    const out = await render(spec, layoutFor(spec), target);
    baseline[target.id].push(out);
    if (NOV11[target.id])
      check(
        sha(out.png) === NOV11[target.id][i],
        `${target.id} position ${spec.position} ${spec.id} = Nov 11 ${sha(out.png).slice(0, 12)}`,
      );
  }
}

console.log('\n== 3. Card 03 feed capture');
const card03 = await resolveCard03(card03Arg);
const final = Object.fromEntries(TARGETS.map((t) => [t.id, baseline[t.id].map((o) => o.png)]));
if (card03.file) {
  const spec = { ...lineup[2], main: { file: card03.file } };
  for (const target of TARGETS) {
    const out = await render(spec, layoutFor(spec), target);
    const rows = out.screenIndependentRows;
    const a = await sharp(out.png)
      .extract({ left: 0, top: 0, width: target.w, height: rows })
      .raw()
      .toBuffer();
    const b = await sharp(baseline[target.id][2].png)
      .extract({ left: 0, top: 0, width: target.w, height: rows })
      .raw()
      .toBuffer();
    check(a.equals(b), `${target.id} card 03: rows 0-${rows} (type, background) unchanged`);
    check(
      sha(out.png) !== sha(baseline[target.id][2].png),
      `${target.id} card 03: screen replaced`,
    );
    final[target.id][2] = out.png;
  }
} else {
  console.log(
    `PEND  card 03 keeps the approved feed capture: ${card03.report.missing} not supplied.\n` +
      `      Swap: node ${rel(join(here, 'refresh.mjs'))} --card03 <path>/${card03.report.missing}`,
  );
}

console.log('\n== 4. Outputs');
const manifest = {
  generated: 'store-assets/listings/2026-11-19-refresh/refresh.mjs',
  basis:
    'PR #245 v3 copy and upload order (head a2500485); position 6 balanced layout and typographic apostrophe per founder, 2026-11-11',
  card03: card03.report,
  card06: 'unchanged (approved For You capture); no stronger capture available',
  targets: {},
};
const checksums = {};
for (const target of TARGETS) {
  const dir = join(here, target.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  manifest.targets[target.id] = {
    slot: target.slot,
    width: target.w,
    height: target.h,
    cards: [],
  };
  for (const [i, spec] of lineup.entries()) {
    const png = final[target.id][i];
    const file = join(dir, `${STEMS[i]}.png`);
    writeFileSync(file, png);
    const v = await validateImage(png, target);
    check(
      v.problems.length === 0,
      `${target.id}/${STEMS[i]}.png ${v.problems.join(', ') || `${target.w}x${target.h} RGB8 no alpha ${(png.length / 1e6).toFixed(2)} MB`}`,
    );
    const digest = sha(png);
    checksums[rel(file)] = digest;
    manifest.targets[target.id].cards.push({
      position: spec.position,
      card: spec.id,
      file: rel(file),
      headline: spec.headline,
      subtitle: spec.subtitle,
      layout: layoutFor(spec).name,
      sha256: digest,
      bytes: png.length,
      changedFromNov11: NOV11[target.id] ? digest !== NOV11[target.id][i] : 'new size',
    });
  }
}

// Contact sheets: the six cards in upload order.
async function sheet(targetId, cardW, file, title) {
  const target = TARGETS.find((t) => t.id === targetId);
  const cardH = R((cardW * target.h) / target.w);
  const gap = 28;
  const top = 96;
  const foot = 70;
  const SW = gap + 6 * (cardW + gap);
  const SH = top + cardH + foot;
  const layers = [];
  for (const [i, spec] of lineup.entries()) {
    const left = gap + i * (cardW + gap);
    layers.push({
      input: await sharp(final[targetId][i]).resize({ width: cardW }).png().toBuffer(),
      left,
      top,
    });
    const changed = i === 2 && card03.file ? ' (new feed capture)' : '';
    layers.push({
      input: svg(
        cardW,
        foot,
        `<text x="${cardW / 2}" y="34" text-anchor="middle" font-family="Inter" font-size="22" fill="#F6D5DA">${spec.position}. ${spec.slot}${changed}</text>`,
      ),
      left,
      top: top + cardH,
    });
  }
  layers.push({
    input: svg(
      SW,
      top,
      `<text x="${gap}" y="58" font-family="Inter" font-size="30" fill="#FFFFFF">${title}</text>`,
    ),
    left: 0,
    top: 0,
  });
  const png = await sharp({
    create: { width: SW, height: SH, channels: 3, background: '#2A1218' },
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(file, png);
  console.log(`      ${rel(file)}`);
}
mkdirSync(join(here, 'review'), { recursive: true });
const c3 = card03.file ? 'card 03 swapped' : 'card 03 pending the new feed capture';
await sheet(
  'apple-1206x2622',
  360,
  join(here, 'review', 'contact-sheet.png'),
  `bingd App Store screenshots, upload order (1206 x 2622). ${c3}.`,
);
await sheet(
  'play-1080x1920',
  360,
  join(here, 'review', 'contact-sheet-play.png'),
  `bingd Google Play phone screenshots, upload order (1080 x 1920). ${c3}.`,
);

// Google Play feature graphic candidate: a centre crop of the brand banner master
// (store-assets/social/render.mjs), no restyle. The graphic wordmark keeps its period.
{
  const master = join(REPO, 'store-assets', 'social', 'social-banner-master.png');
  const m = await sharp(master).metadata();
  const fg = await sharp(master)
    .extract({
      left: R((m.width - 1024) / 2),
      top: R((m.height - 500) / 2),
      width: 1024,
      height: 500,
    })
    .flatten({ background: '#FBF8F4' })
    .removeAlpha()
    .toColourspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();
  const file = join(here, 'play-feature-graphic-1024x500.png');
  writeFileSync(file, fg);
  const fm = await sharp(fg).metadata();
  check(
    fm.width === 1024 && fm.height === 500 && fm.channels === 3 && fg.length < 15 * 1024 * 1024,
    `${rel(file)} 1024x500 RGB8 no alpha (centre crop of ${m.width}x${m.height} banner master)`,
  );
  checksums[rel(file)] = sha(fg);
  manifest.playFeatureGraphic = { file: rel(file), sha256: sha(fg), source: rel(master) };
}

writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(here, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n');
console.log(
  `      ${rel(join(here, 'manifest.json'))}\n      ${rel(join(here, 'checksums.json'))}`,
);
console.log(
  `\nDone: ${results.filter((r) => r.ok).length} checks passed. ${card03.file ? 'Card 03 swapped.' : 'Card 03 swap pending.'}`,
);
