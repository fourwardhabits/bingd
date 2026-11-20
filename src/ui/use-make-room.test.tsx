import { act, renderHook } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { useMakeRoom } from './use-make-room';

jest.mock('./motion', () => ({ useReducedMotion: () => mockReduced }));
let mockReduced = false;

/**
 * A cell stepping aside for a held title (Android QA, 2026-11-20): eased while held, placed
 * at once when it is a different title (a recycled cell), under Reduce Motion, and when the
 * hold ends, so a drop's new order is never drawn under offsets easing back.
 */
const valueOf = (offset: Animated.ValueXY) =>
  (offset as unknown as { __getValue: () => { x: number; y: number } }).__getValue();

describe('useMakeRoom', () => {
  beforeEach(() => {
    mockReduced = false;
  });

  it('eases to a new offset while held', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    type Props = { shift: { x: number; y: number } | null };
    const hook = await renderHook(({ shift }: Props) => useMakeRoom(shift, 'a'), {
      initialProps: { shift: null } as Props,
    });
    await act(async () => hook.rerender({ shift: { x: 0, y: -72 } }));
    expect(timing).toHaveBeenCalledWith(
      hook.result.current,
      expect.objectContaining({ toValue: { x: 0, y: -72 }, useNativeDriver: true }),
    );
    timing.mockRestore();
  });

  it('is placed at once when the hold ends, a new title arrives, or Reduce Motion is on', async () => {
    type Props = { shift: { x: number; y: number } | null; id: string };
    const hook = await renderHook(({ shift, id }: Props) => useMakeRoom(shift, id), {
      initialProps: { shift: { x: 0, y: -72 }, id: 'a' } as Props,
    });
    await act(async () => hook.rerender({ shift: null, id: 'a' }));
    expect(valueOf(hook.result.current)).toEqual({ x: 0, y: 0 });

    await act(async () => hook.rerender({ shift: { x: 118, y: 0 }, id: 'b' }));
    expect(valueOf(hook.result.current)).toEqual({ x: 118, y: 0 });

    mockReduced = true;
    await act(async () => hook.rerender({ shift: { x: 0, y: 177 }, id: 'b' }));
    expect(valueOf(hook.result.current)).toEqual({ x: 0, y: 177 });
  });
});
