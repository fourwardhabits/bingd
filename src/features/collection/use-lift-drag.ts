import type { FlashListRef } from '@shopify/flash-list';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type View,
  type ViewProps,
} from 'react-native';

import { hapticSelection } from '@/ui/haptics';
import { useReducedMotion } from '@/ui/motion';

import {
  autoScrollSpeed,
  displacement,
  hitIndex,
  itemTopInViewport,
  layoutYAtViewport,
  type Rect,
} from './drag-geometry';

/** Every displacement while `from` is held over `to`, keyed by index. */
/** How long a dropped copy waits for the caller's list to show the move before it goes. */
export const DROP_FALLBACK_MS = 800;

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

/** How much a lifted title grows, so it reads as picked up. Back to 1 as it settles. */
export const LIFT_SCALE = 1.04;
/** How long a released title takes to settle into its slot: brief, and eased out. */
export const SETTLE_MS = 160;

export type LiftState = {
  from: number;
  to: number;
  /**
   * `held` while the finger is down. `dropped` once the copy has settled into its new slot
   * and the move is handed to the caller: the copy and the gap stay exactly where they are
   * until the caller sees its list drawn in the new order and calls `settle()`, so the two
   * swap in one render (Android QA, 2026-11-20: "a visible flash" on release).
   */
  phase: 'held' | 'dropped';
  /** What the caller said it lifted, so it can tell when its list shows it at `to`. */
  id: string | null;
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
  /** `settling`: released, the copy gliding to its slot; nothing else is accepted. */
  phase: 'held' | 'settling' | 'dropped';
  id: string | null;
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
  listKey = '',
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
  /**
   * Which list is mounted (Poster or List). A new list starts at the top, so the offset
   * this hook tracks starts at zero with it.
   */
  listKey?: string;
}) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<LiftState | null>(null);
  const [travel] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const [scale] = useState(() => new Animated.Value(LIFT_SCALE));
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /**
   * **The scroll offset is this hook's own, from the list's scroll events, and nothing
   * else** (Android QA, 2026-11-20: "the top three posters sometimes stop responding").
   * `getAbsoluteLastScrollOffset()` is FlashList's tracker offset plus the header height
   * *now*, and the tracker starts at 0 and stores offsets relative to the header height *at
   * the last scroll*. So before any scroll, and after the header changes height, it
   * reported the header's height for a list at the very top: a lift there drew the copy a
   * header above the finger, over the toolbar, with the slot hidden, and the list view
   * auto-scrolled the wrong way. The raw `contentOffset.y` this hook records is 0 at mount
   * and exact after every scroll event.
   */
  const scrollTop = () => scrollY.current;

  useEffect(() => {
    scrollY.current = 0;
  }, [listKey]);

  const frameOf = (current: Live): LiftFrame | null =>
    current.x === null
      ? null
      : { x: current.x, y: current.y, width: current.origin.width, height: current.origin.height };

  const publish = (current: Live, shifts = shiftsFor(current.from, current.to, layoutOf)) =>
    setState({
      from: current.from,
      to: current.to,
      phase: current.phase === 'dropped' ? 'dropped' : 'held',
      id: current.id,
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
    if (!current || current.phase !== 'held') return;
    // The centre of the copy under the finger, in the viewport, read back into the list's
    // layout coordinates at the list's current scroll and header.
    const point = {
      x: current.origin.x + current.origin.width / 2 + current.dx,
      y: layoutYAtViewport(
        current.y + current.origin.height / 2 + current.dy,
        firstItemOffset(),
        scrollTop(),
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

  /** Everything back to rest, at once: the copy gone, the cells in place. */
  const clear = () => {
    stopAuto();
    if (fallback.current) clearTimeout(fallback.current);
    fallback.current = null;
    travel.stopAnimation();
    scale.stopAnimation();
    live.current = null;
    setState(null);
    travel.setValue({ x: 0, y: 0 });
    scale.setValue(LIFT_SCALE);
  };

  /**
   * **Release** (Android QA, 2026-11-20). The copy glides from under the finger into the slot
   * it is going to (or back to its own, for a release that moves nothing), shrinking to its
   * resting size, in `SETTLE_MS`. Only then is the move handed over. The copy and the gap
   * stay as they are until the caller's list shows the new order (`settle()`), so the copy
   * becomes the cell in place: no flash of the old order, no duplicate and no blank slot.
   * Reduce Motion settles at once. A caller that never confirms is released after a moment,
   * so a refused move cannot leave a copy on screen.
   */
  const release = () => {
    const current = live.current;
    if (!current || current.phase !== 'held') return;
    stopAuto();
    const moved = current.start !== null && current.to !== current.from;
    const slot = moved ? layoutOf(current.to) : current.origin;
    if (current.x === null || !slot) {
      clear();
      if (moved) onDrop(current.from, current.to);
      return;
    }
    current.phase = 'settling';
    const inset = current.x - current.origin.x;
    const target = {
      x: inset + slot.x - current.x,
      y: itemTopInViewport(slot.y, firstItemOffset(), scrollTop()) - current.y,
    };
    const done = () => {
      if (live.current !== current) return;
      if (!moved) {
        clear();
        return;
      }
      current.phase = 'dropped';
      publish(current);
      fallback.current = setTimeout(() => {
        if (live.current === current) clear();
      }, DROP_FALLBACK_MS);
      onDrop(current.from, current.to);
    };
    if (reduced) {
      travel.setValue(target);
      scale.setValue(1);
      done();
      return;
    }
    Animated.parallel([
      Animated.timing(travel, {
        toValue: target,
        duration: SETTLE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: SETTLE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(done);
  };

  /** The caller's list now shows the move: the copy and the gap can go, in this render. */
  const settle = () => {
    if (live.current?.phase === 'dropped') clear();
  };

  /**
   * Lifts the item at `index`, whose own view is `node`.
   *
   * The copy's top is computed here, synchronously, from the list (see the header). Only its
   * left edge is measured, and only the first time on a screen: every later lift reuses it.
   */
  const lift = (index: number, node: View | null, id: string | null = null) => {
    const container = containerRef.current;
    if (!node || !container || index < 0 || index >= count) return;
    // A title still settling from the last drop is finished now, rather than refusing the
    // reader's next long-press: the copy and the gap belong to a move already handed over.
    if (live.current?.phase === 'dropped') clear();
    if (live.current) return;
    const origin = layoutOf(index);
    // Not laid out (never expected for a title the reader is touching): nothing to lift.
    if (!origin) return;
    const lifted: Live = {
      from: index,
      to: index,
      phase: 'held',
      id,
      y: itemTopInViewport(origin.y, firstItemOffset(), scrollTop()),
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
    scale.setValue(LIFT_SCALE);
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
        if (live.current === lifted) clear();
      },
    );
  };

  /** Android Back while a title is held puts it back, and is not also a navigation. */
  const holding = state !== null;
  useEffect(() => {
    if (!holding) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (live.current?.phase !== 'held') return false;
      clear();
      return true;
    });
    return () => subscription.remove();
    // `clear` reads refs only; re-subscribing on every render would add nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);

  /** A lift released before the finger moved is not a drop: the press ended it. */
  const releaseWithoutMoving = () => {
    if (live.current?.phase === 'held' && live.current.start === null) clear();
  };

  const containerProps: ViewProps = {
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current = event.nativeEvent.layout.height;
    },
    onMoveShouldSetResponderCapture: () => live.current?.phase === 'held',
    onMoveShouldSetResponder: () => live.current?.phase === 'held',
    onResponderGrant: (event: GestureResponderEvent) => {
      if (live.current?.phase === 'held') {
        live.current.start = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
      }
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const current = live.current;
      if (!current?.start || current.phase !== 'held') return;
      current.dx = event.nativeEvent.pageX - current.start.x;
      current.dy = event.nativeEvent.pageY - current.start.y;
      travel.setValue({ x: current.dx, y: current.dy });
      retarget();
      steer();
    },
    onResponderTerminationRequest: () => false,
    onResponderRelease: () => release(),
    // The system took the gesture: put the title back at once. Not while settling, when the
    // finger has already let go and the move is being handed over.
    onResponderTerminate: () => {
      if (live.current?.phase === 'held') clear();
    },
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
    scale,
    containerProps,
    onScroll,
    lift,
    releaseWithoutMoving,
    shiftOf,
    settle,
    cancel: clear,
  };
}

export type LiftDrag = ReturnType<typeof useLiftDrag>;
