#!/usr/bin/env node
/**
 * Renders the proposed 2026-11-09 revision of the App Store cards, and the
 * review sheets the founder approves them from.
 *
 *   node store-assets/listings/2026-11-09-revision/render.mjs
 *
 * Steps, each of which stops the run on failure:
 *   1. Every source in sources/ matches SOURCES.json (sha256 and bytes).
 *   2. Reproduction check: the approved layout, rendered by this code, matches the
 *      approved exports in ../2026-11-09/apple-1206x2622 to within 2 levels per
 *      channel, over the whole card.
 *   3. The proposed six cards → apple-1206x2622/, the ranking candidate → candidate/,
 *      the card 05 balanced-layout alternative → alternatives/.
 *   4. Review sheets → review/.
 *   5. QA → qa/qa-report.json (format, measured gaps and phone widths, unchanged
 *      screen content, secondary tab bars hidden).
 *
 * Nothing here uploads, publishes or touches the approved set.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BALANCED, LEGACY, REVISION, cardSpecs, renderCard } from './cards.mjs';
import { H, W, sha256, sharp } from './lib.mjs';
import { measureCard, measureFrameWidth } from './measure.mjs';
import { beforeAfter, bottomEdges, browseSheet, card02Large, contactSheet } from './review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'sources');
const APPROVED = join(here, '..', '2026-11-09', 'apple-1206x2622');
const OUT = join(here, 'apple-1206x2622');
const CANDIDATE = join(here, 'candidate');
const REVIEW = join(here, 'review');
const ALTERNATIVES = join(here, 'alternatives');
const QA = join(here, 'qa');
for (const d of [OUT, CANDIDATE, ALTERNATIVES, REVIEW, join(REVIEW, 'before-after'), QA])
  await mkdir(d, { recursive: true });

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);

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
  ...specs.lineup.filter((c) => c.id !== '02-head-to-head'),
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
step('3. proposed cards');
const rendered = {};
const checksums = {};
const ALT_ID = '05-your-year_ALT-balanced';
const jobs = [
  ...specs.lineup.map((spec) => ({
    spec,
    layout: REVISION,
    dir: 'apple-1206x2622',
    id: spec.id,
  })),
  { spec: specs.candidate, layout: REVISION, dir: 'candidate', id: specs.candidate.id },
  { spec: specs.lineup[4], layout: BALANCED, dir: 'alternatives', id: ALT_ID },
];
for (const { spec, layout, dir, id } of jobs) {
  const { png, geo } = await renderCard(spec, layout);
  await writeFile(join(here, dir, `${id}.png`), png);
  rendered[id] = { png, geo, spec, layout };
  checksums[`${dir}/${id}.png`] = { sha256: sha256(png), bytes: png.length };
  console.log(`      ${dir}/${id}.png  ${Math.round(png.length / 1024)} KB`);
}
await writeFile(
  join(here, 'checksums.json'),
  `${JSON.stringify({ files: checksums }, null, 2)}\n`,
);

// Measurements, from pixels, for the approved and proposed cards.
const lineupIds = specs.lineup.map((c) => c.id);
const approvedPng = Object.fromEntries(
  await Promise.all(
    lineupIds.map(async (id) => [id, await readFile(join(APPROVED, `${id}.png`))]),
  ),
);
/** Main phone measured above the secondary phone; secondary measured over its own rows. */
async function widths(png, geo) {
  const primary = await measureFrameWidth(png, [900, 1400], [0, W]);
  if (!geo.secTop) return { primary: primary.width };
  const secondary = await measureFrameWidth(
    png,
    [geo.secTop + 150, Math.min(geo.secBottom, H) - 80],
    [300, W],
  );
  return {
    primary: primary.width,
    secondary: secondary.width,
    ratio: +(secondary.width / primary.width).toFixed(3),
  };
}
const measures = {};
for (const id of Object.keys(rendered)) {
  const approvedId = rendered[id].spec.id;
  const before =
    approvedPng[approvedId] && id !== specs.candidate.id ? approvedPng[approvedId] : null;
  measures[id] = {
    before: before ? await measureCard(before) : null,
    after: await measureCard(rendered[id].png),
    widthsBefore: before
      ? await widths(before, approvedId === '02-head-to-head' ? {} : legacyGeo[approvedId])
      : null,
    widthsAfter: await widths(rendered[id].png, rendered[id].geo),
  };
}

