import type { FlashListRef } from '@shopify/flash-list';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Animated,
  BackHandler,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type View,
  type ViewProps,
} from 'react-native';

import { hapticSelection } from '@/ui/haptics';

import {
  autoScrollSpeed,
  displacement,
  hitIndex,
  itemTopInViewport,
  layoutYAtViewport,
  type Rect,
} from './drag-geometry';

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
  /**
   * Where the floating copy is drawn, or null for the one frame before its horizontal
   * position is known (the first lift on a screen). The copy, and the hiding of the
   * original, wait for it; scrolling is off from the lift itself.
   */
  frame: LiftFrame | null;
  /** Over another rating category: the drop recategorises the title, and the lifted tile says so. */
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
  /** The copy's top, in the container, from the list's numbers at the lift. Never measured. */
  y: number;
  /** Its left edge, null until known (see `LiftState.frame`). */
  x: number | null;
  origin: Rect;
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
 *   · **Where the copy is drawn comes from the list's own numbers, never a measurement of
 *     the scrolled view** (Android QA, 2026-11-20). Its top is the item's layout, below the
 *     header, minus the scroll offset (`itemTopInViewport`). `measureLayout` supplied it
 *     until then, and on Android's new architecture that value can lag the real scroll
 *     position, which drew the copy away from the finger after a scroll. It now supplies
 *     only the left edge, which no vertical scroll changes, once per screen.
 *   · Where it is over is read back from the copy under the finger (`layoutYAtViewport`),
 *     so an auto-scroll, a header that changes height or an item re-measured mid-gesture
 *     cannot separate the target from what the reader sees. No window or page coordinate is
 *     read, so the status bar and edge-to-edge insets cannot shift the arithmetic.
 *   · Scrolling is off from the moment of the lift, not from a measurement a frame later,
 *     so Android's scroll view cannot take the first move away from the drag.
 *   · Android Back while holding a title puts it back, and consumes the press.
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
  layoutKey = '',
}: {
  listRef: RefObject<FlashListRef<T> | null>;
  /** The view the list sits in, which the floating copy is positioned in. */
  containerRef: RefObject<View | null>;
  /** Only the first `count` items can be dropped on: the ranked ones. */
  count: number;
  isOutside: (from: number, to: number) => boolean;
  onDrop: (from: number, to: number) => void;
  /**
   * What the list's horizontal geometry depends on: the view (a poster wall has a gutter, a
   * list of rows has none) and the width. The left edge learned at a lift is reused only
   * under the same key (Codex, PR 319): Poster then List must not draw a row at the wall's
   * inset.
   */
  layoutKey?: string;
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

  /**
   * The left edge of an item's cell inside the container, minus its layout `x`: learned
   * once per `layoutKey`, and forgotten when the key changes.
   */
  const learned = useRef<{ key: string; inset: number } | null>(null);
  const insetFor = (key: string) => (learned.current?.key === key ? learned.current.inset : null);

  const layoutOf = (index: number): Rect | undefined => {
    try {
      return listRef.current?.getLayout(index) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const firstItemOffset = () => {
    try {
      return listRef.current?.getFirstItemOffset() ?? 0;
    } catch {
      return 0;
    }
  };

  /** The list's own record of its offset, else the last one this hook was told. */
  const listScrollTop = () => {
    try {
      const offset = listRef.current?.getAbsoluteLastScrollOffset();
      return typeof offset === 'number' && Number.isFinite(offset) ? offset : scrollY.current;
    } catch {
      return scrollY.current;
    }
  };

  const frameOf = (current: Live): LiftFrame | null =>
    current.x === null
      ? null
      : { x: current.x, y: current.y, width: current.origin.width, height: current.origin.height };

  const publish = (current: Live, shifts = shiftsFor(current.from, current.to, layoutOf)) =>
    setState({
      from: current.from,
      to: current.to,
      frame: frameOf(current),
      outside: current.outside,
      shifts,
    });

  const stopAuto = () => {
    if (auto.current.timer) clearInterval(auto.current.timer);
    auto.current = { timer: null, speed: 0 };
  };

  useEffect(() => stopAuto, []);

  const retarget = () => {
    const current = live.current;
    if (!current) return;
    // The centre of the copy under the finger, in the viewport, read back into the list's
    // layout coordinates at the list's current scroll and header.
    const point = {
      x: current.origin.x + current.origin.width / 2 + current.dx,
      y: layoutYAtViewport(
        current.y + current.origin.height / 2 + current.dy,
        firstItemOffset(),
        scrollY.current,
      ),
    };
    const hit = hitIndex(point, count, layoutOf);
    if (hit < 0) return;
    const to = Math.max(0, Math.min(hit, count - 1));
    if (to === current.to) return;
    const outside = isOutside(current.from, to);
    // One light tick on crossing into another category, where the drop changes the rating.
    if (outside && !current.outside) hapticSelection();
    current.to = to;
    current.outside = outside;
    publish(current);
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
    const centre = current.y + current.origin.height / 2 + current.dy;
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
   * Lifts the item at `index`, whose own view is `node`.
   *
   * The copy's top is computed here, synchronously, from the list (see the header). Only its
   * left edge is measured, and only the first time on a screen: every later lift reuses it.
   */
  const lift = (index: number, node: View | null) => {
    const container = containerRef.current;
    if (live.current || !node || !container || index < 0 || index >= count) return;
    const origin = layoutOf(index);
    // Not laid out (never expected for a title the reader is touching): nothing to lift.
    if (!origin) return;
    scrollY.current = listScrollTop();
    const lifted: Live = {
      from: index,
      to: index,
      y: itemTopInViewport(origin.y, firstItemOffset(), scrollY.current),
      x: insetFor(layoutKey) === null ? null : (insetFor(layoutKey) as number) + origin.x,
      origin,
      start: null,
      dx: 0,
      dy: 0,
      outside: false,
    };
    // Claimed at once, and published at once: the very next move is the container's, and
    // the list stops scrolling now rather than a frame from now.
    live.current = lifted;
    travel.setValue({ x: 0, y: 0 });
    hapticSelection();
    publish(lifted);
    if (lifted.x !== null) return;
    const key = layoutKey;
    node.measureLayout(
      container,
      (x) => {
        learned.current = { key, inset: x - origin.x };
        // Released, or another lift, in the meantime: the inset is still worth keeping.
        if (live.current !== lifted) return;
        lifted.x = x;
        publish(lifted);
      },
      () => {
        if (live.current === lifted) end(false);
      },
    );
  };

  /** Android Back while a title is held puts it back, and is not also a navigation. */
  const holding = state !== null;
  useEffect(() => {
    if (!holding) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!live.current) return false;
      end(false);
      return true;
    });
    return () => subscription.remove();
    // `end` reads refs only; re-subscribing on every render would add nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);

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

  /**
   * Where the item at `index` is drawn while something is lifted: hidden, moved, or put.
   * The original is hidden only once its copy is drawn, so the slot is never blank alone.
   */
  const shiftOf = (index: number): { hidden: boolean; x: number; y: number } | null => {
    if (!state) return null;
    if (index === state.from) return state.frame ? { hidden: true, x: 0, y: 0 } : null;
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
