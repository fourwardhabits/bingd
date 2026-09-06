import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * How close to the end of a scroll view the next page is asked for, in points.
 *
 * Eight hundred is about one phone screen. The fetch has to start while the reader still
 * has content to read or the spinner is the thing they arrive at, and a page of twenty
 * rows is several screens deep — so a threshold of one screen buys the round trip
 * roughly a screenful of reading time without prefetching everything.
 */
export const NEXT_PAGE_THRESHOLD = 800;

/**
 * Is the reader within a screenful of the bottom?
 *
 * Extracted when the profile got pages, because the arithmetic is the part that is easy
 * to get subtly wrong — `contentSize` minus where the *bottom* of the viewport is, not
 * where its top is — and two profiles were about to write it out again.
 *
 * **`app/(tabs)/feed.tsx` keeps its own copy on purpose.** It is the surface this
 * tranche was told not to reopen, and swapping a working local constant for an import
 * buys a reader nothing and costs a regression risk on the screen that can least afford
 * one. The values are the same and this note is the link between them; the day the feed
 * screen is being edited for its own reasons is the day to collapse them.
 */
export function isNearEnd(
  event: NativeSyntheticEvent<NativeScrollEvent>,
  threshold: number = NEXT_PAGE_THRESHOLD,
): boolean {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
  return contentSize.height - (contentOffset.y + layoutMeasurement.height) <= threshold;
}
