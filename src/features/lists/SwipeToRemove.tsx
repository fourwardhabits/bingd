import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/** How far the row slides to show Remove. */
export const REMOVE_WIDTH = 112;

/** A move must travel this far sideways, and twice as far sideways as down, to count. */
const SLOP = 12;

/** Decides whether a move is a sideways swipe rather than a scroll or a drag. */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > SLOP && Math.abs(dx) > 2 * Math.abs(dy);
}

/** Where a released swipe settles: open when it passed half the action, else closed. */
export function settle(offset: number): 'open' | 'closed' {
  return offset <= -REMOVE_WIDTH / 2 ? 'open' : 'closed';
}

export type SwipeToRemoveProps = {
  /** The title's name, for the action's spoken label. */
  name: string;
  /** True while a vertical drag-to-reorder is in progress: no swipe may start. */
  locked: boolean;
  /** Whether this row is the one currently slid open. Only one row is open at a time. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
  children: ReactNode;
};

/**
 * Swipe left on an owned list's row to reveal **Remove from list** (founder QA,
 * 2026-09-21), replacing the permanent ⋯ on every row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CORE RESPONDER SYSTEM, AND HOW IT STAYS OUT OF THE DRAG'S WAY
 *
 * The same system as the drag-to-reorder that already works on device: no native
 * dependency and no new binary. The two gestures are separated by their start and their
 * direction, never by guesswork:
 *
 *   · the drag starts only after a long press lifts a row, and while it runs the list's
 *     container claims every move in the capture phase (`locked` also refuses a swipe);
 *   · a swipe is claimed only for a move that is **horizontally dominant** before any long
 *     press — past 12pt sideways and twice as far sideways as down — so a vertical scroll
 *     is never mistaken for one.
 *
 * ---------------------------------------------------------------------------
 * NO ACCIDENTAL DELETE
 *
 * The swipe only reveals the action; removing takes a second, deliberate tap on it. A
 * short swipe springs back. The same Remove is an accessibility action on the row, so it
 * is never reachable only by a gesture. Removing touches list membership and nothing
 * else — the title stays in the collection, the ranking and the Watchlist.
 */
export function SwipeToRemove({
  name,
  locked,
  open,
  onOpenChange,
  onRemove,
  children,
}: SwipeToRemoveProps) {
  const [offset] = useState(() => new Animated.Value(0));
  const start = useRef<{ x: number; y: number } | null>(null);
  const base = useRef(0);
  const current = useRef(0);

  const animateTo = (to: number) => {
    current.current = to;
    Animated.timing(offset, {
      toValue: to,
      duration: theme.duration.state,
      useNativeDriver: true,
    }).start();
  };

  // A row told it is no longer the open one closes itself.
  useEffect(() => {
    if (open) return;
    current.current = 0;
    Animated.timing(offset, {
      toValue: 0,
      duration: theme.duration.state,
      useNativeDriver: true,
    }).start();
  }, [open, offset]);

  const delta = (event: GestureResponderEvent) => {
    const s = start.current;
    if (!s) return { dx: 0, dy: 0 };
    return { dx: event.nativeEvent.pageX - s.x, dy: event.nativeEvent.pageY - s.y };
  };

  return (
    <View style={styles.frame}>
      <View
        style={styles.action}
        // Hidden while closed, so a screen reader does not meet a control that is not
        // on screen; the row's own accessibility action carries Remove meanwhile.
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${name} from list`}
          onPress={() => {
            onOpenChange(false);
            onRemove();
          }}
          style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
          testID={`swipe-remove-${name}`}
        >
          <Text variant="footnote" tone="inverse" style={styles.removeText}>
            Remove from list
          </Text>
        </Pressable>
      </View>

      <Animated.View
        style={{ transform: [{ translateX: offset }] }}
        onTouchStart={(event) => {
          start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
          base.current = current.current;
        }}
        onMoveShouldSetResponder={(event) => {
          if (locked) return false;
          const { dx, dy } = delta(event);
          return isHorizontalSwipe(dx, dy);
        }}
        onResponderMove={(event) => {
          const { dx } = delta(event);
          const next = Math.min(0, Math.max(-REMOVE_WIDTH, base.current + dx));
          current.current = next;
          offset.setValue(next);
        }}
        onResponderTerminationRequest={() => false}
        onResponderRelease={() => {
          const state = settle(current.current);
          animateTo(state === 'open' ? -REMOVE_WIDTH : 0);
          onOpenChange(state === 'open');
        }}
        onResponderTerminate={() => {
          animateTo(0);
          onOpenChange(false);
        }}
        testID={`swipe-row-${name}`}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  action: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: REMOVE_WIDTH,
  },
  remove: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.semantic.action,
    paddingHorizontal: theme.space[2],
  },
  removeText: { textAlign: 'center' },
  pressed: { opacity: 0.8 },
});
