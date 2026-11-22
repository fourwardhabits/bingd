import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { launchChrome, OUT } from '../lib/common.mjs';
import { FIXED_NOW, VIEWER, VIEWER_EMAIL } from './mock/backend.mjs';

/** An iPhone 390x844 at 3x, the size every scene is framed for. */
export const DEVICE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  safeArea: { top: 47, left: 0, bottom: 34, right: 0 },
};

/** Gitignored with the rest of `out/`: these are poster artwork. Delete it to refetch. */
const POSTER_CACHE = join(OUT, 'poster-cache');

/**
 * Each poster comes from the CDN once and from disk after that. The CDN negotiates the format
 * per request, and now and then answers a whole page in JPEG instead of WebP, which changes
 * the frame even though the picture is the same. Serving the first answer every time is
 * what makes two runs match, and it means a slow CDN only costs the first run.
 */
async function servePoster(route) {
  const key = createHash('sha256').update(route.request().url()).digest('hex').slice(0, 32);
  const bodyFile = join(POSTER_CACHE, `${key}.bin`);
  const typeFile = join(POSTER_CACHE, `${key}.type`);
  if (existsSync(bodyFile) && existsSync(typeFile)) {
    return route.fulfill({
      status: 200,
      contentType: readFileSync(typeFile, 'utf8'),
      headers: { 'access-control-allow-origin': '*' },
      body: readFileSync(bodyFile),
    });
  }
  const response = await route.fetch();
  if (response.ok()) {
    mkdirSync(POSTER_CACHE, { recursive: true });
    writeFileSync(bodyFile, await response.body());
    writeFileSync(typeFile, response.headers()['content-type'] ?? 'application/octet-stream');
  }
  return route.fulfill({ response });
}

/** The app, the mock and the public poster CDN. Anything else is aborted and reported. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', 'image.tmdb.org']);

const base64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: VIEWER, aud: 'authenticated', role: 'authenticated', exp: 4102444800, email: VIEWER_EMAIL })}.mock`;
const session = {
  access_token: jwt,
  refresh_token: 'mock-refresh',
  token_type: 'bearer',
  expires_in: 3600000,
  expires_at: 4102444800,
  user: {
    id: VIEWER,
    aud: 'authenticated',
    role: 'authenticated',
    email: VIEWER_EMAIL,
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-06-01T00:00:00Z',
  },
};

/**
 * Runs before the app's first line.
 *
 * The clock starts at a fixed instant and then runs: "12m ago" repeats, while `Animated`
 * still advances, because its timing reads Date.now() and a frozen clock would hang every
 * animation. `Math.random` is seeded so anything shuffled comes out the same each run.
 */
function seedBrowser({ fixedNow, origin, seed, auth, stage, phase, viewer, prefs }) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  // The same mapping the mock uses: see FIXED_NOW in capture/mock/backend.mjs.
  const offset = fixedNow - origin;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(realNow() + offset);
      else super(...args);
    }
    static now() {
      return realNow() + offset;
    }
  }
  globalThis.Date = FixedDate;

  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  if (sessionStorage.getItem('__seeded')) return;
  sessionStorage.setItem('__seeded', '1');
  localStorage.clear();
  if (auth) localStorage.setItem('sb-127-auth-token', JSON.stringify(auth));
  if (stage) localStorage.setItem(`pref.${viewer}.onboarding.stage`, JSON.stringify(stage));
  if (phase) localStorage.setItem(`pref.${viewer}.onboarding.taste.phase`, JSON.stringify(phase));
  for (const [key, value] of Object.entries(prefs ?? {})) {
    localStorage.setItem(`pref.${key}`, JSON.stringify(value));
  }
}

/**
 * Looks only at what the viewport shows. Offscreen images are lazy, so waiting on one would
 * wait for something that never starts, and `decode()` on one never settles at all.
 */
function artworkOnScreen() {
  const { innerWidth, innerHeight } = window;
  const inView = (box) =>
    box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 &&
    box.top < innerHeight && box.left < innerWidth;
  const waiting = [];
  for (const img of document.images) {
    if (inView(img.getBoundingClientRect()) && !(img.complete && img.naturalWidth > 0)) {
      waiting.push(img.currentSrc || img.src);
    }
  }
  return waiting;
}

/**
 * Waits until no poster is in flight and everything in view has painted. A tile captured
 * earlier shows a placeholder, and a placeholder in a store frame is a defect. Ninety seconds,
 * because a poster served from the local cache once took longer than 45 on a loaded machine.
 */
async function waitForArtwork(page, tracker) {
  const deadline = Date.now() + 90000;
  let waiting = [];
  while (Date.now() < deadline) {
    waiting = await page.evaluate(artworkOnScreen);
    if (tracker.inflight.size === 0 && waiting.length === 0) {
      return;
    }
    await page.waitForTimeout(250);
  }
  const stuck = [...tracker.inflight, ...waiting].slice(0, 3).join(', ');
  throw new Error(`Artwork still not on screen after 90s: ${stuck}`);
}

/**
 * Takes the shot only once two frames in a row are identical. "Loaded" is not "painted":
 * expo-image fades each poster in, and under load a shot taken on any fixed delay catches
 * them half transparent. A screen that never holds still is an error, not a shot. The window
 * is a minute because on a loaded machine one CPU-rastered screenshot can take several seconds.
 */
async function stillShot(page) {
  const deadline = Date.now() + 60000;
  let last = await page.screenshot({ timeout: 120000 });
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    const next = await page.screenshot({ timeout: 120000 });
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error('The screen was still changing after 60s');
}

