import { act, renderHook } from '@testing-library/react-native';
import type { FlashListRef } from '@shopify/flash-list';
import { Animated, BackHandler, type GestureResponderEvent, type View } from 'react-native';

import { itemTopInViewport, layoutYAtViewport, type Rect } from './drag-geometry';
import { DROP_FALLBACK_MS, LIFT_SCALE, SETTLE_MS, useLiftDrag } from './use-lift-drag';

// Reduce Motion settles a release at once; most tests use it, the settle tests turn it off.
let mockReduced = true;
jest.mock('@/ui/motion', () => ({ useReducedMotion: () => mockReduced }));

/**
 * The Collection drag against a fake FlashList (Android QA, 2026-11-20).
 *
 * The founder's two reproductions on a Galaxy S25 Ultra:
 *   1. Poster: scroll down slightly, long-press Iron Man, drag. The copy appears displaced
 *      from the finger.
 *   2. List: scroll to Battleship, lift it. The row jumps or floats near the bottom.
 *
 * Both are a lift after a scroll. The copy's top used to come from `measureLayout`, whose
 * value inside a scrolled list can lag the real offset on Android's new architecture. The
 * fake here does exactly that: its `measureLayout` answers asynchronously, with the right
 * left edge and a deliberately stale top. Every test that lifts after a scroll proves the
 * copy is drawn from the list's own numbers instead.
 *
 * What Jest cannot prove is the native feel: touch latency, the responder handoff from a
 * real Android scroll view, frame pacing. Those stay on the device checklist.
 */

const COLUMNS = 3;
const TILE = { width: 110, height: 165 };
const GAP_Y = 12;
const HEADER = 220; // getFirstItemOffset: the toolbar, cards and count above the wall
const INSET_X = 16; // the wall's gutter: where layout x = 0 sits inside the container
const STALE_Y = 9_999;

type Fake = {
  layouts: (Rect | undefined)[];
  header: number;
  scroll: number;
  scrolledTo: number[];
};

const grid = (count: number): Rect[] =>
  Array.from({ length: count }, (_, i) => ({
    x: (i % COLUMNS) * (TILE.width + 8),
    y: Math.floor(i / COLUMNS) * (TILE.height + GAP_Y),
    ...TILE,
  }));

const rows = (count: number, height = 72): Rect[] =>
  Array.from({ length: count }, (_, i) => ({ x: 0, y: i * height, width: 360, height }));

const fakeList = (fake: Fake) =>
  ({
    current: {
      getLayout: (index: number) => fake.layouts[index],
      getFirstItemOffset: () => fake.header,
      getAbsoluteLastScrollOffset: () => fake.scroll,
      getChildContainerDimensions: () => ({ width: 360, height: 10_000 }),
      scrollToOffset: ({ offset }: { offset: number }) => {
        fake.scroll = offset;
        fake.scrolledTo.push(offset);
      },
    },
  }) as unknown as React.RefObject<FlashListRef<unknown>>;

/** A cell's view: measured asynchronously, right on x and stale on y, like the device. */
const pendingMeasures: (() => void)[] = [];
const cell = (layout: Rect | undefined): View =>
  ({
    measureLayout: (_container: unknown, ok: (x: number, y: number, w: number, h: number) => void) => {
      pendingMeasures.push(() => ok(INSET_X + (layout?.x ?? 0), STALE_Y, layout?.width ?? 0, layout?.height ?? 0));
    },
  }) as unknown as View;

const flushMeasures = () => {
  while (pendingMeasures.length) pendingMeasures.shift()?.();
};

const touch = (pageX: number, pageY: number) =>
  ({ nativeEvent: { pageX, pageY } }) as unknown as GestureResponderEvent;

