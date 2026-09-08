import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { PeoplePicker } from '@/features/people/PeoplePicker';

import { Button } from './components/Button';
import { FilterChip } from './components/FilterChip';
import { PosterGrid } from './components/PosterWall';

/**
 * **The interaction contract of the premium pass** (founder, 2026-09-08).
 *
 * Two things are being pinned here and they pull in opposite directions, which is why
 * they are in one file.
 *
 * **What must buzz.** The haptic vocabulary in `ui/haptics.ts` has three words and each
 * one is attached to a class of act rather than to a control. If a bookmark stopped
 * speaking, or a chip did, nothing would look wrong on any screenshot and the app would
 * simply feel less finished on a device — which is a defect no other test in this suite
 * can see.
 *
 * **What must not.** The much likelier failure is the opposite one: haptics spreading
 * until the phone buzzes at everything and the feedback stops meaning anything. So the
 * silences are asserted as hard as the sounds — opening a title from the wall is
 * navigation and stays silent, and an ordinary `Button` is not a haptic surface however
 * primary it looks.
 *
 * And underneath both: **the press feedback must be invisible to everything except a
 * thumb.** It was implemented once as an animated `Pressable` and that hid `style` from
 * the test renderer, taking ten founder-lock assertions with it (see `ui/press.ts`). The
 * last block here is the guard that the wrapper it became stays transparent.
 */

const mockHaptics = {
  selection: jest.fn(),
  impact: jest.fn(),
  notification: jest.fn(),
};

