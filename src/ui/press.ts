import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';

import { useReducedMotion } from './motion';

/**
 * How far a control gives under a thumb.
 *
 * **0.975, and the range it was chosen from is 0.97–0.985** (founder, 2026-09-08). The
 * brief is "physical, not cartoon": at 0.95 a chip visibly shrinks and the row around it
 * appears to move; at 0.99 nothing is felt on a 60Hz Android panel. 0.975 is about a
 * point of travel on a 44pt control — under the threshold at which it reads as an
 * animation, over the threshold at which it reads as nothing.
 *
 * One number for every control rather than one per size. A poster tile that gave more
 * than a button would say the tile is a different kind of object, and it is not: they
 * are both things you press.
 */
const PRESSED_SCALE = 0.975;

/**
 * Down fast, back slower — which is the asymmetry that makes it feel like a surface
 * rather than a transition.
 *
 * Down is 90ms and effectively immediate: the founder's word is "immediate", and a press
 * that eases in has already lost the argument. Coming back is 160ms on `Easing.out`, so
 * the control settles rather than snapping — the release is the only half a reader
 * actually watches, because on the way down their thumb is over it.
 *
 * Timing rather than a spring, deliberately. A spring at this amplitude either overshoots
 * visibly, which is the bounce the brief rules out, or is damped hard enough that it is a
 * curve with extra machinery.
 */
const DOWN_MS = 90;
const UP_MS = 160;

/**
 * Subtle physical press feedback for a high-frequency control.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HOOK AND NOT A COMPONENT
 *
 * Every control this is applied to already has a considered `style` function, its own
 * accessibility contract, its own `hitSlop` arithmetic, and in two cases its own long
 * press. A wrapper *component* would have to forward all of that. So the hook returns two
 * handlers and a style, and the call site keeps the `Pressable` it already has, spreads
 * the handlers onto it, and puts `pressStyle` on a bare `Animated.View` around it.
 *
 * ---------------------------------------------------------------------------
 * **WHY THE TRANSFORM IS ON A WRAPPER AND NOT ON THE PRESSABLE ITSELF**
 *
 * The obvious implementation is `Animated.createAnimatedComponent(Pressable)`, and it was
 * written that way first. It is correct at runtime and it is wrong here for a reason worth
 * recording: **an animated component does not expose `style` on its host node to the test
 * renderer.** `Animated` applies styles imperatively, so under React Native Testing
 * Library the chip, the button and the Rank control each rendered with `props.style ===
 * undefined` — and this codebase asserts founder locks off exactly that prop: the chip's
 * 32pt height and 44pt slop, the Rank button's 150–170 max width, the social chips' Maroon
 * hairline. Ten of those assertions went from *passing* to *unable to see the thing they
 * are about*, which would have meant deleting them to ship a press animation.
 *
 * A wrapper costs one host `View` with no style but a transform. It changes no layout — a
 * bare `View` hugs or stretches exactly as its child would in the same slot — and every
 * existing assertion keeps reading the node it was written for.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT BELONGS, AND WHERE IT DOES NOT
 *
 * High-frequency surfaces where the tap is the point: chips, poster tiles, the comparison
 * cards, the Rank/Ranked control and the title page's icon actions. **Not every
 * `Pressable` in the app.** A list row that already feels right under a thumb is left
 * alone — animating it would be motion added because it was available, which is the thing
 * the doctrine in `design-system.md` §10b forbids.
 *
 * ---------------------------------------------------------------------------
 * **`Button` IS DELIBERATELY NOT ONE OF THEM, AND THE REASON IS STRUCTURAL**
 *
 * It was, for one round, and it is the reason the exclusion is written down rather than
 * left as an omission somebody will "fix". `Button` is the app's most-reused control and
 * its **parentage is load-bearing**: callers put two of them in a row inside `flex: 1`
 * slots, and four suites assert exactly that — `expect(rank.parent).toBe(notNow.parent)`
 * for a pair that must share a row, and `button.parent.style.flex === 1` for a pair that
 * must take equal halves. A wrapper gives each button a parent of its own, so those five
 * assertions fail — and they are founder locks about layout, not incidental detail.
 *
 * Shipping the animation would have meant weakening them. The trade is the wrong way
 * round: a button already has press feedback (its opacity drops), the scale would have
 * added a little, and what it would have cost is the only guard the repo has that two
 * controls still share a row. Revisit it by giving `Button` a layout-forwarding wrapper
 * and updating those locks *deliberately*, not as collateral.
 *
 * ---------------------------------------------------------------------------
 * REDUCE MOTION
 *
 * Honoured by not animating at all: `enabled` goes false and the scale is pinned at 1, so
 * the control still has whatever opacity change its own `style` function applies and has
 * no transform. That is the right reduction here — the point of the setting is that
 * things do not move, and a slower shrink is still a shrink.
 *
 * `useNativeDriver` throughout, so the transform runs off the JS thread and a press that
 * lands while a query is resolving still feels immediate.
 */
