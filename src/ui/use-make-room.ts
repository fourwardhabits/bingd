import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { useReducedMotion } from './motion';

/** How long a title takes to step aside for a held one: quick, so it follows the finger. */
export const MAKE_ROOM_MS = 140;

/**
 * **A cell's step aside while another title is held over it** (#318, Android QA 2026-11-20).
 *
 * The cells between the held title's slot and its target are translated by the drag's
 * `shift`. Until now the translation was set outright, so every cell jumped the moment the
 * target changed. This eases each cell to its new offset, on the native driver.
 *
 * `identity` is whatever the cell is drawing (a title id). A virtualised list recycles a
 * cell for another title, and an offset left over from the previous one would ease in from
 * somewhere it never was, so a new identity is placed at once rather than animated.
 * Reduce Motion places every offset at once.
 */
export function useMakeRoom(shift: { x: number; y: number } | null | undefined, identity: string) {
  const reduced = useReducedMotion();
  const [offset] = useState(() => new Animated.ValueXY({ x: shift?.x ?? 0, y: shift?.y ?? 0 }));
  const drawn = useRef(identity);
  const x = shift?.x ?? 0;
  const y = shift?.y ?? 0;

  const holding = shift != null;

  useEffect(() => {
    // A new title in a recycled cell, Reduce Motion, or the hold ending: placed at once. The
    // last matters most: on a drop the list re-renders in its new order in the same commit,
    // and an offset easing back over the new order would show every title twice.
    if (drawn.current !== identity || reduced || !holding) {
      drawn.current = identity;
      offset.stopAnimation();
      offset.setValue({ x, y });
      return undefined;
    }
    const animation = Animated.timing(offset, {
      toValue: { x, y },
      duration: MAKE_ROOM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [holding, identity, offset, reduced, x, y]);

  return offset;
}
