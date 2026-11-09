import { trailerPreviewsByDefault } from './trailer-previews';

/**
 * **Stills by default in all lanes including production** (enabled 2026-11-09, after the
 * founder confirmed Play Console "No data shared" remains accurate for automatic loads —
 * F-6 in `docs/release/privacy-decision-matrix.md`).
 *
 * The function no longer reads `lane` — it is unconditionally `true` — so no lane mock
 * is needed here.
 */
describe('trailerPreviewsByDefault', () => {
  it('is on in every lane, including production', () => {
    expect(trailerPreviewsByDefault()).toBe(true);
  });
});
