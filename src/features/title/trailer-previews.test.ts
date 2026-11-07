import { trailerPreviewsByDefault } from './trailer-previews';

let mockLane: string | undefined = 'preview';
jest.mock('@/lib/env', () => ({
  get lane() {
    return mockLane;
  },
}));

/**
 * **Stills by default everywhere but production** (founder Preview QA, 2026-11-07).
 * Production keeps Show previews until its privacy disclosures name YouTube's image host.
 */
describe('trailerPreviewsByDefault', () => {
  it('is on in Preview, Beta and development, and in a local build with no lane', () => {
    for (const lane of ['preview', 'beta', 'development', undefined]) {
      mockLane = lane;
      expect(trailerPreviewsByDefault()).toBe(true);
    }
  });

  it('is off in production, which keeps the opt-in', () => {
    mockLane = 'production';
    expect(trailerPreviewsByDefault()).toBe(false);
  });
});
