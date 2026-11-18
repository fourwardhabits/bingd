import type { FlashListRef } from '@shopify/flash-list';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Animated,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type View,
  type ViewProps,
} from 'react-native';

import { hapticSelection } from '@/ui/haptics';

import { autoScrollSpeed, displacement, hitIndex, type Rect } from './drag-geometry';

/** Every displacement while `from` is held over `to`, keyed by index. */
const shiftsFor = (
  from: number,
  to: number,
  layoutOf: (index: number) => Rect | undefined,
): Record<number, { x: number; y: number }> => {
  const shifts: Record<number, { x: number; y: number }> = {};
  for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
    const moved = displacement(i, from, to, layoutOf);
    if (moved) shifts[i] = moved;
  }
  return shifts;
};

/** The lifted title's frame, in the container's coordinates, at the moment it was lifted. */
export type LiftFrame = { x: number; y: number; width: number; height: number };

export type LiftState = {
  from: number;
  to: number;
  frame: LiftFrame;
  /** Over another band: the drop will be refused, and the lifted tile says so. */
  outside: boolean;
  /**
   * Where each title between `from` and `to` is moved to make room, by index. Computed when
   * the target changes, from the list's layouts, so rendering reads state and never a ref.
   */
  shifts: Record<number, { x: number; y: number }>;
};

/** The drag in progress, kept in a ref so the responder handlers read it synchronously. */
type Live = {
  from: number;
  to: number;
  /** Null until the measure lands, a frame after the lift; the floating copy waits for it. */
  frame: LiftFrame | null;
  origin: Rect | undefined;
  scroll0: number;
  start: { x: number; y: number } | null;
  dx: number;
  dy: number;
  outside: boolean;
};

/**
 * **The Collection's long-press, drag and drop** (#318), for the poster grid and the list.
 *
 * The same mechanism as a custom list's drag (`app/lists/[id].tsx`): core React Native, the
 * responder system and `Animated`, with no gesture library. That drag has been used by the
 * founder on both platforms, and a first native gesture system is a device risk this does
 * not take.
 *
 *   · A long-press on a title lifts it (`lift`), with a `selection` haptic. Nothing moves on
 *     a plain press, so tap-to-open is untouched, and scrolling is untouched until a lift.
 *   · Once lifted, the container claims the next move in the capture phase, so it wins over
 *     the press and the scroller. The caller disables scrolling while lifted.
 *   · The lifted title is drawn as a floating copy over the list (the caller's `ghost`), at
 *     the frame it was measured at plus the finger's travel. The original slot is hidden,
 *     and the titles between make room (`shiftOf`).
 *   · Where it is over comes from the list's own item layouts, displaced by the finger's
 *     travel and by any auto-scroll since the lift. No window or page coordinate is read,
 *     so the status bar and edge-to-edge insets cannot shift the arithmetic.
 *   · Near the top or bottom edge the list scrolls on its own, faster the deeper in.
 *   · Release: a drop elsewhere calls `onDrop(from, to)`. A lift released without moving,
 *     or a gesture the system takes away, drops nothing.
 */