/** The small vocabulary scenes are written in. */
function sceneTools(page) {
  const tools = {
    page,
    text: (t) => page.getByText(t, { exact: true }).first(),
    waitText: (t, timeout = 60000) => tools.text(t).waitFor({ state: 'visible', timeout }),
    /** For a string the app wraps in something else, such as a note in curly quotes. */
    waitPartial: (t, timeout = 60000) =>
      page.getByText(t).first().waitFor({ state: 'visible', timeout }),
    /**
     * Waits for the real element, then dispatches the click. A real click under load times
     * out, or lands as a long-press once the machine is busy.
     */
    tap: async (locator, timeout = 60000) => {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.dispatchEvent('click');
      await page.waitForTimeout(700);
    },
    tapText: (t) => tools.tap(tools.text(t)),
    tapLabel: (l) => tools.tap(page.locator(`[aria-label="${l}"]`).first()),
    settle: (ms) => page.waitForTimeout(ms),
  };
  return tools;
}

async function shootScene(browser, scene, { baseUrl, mock, outDir, fixedSeed }) {
  const origin = Date.now();
  mock.setScenario(scene.scenario ?? 'established', origin);
  const context = await browser.newContext({
    viewport: DEVICE.viewport,
    deviceScaleFactor: DEVICE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: DEVICE.safeArea });

  const tracker = { inflight: new Set(), failedArt: new Set(), blocked: new Set(), art: {} };
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'image.tmdb.org') return servePoster(route).catch(() => route.abort());
    if (ALLOWED_HOSTS.has(host)) return route.continue();
    tracker.blocked.add(host);
    return route.abort();
  });
  const isArt = (url) => url.includes('image.tmdb.org');
  page.on('request', (r) => isArt(r.url()) && tracker.inflight.add(r.url()));
  page.on('requestfinished', async (r) => {
    if (!isArt(r.url())) return;
    const response = await r.response().catch(() => null);
    if (response && !response.ok()) tracker.failedArt.add(`${response.status()} ${r.url()}`);
    const body = await response?.body().catch(() => null);
    if (body) {
      const type = response.headers()['content-type'] ?? 'unknown';
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      tracker.art[r.url().replace('https://image.tmdb.org/t/p/', '')] = `${type} ${hash}`;
    }
    tracker.inflight.delete(r.url());
  });
  page.on('requestfailed', (r) => {
    if (!isArt(r.url())) return;
    tracker.failedArt.add(`${r.failure()?.errorText} ${r.url()}`);
    tracker.inflight.delete(r.url());
  });
  const pageErrors = new Set();
  page.on('pageerror', (e) => pageErrors.add(e.message.slice(0, 240)));

  const signedIn = scene.signedIn !== false;
  await page.addInitScript(seedBrowser, {
    fixedNow: FIXED_NOW,
    origin,
    seed: fixedSeed,
    auth: signedIn ? session : null,
    stage: scene.stage === undefined ? 'done' : scene.stage,
    phase: scene.phase === undefined ? 'done' : scene.phase,
    viewer: VIEWER,
    prefs: scene.prefs,
  });

  try {
    await page.goto(`${baseUrl}${scene.url}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    const tools = sceneTools(page);
    await scene.run(tools);
    await waitForArtwork(page, tracker);
    if (tracker.failedArt.size) {
      throw new Error(`Artwork failed to load: ${[...tracker.failedArt].slice(0, 3).join('; ')}`);
    }
    const buffer = await stillShot(page);
    let focusTop;
    if (scene.focusOn) {
      const box = await page.locator(scene.focusOn).filter({ visible: true }).last().boundingBox();
      if (!box) throw new Error(`focusOn ${scene.focusOn} is not on screen`);
      focusTop = Math.round(box.y);
    }
    const file = `${scene.id}.png`;
    writeFileSync(join(outDir, file), buffer);
    const { width, height } = await sharp(buffer).metadata();
    return {
      file,
      width,
      height,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      ...(focusTop === undefined ? {} : { focusTop }),
      // Sorted: posters finish in network order, and the record should not change with it.
      artwork: Object.fromEntries(Object.entries(tracker.art).sort()),
      blocked: [...tracker.blocked],
      pageErrors: [...pageErrors],
    };
  } catch (error) {
    // Kept beside the output for diagnosis, under a name compose will never pick up.
    await page
      .screenshot({ path: join(outDir, `${scene.id}--FAILED.png`), timeout: 30000 })
      .catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

/** Runs each scene once, with one retry: a busy machine is expected here, not exceptional. */
export async function shootScenes({ scenes, baseUrl, mock, outDir, retries = 1 }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await launchChrome();
  const results = {};
  const failures = [];
  try {
    for (const scene of scenes) {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const started = Date.now();
        try {
          results[scene.id] = await shootScene(browser, scene, {
            baseUrl,
            mock,
            outDir,
            fixedSeed: 20261015,
          });
          console.log(`  ok   ${scene.id}  ${Math.round((Date.now() - started) / 1000)}s`);
          break;
        } catch (error) {
          const message = error.message.split('\n')[0];
          console.log(`  fail ${scene.id} (attempt ${attempt}): ${message}`);
          if (attempt > retries) {
            failures.push({ scene: scene.id, error: message });
            break;
          }
        }
      }
    }
    return { results, failures, chrome: browser.version() };
  } finally {
    await browser.close();
  }
}
