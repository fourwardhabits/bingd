import { REVEAL_WINDOW } from '@/features/title/use-hero-reveal';
import { heroFrameHeight } from '@/ui/components';

import { personGroundRange } from './hero-geometry';

describe('the person top bar ground range', () => {
  // Phone widths from the smallest supported to a large Android, with the status-bar
  // insets those devices report and both platforms' bar heights.
  const CASES = [
    { width: 320, inset: 20, bar: 44 },
    { width: 360, inset: 24, bar: 56 },
    { width: 390, inset: 47, bar: 44 },
    { width: 412, inset: 32, bar: 56 },
    { width: 430, inset: 59, bar: 44 },
  ];

  it.each(CASES)(
    'ends where the 16:9 frame passes under the bar ($width pt)',
    ({ width, inset, bar }) => {
      const [start, end] = personGroundRange(width, inset + bar);
      expect(end).toBeCloseTo((width * 9) / 16 - (inset + bar), 6);
      expect(end).toBe(heroFrameHeight(width) - (inset + bar));
      expect(end - start).toBe(REVEAL_WINDOW);
    },
  );

  it('never runs backwards or starts above the top', () => {
    // A bar taller than the frame (a pathological inset): clamped, still ordered.
    const [start, end] = personGroundRange(200, 400);
    expect(end).toBe(2);
    expect(start).toBe(0);
  });
});