const setup = async (
  layouts: Rect[],
  {
    scroll = 0,
    count = layouts.length,
    viewport = 700,
    resolve,
  }: {
    scroll?: number;
    count?: number;
    viewport?: number;
    resolve?: (from: number, to: number) => number | null;
  } = {},
) => {
  const fake: Fake = { layouts, header: HEADER, scroll, scrolledTo: [] };
  const onDrop = jest.fn();
  const onRefuse = jest.fn();
  const hook = await renderHook(
    ({ layoutKey }: { layoutKey: string }) =>
      useLiftDrag({
        listRef: fakeList(fake),
        containerRef: { current: {} as View },
        count,
        isOutside: () => false,
        onDrop,
        resolve,
        onRefuse,
        layoutKey,
      }),
    { initialProps: { layoutKey: 'poster:360' } },
  );
  await act(async () => {
    hook.result.current.containerProps.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: viewport } },
    } as never);
    hook.result.current.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scroll } } } as never);
  });
  return { fake, onDrop, onRefuse, hook };
};

beforeEach(() => {
  pendingMeasures.length = 0;
  mockReduced = true;
});

describe('the copy is drawn where the title is, after a scroll (reproductions 1 and 2)', () => {
  it('Poster: lifts Iron Man after scrolling down, over the tile, ignoring a stale measurement', async () => {
    const layouts = grid(30);
    const { hook } = await setup(layouts, { scroll: 240 });
    const ironMan = 4; // second row, middle column

    await act(async () => hook.result.current.lift(ironMan, cell(layouts[ironMan])));

    // Held at once: the list stops scrolling now, not a frame from now.
    expect(hook.result.current.state).not.toBeNull();
    // The first lift on a screen waits one frame for the left edge, and hides nothing yet.
    expect(hook.result.current.state?.frame).toBeNull();
    expect(hook.result.current.shiftOf(ironMan)).toBeNull();

    await act(async () => flushMeasures());

    const expectedTop = itemTopInViewport((layouts[ironMan] as Rect).y, HEADER, 240);
    expect(hook.result.current.state?.frame).toEqual({
      x: INSET_X + (layouts[ironMan] as Rect).x,
      y: expectedTop,
      width: TILE.width,
      height: TILE.height,
    });
    expect(hook.result.current.state?.frame?.y).not.toBe(STALE_Y);
    expect(hook.result.current.shiftOf(ironMan)).toEqual({ hidden: true, x: 0, y: 0 });
  });

  it('List: lifts Battleship far down the list, over its row', async () => {
    const layouts = rows(80);
    const { hook } = await setup(layouts, { scroll: 3_900 });
    const battleship = 57;

    await act(async () => hook.result.current.lift(battleship, cell(layouts[battleship])));
    await act(async () => flushMeasures());

    // 220 + 57 × 72 − 3900 = 424: inside a 700pt viewport, where the finger is.
    expect(hook.result.current.state?.frame?.y).toBe(424);
    expect(hook.result.current.state?.frame?.x).toBe(INSET_X);
  });

  it('every later lift on the screen is placed at once, with no measurement', async () => {
    const layouts = grid(30);
    const { hook } = await setup(layouts, { scroll: 120 });
    await act(async () => hook.result.current.lift(1, cell(layouts[1])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.cancel());

    await act(async () => hook.result.current.lift(7, cell(layouts[7])));
    expect(pendingMeasures).toHaveLength(0);
    expect(hook.result.current.state?.frame).toEqual({
      x: INSET_X + (layouts[7] as Rect).x,
      y: itemTopInViewport((layouts[7] as Rect).y, HEADER, 120),
      width: TILE.width,
      height: TILE.height,
    });
  });

  it('a change of view or width forgets the learned left edge (Codex, PR 319)', async () => {
    const layouts = grid(30);
    const { hook } = await setup(layouts);
    await act(async () => hook.result.current.lift(1, cell(layouts[1])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.cancel());

    // Poster -> List: the wall's gutter is not the list's, so the next lift measures again.
    await act(async () => hook.rerender({ layoutKey: 'list:360' }));
    await act(async () => hook.result.current.lift(2, cell(layouts[2])));
    expect(pendingMeasures).toHaveLength(1);
    expect(hook.result.current.state?.frame).toBeNull();
  });

  it('a measurement that lands after the release changes nothing', async () => {
    const layouts = rows(10);
    const { hook } = await setup(layouts);
    await act(async () => hook.result.current.lift(2, cell(layouts[2])));
    await act(async () => hook.result.current.releaseWithoutMoving());
    await act(async () => flushMeasures());
    expect(hook.result.current.state).toBeNull();
  });

  it('a title the list has not laid out is not lifted', async () => {
    const layouts: (Rect | undefined)[] = rows(10);
    layouts[6] = undefined;
    const { hook } = await setup(layouts as Rect[]);
    await act(async () => hook.result.current.lift(6, cell(undefined)));
    expect(hook.result.current.state).toBeNull();
  });
});

describe('the finger and the target', () => {
  it('moves before the responder is granted do nothing; travel counts from the grant', async () => {
    const layouts = rows(20);
    const { hook } = await setup(layouts, { scroll: 300 });
    await act(async () => hook.result.current.lift(8, cell(layouts[8])));
    await act(async () => flushMeasures());

    // A move with no grant yet (the long-press handed over mid-move) is not travel.
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 900)));
    expect(hook.result.current.state?.to).toBe(8);

    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 500)));
    // Two rows down from where the grant was.
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 500 + 144)));
    expect(hook.result.current.state?.to).toBe(10);
  });

  it('the target is read from what is on screen, after a scroll, in the grid', async () => {
    const layouts = grid(30);
    const { hook } = await setup(layouts, { scroll: 240 });
    await act(async () => hook.result.current.lift(4, cell(layouts[4])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(180, 400)));
    // One row down and one column right: index 4 + 3 + 1.
    await act(async () =>
      hook.result.current.containerProps.onResponderMove?.(touch(180 + 118, 400 + TILE.height + GAP_Y)),
    );
    expect(hook.result.current.state?.to).toBe(8);
  });

  it('a header that changes height mid-gesture does not separate the target from the finger', async () => {
    const layouts = rows(20);
    const { fake, hook } = await setup(layouts, { scroll: 0 });
    await act(async () => hook.result.current.lift(3, cell(layouts[3])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));

    // The header grows by a row's height while the title is held: everything below it moves
    // down one row on screen. The copy under the finger is now over what was one row up.
    fake.header = HEADER + 72;
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 301)));
    const frame = hook.result.current.state?.frame as NonNullable<typeof hook.result.current.state>['frame'];
    const underFinger = layoutYAtViewport((frame?.y ?? 0) + 72 / 2 + 1, fake.header, 0);
    expect(hook.result.current.state?.to).toBe(Math.floor(underFinger / 72));
    expect(hook.result.current.state?.to).toBe(2);
  });

  it('auto-scroll near the bottom edge scrolls the list and keeps the target under the copy', async () => {
    jest.useFakeTimers();
    try {
      const layouts = rows(80);
      const { fake, hook } = await setup(layouts, { scroll: 500, viewport: 700 });
      await act(async () => hook.result.current.lift(10, cell(layouts[10])));
      await act(async () => flushMeasures());
      const startTop = hook.result.current.state?.frame?.y ?? 0;
      await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
      // Carry the copy's centre deep into the bottom band, and hold it there.
      const dy = 700 - 10 - (startTop + 36);
      await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + dy)));
      const before = hook.result.current.state?.to ?? 0;
      await act(async () => {
        jest.advanceTimersByTime(16 * 20);
      });
      expect(fake.scrolledTo.length).toBeGreaterThan(0);
      expect(fake.scroll).toBeGreaterThan(500);
      const centre = layoutYAtViewport(startTop + 36 + dy, HEADER, fake.scroll);
      expect(hook.result.current.state?.to).toBe(Math.min(79, Math.floor(centre / 72)));
      expect(hook.result.current.state?.to).toBeGreaterThan(before);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a release after moving drops on the target; one without moving drops nothing', async () => {
    const layouts = rows(20);
    const { hook, onDrop } = await setup(layouts);
    await act(async () => hook.result.current.lift(2, cell(layouts[2])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 72 * 3)));
    await act(async () => hook.result.current.containerProps.onResponderRelease?.(touch(50, 300 + 72 * 3)));
    expect(onDrop).toHaveBeenCalledWith(2, 5);
    // Held, as dropped, until the caller's list shows the move.
    expect(hook.result.current.state).toMatchObject({ phase: 'dropped', from: 2, to: 5 });
    await act(async () => hook.result.current.settle());
    expect(hook.result.current.state).toBeNull();

    await act(async () => hook.result.current.lift(4, cell(layouts[4])));
    await act(async () => hook.result.current.releaseWithoutMoving());
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('the cells between make room by index, and only those', async () => {
    const layouts = rows(20);
    const { hook } = await setup(layouts);
    await act(async () => hook.result.current.lift(2, cell(layouts[2])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 72 * 2)));
    expect(hook.result.current.shiftOf(3)).toEqual({ hidden: false, x: 0, y: -72 });
    expect(hook.result.current.shiftOf(4)).toEqual({ hidden: false, x: 0, y: -72 });
    expect(hook.result.current.shiftOf(5)).toBeNull();
    expect(hook.result.current.shiftOf(1)).toBeNull();
  });
});

