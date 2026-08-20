import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the person using the app has asked the system to reduce motion.
 *
 * Honoured rather than consulted: design-system.md §10 requires that every
 * looping or transform animation has a still equivalent, and "reduce" for a
 * pulse means holding it at a legible opacity, not slowing it down.
 *
 * Subscribed to as well as read, because the setting can change while the app
 * is open — someone turning it on mid-session is very likely doing so because
 * of something they are looking at right now.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let live = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (live) setReduced(enabled);
      })
      .catch(() => {});

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);

    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