export function useLiftDrag<T>({
  listRef,
  containerRef,
  count,
  isOutside,
  onDrop,
}: {
  listRef: RefObject<FlashListRef<T> | null>;
  /** The view the list sits in, which the floating copy is positioned in. */
  containerRef: RefObject<View | null>;
  /** Only the first `count` items can be dropped on: the ranked ones. */
  count: number;
  isOutside: (from: number, to: number) => boolean;
  onDrop: (from: number, to: number) => void;
}) {
  const [state, setState] = useState<LiftState | null>(null);
  const [travel] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const viewport = useRef(0);
  const scrollY = useRef(0);
  const auto = useRef<{ timer: ReturnType<typeof setInterval> | null; speed: number }>({
    timer: null,
    speed: 0,
  });
  const live = useRef<Live | null>(null);

  const layoutOf = (index: number): Rect | undefined => {
    try {
      return listRef.current?.getLayout(index) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const stopAuto = () => {
    if (auto.current.timer) clearInterval(auto.current.timer);
    auto.current = { timer: null, speed: 0 };
  };

  useEffect(() => stopAuto, []);

  const retarget = () => {
    const current = live.current;
    if (!current?.origin) return;
    const point = {
      x: current.origin.x + current.origin.width / 2 + current.dx,
      y: current.origin.y + current.origin.height / 2 + current.dy + (scrollY.current - current.scroll0),
    };
    const hit = hitIndex(point, count, layoutOf);
    if (hit < 0) return;
    const to = Math.max(0, Math.min(hit, count - 1));
    if (to === current.to) return;
    const outside = isOutside(current.from, to);
    // One light tick on crossing into another band, which is a drop that will be refused.
    if (outside && !current.outside) hapticSelection();
    current.to = to;
    current.outside = outside;
    if (!current.frame) return;
    setState({
      from: current.from,
      to,
      frame: current.frame,
      outside,
      shifts: shiftsFor(current.from, to, layoutOf),
    });
  };

  const tick = () => {
    const list = listRef.current;
    const { speed } = auto.current;
    if (!list || speed === 0) return;
    let max = Number.POSITIVE_INFINITY;
    try {
      const content = list.getChildContainerDimensions().height + list.getFirstItemOffset();
      max = Math.max(0, content - viewport.current);
    } catch {
      // A list that cannot say how tall it is: let the scroller clamp, as it does anyway.
    }
    const next = Math.max(0, Math.min(max, scrollY.current + speed));
    if (next === scrollY.current) return;
    scrollY.current = next;
    list.scrollToOffset({ offset: next, animated: false });
    retarget();
  };

  const steer = () => {
    const current = live.current;
    if (!current) return;
    if (!current.frame) return;
    const centre = current.frame.y + current.frame.height / 2 + current.dy;
    const speed = autoScrollSpeed(centre, viewport.current);
    auto.current.speed = speed;
    if (speed !== 0 && !auto.current.timer) auto.current.timer = setInterval(tick, 16);
    if (speed === 0 && auto.current.timer) stopAuto();
  };

  const end = (commit: boolean) => {
    stopAuto();
    const current = live.current;
    live.current = null;
    setState(null);
    travel.setValue({ x: 0, y: 0 });
    if (commit && current && current.start && current.to !== current.from) {
      onDrop(current.from, current.to);
    }
  };

  /**
   * Lifts the item at `index`, whose own view is `node`. Measured against the container, so
   * the floating copy starts exactly over the original.
   */
  const lift = (index: number, node: View | null) => {
    const container = containerRef.current;
    if (live.current || !node || !container || index < 0 || index >= count) return;
    // Claimed at once, so the very next move is the container's rather than the scroller's,
    // even if it comes before the measure below lands.
    const lifted: Live = {
      from: index,
      to: index,
      frame: null,
      origin: layoutOf(index),
      scroll0: scrollY.current,
      start: null,
      dx: 0,
      dy: 0,
      outside: false,
    };
    live.current = lifted;
    travel.setValue({ x: 0, y: 0 });
    hapticSelection();
    node.measureLayout(
      container,
      (x, y, width, height) => {
        // Released, or another lift, in the meantime.
        if (live.current !== lifted) return;
        lifted.frame = { x, y, width, height };
        setState({
          from: index,
          to: lifted.to,
          frame: lifted.frame,
          outside: lifted.outside,
          shifts: shiftsFor(index, lifted.to, layoutOf),
        });
      },
      () => {
        if (live.current === lifted) end(false);
      },
    );
  };

  /** A lift released before the finger moved is not a drop: the press ended it. */
  const releaseWithoutMoving = () => {
    if (live.current && live.current.start === null) end(false);
  };

  const containerProps: ViewProps = {
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current = event.nativeEvent.layout.height;
    },
    onMoveShouldSetResponderCapture: () => live.current !== null,
    onMoveShouldSetResponder: () => live.current !== null,
    onResponderGrant: (event: GestureResponderEvent) => {
      if (live.current) live.current.start = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const current = live.current;
      if (!current?.start) return;
      current.dx = event.nativeEvent.pageX - current.start.x;
      current.dy = event.nativeEvent.pageY - current.start.y;
      travel.setValue({ x: current.dx, y: current.dy });
      retarget();
      steer();
    },
    onResponderTerminationRequest: () => false,
    onResponderRelease: () => end(true),
    onResponderTerminate: () => end(false),
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = event.nativeEvent.contentOffset.y;
  };

  /** Where the item at `index` is drawn while something is lifted: hidden, moved, or put. */
  const shiftOf = (index: number): { hidden: boolean; x: number; y: number } | null => {
    if (!state) return null;
    if (index === state.from) return { hidden: true, x: 0, y: 0 };
    const moved = state.shifts[index];
    return moved ? { hidden: false, ...moved } : null;
  };

  return {
    state,
    travel,
    containerProps,
    onScroll,
    lift,
    releaseWithoutMoving,
    shiftOf,
    cancel: () => end(false),
  };
}

export type LiftDrag = ReturnType<typeof useLiftDrag>;
