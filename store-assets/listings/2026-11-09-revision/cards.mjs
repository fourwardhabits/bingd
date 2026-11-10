/**
 * Card specs and the layouts:
 *   LEGACY    the approved 2026-11-09 geometry (used only to prove this renderer reproduces the approved exports)
 *   REVISION  the proposed geometry: approved phones, no eyebrow, type moved down, larger secondary phone
 *   BALANCED  a review alternative for one dual-phone card
 */
import { join } from 'node:path';

import {
  H,
  W,
  background,
  encodeCard,
  line,
  loadScreen,
  phone,
  placeLine,
  shadowOf,
  sharp,
  visible,
} from './lib.mjs';

export const TYPE = {
  eyebrow: { face: 'sansSemi', px: 29, tracking: 9.0, color: '#D4A64C' },
  headline: { face: 'serif', px: 107, color: '#FFFFFF' },
  subtitle: { face: 'sans', px: 52, color: '#F6D5DA' },
};

const MAIN = { x: 98, w: 1015, bezel: 17, radius: 112 };
const SEC = { x: 615, w: 545, bezel: 7, radius: 58 };

export const LEGACY = {
  name: 'legacy',
  eyebrow: 174,
  headline: [296, 421],
  subtitle: 542,
  main: { ...MAIN, y: 783 },
  sec: { ...SEC, cy: 1963 },
};

/** Moves the headline and subtitle down; the main phone keeps the approved placement. */
const TEXT_DOWN = 112;

/** A phone frame at a new width, with bezel and corner radius scaled from `base`. */
const scaledFrame = (base, w) => ({
  w,
  bezel: Math.round((base.bezel * w) / base.w),
  radius: Math.round((base.radius * w) / base.w),
});

/**
 * Main phone exactly as approved; the type moves down TEXT_DOWN to close the gap.
 * The secondary phone is 609 px wide (60% of the main phone) and keeps the approved
 * right edge. Any wider and it cuts the card 03 "RECENT ACTIVITY" header, which the
 * approved card shows in full. It runs past the card's bottom edge far enough to
 * hide its tab bar (`hideTabBar`).
 */
export const REVISION = {
  name: 'revision',
  eyebrow: null,
  headline: LEGACY.headline.map((b) => b + TEXT_DOWN),
  subtitle: LEGACY.subtitle + TEXT_DOWN,
  main: LEGACY.main,
  sec: { ...scaledFrame(SEC, 615), x: SEC.x + SEC.w - 615, hideTabBar: true },
};

/**
 * Review alternative for one dual-phone card: the pair is narrowed and centred as a
 * group (40 px side margins) so a 65% secondary phone clears the main screen's
 * left text column. Main phone 960 px wide, secondary 624 px.
 */
export const BALANCED = {
  ...REVISION,
  name: 'balanced',
  main: { ...scaledFrame(MAIN, 960), x: 40, y: LEGACY.main.y },
  sec: { ...scaledFrame(SEC, 624), x: W - 40 - 624, hideTabBar: true },
};

/**
 * Tallest secondary tab bar as a fraction of screen width: 145 source px on the
 * 945 px captures (04, 05). Card 01's is 100 of 832; the comments screen has none.
 */