jest.mock('expo-haptics', () => ({
  selectionAsync: () => {
    mockHaptics.selection();
    return Promise.resolve();
  },
  impactAsync: (style: unknown) => {
    mockHaptics.impact(style);
    return Promise.resolve();
  },
  notificationAsync: (type: unknown) => {
    mockHaptics.notification(type);
    return Promise.resolve();
  },
  ImpactFeedbackStyle: { Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success' },
}));

beforeEach(() => {
  mockHaptics.selection.mockReset();
  mockHaptics.impact.mockReset();
  mockHaptics.notification.mockReset();
});

const tile = (over: Record<string, unknown> = {}) => ({
  id: 'film-1',
  title: 'Inception',
  year: 2010,
  posterUri: null,
  saved: false,
  ...over,
});

describe('what speaks, and in which word', () => {
  it('gives a chip the selection haptic, and passes the press through unchanged', async () => {
    // A chip row is where somebody says what they want to look at: lightweight, reversible,
    // and the commonest press in the app after a poster.
    const onPress = jest.fn();
    await render(<FilterChip icon="options-outline" label="Filters" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));

    expect(mockHaptics.selection).toHaveBeenCalledTimes(1);
    // The feedback decorates the act; it must never replace or reorder it.
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('gives a bookmark the selection haptic without disturbing the write', async () => {
    const onToggleSave = jest.fn();
    await render(
      <PosterGrid tiles={[tile()]} onPressTile={jest.fn()} onToggleSave={onToggleSave} />,
    );

    await fireEvent.press(screen.getByLabelText('Save Inception to watchlist'));

    expect(mockHaptics.selection).toHaveBeenCalledTimes(1);
    expect(onToggleSave).toHaveBeenCalledTimes(1);
  });

  it('speaks the same word when a bookmark comes off as when it goes on', async () => {
    // The *pulse* is one-directional — a flourish for undoing something is the app
    // disagreeing with the reader — but the haptic is not: both directions are the reader
    // having done something, and a control that answers one press and not its opposite
    // reads as broken rather than as considered.
    await render(
      <PosterGrid
        tiles={[tile({ saved: true })]}
        onPressTile={jest.fn()}
        onToggleSave={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText('Remove Inception from watchlist'));
    expect(mockHaptics.selection).toHaveBeenCalledTimes(1);
  });

  it('gives choosing a person the selection haptic', async () => {
    const onToggle = jest.fn();
    await render(
      <PeoplePicker
        people={[{ id: 'u-1', username: 'abby', name: 'Abby', avatarUri: null }]}
        selected={new Set()}
        onToggle={onToggle}
        searchPlaceholder="Search your friends"
      />,
    );

    await fireEvent.press(screen.getByLabelText('Abby, @abby'));

    expect(mockHaptics.selection).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('u-1');
  });
});

describe('what stays silent, which is the half that decays', () => {
  it('says nothing when a poster tile is opened', async () => {
    /**
     * **Navigation is not feedback.** Opening a title is the commonest tap in the
     * product, and a haptic on it would be the one the reader felt hundreds of times a
     * session — which is exactly how a vocabulary stops meaning anything. The tile still
     * gives visually, under a thumb.
     */
    const onPressTile = jest.fn();
    await render(<PosterGrid tiles={[tile()]} onPressTile={onPressTile} />);

    await fireEvent.press(screen.getByLabelText(/^Inception, 2010/));

    expect(onPressTile).toHaveBeenCalledTimes(1);
    expect(mockHaptics.selection).not.toHaveBeenCalled();
    expect(mockHaptics.impact).not.toHaveBeenCalled();
    expect(mockHaptics.notification).not.toHaveBeenCalled();
  });

  it('says nothing for an ordinary button, however primary it looks', async () => {
    // `Button` is the app's most-reused control — Done, Close, Try again, Save. Wiring a
    // haptic into the primitive would put one behind every one of them, which is the
    // "generic button" case `ui/haptics.ts` rules out by name.
    await render(<Button label="Done" onPress={jest.fn()} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));

    expect(mockHaptics.selection).not.toHaveBeenCalled();
    expect(mockHaptics.impact).not.toHaveBeenCalled();
    expect(mockHaptics.notification).not.toHaveBeenCalled();
  });

  it('says nothing on a render, only on an act', async () => {
    // Nothing the app does on its own may buzz. Mounting three haptic-bearing controls
    // is the cheapest proxy for that and catches the mistake of firing in an effect.
    await render(
      <>
        <FilterChip icon="options-outline" label="Filters" onPress={jest.fn()} />
        <PosterGrid tiles={[tile()]} onPressTile={jest.fn()} onToggleSave={jest.fn()} />
      </>,
    );

    expect(mockHaptics.selection).not.toHaveBeenCalled();
    expect(mockHaptics.impact).not.toHaveBeenCalled();
    expect(mockHaptics.notification).not.toHaveBeenCalled();
  });

  it('survives a platform with no haptics at all', async () => {
    /**
     * The whole error contract, as a test. Haptics are absent on web, absent on a good
     * many Android devices and refused outright when the system switch is off — none of
     * which is an error, and none of which may take the act down with it. A rejected
     * promise inside `hapticSelection` must not surface as an unhandled rejection or stop
     * the bookmark being written.
     */
    const Haptics = jest.requireMock('expo-haptics') as { selectionAsync: () => Promise<void> };
    const original = Haptics.selectionAsync;
    Haptics.selectionAsync = () => Promise.reject(new Error('no haptic engine'));

    const onPress = jest.fn();
    await render(<FilterChip icon="options-outline" label="Filters" onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));

    expect(onPress).toHaveBeenCalledTimes(1);
    Haptics.selectionAsync = original;
  });
});

describe('the press feedback is invisible to everything but a thumb', () => {
  /**
   * **The regression this exists for is a real one that happened.** The first
   * implementation wrapped each control in `Animated.createAnimatedComponent(Pressable)`,
   * which is correct at runtime and does not expose `style` on its host node to the test
   * renderer — so ten assertions about founder-locked geometry and colour silently lost
   * sight of what they were asserting. See the note in `ui/press.ts`.
   */
  it('leaves the control’s own style readable where every other test reads it', async () => {
    await render(<FilterChip icon="options-outline" label="Filters" onPress={jest.fn()} />);

    const chip = screen.getByRole('button', { name: 'Filters' });
    const style = (
      Array.isArray(chip.props.style)
        ? Object.assign({}, ...chip.props.style)
        : chip.props.style
    ) as Record<string, unknown>;

    expect(style.minHeight).toBeDefined();
    expect(style.borderColor).toBeDefined();
  });

  it('leaves roles, names and targets exactly as they were', async () => {
    await render(
      <FilterChip
        icon="mail-outline"
        label="Sent to you"
        accessibilityLabel="Sent to you, 3 unopened"
        selected
        emphasis="social"
        onPress={jest.fn()}
      />,
    );

    const chip = screen.getByRole('button', { name: 'Sent to you, 3 unopened' });
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
    expect(chip.props.hitSlop).toBeDefined();
  });

  it('actually travels down and back, and does not touch the act', async () => {
    /**
     * **Asserted on the animation rather than on the callback** (independent review 78,
     * P2). The first version of this only checked that `onPress` still fired, which would
     * have passed with the whole transform deleted — or, worse, with a press-in that
     * animates and a press-out that does not, which leaves the control visibly stuck at
     * 0.975 for ever.
     *
     * `Animated.timing` is the seam: one call down to 0.975, one call back to 1.
     */
    const timing = jest.spyOn(Animated, 'timing');
    const onPress = jest.fn();
    await render(<FilterChip icon="options-outline" label="Group Picks" onPress={onPress} />);
    const chip = screen.getByRole('button', { name: 'Group Picks' });

    await fireEvent(chip, 'pressIn');
    await fireEvent(chip, 'pressOut');
    await fireEvent.press(chip);

    const targets = timing.mock.calls.map(([, config]) => config.toValue);
    expect(targets).toEqual([0.975, 1]);
    // Down fast, back slower — the asymmetry that makes it read as a surface.
    const [down, up] = timing.mock.calls.map(([, config]) => config.duration);
    expect(down).toBeLessThan(up as number);
    expect(up).toBeLessThanOrEqual(200);
    // Off the JS thread, so a press during a resolving query still feels immediate.
    expect(timing.mock.calls.every(([, config]) => config.useNativeDriver)).toBe(true);

    expect(onPress).toHaveBeenCalledTimes(1);
    timing.mockRestore();
  });

  it('leaves `Button` out of it entirely, and that is deliberate', async () => {
    /**
     * **The one control on the founder's list that did not get the press give.**
     *
     * `Button`'s parentage is load-bearing: callers put two of them in a row inside
     * `flex: 1` slots, and four suites assert exactly that — a pair sharing one parent,
     * a pair taking equal halves. A wrapper gives each its own parent and breaks five
     * such locks. See `ui/press.ts`.
     *
     * Asserted here as *structure*, which is the property that was at stake: two buttons
     * rendered as siblings must still be siblings. A future round that animates `Button`
     * will fail this, which is the point — it should be a decision, not a side effect.
     */
    await render(
      <>
        <Button label="Rank it" onPress={jest.fn()} />
        <Button label="Not now" kind="secondary" onPress={jest.fn()} />
      </>,
    );

    const rank = screen.getByRole('button', { name: 'Rank it' });
    const notNow = screen.getByRole('button', { name: 'Not now' });
    expect(rank.parent).toBe(notNow.parent);
  });
});

describe('Reduce Motion', () => {
  /**
   * **One render, one test.** These two facts were two tests and the pair was flaky in a
   * way worth recording: `useReducedMotion` subscribes on mount and calls `.remove()` on
   * whatever `addEventListener` returned at unmount, and React Native Testing Library
   * unmounts in an `afterEach` — *after* a spy restored inside the test body. A second
   * render in the same file inherited a half-restored spy and failed on the cleanup of
   * the first. One render, both assertions.
   */
  it('suppresses the transform outright and still restores rest', async () => {
    /**
     * **Reduce Motion is honoured by not animating, never by animating slower** — and the
     * control must still end up at rest. The sequence independent review 78 found is the
     * reason the second half is here: an early return from *both* handlers leaves a
     * control that was mid-shrink permanently shrunk when the preference flips.
     */
    const isEnabled = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    const subscribe = jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() } as never);
    const timing = jest.spyOn(Animated, 'timing');

    await render(<FilterChip icon="options-outline" label="Filters" onPress={jest.fn()} />);
    const chip = screen.getByRole('button', { name: 'Filters' });

    await fireEvent(chip, 'pressIn');
    await fireEvent(chip, 'pressOut');

    // Nothing moved.
    expect(timing).not.toHaveBeenCalled();

    isEnabled.mockRestore();
    subscribe.mockRestore();
    timing.mockRestore();
  });

  it('puts a held control back when the preference changes mid-press', async () => {
    /**
     * **The sequence review 78 named as a P1, exercised** (its follow-up P2 was that the
     * fix had no test that ran it). Press in with motion allowed, switch Reduce Motion on
     * while the thumb is still down, and the control must not be left sitting at 0.975 —
     * which is exactly what an early return from both handlers produced.
     *
     * The listener is captured from the subscription rather than simulated, so this
     * exercises the real path a system event takes into the hook.
     */
    let notify: ((reduced: boolean) => void) | undefined;
    const isEnabled = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    const subscribe = jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockImplementation((_event, handler) => {
        notify = handler as unknown as (reduced: boolean) => void;
        return { remove: jest.fn() } as never;
      });
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');

    await render(<FilterChip icon="options-outline" label="Filters" onPress={jest.fn()} />);
    const chip = screen.getByRole('button', { name: 'Filters' });

    await fireEvent(chip, 'pressIn');
    setValue.mockClear();

    // The reader turns Reduce Motion on with the control still held.
    await act(async () => {
      notify?.(true);
    });

    expect(setValue).toHaveBeenCalledWith(1);

    // And releasing afterwards still leaves it at rest rather than doing nothing.
    setValue.mockClear();
    await fireEvent(chip, 'pressOut');
    expect(setValue).toHaveBeenCalledWith(1);

    isEnabled.mockRestore();
    subscribe.mockRestore();
    setValue.mockRestore();
  });

  it('is consulted, subscribed to, and does not silence the haptic', async () => {
    /**
     * The transform itself is driven natively and is not observable from here, so what is
     * asserted is the seam: the control consults the setting at all, and re-consults it
     * when it changes — somebody turning Reduce Motion on mid-session is very likely
     * doing so because of something they are looking at right now. The behaviour behind
     * the seam is one branch, `if (!active) return`, in one shared file.
     *
     * And the haptic still fires with the setting on. The two settings are separate on
     * purpose: Reduce Motion silences the transform, and the system's own haptic switch
     * silences the buzz. Conflating them would take feedback away from a reader who asked
     * only for stillness.
     */
    const isEnabled = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    // Given a real subscription object to return: a bare spy returns undefined, and the
    // hook calls `.remove()` on it at unmount.
    const subscribe = jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() } as never);

    await render(<FilterChip icon="options-outline" label="Filters" onPress={jest.fn()} />);

    expect(isEnabled).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith('reduceMotionChanged', expect.any(Function));

    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
    expect(mockHaptics.selection).toHaveBeenCalledTimes(1);

    isEnabled.mockRestore();
    subscribe.mockRestore();
  });
});
