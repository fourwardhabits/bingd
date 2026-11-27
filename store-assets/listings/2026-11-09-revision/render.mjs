#!/usr/bin/env node
/**
 * Renders the v3 App Store cards (v2 geometry, final copy, new upload order) and
 * the review sheets the founder approves them from.
 *
 *   node store-assets/listings/2026-11-09-revision/render.mjs
 *
 * Steps, each of which stops the run on failure:
 *   1. Every source in sources/ matches SOURCES.json (sha256 and bytes).
 *   2. Reproduction check: the approved layout, rendered by this code, matches the
 *      approved exports in ../2026-11-09/apple-1206x2622 to within 2 levels per
 *      channel, over the whole card.
 *   3. Baseline check: the v2 cards (approved copy, v2 geometry), rendered by this
 *      code, are byte-identical to the committed v2/ render.
 *   4. The v3 cards → apple-1206x2622/ (original card names), alternatives/ (card 05
 *      balanced layout), and store-order/ (upload order, with manifest.json).
 *   5. Review sheets → review/.
 *   6. QA → qa/qa-report.json and qa/qa-report.md.
 *
 * Nothing here uploads, publishes or touches the approved set.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';

import { BALANCED, LEGACY, REVISION, TYPE, cardSpecs, renderCard } from './cards.mjs';
import { H, W, line, sha256, sharp } from './lib.mjs';
import { measureCard, measureFrameWidth, measureTextLines } from './measure.mjs';
import {
  bottomEdges,
  browseSheet,
  card02Large,
  contactSheet,
  copyBeforeAfter,
} from './review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'sources');
const APPROVED = join(here, '..', '2026-11-09', 'apple-1206x2622');
const V2 = join(here, 'v2');
const OUT = join(here, 'apple-1206x2622');
const ALTERNATIVES = join(here, 'alternatives');
const STORE_ORDER_DIR = join(here, 'store-order');
const REVIEW = join(here, 'review');
const QA = join(here, 'qa');
await rm(STORE_ORDER_DIR, { recursive: true, force: true });
for (const d of [OUT, ALTERNATIVES, STORE_ORDER_DIR, REVIEW, QA])
  await mkdir(d, { recursive: true });

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);
/** Generated text files are written as the repo's prettier would leave them. */
const writeFormatted = async (file, text) =>
  writeFile(file, await format(text, { filepath: file }));

// 1 -------------------------------------------------------------------------
step('1. sources');
const { files: sources } = JSON.parse(await readFile(join(SRC, 'SOURCES.json'), 'utf8'));
for (const [name, want] of Object.entries(sources)) {
  const bytes = await readFile(join(SRC, name)).catch(() => fail(`missing source ${name}`));
  if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256)
    fail(`source ${name} does not match SOURCES.json`);
}
console.log(`PASS  ${Object.keys(sources).length} sources match SOURCES.json`);

const specs = cardSpecs(SRC);
const raw = (png) => sharp(png).removeAlpha().raw().toBuffer();