describe('Android Back', () => {
  it('puts a held title back, drops nothing, and consumes the press', async () => {
    type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: BackListener[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_, handler) => {
      handlers.push(handler);
      return { remove: () => handlers.splice(handlers.indexOf(handler), 1) };
    });
    try {
      const layouts = rows(10);
      const { hook, onDrop } = await setup(layouts);
      await act(async () => hook.result.current.lift(2, cell(layouts[2])));
      await act(async () => flushMeasures());
      await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
      await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 450)));
      let consumed: boolean | null | undefined;
      await act(async () => {
        consumed = handlers[handlers.length - 1]?.({} as never);
      });
      expect(consumed).toBe(true);
      expect(hook.result.current.state).toBeNull();
      expect(onDrop).not.toHaveBeenCalled();
      // Not held any more: Back is the screen's again.
      expect(handlers).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * **Release** (Android QA, 2026-11-20: "a visible flash or abrupt repositioning"). The copy
 * glides into its slot and settles to its resting size; the move is handed over only then;
 * and the copy and the gap stay until the caller's list shows the new order.
 */
describe('the drop', () => {
  it('glides the copy into the target slot, then hands the move over, then waits to be settled', async () => {
    mockReduced = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const layouts = rows(20);
      const { hook, onDrop } = await setup(layouts, { scroll: 0 });
      await act(async () => hook.result.current.lift(2, cell(layouts[2]), 'heat'));
      await act(async () => flushMeasures());
      await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
      await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 72 * 3 + 20)));
      await act(async () => hook.result.current.containerProps.onResponderRelease?.(touch(50, 300 + 72 * 3 + 20)));

      // Gliding: nothing handed over yet, and a new lift is not taken.
      expect(onDrop).not.toHaveBeenCalled();
      await act(async () => hook.result.current.lift(9, cell(layouts[9])));
      expect(hook.result.current.state?.from).toBe(2);

      await act(async () => {
        jest.advanceTimersByTime(SETTLE_MS + 20);
      });
      expect(onDrop).toHaveBeenCalledWith(2, 5);
      // The copy is sent exactly over slot 5 (three rows down from where it was lifted),
      // at its resting size. Asserted as the animation's target: native-driver animations
      // in Jest finish without writing the JS-side value.
      const targets = timing.mock.calls.map(([, config]) => (config as { toValue: unknown }).toValue);
      expect(targets).toContainEqual({ x: 0, y: 72 * 3 });
      expect(targets).toContainEqual(1);
      expect(hook.result.current.state).toMatchObject({ phase: 'dropped', id: 'heat', to: 5 });

      await act(async () => hook.result.current.settle());
      expect(hook.result.current.state).toBeNull();
      expect((hook.result.current.scale as unknown as { __getValue: () => number }).__getValue()).toBe(LIFT_SCALE);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('the TV wall: glides to where the show will be drawn, and hands over the drop slot', async () => {
    mockReduced = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const layouts = rows(20);
      const { hook, onDrop, onRefuse } = await setup(layouts, { resolve: () => 7 });
      await act(async () => hook.result.current.lift(2, cell(layouts[2]), 'show'));
      await act(async () => flushMeasures());
      await act(async () =>
        hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)),
      );
      await act(async () =>
        hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 72 * 3 + 20)),
      );
      await act(async () =>
        hook.result.current.containerProps.onResponderRelease?.(touch(50, 300 + 72 * 3 + 20)),
      );
      // The cells make room at the landing at once.
      expect(hook.result.current.state?.to).toBe(7);
      await act(async () => {
        jest.advanceTimersByTime(SETTLE_MS + 20);
      });
      const targets = timing.mock.calls.map(
        ([, config]) => (config as { toValue: unknown }).toValue,
      );
      expect(targets).toContainEqual({ x: 0, y: 72 * 5 });
      expect(onDrop).toHaveBeenCalledWith(2, 5);
      expect(onRefuse).not.toHaveBeenCalled();
      expect(hook.result.current.state).toMatchObject({ phase: 'dropped', id: 'show', to: 7 });
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('the TV wall: a drop that changes nothing glides home and is refused, not dropped', async () => {
    mockReduced = false;
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const layouts = rows(20);
      const { hook, onDrop, onRefuse } = await setup(layouts, { resolve: () => null });
      await act(async () => hook.result.current.lift(2, cell(layouts[2]), 'show'));
      await act(async () => flushMeasures());
      await act(async () =>
        hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)),
      );
      await act(async () =>
        hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 72 * 3 + 20)),
      );
      await act(async () =>
        hook.result.current.containerProps.onResponderRelease?.(touch(50, 300 + 72 * 3 + 20)),
      );
      // The gap closes while the copy goes home.
      expect(hook.result.current.state?.to).toBe(2);
      await act(async () => {
        jest.advanceTimersByTime(SETTLE_MS + 20);
      });
      const targets = timing.mock.calls.map(
        ([, config]) => (config as { toValue: unknown }).toValue,
      );
      expect(targets).toContainEqual({ x: 0, y: 0 });
      expect(onDrop).not.toHaveBeenCalled();
      expect(onRefuse).toHaveBeenCalledWith(2, 5);
      expect(hook.result.current.state).toBeNull();
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('a release that moves nothing glides back and drops nothing', async () => {
    mockReduced = false;
    jest.useFakeTimers();
    try {
      const layouts = rows(20);
      const { hook, onDrop } = await setup(layouts);
      await act(async () => hook.result.current.lift(2, cell(layouts[2])));
      await act(async () => flushMeasures());
      await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
      await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 310)));
      await act(async () => hook.result.current.containerProps.onResponderRelease?.(touch(50, 310)));
      await act(async () => {
        jest.advanceTimersByTime(SETTLE_MS + 20);
      });
      expect(onDrop).not.toHaveBeenCalled();
      expect(hook.result.current.state).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a drop the caller never confirms is released after a moment, so no copy is left behind', async () => {
    jest.useFakeTimers();
    try {
      const layouts = rows(20);
      const { hook } = await setup(layouts);
      await act(async () => hook.result.current.lift(2, cell(layouts[2])));
      await act(async () => flushMeasures());
      await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
      await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 300 + 144)));
      await act(async () => hook.result.current.containerProps.onResponderRelease?.(touch(50, 300 + 144)));
      expect(hook.result.current.state?.phase).toBe('dropped');
      await act(async () => {
        jest.advanceTimersByTime(DROP_FALLBACK_MS + 10);
      });
      expect(hook.result.current.state).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a long-press during the wait after a drop is taken, not refused', async () => {
    const layouts = rows(20);
    const { hook } = await setup(layouts);
    await act(async () => hook.result.current.lift(2, cell(layouts[2])));
    await act(async () => flushMeasures());
    await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(50, 300)));
    await act(async () => hook.result.current.containerProps.onResponderMove?.(touch(50, 444)));
    await act(async () => hook.result.current.containerProps.onResponderRelease?.(touch(50, 444)));
    expect(hook.result.current.state?.phase).toBe('dropped');
    await act(async () => hook.result.current.lift(0, cell(layouts[0]), 'top'));
    expect(hook.result.current.state).toMatchObject({ phase: 'held', from: 0, id: 'top' });
  });
});

