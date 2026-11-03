import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { fixtures, me, people, titleId } from '../capture/mock/backend.mjs';
import { loadFonts } from '../compose/fonts.mjs';
import { DEVICE } from '../capture/browser.mjs';
import { deviceMetrics, reversedMark, TEMPLATES } from '../compose/templates.mjs';
import { REPO, ROOT } from '../lib/common.mjs';
import { APPROVED_HEADLINES, copy } from '../manifest/copy.mjs';
import { frames, SOCIAL_FRAMES, STORE_FRAMES } from '../manifest/frames.mjs';
import { scenes } from '../manifest/scenes.mjs';
import { canvases, SURFACE_RULES, targets } from '../manifest/targets.mjs';

const sceneIds = new Set(scenes.map((s) => s.id));
const sentences = (entry) => [entry.eyebrow, entry.headline.join(' '), entry.sub].filter(Boolean);

test('scene ids are unique and routes stay inside the app', () => {
  assert.equal(sceneIds.size, scenes.length);
  for (const scene of scenes) {
    assert.match(scene.url, /^\/[^/]/, `${scene.id} must be a local route`);
    assert.equal(typeof scene.run, 'function', scene.id);
  }
});

test('every frame points at scenes and copy that exist', () => {
  for (const [id, frame] of Object.entries(frames)) {
    assert.ok(copy[frame.copy], `${id} has no copy`);
    if (frame.artwork === false) {
      assert.equal(frame.scene, undefined, `${id} says no artwork but names a scene`);
      continue;
    }
    assert.ok(sceneIds.has(frame.scene), `${id} scene ${frame.scene}`);
    if (frame.inset) assert.ok(sceneIds.has(frame.inset), `${id} inset ${frame.inset}`);
  }
});

