import { trailerPreviewsByDefault } from './trailer-previews';

/**
 * **Stills prepared for all lanes including production** (2026-11-09 — production change
 * ready, pending founder confirmation of F-6 before merge/OTA).
 *
 * The function is unconditionally `true`; no lane mock is needed here. Behaviour in the
 * Cinematic and Original layouts is covered by `TitleScreen.test.tsx` (trailer tiles and
 * Original-layout-never-loads-YouTube-thumbnails tests).
 */
describe('trailerPreviewsByDefault', () => {
  it('returns true in every lane, including production', () => {
    expect(trailerPreviewsByDefault()).toBe(true);
  });
});