export function usePressScale({ enabled = true }: { enabled?: boolean } = {}) {
  const reducedMotion = useReducedMotion();
  // `useState` with a lazy initialiser rather than `useRef(...).current`, which is what
  // this codebase uses everywhere else it holds an `Animated.Value` (`SkeletonRow`,
  // `DetailHeader`, the title page's scroll position). The React Compiler is on in
  // `babel.config.js` and reading a ref during render is an error under it.
  const [scale] = useState(() => new Animated.Value(1));
  const active = enabled && !reducedMotion;

  /**
   * **Rest is restored unconditionally, and that is independent review 78's third P1.**
   *
   * The first version returned early from *both* handlers when animation was off, which
   * has a sequence: press in, the control starts travelling to 0.975, Reduce Motion is
   * switched on — or the asynchronous first read of it lands — and press-out returns
   * without doing anything. The control stays visibly shrunk, permanently, until the
   * screen is rebuilt.
   *
   * So `active` decides *how* the value returns to rest, never *whether* it does. When
   * animation is off the scale is set to 1 outright, which is also the correct behaviour
   * for a reader who turned Reduce Motion on mid-press: the movement stops at once
   * rather than easing out politely.
   */
  const settle = (value: number, duration: number) => {
    scale.stopAnimation();
    if (!active) {
      // Never mid-shrink: with animation off the only legal resting state is 1.
      scale.setValue(1);
      return;
    }
    Animated.timing(scale, {
      toValue: value,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  /**
   * And if the preference changes while a control happens to be held down, the value is
   * put back without waiting for a press-out that may never come — the reader may lift
   * their thumb outside the target, or the sheet under it may close.
   */
  useEffect(() => {
    if (active) return;
    scale.stopAnimation();
    scale.setValue(1);
  }, [active, scale]);

  return {
    onPressIn: () => settle(PRESSED_SCALE, DOWN_MS),
    onPressOut: () => settle(1, UP_MS),
    /**
     * Spread into the control's own style array, last, so it composes with whatever the
     * control's `style` function already returns rather than replacing it.
     */
    pressStyle: { transform: [{ scale }] },
  };
}

/**
 * A control that has just changed state, acknowledging it with one small pulse.
 *
 * The bookmark is what this exists for. Off to on is a real state change and the icon
 * swap alone happens *between* frames — there is no moment at which anything moved, so on
 * a device the change is something the reader notices afterwards rather than something
 * they see happen. A 1 → 1.18 → 1 pulse over a quarter of a second is the smallest
 * gesture that says *that landed*, and it is deliberately larger than a press because it
 * is answering the outcome rather than the touch.
 *
 * **Only in one direction.** Turning a bookmark *off* gets no pulse: a celebration for
 * undoing something is the app disagreeing with the reader. Callers pass the new state
 * and this decides.
 *
 * Reduce Motion pins it at 1, as {@link usePressScale} does and for the same reason.
 */
export function usePulse() {
  const reducedMotion = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));

  const pulse = () => {
    if (reducedMotion) return;
    scale.setValue(1);
    Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.18,
        duration: 110,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  };

  return { pulse, pulseStyle: { transform: [{ scale }] } };
}