const TAB_BAR = 145 / 945;
const TAB_BAR_MARGIN = 12;
export function cardSpecs(src) {
  const layer = (name) => ({ file: join(src, 'layers', `${name}.png`) });
  const capture = (name) => ({ file: join(src, 'captures', name), rawCapture: true });
  return {
    lineup: [
      {
        id: '01-movies-tv',
        eyebrow: 'MOVIES + TV',
        headline: ['Movies and TV,', 'one place'],
        subtitle: 'Rank movies and TV seasons separately',
        main: layer('01-movies-tv__main-screen'),
        sec: layer('01-movies-tv__secondary-screen'),
      },
      {
        id: '02-head-to-head',
        eyebrow: 'HOW IT WORKS',
        headline: ['Put your favorites', 'head to head'],
        subtitle: 'Quick comparisons build your ranking',
        main: capture('1000087685.jpg'),
      },
      {
        id: '03-friends',
        eyebrow: 'FRIENDS',
        headline: ['See what your', 'friends are watching'],
        subtitle: 'React, comment, send recommendations',
        main: layer('03-friends__main-screen'),
        sec: layer('03-friends__secondary-screen'),
      },
      {
        id: '04-watchlist',
        eyebrow: 'WATCHLIST',
        headline: ['Save your', 'next watch'],
        subtitle: 'Your watchlist, plus picks from friends',
        main: layer('04-watchlist__main-screen'),
        sec: layer('04-watchlist__secondary-screen'),
      },
      {
        id: '05-your-year',
        eyebrow: 'YOUR YEAR',
        headline: ['Your taste,', 'on the record'],
        subtitle: 'Set goals and unlock Awards',
        main: layer('05-your-year__main-screen'),
        sec: layer('05-your-year__secondary-screen'),
      },
      {
        id: '06-for-you',
        eyebrow: 'FOR YOU',
        headline: ['Find something', 'worth watching'],
        subtitle: 'Recommendations shaped by your taste',
        main: layer('06-for-you__main-screen'),
      },
    ],
    candidate: {
      id: '07-ranked-CANDIDATE',
      eyebrow: 'RANKED',
      headline: ['Your favorites,', 'ranked'],
      subtitle: 'Every comparison sharpens your list',
      main: capture('ranked-movies-list.jpg'),
    },
    /** The approved card 02 (comparison behind, 9.8 result in front), for the reproduction check only. */
    legacyCard02: {
      id: '02-head-to-head',
      eyebrow: 'HOW IT WORKS',
      headline: ['Put your favorites', 'head to head'],
      subtitle: 'Quick comparisons build your ranking',
      main: capture('1000087685.jpg'),
      sec: capture('1000087701.jpg'),
    },
  };
}

export async function renderCard(spec, layout) {
  const layers = [];
  const geo = {};
  if (layout.eyebrow) {
    const eb = await line({ text: spec.eyebrow, ...TYPE.eyebrow });
    layers.push(placeLine(eb, W / 2, layout.eyebrow));
  }
  for (let i = 0; i < 2; i++) {
    const hl = await line({ text: spec.headline[i], ...TYPE.headline });
    layers.push(placeLine(hl, W / 2, layout.headline[i]));
    if (i === 0) geo.headlineCapTop = layout.headline[0] - (hl.baseline - hl.capTop);
  }
  const st = await line({ text: spec.subtitle, ...TYPE.subtitle });
  layers.push(placeLine(st, W / 2, layout.subtitle));
  geo.subtitleInkBottom = layout.subtitle - st.baseline + st.ink.y1;

  const M = layout.main;
  const mainScr = await loadScreen(spec.main.file, spec.main);
  const mainH = H - M.y + M.radius + 40;
  const main = await phone({
    scr: mainScr,
    outerW: M.w,
    outerH: mainH,
    bezel: M.bezel,
    radius: M.radius,
  });
  const ms = await shadowOf(main.buffer, { sigma: 18, opacity: 0.28, dy: 10 });
  layers.push(await visible(ms.input, M.x - ms.pad, M.y - ms.pad + ms.dy));
  layers.push(await visible(main.buffer, M.x, M.y));
  geo.mainW = M.w;
  geo.mainTop = M.y;
  geo.mainScreenBottom = M.y + M.bezel + main.scaledH;
  geo.mainCrop = mainScr.crop ?? null;

  if (spec.sec) {
    const S = layout.sec;
    const secScr = await loadScreen(spec.sec.file, spec.sec);
    const innerW = S.w - 2 * S.bezel;
    const natural = Math.round((secScr.height * innerW) / secScr.width);
    // Held to the frame height of the full-height captures (the comments capture is shorter).
    const ih = Math.min(natural, Math.round((1876 / 945) * innerW));
    const outerH = ih + 2 * S.bezel;
    const top = S.hideTabBar
      ? H + S.bezel + Math.ceil(TAB_BAR * innerW) + TAB_BAR_MARGIN - outerH
      : Math.round(S.cy - outerH / 2);
    const sec = await phone({
      scr: secScr,
      outerW: S.w,
      outerH,
      bezel: S.bezel,
      radius: S.radius,
    });
    const ss = await shadowOf(sec.buffer, { sigma: 22, opacity: 0.5, dy: 16 });
    layers.push(await visible(ss.input, S.x - ss.pad, top - ss.pad + ss.dy));
    layers.push(await visible(sec.buffer, S.x, top));
    geo.secX = S.x;
    geo.secW = S.w;
    geo.secTop = top;
    geo.secBottom = top + outerH;
    geo.secScreenBottom = top + S.bezel + sec.screenH;
    geo.secTabBarPx = Math.ceil(TAB_BAR * innerW);
  }
  const png = await encodeCard(sharp(await background()).composite(layers));
  return { png, geo };
}