// 4 -------------------------------------------------------------------------
step('4. review sheets');
const cand = rendered[specs.candidate.id].png;
const alt = rendered[ALT_ID].png;
const NAMES = {
  '01-movies-tv': 'Movies + TV',
  '02-head-to-head': 'Head to head',
  '03-friends': 'Friends',
  '04-watchlist': 'Watchlist',
  '05-your-year': 'Your year',
  '06-for-you': 'For you',
};
const pct = (r) => `${Math.round(r * 100)}%`;
function note(id) {
  const { widthsBefore: b, widthsAfter: a } = measures[id];
  const type = 'No eyebrow, type 112 px lower, main phone as approved.';
  if (id === '02-head-to-head') return `${type} No result phone.`;
  if (!a.secondary) return type;
  return `${type} Secondary ${b.secondary} → ${a.secondary} px (${pct(b.ratio)} → ${pct(a.ratio)}), tab bar off-card.`;
}
const sheets = {
  'contact-sheet.png': await contactSheet(
    lineupIds.map((id, i) => ({ png: rendered[id].png, label: `${i + 1}. ${NAMES[id]}` })),
    'bingd App Store cards, proposed revision v2 (store order). Not uploaded.',
  ),
  'contact-sheet-with-candidate.png': await contactSheet(
    [
      ...lineupIds.map((id, i) => ({ png: rendered[id].png, label: `${i + 1}. ${NAMES[id]}` })),
      { png: cand, label: 'CANDIDATE: Ranked', flag: true, note: 'not in the six-card lineup' },
    ],
    'Proposed six + the ranking-payoff candidate (for decision only)',
  ),
  'alternative-05-balanced.png': await contactSheet(
    [
      { png: approvedPng['05-your-year'], label: 'Approved (PR #240)' },
      {
        png: rendered['05-your-year'].png,
        label: 'Proposed v2',
        note: 'secondary 60% of main',
      },
      {
        png: alt,
        label: 'ALTERNATIVE: balanced',
        flag: true,
        note: 'main 960, secondary 624 (65%)',
      },
    ],
    'Card 05: optional balanced layout (Award names stay readable with a 65% secondary)',
  ),
  'browse-size-preview.png': await browseSheet([
    {
      title: 'Proposed v2: first three, as an App Store search result (250 px wide)',
      items: lineupIds.slice(0, 3).map((id) => rendered[id].png),
      flag: true,
    },
    {
      title: 'Approved (PR #240) for comparison',
      items: lineupIds.slice(0, 3).map((id) => approvedPng[id]),
    },
    {
      title: 'Proposed v2: cards 4 to 6',
      items: lineupIds.slice(3).map((id) => rendered[id].png),
      flag: true,
    },
    { title: 'Approved: cards 4 to 6', items: lineupIds.slice(3).map((id) => approvedPng[id]) },
    {
      title: 'Card 05 alternative (balanced) and the ranking candidate',
      items: [rendered['05-your-year'].png, alt, cand],
      flag: true,
    },
  ]),
  'bottom-edges.png': await bottomEdges(
    [...lineupIds, ALT_ID, specs.candidate.id].map((id) => ({
      png: rendered[id].png,
      label: id,
    })),
  ),
  'card02-large.png': await card02Large(rendered['02-head-to-head'].png),
};
for (const id of lineupIds) {
  sheets[`before-after/${id}.png`] = await beforeAfter({
    id,
    before: approvedPng[id],
    after: rendered[id].png,
    mBefore: measures[id].before,
    mAfter: measures[id].after,
    note: note(id),
  });
}
for (const [name, png] of Object.entries(sheets)) {
  await writeFile(join(REVIEW, name), png);
  console.log(`      review/${name}`);
}