test('copy is only what already exists, as whole sentences', () => {
  for (const [id, entry] of Object.entries(copy)) {
    assert.ok(APPROVED_HEADLINES.includes(entry.headline.join(' ')), `${id} headline changed`);
    assert.ok(entry.source, `${id} must say where the words come from`);
  }
  // The live frames and the landing page are the only sources. Bars invented superlatives too.
  const banned = /\b(best|#1|number one|free|award-winning|millions?|top-rated)\b/i;
  for (const entry of Object.values(copy)) {
    for (const text of sentences(entry)) assert.doesNotMatch(text, banned);
  }
});

test('the name is written bingd in text; bingd. belongs only to the logo', () => {
  for (const entry of Object.values(copy)) {
    for (const text of sentences(entry)) assert.doesNotMatch(text, /bingd\./i);
  }
});

test('Amber text is large on every canvas that carries it', () => {
  const WCAG_LARGE_BOLD = 18.66;
  for (const [id, canvas] of Object.entries(canvases)) {
    if (canvas.type.eyebrow === null) continue;
    const rendered = (canvas.type.eyebrow * canvas.viewedAt) / canvas.width;
    assert.ok(rendered >= WCAG_LARGE_BOLD, `${id} eyebrow renders at ${rendered.toFixed(1)}px`);
  }
});

test('the foot of a device never slices through the tab bar', () => {
  const tabBarCss = 56 + DEVICE.safeArea.bottom;
  const { height: cssHeight, width: cssWidth } = DEVICE.viewport;
  for (const [id, canvas] of Object.entries(canvases)) {
    if (!canvas.device) continue;
    const { bezel, screenWidth } = deviceMetrics(canvas.device.width);
    const scale = screenWidth / cssWidth;
    const visible = canvas.height - canvas.device.top - bezel;
    // Frames keep ten points of safe area above the header. See compose/run.mjs.
    const screen = (cssHeight - (DEVICE.safeArea.top - 10)) * scale;
    const content = screen - tabBarCss * scale;
    assert.ok(visible <= content || visible >= screen, `${id} cuts the tab bar at ${visible}`);
  }
});

test('every target resolves to a canvas or raw scenes it can actually build', () => {
  assert.equal(new Set(targets.map((t) => t.id)).size, targets.length);
  for (const target of targets) {
    assert.ok(SURFACE_RULES[target.surface], `${target.id} surface`);
    assert.ok(SURFACE_RULES[target.surface].formats.includes(target.format), target.id);
    if (target.shots) {
      for (const scene of Object.values(target.shots)) assert.ok(sceneIds.has(scene), scene);
      continue;
    }
    const canvas = canvases[target.canvas];
    assert.ok(canvas, `${target.id} canvas`);
    assert.ok(TEMPLATES[canvas.template], `${target.id} template`);
    for (const frame of target.frames) assert.ok(frames[frame], `${target.id} frame ${frame}`);
    // Export may trim a sliver, never recompose. Anything more needs its own canvas.
    const drift = Math.abs(target.width / target.height - canvas.width / canvas.height);
    assert.ok(drift < 0.005, `${target.id} is too far from ${target.canvas}`);
    assert.ok(target.width <= canvas.width, `${target.id} would upscale`);
  }
});

test('a frame with focus can be framed from a capture record and without one', () => {
  for (const [id, frame] of Object.entries(frames)) {
    if (!frame.focus) continue;
    assert.ok(Number.isFinite(frame.focus.margin), `${id} focus.margin`);
    assert.ok(frame.focus.fallback > 0 && frame.focus.fallback < 1, `${id} focus.fallback`);
    const scene = scenes.find((s) => s.id === frame.scene);
    assert.ok(scene.focusOn, `${id} focuses on ${frame.scene}, which records no focusOn edge`);
  }
});

test('the store sizes Apple and Google document are all present', () => {
  const sizes = new Set(targets.map((t) => `${t.surface} ${t.width}x${t.height}`));
  for (const size of [
    'app-store 1206x2622', // Dynamic Island (medium), the stated requirement
    'app-store 1320x2868',
    'app-store 1284x2778',
    'google-play 1080x1920',
    'google-play 1024x500',
    'social 1080x1350',
    'social 1080x1080',
    'social 1200x630',
  ]) {
    assert.ok(sizes.has(size), size);
  }
  // The 2:1 limit is on screenshots. The feature graphic is a fixed 1024x500.
  const phone = targets.find((t) => t.id === 'google-play-phone');
  assert.ok(phone.height / phone.width <= SURFACE_RULES['google-play'].maxScreenshotRatio);
  assert.ok(STORE_FRAMES.length <= 8, 'Google Play takes eight per device type');
  assert.ok(STORE_FRAMES.length >= 4, 'promotion needs four at 1080px or more');
  assert.ok(SOCIAL_FRAMES.every((f) => frames[f]));
});

test('website targets replace real files at the size those files already are', () => {
  const website = targets.find((t) => t.surface === 'website');
  for (const name of Object.keys(website.shots)) {
    assert.ok(existsSync(join(REPO, 'web', 'src', `${name}.webp`)), `${name} is not a site image`);
  }
});

test('the feature graphic carries no artwork', () => {
  const graphic = targets.find((t) => t.id === 'google-play-feature-graphic');
  for (const frame of graphic.frames) assert.equal(frames[frame].artwork, false);
});

test('demo people are fictional and carry nothing linkable', () => {
  for (const person of [me, ...people]) {
    for (const link of ['link_instagram', 'link_tiktok', 'link_youtube', 'link_x', 'link_website']) {
      assert.equal(person[link], null, `${person.username} ${link}`);
    }
    assert.equal(person.avatar_path, null, `${person.username} must not have a photo`);
  }
  const credits = fixtures.tables.media_cache({ media_item_id: titleId('Coco'), facet: 'credits' });
  assert.deepEqual(credits[0].payload, { cast: [], crew: [] }, 'cast lists are real names');
});

test('a missing font stops compose rather than falling back', () => {
  assert.throws(() => loadFonts(join(ROOT, 'no-such-folder')), /Missing font/);
});

test('the reversed mark is drawn from the canonical SVG', () => {
  const svg = reversedMark();
  assert.match(svg, /stroke="#F5EBDD"/);
  assert.doesNotMatch(svg, /stroke="#773744"/);
});

test('generated output cannot be committed', () => {
  const paths = [
    'out/raw/feed.png',
    'out/export/x/y.webp',
    'out/poster-cache/abc.bin',
    'stray.png',
    'node_modules/x',
  ];
  for (const path of paths) {
    const ignored = execFileSync('git', ['check-ignore', join(ROOT, path)], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.ok(ignored.trim(), `${path} is not ignored`);
  }
});

test('publishing is absent: no script here can reach a store or a host', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['capture', 'compose', 'export', 'test']);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@expo-google-fonts/dm-serif-display',
    '@expo-google-fonts/inter',
    'playwright-core',
    'sharp',
  ]);
});
