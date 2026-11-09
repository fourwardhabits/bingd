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
 *   3. The proposed six cards → apple-1206x2622/, the ranking candidate → candidate/.
 *   4. Review sheets → review/.
 *   5. QA → qa/qa-report.json (format, measured gaps, unchanged screen content).
 *
 * Nothing here uploads, publishes or touches the approved set.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY, REVISION, cardSpecs, renderCard } from './cards.mjs';
import { H, W, sha256, sharp } from './lib.mjs';
import { measureCard } from './measure.mjs';
import { beforeAfter, browseSheet, card02Large, contactSheet } from './review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'sources');
const APPROVED = join(here, '..', '2026-11-09', 'apple-1206x2622');
const OUT = join(here, 'apple-1206x2622');
const CANDIDATE = join(here, 'candidate');
const REVIEW = join(here, 'review');
const QA = join(here, 'qa');
for (const d of [OUT, CANDIDATE, REVIEW, join(REVIEW, 'before-after'), QA])
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
for (const spec of [
  ...specs.lineup.filter((c) => c.id !== '02-head-to-head'),
  specs.legacyCard02,
]) {
  const { png } = await renderCard(spec, LEGACY);
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
for (const spec of [...specs.lineup, specs.candidate]) {
  const { png, geo } = await renderCard(spec, REVISION);
  const dir = spec === specs.candidate ? CANDIDATE : OUT;
  await writeFile(join(dir, `${spec.id}.png`), png);
  rendered[spec.id] = { png, geo, spec };
  checksums[`${spec === specs.candidate ? 'candidate' : 'apple-1206x2622'}/${spec.id}.png`] = {
    sha256: sha256(png),
    bytes: png.length,
  };
  console.log(`      ${spec.id}.png  ${Math.round(png.length / 1024)} KB`);
}
await writeFile(
  join(here, 'checksums.json'),
  `${JSON.stringify({ files: checksums }, null, 2)}\n`,
);

// 4 -------------------------------------------------------------------------
step('4. review sheets');
const lineupIds = specs.lineup.map((c) => c.id);
const approvedPng = Object.fromEntries(
  await Promise.all(
    lineupIds.map(async (id) => [id, await readFile(join(APPROVED, `${id}.png`))]),
  ),
);
const cand = rendered[specs.candidate.id].png;
const NAMES = {
  '01-movies-tv': 'Movies + TV',
  '02-head-to-head': 'Head to head',
  '03-friends': 'Friends',
  '04-watchlist': 'Watchlist',
  '05-your-year': 'Your year',
  '06-for-you': 'For you',
};

const sheets = {
  'contact-sheet.png': await contactSheet(
    lineupIds.map((id, i) => ({ png: rendered[id].png, label: `${i + 1}. ${NAMES[id]}` })),
    'bingd App Store cards, proposed revision (store order). Not uploaded.',
  ),
  'contact-sheet-with-candidate.png': await contactSheet(
    [
      ...lineupIds.map((id, i) => ({ png: rendered[id].png, label: `${i + 1}. ${NAMES[id]}` })),
      { png: cand, label: 'CANDIDATE: Ranked', flag: true, note: 'not in the six-card lineup' },
    ],
    'Proposed six + the ranking-payoff candidate (for decision only)',
  ),
  'browse-size-preview.png': await browseSheet([
    {
      title: 'Proposed: first three, as an App Store search result (250 px wide)',
      items: lineupIds.slice(0, 3).map((id) => rendered[id].png),
      flag: true,
    },
    {
      title: 'Approved (PR #240) for comparison',
      items: lineupIds.slice(0, 3).map((id) => approvedPng[id]),
    },
    {
      title: 'Proposed: cards 4 to 6',
      items: lineupIds.slice(3).map((id) => rendered[id].png),
      flag: true,
    },
    { title: 'Approved: cards 4 to 6', items: lineupIds.slice(3).map((id) => approvedPng[id]) },
    {
      title: 'Candidate next to the cards it overlaps with (01 and 02)',
      items: [rendered['01-movies-tv'].png, rendered['02-head-to-head'].png, cand],
      flag: true,
    },
  ]),
  'card02-large.png': await card02Large(rendered['02-head-to-head'].png),
};
const measures = {};
const NOTES = {
  '01-movies-tv':
    'Eyebrow removed. Both phones up 121 px; the main phone now ends on its own tab bar.',
  '02-head-to-head':
    'Result phone removed. One phone: the real You Can See Everything vs Inception comparison.',
  '03-friends': 'Eyebrow removed. Both phones up 121 px. Witcher comments phone unchanged.',
  '04-watchlist': 'Eyebrow removed. Both phones up 121 px.',
  '05-your-year':
    'Eyebrow removed. Both phones up 121 px; the Awards sheet now shows its own Done footer.',
  '06-for-you': 'Eyebrow removed. Phone up 121 px; the main phone now ends on its own tab bar.',
};
for (const id of lineupIds) {
  measures[id] = {
    before: await measureCard(approvedPng[id]),
    after: await measureCard(rendered[id].png),
  };
  sheets[`before-after/${id}.png`] = await beforeAfter({
    id,
    before: approvedPng[id],
    after: rendered[id].png,
    mBefore: measures[id].before,
    mAfter: measures[id].after,
    note: NOTES[id],
  });
}
measures[specs.candidate.id] = { before: null, after: await measureCard(cand) };
for (const [name, png] of Object.entries(sheets)) {
  await writeFile(join(REVIEW, name), png);
  console.log(`      review/${name}`);
}

// 5 -------------------------------------------------------------------------
step('5. QA');
const qa = { reproduction: repro, cards: [] };
let failed = 0;
const SHIFT = LEGACY.main.y - REVISION.main.y;
/** Mean abs difference between the new card and the approved card moved up by SHIFT, inside a screen rectangle. */
async function translatedDiff(id, [x0, x1], [y0, y1]) {
  const [a, b] = await Promise.all([raw(rendered[id].png), raw(approvedPng[id])]);
  let sum = 0,
    max = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[(y * W + x) * 3 + c] - b[((y + SHIFT) * W + x) * 3 + c]);
        sum += d;
        n++;
        if (d > max) max = d;
      }
  return { mean: +(sum / n).toFixed(4), max };
}
for (const [id, { png, geo, spec }] of Object.entries(rendered)) {
  const meta = await sharp(png).metadata();
  const m = measures[id];
  const checks = {
    format:
      meta.format === 'png' &&
      meta.width === W &&
      meta.height === H &&
      meta.channels === 3 &&
      !meta.hasAlpha &&
      meta.space === 'srgb',
    gapReduced45to55: m.before
      ? (m.before.gap - m.after.gap) / m.before.gap >= 0.45 &&
        (m.before.gap - m.after.gap) / m.before.gap <= 0.55
      : null,
    mainScreenReachesCardEdge: geo.mainScreenBottom >= H,
  };
  const card = {
    id,
    width: meta.width,
    height: meta.height,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    space: meta.space,
    bytes: png.length,
    measured: m,
    geometry: geo,
    checks,
  };
  if (spec.main.rawCapture) card.chromeCrop = geo.mainCrop;
  if (m.before && id !== '02-head-to-head') {
    // Rows the approved card already showed, inside the main phone's screen.
    card.mainScreenUnchanged = await translatedDiff(
      id,
      [
        LEGACY.main.x + LEGACY.main.bezel + 4,
        LEGACY.main.x + LEGACY.main.w - LEGACY.main.bezel - 4,
      ],
      [REVISION.main.y + 140, H - SHIFT],
    );
    // Inset past the corner radius: the background gradient behind the corners does not move with the phone.
    if (geo.secTop)
      card.secondaryPhoneUnchanged = await translatedDiff(
        id,
        [LEGACY.sec.x + 10, LEGACY.sec.x + LEGACY.sec.w - 10],
        [geo.secTop + LEGACY.sec.radius, geo.secBottom - LEGACY.sec.radius],
      );
    checks.screensPixelIdenticalToApproved =
      card.mainScreenUnchanged.max <= 2 &&
      (!card.secondaryPhoneUnchanged || card.secondaryPhoneUnchanged.max <= 2);
  }
  if (id === '02-head-to-head') {
    // Left half of the comparison, which the approved card's result phone did not cover.
    card.comparisonLeftHalfUnchanged = await translatedDiff(
      id,
      [LEGACY.main.x + LEGACY.main.bezel + 4, 540],
      [REVISION.main.y + 140, H - SHIFT],
    );
    checks.screensPixelIdenticalToApproved = card.comparisonLeftHalfUnchanged.max <= 2;
  }
  const bad = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  failed += bad.length ? 1 : 0;
  qa.cards.push(card);
  const g = m.before ? `gap ${m.before.gap} → ${m.after.gap} px` : `gap ${m.after.gap} px`;
  console.log(
    `${bad.length ? 'FAIL' : 'PASS'}  ${id}  ${meta.width}x${meta.height} ch=${meta.channels} alpha=${meta.hasAlpha}  ${g}${bad.length ? `  [${bad.join(', ')}]` : ''}`,
  );
}
await writeFile(join(QA, 'qa-report.json'), `${JSON.stringify(qa, null, 2)}\n`);
if (failed) fail(`${failed} card(s) failed QA, see qa/qa-report.json`);
console.log(
  '\nDone. Cards in apple-1206x2622/ and candidate/, sheets in review/, report in qa/qa-report.json',
);