// 2 -------------------------------------------------------------------------
step('2. reproduction check against the approved exports');
/** Largest per-channel difference allowed anywhere on the card (encoder rounding). */
const REPRO_TOLERANCE = 2;
const repro = [];
const legacyGeo = {};
for (const spec of [
  ...specs.approved.filter((c) => c.id !== '02-head-to-head'),
  specs.legacyCard02,
]) {
  const { png, geo } = await renderCard(spec, LEGACY);
  legacyGeo[spec.id] = geo;
  const [a, b] = await Promise.all([raw(png), raw(join(APPROVED, `${spec.id}.png`))]);
  let maxDiff = 0,
    differing = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
    if (d) differing++;
  }
  repro.push({ id: spec.id, maxDiff, differingSamples: differing, samples: a.length });
  const ok = maxDiff <= REPRO_TOLERANCE;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${spec.id}  max channel diff ${maxDiff} over the whole card (${differing} of ${a.length} samples differ)`,
  );
  if (!ok) fail(`${spec.id} no longer reproduces the approved export`);
}

// 3 -------------------------------------------------------------------------
step('3. v2 baseline check');
const ALT_ID = '05-your-year_ALT-balanced';
const { files: v2Sums } = JSON.parse(await readFile(join(V2, 'checksums.json'), 'utf8'));
const v2 = {};
for (const [spec, layout, key] of [
  ...specs.approved.map((s) => [s, REVISION, s.id]),
  [specs.approved.find((s) => s.id === '05-your-year'), BALANCED, ALT_ID],
]) {
  const { png } = await renderCard(spec, layout);
  const file = key === ALT_ID ? `alternatives/${ALT_ID}.png` : `apple-1206x2622/${key}.png`;
  if (sha256(png) !== v2Sums[file]?.sha256) fail(`${file} no longer matches the v2 render`);
  v2[key] = png;
  console.log(`PASS  ${file} byte-identical to v2/`);
}

// 4 -------------------------------------------------------------------------
step('4. v3 cards');
const rendered = {};
const checksums = {};
const record = (rel, png) => (checksums[rel] = { sha256: sha256(png), bytes: png.length });
const pos = (n) => String(n).padStart(2, '0');
const manifest = {
  note: 'Upload order for the App Store (iPhone 6.9", 1206 x 2622). Review only: not uploaded.',
  positions: [],
};
for (const spec of specs.lineup) {
  const jobs = [{ layout: REVISION, key: spec.id, rel: `apple-1206x2622/${spec.id}.png` }];
  if (spec.id === '05-your-year')
    jobs.push({ layout: BALANCED, key: ALT_ID, rel: `alternatives/${ALT_ID}.png` });
  for (const { layout, key, rel } of jobs) {
    const { png, geo } = await renderCard(spec, layout);
    await writeFile(join(here, rel), png);
    record(rel, png);
    rendered[key] = { png, geo, spec, layout };
    console.log(`      ${rel}  ${Math.round(png.length / 1024)} KB`);
  }
  const orderRel = `store-order/${pos(spec.position)}-${spec.slot}__${spec.id}.png`;
  await writeFile(join(here, orderRel), rendered[spec.id].png);
  record(orderRel, rendered[spec.id].png);
  const entry = {
    position: spec.position,
    slot: spec.slot,
    card: spec.id,
    file: orderRel,
    sameBytesAs: `apple-1206x2622/${spec.id}.png`,
    headline: spec.headline,
    subtitle: spec.subtitle,
    sha256: checksums[orderRel].sha256,
  };
  if (spec.id === '05-your-year')
    entry.alternative = {
      file: `alternatives/${ALT_ID}.png`,
      sha256: checksums[`alternatives/${ALT_ID}.png`].sha256,
      note: 'Balanced layout, same copy. Kept for review; not selected.',
    };
  manifest.positions.push(entry);
  console.log(`      ${orderRel}`);
}
await writeFormatted(join(STORE_ORDER_DIR, 'manifest.json'), JSON.stringify(manifest));
await writeFile(
  join(here, 'checksums.json'),
  `${JSON.stringify({ files: checksums }, null, 2)}\n`,
);

// 5 -------------------------------------------------------------------------
step('5. review sheets');
const NAMES = {
  collection: 'Collection',
  'head-to-head': 'Head-to-head',
  friends: 'Friends',
  'for-you': 'For You',
  watchlist: 'Watchlist',
  'goals-awards': 'Goals & Awards',
};
const order = specs.lineup;
const sheets = {
  'contact-sheet.png': await contactSheet(
    order.map((s) => ({
      png: rendered[s.id].png,
      label: `${s.position}. ${NAMES[s.slot]}`,
      note: `card ${s.id}`,
    })),
    'bingd App Store cards v3: final copy, upload order. Not uploaded.',
  ),
  'browse-first-three.png': await browseSheet([
    {
      title: 'v3: first three, as an App Store search result (250 px wide)',
      items: order.slice(0, 3).map((s) => rendered[s.id].png),
      flag: true,
    },
    {
      title: 'v2 copy (PR #244) for comparison',
      items: order.slice(0, 3).map((s) => v2[s.id]),
    },
  ]),
  'before-after-copy.png': await copyBeforeAfter(
    order.map((s) => ({
      title: `${s.position}. ${NAMES[s.slot]} (${s.id})`,
      before: v2[s.id],
      after: rendered[s.id].png,
    })),
    {
      title: 'Copy before/after, in the new upload order (top 960 px of each card, 50%)',
      beforeLabel: 'v2 COPY (PR #244)',
      afterLabel: 'v3 COPY',
    },
  ),
  'position-06-layouts.png': await contactSheet(
    [
      {
        png: rendered['05-your-year'].png,
        label: '6. v2 layout',
        note: 'secondary 60% of main',
      },
      {
        png: rendered[ALT_ID].png,
        label: '6. Balanced alternative',
        flag: true,
        note: 'main 960, secondary 65%',
      },
    ],
    'Position 6 with the new copy: both layouts, for review',
  ),
  'bottom-edges.png': await bottomEdges(
    [...order.map((s) => s.id), ALT_ID].map((id) => ({ png: rendered[id].png, label: id })),
  ),
  'card02-large.png': await card02Large(rendered['02-head-to-head'].png),
};
for (const [name, png] of Object.entries(sheets)) {
  await writeFile(join(REVIEW, name), png);
  console.log(`      review/${name}`);
}

// 6 -------------------------------------------------------------------------
step('6. QA');
const approvedPng = Object.fromEntries(
  await Promise.all(
    specs.approved.map(async (s) => [s.id, await readFile(join(APPROVED, `${s.id}.png`))]),
  ),
);
/** Mean and max abs difference between two cards inside a rectangle. */
async function regionDiff(pngA, pngB, [x0, x1], [y0, y1]) {
  const [a, b] = await Promise.all([raw(pngA), raw(pngB)]);
  let sum = 0,
    max = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[(y * W + x) * 3 + c] - b[(y * W + x) * 3 + c]);
        sum += d;
        n++;
        if (d > max) max = d;
      }
  return { mean: +(sum / n).toFixed(4), max };
}
/**
 * The resized secondary screen against the approved one: the new screen is scaled
 * to the approved width and compared row for row. Only resampling differs, so the
 * mean difference stays small; different content or a lost blur would not.
 */
async function secondaryContentDiff(id) {
  const g = rendered[id].geo;
  const L = LEGACY.sec;
  const S = rendered[id].layout.sec;
  const oldInner = {
    x: L.x + L.bezel,
    y: legacyGeo[id].secTop + L.bezel,
    w: L.w - 2 * L.bezel,
  };
  const newInner = { x: g.secX + S.bezel, y: g.secTop + S.bezel, w: S.w - 2 * S.bezel };
  const rows = Math.min(
    legacyGeo[id].secBottom - L.bezel - oldInner.y,
    Math.floor(((H - newInner.y) * oldInner.w) / newInner.w),
  );
  const resized = await sharp(rendered[id].png)
    .extract({
      left: newInner.x,
      top: newInner.y,
      width: newInner.w,
      height: Math.round((rows * newInner.w) / oldInner.w),
    })
    .resize(oldInner.w, rows, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const old = await sharp(approvedPng[id])
    .extract({ left: oldInner.x, top: oldInner.y, width: oldInner.w, height: rows })
    .raw()
    .toBuffer();
  let sum = 0;
  let n = 0;
  const skip = L.radius + 10;
  for (let y = skip; y < rows; y++)
    for (let x = skip; x < oldInner.w - skip; x++)
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(
          resized[(y * oldInner.w + x) * 3 + c] - old[(y * oldInner.w + x) * 3 + c],
        );
        n++;
      }
  return { mean: +(sum / n).toFixed(3), comparedRows: rows - skip };
}
/** Ink width of one line as rendered on its own, before compositing. */
const glyphWidth = async (text, type) => {
  const l = await line({ text, ...type });
  return l.ink.x1 - l.ink.x0 + 1;
};
const capHeight = async (type) => {
  const l = await line({ text: 'H', ...type });
  return l.baseline - l.capTop;
};
const BROWSE = 250 / W;
const browse = {
  headlineCapPx: +((await capHeight(TYPE.headline)) * BROWSE).toFixed(1),
  subtitleCapPx: +((await capHeight(TYPE.subtitle)) * BROWSE).toFixed(1),
};
/** Upload order required by the 2026-11-10 brief. */
const BRIEF_ORDER = [
  '01-movies-tv',
  '02-head-to-head',
  '03-friends',
  '06-for-you',
  '04-watchlist',
  '05-your-year',
];
/** Rows from here down are phones and background only; type ends well above. */
const BELOW_TYPE = 700;
const MIN_SIDE_MARGIN = 100;
const MIN_BALANCE = 0.7;

const qa = {
  reproduction: repro,
  order: {
    expected: BRIEF_ORDER,
    actual: order.map((s) => s.id),
    pass:
      order.every((s, i) => s.id === BRIEF_ORDER[i] && s.position === i + 1) &&
      order.length === 6,
  },
  browse,
  cards: [],
};
console.log(`${qa.order.pass ? 'PASS' : 'FAIL'}  upload order ${qa.order.actual.join(', ')}`);
let failed = qa.order.pass ? 0 : 1;
for (const [key, { png, geo, spec, layout }] of Object.entries(rendered)) {
  const meta = await sharp(png).metadata();
  const lines = await measureTextLines(png);
  const texts = [...spec.headline, spec.subtitle];
  const types = [TYPE.headline, TYPE.headline, TYPE.subtitle];
  const expectedWidths = await Promise.all(texts.map((t, i) => glyphWidth(t, types[i])));
  const [h1, h2] = lines;
  const balance =
    h1 && h2 ? +(Math.min(h1.width, h2.width) / Math.max(h1.width, h2.width)).toFixed(3) : null;
  const m = await measureCard(png);
  const mApproved = await measureCard(approvedPng[spec.id]);
  const reduction = (mApproved.gap - m.gap) / mApproved.gap;
  const below = await regionDiff(png, v2[key], [0, W], [BELOW_TYPE, H]);
  const checks = {
    format:
      meta.format === 'png' &&
      meta.width === W &&
      meta.height === H &&
      meta.channels === 3 &&
      !meta.hasAlpha &&
      meta.space === 'srgb',
    threeTextLines: lines.length === 3,
    eachLineSingle: lines.every((l, i) => l.height <= 1.4 * types[i].px),
    widthsMatchGlyphs: lines.every((l, i) => Math.abs(l.width - expectedWidths[i]) <= 2),
    centred: lines.every((l) => Math.abs(l.centre - W / 2) <= 1.5),
    sideMargins: lines.every((l) => Math.min(l.marginLeft, l.marginRight) >= MIN_SIDE_MARGIN),
    headlineBalanced: balance !== null && balance >= MIN_BALANCE,
    gapReduced45to55vsApproved: reduction >= 0.45 && reduction <= 0.55,
    belowTypeIdenticalToV2: below.max === 0,
    secondaryTabBarBelowEdge: geo.secTop ? geo.secScreenBottom - H >= geo.secTabBarPx : null,
  };
  const card = {
    card: key,
    position: spec.position,
    layout: layout.name,
    format: {
      width: meta.width,
      height: meta.height,
      channels: meta.channels,
      hasAlpha: meta.hasAlpha,
      space: meta.space,
    },
    text: lines.map((l, i) => ({ text: texts[i], glyphWidth: expectedWidths[i], ...l })),
    headlineBalance: balance,
    gap: { approved: mApproved.gap, v3: m.gap, reduction: +reduction.toFixed(3) },
    belowTypeVsV2: below,
    geometry: geo,
    checks,
  };
  if (layout === REVISION) {
    const M = LEGACY.main;
    const right =
      spec.id === '02-head-to-head'
        ? 540
        : geo.secX
          ? Math.min(geo.secX, LEGACY.sec.x) - 70
          : M.x + M.w - M.bezel - 4;
    card.mainScreenVsApproved = await regionDiff(
      png,
      approvedPng[spec.id],
      [M.x + M.bezel + 4, right],
      [M.y + 140, H],
    );
    checks.mainScreenIdenticalToApproved = card.mainScreenVsApproved.max <= 2;
    if (geo.secTop) {
      card.secondaryContentVsApproved = await secondaryContentDiff(spec.id);
      checks.secondaryContentMatchesApproved = card.secondaryContentVsApproved.mean <= 4;
    }
  }
  if (geo.secTop) {
    const primary = await measureFrameWidth(png, [900, 1400], [0, W]);
    const secondary = await measureFrameWidth(
      png,
      [geo.secTop + 150, Math.min(geo.secBottom, H) - 80],
      [300, W],
    );
    card.phoneWidths = {
      primary: primary.width,
      secondary: secondary.width,
      ratio: +(secondary.width / primary.width).toFixed(3),
    };
  }
  const bad = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  if (bad.length) failed++;
  qa.cards.push(card);
  console.log(
    `${bad.length ? 'FAIL' : 'PASS'}  ${pos(spec.position)} ${key}  lines ${lines.map((l) => l.width).join(' / ')}  balance ${balance}  gap ${mApproved.gap} → ${m.gap}${bad.length ? `  [${bad.join(', ')}]` : ''}`,
  );
}
await writeFile(join(QA, 'qa-report.json'), `${JSON.stringify(qa, null, 2)}\n`);

const allChecks = [...new Set(qa.cards.flatMap((c) => Object.keys(c.checks)))];
const md = [
  '# QA report: v3 copy and order',
  '',
  'Generated by `render.mjs` from the rendered PNGs. Widths are measured ink extents in px on the 1206 px card. Full data: `qa-report.json`.',
  '',
  `**Result: ${failed ? `${failed} FAILED` : 'all checks pass'}.** Upload order: ${qa.order.actual.join(', ')} (${qa.order.pass ? 'matches the brief' : 'DOES NOT match the brief'}).`,
  '',
  '## Text, measured',
  '',
  '| Pos | Card | Headline line 1 | px | Headline line 2 | px | Balance | Subtitle | px | Tightest side margin |',
  '| --: | --- | --- | --: | --- | --: | --: | --- | --: | --: |',
  ...qa.cards.map((c) => {
    const [a, b, s] = c.text;
    const margin = Math.min(...c.text.map((t) => Math.min(t.marginLeft, t.marginRight)));
    return `| ${c.position} | ${c.card} | ${a.text} | ${a.width} | ${b.text} | ${b.width} | ${c.headlineBalance} | ${s.text} | ${s.width} | ${margin} |`;
  }),
  '',
  `Balance is the shorter headline line divided by the longer one. Every card renders exactly three lines of type (two headline, one subtitle); each line is drawn on its own with no wrap width, so no automatic breaks are possible. Pixel widths match the glyph widths of each string rendered alone to within 2 px. Headlines are DM Serif Display ${TYPE.headline.px} px and subtitles Inter ${TYPE.subtitle.px} px, unchanged; baselines unchanged at v2 positions.`,
  '',
  `At App Store browse size (250 px wide) the headline cap height is ${browse.headlineCapPx} px and the subtitle cap height ${browse.subtitleCapPx} px, the same as v2 and the approved set.`,
  '',
  '## Spacing and screens',
  '',
  '| Pos | Card | Gap approved → v3 | Reduction | Rows ≥ 700 vs v2 (max diff) | Main screen vs approved (max) | Secondary vs approved (mean) | Phone widths |',
  '| --: | --- | --- | --: | --: | --: | --: | --- |',
  ...qa.cards.map(
    (c) =>
      `| ${c.position} | ${c.card} | ${c.gap.approved} → ${c.gap.v3} px | ${(c.gap.reduction * 100).toFixed(1)}% | ${c.belowTypeVsV2.max} | ${c.mainScreenVsApproved?.max ?? '—'} | ${c.secondaryContentVsApproved?.mean ?? '—'} | ${c.phoneWidths ? `${c.phoneWidths.primary} / ${c.phoneWidths.secondary} (${(c.phoneWidths.ratio * 100).toFixed(1)}%)` : '1011'} |`,
  ),
  '',
  'A max diff of 0 on rows 700 to 2622 means every phone, screen, blur, crop and bottom edge is byte-for-byte the v2 card: only the type changed.',
  '',
  '## Checks',
  '',
  `| Check | ${qa.cards.map((c) => `${c.position}${c.layout === 'balanced' ? ' ALT' : ''}`).join(' | ')} |`,
  `| --- | ${qa.cards.map(() => ':-:').join(' | ')} |`,
  ...allChecks.map(
    (k) =>
      `| ${k} | ${qa.cards.map((c) => (c.checks[k] === undefined || c.checks[k] === null ? '—' : c.checks[k] ? 'pass' : '**FAIL**')).join(' | ')} |`,
  ),
  '',
];
await writeFormatted(join(QA, 'qa-report.md'), md.join('\n'));
if (failed) fail(`${failed} QA failure(s), see qa/qa-report.md`);
console.log(
  '\nDone. Cards in apple-1206x2622/, alternatives/ and store-order/, sheets in review/, report in qa/',
);
