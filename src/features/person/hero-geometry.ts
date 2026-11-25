import { REVEAL_WINDOW } from '@/features/title/use-hero-reveal';
import { heroFrameHeight } from '@/ui/components';

/**
 * The stretch of scroll over which the person page's top bar becomes Paper.
 *
 * `useHeroReveal`'s arithmetic over the hero frame: the last `REVEAL_WINDOW` of it, ending
 * where the frame's bottom passes under the bar. **A function of the width and the bar
 * alone**: the frame is the full 16:9 whether a backdrop has arrived or not
 * (`TitleHero`'s `reserveFrame`), so nothing about the artwork can move this range under
 * a reader mid-scroll. It used to switch from the short band's range to this one when the
 * backdrop arrived, alongside the hero growing (founder QA, Android Preview, 2026-11-25).
 */
export function personGroundRange(width: number, barHeight: number): [number, number] {
  const end = Math.max(heroFrameHeight(width) - barHeight, 2);
  return [Math.max(end - REVEAL_WINDOW, 0), end];
}
