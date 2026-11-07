import { trailerPreviewsByDefault } from './trailer-previews';

/**
 * **Stills by default, production included** (founder, release pass, 2026-11-07), now that
 * the privacy policy names YouTube's image servers. The opt-in (Show previews) remains in
 * the Trailers section for whenever this returns false.
 */
describe('trailerPreviewsByDefault', () => {
  it('is on', () => {
    expect(trailerPreviewsByDefault()).toBe(true);
  });
});