/**
 * **The top of the list, after drags** (Android QA, 2026-11-20: "the top three posters
 * sometimes stop responding"). FlashList's `getAbsoluteLastScrollOffset()` reports the
 * header's height for a list at the very top before any scroll, and after the header changes
 * height. The fake reports exactly that; the copy must still be drawn over the title.
 */
describe('the top three, repeatedly', () => {
  it('lifts #1, #2 and #3 over themselves at offset zero, drag after drag, even when FlashList misreports the offset', async () => {
    const layouts = grid(30);
    const { fake, hook, onDrop } = await setup(layouts, { scroll: 0 });
    // FlashList's tracker before any scroll: header height, not 0.
    fake.scroll = HEADER;
    for (let round = 0; round < 4; round += 1) {
      for (const index of [0, 1, 2]) {
        await act(async () => hook.result.current.lift(index, cell(layouts[index]), `t${index}`));
        await act(async () => flushMeasures());
        const frame = hook.result.current.state?.frame;
        expect(frame?.y).toBe(itemTopInViewport(0, HEADER, 0));
        expect(frame?.x).toBe(INSET_X + (layouts[index] as Rect).x);
        await act(async () => hook.result.current.containerProps.onResponderGrant?.(touch(60, 300)));
        await act(async () =>
          hook.result.current.containerProps.onResponderMove?.(touch(60, 300 + TILE.height + GAP_Y)),
        );
        await act(async () =>
          hook.result.current.containerProps.onResponderRelease?.(touch(60, 300 + TILE.height + GAP_Y)),
        );
        await act(async () => hook.result.current.settle());
        expect(hook.result.current.state).toBeNull();
      }
    }
    expect(onDrop).toHaveBeenCalledTimes(12);
  });

  it('after scrolling down and back to the top, #1 is drawn over itself', async () => {
    const layouts = grid(30);
    const { hook } = await setup(layouts, { scroll: 0 });
    await act(async () => hook.result.current.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 900 } } } as never));
    await act(async () => hook.result.current.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } } as never));
    await act(async () => hook.result.current.lift(0, cell(layouts[0])));
    await act(async () => flushMeasures());
    expect(hook.result.current.state?.frame?.y).toBe(HEADER);
  });

  it('a new list (Poster to List) starts at the top', async () => {
    const layouts = rows(20);
    const fake: Fake = { layouts, header: HEADER, scroll: 0, scrolledTo: [] };
    const hook = await renderHook(
      ({ listKey }: { listKey: string }) =>
        useLiftDrag({
          listRef: fakeList(fake),
          containerRef: { current: {} as View },
          count: 20,
          isOutside: () => false,
          onDrop: jest.fn(),
          listKey,
        }),
      { initialProps: { listKey: 'poster' } },
    );
    await act(async () => hook.result.current.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 640 } } } as never));
    await act(async () => hook.rerender({ listKey: 'list' }));
    await act(async () => hook.result.current.lift(0, cell(layouts[0])));
    await act(async () => flushMeasures());
    expect(hook.result.current.state?.frame?.y).toBe(HEADER);
  });
});