// 5 -------------------------------------------------------------------------
step('5. QA');
const qa = { reproduction: repro, cards: [] };
let failed = 0;
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
for (const [id, { png, geo, spec, layout }] of Object.entries(rendered)) {
  const meta = await sharp(png).metadata();
  const m = measures[id];
  const reduction = m.before ? (m.before.gap - m.after.gap) / m.before.gap : null;
  const checks = {
    format:
      meta.format === 'png' &&
      meta.width === W &&
      meta.height === H &&
      meta.channels === 3 &&
      !meta.hasAlpha &&
      meta.space === 'srgb',
    gapReduced45to55: reduction === null ? null : reduction >= 0.45 && reduction <= 0.55,
    secondaryWidth60to70: m.widthsAfter.ratio
      ? m.widthsAfter.ratio >= 0.6 && m.widthsAfter.ratio <= 0.7
      : null,
    secondaryTabBarBelowEdge: geo.secTop ? geo.secScreenBottom - H >= geo.secTabBarPx : null,
  };
  const card = {
    id,
    layout: layout.name,
    width: meta.width,
    height: meta.height,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    space: meta.space,
    bytes: png.length,
    gap: {
      before: m.before?.gap ?? null,
      after: m.after.gap,
      reduction: reduction && +reduction.toFixed(3),
    },
    widths: { before: m.widthsBefore, after: m.widthsAfter },
    measured: { before: m.before, after: m.after },
    geometry: geo,
    checks,
  };
  if (spec.main.rawCapture) card.chromeCrop = geo.mainCrop;
  if (layout === REVISION && approvedPng[id]) {
    // The main phone is where the approved card put it: compare the screen left of both
    // secondary phones and their shadows (or the whole screen when there is none).
    const M = LEGACY.main;
    const right =
      id === '02-head-to-head'
        ? 540
        : geo.secX
          ? Math.min(geo.secX, LEGACY.sec.x) - 70
          : M.x + M.w - M.bezel - 4;
    card.mainScreenUnchanged = await regionDiff(
      png,
      approvedPng[id],
      [M.x + M.bezel + 4, right],
      [M.y + 140, H],
    );
    checks.mainScreenIdenticalToApproved = card.mainScreenUnchanged.max <= 2;
    if (geo.secTop) {
      card.secondaryContentVsApproved = await secondaryContentDiff(id);
      checks.secondaryContentMatchesApproved = card.secondaryContentVsApproved.mean <= 4;
    }
  }
  const bad = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  failed += bad.length ? 1 : 0;
  qa.cards.push(card);
  const g = m.before ? `gap ${m.before.gap} → ${m.after.gap} px` : `gap ${m.after.gap} px`;
  const wd = m.widthsAfter.secondary
    ? `  widths ${m.widthsAfter.primary}/${m.widthsAfter.secondary} = ${pct(m.widthsAfter.ratio)}`
    : `  width ${m.widthsAfter.primary}`;
  console.log(
    `${bad.length ? 'FAIL' : 'PASS'}  ${id}  ${meta.width}x${meta.height} ch=${meta.channels} alpha=${meta.hasAlpha}  ${g}${wd}${bad.length ? `  [${bad.join(', ')}]` : ''}`,
  );
}
await writeFile(join(QA, 'qa-report.json'), `${JSON.stringify(qa, null, 2)}\n`);
if (failed) fail(`${failed} card(s) failed QA, see qa/qa-report.json`);
console.log(
  '\nDone. Cards in apple-1206x2622/, candidate/ and alternatives/, sheets in review/, report in qa/qa-report.json',
);
